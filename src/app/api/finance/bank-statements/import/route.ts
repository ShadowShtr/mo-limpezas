import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit";
import { parseStatement, fileHash, type BankFileType, type ParsedTransaction } from "@/lib/bank-import";
import { generateSuggestions } from "@/lib/bank-import/reconcile-db";

export const maxDuration = 60;

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB
const EXT_TO_TYPE: Record<string, BankFileType> = {
  csv: "csv",
  xlsx: "xlsx",
  xls: "xls",
  pdf: "pdf",
};

function detectType(name: string): BankFileType | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_TYPE[ext] ?? null;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  // Só admin/gestor — colaborador nunca acede a dados bancários.
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return NextResponse.json({ error: "Sem permissão." }, { status: 403 });
  }
  const companyId = profile.company_id;

  const limited = await rateLimit(rateLimitKey("bank-import", user.id), 10, 60_000);
  if (limited) return limited;

  // ── Ler ficheiro ──
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  }
  const file = form.get("file");
  const mode = String(form.get("mode") ?? "commit"); // "preview" | "commit"
  const bankAccountId = (form.get("bank_account_id") as string) || null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Ficheiro em falta." }, { status: 400 });
  }
  const fileType = detectType(file.name);
  if (!fileType) {
    return NextResponse.json(
      { error: "Tipo de ficheiro não suportado. Use CSV, XLSX, XLS ou PDF." },
      { status: 400 },
    );
  }
  if (file.size === 0) return NextResponse.json({ error: "Ficheiro vazio." }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Ficheiro demasiado grande (máx 8 MB)." }, { status: 413 });
  }

  // Validar que a conta bancária (se indicada) é da empresa
  if (bankAccountId) {
    const { data: acc } = await admin
      .from("bank_accounts")
      .select("id")
      .eq("id", bankAccountId)
      .eq("company_id", companyId)
      .single();
    if (!acc) return NextResponse.json({ error: "Conta bancária inválida." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const hash = fileHash(buffer);

  // ── Parse ──
  const parsed = await parseStatement(fileType, buffer);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 422 });
  }

  // ── Pré-visualização: não persiste nada ──
  if (mode === "preview") {
    return NextResponse.json({
      ok: true,
      preview: true,
      total: parsed.transactions.length,
      skipped: parsed.skipped,
      transactions: parsed.transactions.slice(0, 200).map((t) => ({
        transaction_date: t.transaction_date,
        description: t.description,
        amount: t.amount,
        direction: t.direction,
        counterparty_name: t.counterparty_name,
        reference: t.reference,
      })),
      file_hash: hash,
    });
  }

  // ── Commit: impedir reimportação do mesmo ficheiro ──
  const { data: existing } = await admin
    .from("bank_statement_imports")
    .select("id, created_at, imported_rows")
    .eq("company_id", companyId)
    .eq("file_hash", hash)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "Este ficheiro já foi importado anteriormente.", duplicate_import: true },
      { status: 409 },
    );
  }

  // Cria o registo de importação (status processing)
  const { data: imp, error: impErr } = await admin
    .from("bank_statement_imports")
    .insert({
      company_id: companyId,
      bank_account_id: bankAccountId,
      file_name: file.name,
      file_type: fileType,
      file_hash: hash,
      status: "processing",
      total_rows: parsed.transactions.length,
      uploaded_by: user.id,
    })
    .select("id")
    .single();
  if (impErr || !imp) {
    return NextResponse.json({ error: "Falha a registar importação." }, { status: 500 });
  }

  try {
    // Fingerprints já existentes para a empresa+conta (deteção de duplicados de movimento)
    let existingQuery = admin
      .from("bank_transactions")
      .select("fingerprint")
      .eq("company_id", companyId);
    existingQuery = bankAccountId
      ? existingQuery.eq("bank_account_id", bankAccountId)
      : existingQuery.is("bank_account_id", null);
    const { data: existingFps } = await existingQuery;
    const seen = new Set((existingFps ?? []).map((r) => r.fingerprint));

    let duplicateRows = 0;
    const toInsert: ReturnType<typeof buildRow>[] = [];
    function buildRow(t: ParsedTransaction, status: "pending" | "duplicate") {
      return {
        company_id: companyId,
        bank_account_id: bankAccountId,
        statement_import_id: imp!.id,
        transaction_date: t.transaction_date,
        value_date: t.value_date,
        description: t.description,
        counterparty_name: t.counterparty_name,
        reference: t.reference,
        amount: t.amount,
        direction: t.direction,
        currency: t.currency,
        raw_data: t.raw_data,
        fingerprint: t.fingerprint,
        status,
      };
    }

    for (const t of parsed.transactions) {
      const isDup = seen.has(t.fingerprint);
      if (isDup) duplicateRows++;
      else seen.add(t.fingerprint);
      toInsert.push(buildRow(t, isDup ? "duplicate" : "pending"));
    }

    // Insere em lotes; ignora colisões na unique index (corrida concorrente)
    const inserted: { id: string; transaction_date: string; amount: number; direction: "credit" | "debit"; description: string; counterparty_name: string | null; reference: string | null; status: string }[] = [];
    const BATCH = 200;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const slice = toInsert.slice(i, i + BATCH);
      const { data: batchRows, error: insErr } = await admin
        .from("bank_transactions")
        .upsert(slice, { onConflict: "company_id,bank_account_id,fingerprint", ignoreDuplicates: true })
        .select("id, transaction_date, amount, direction, description, counterparty_name, reference, status");
      if (insErr) throw new Error(insErr.message);
      if (batchRows) inserted.push(...batchRows);
    }

    // Gera sugestões só para movimentos não-duplicados
    const pendingTx = inserted.filter((r) => r.status === "pending");
    const suggestionsCreated = await generateSuggestions(admin, companyId, pendingTx);

    const importedRows = inserted.filter((r) => r.status !== "duplicate").length;
    await admin
      .from("bank_statement_imports")
      .update({
        status: "completed",
        imported_rows: importedRows,
        duplicate_rows: duplicateRows,
        completed_at: new Date().toISOString(),
      })
      .eq("id", imp.id);

    await auditLog(
      {
        companyId,
        actorId: user.id,
        action: "bank_statement_imported",
        entityType: "bank_statement_import",
        entityId: imp.id,
        meta: { file_name: file.name, file_type: fileType, total: parsed.transactions.length, imported: importedRows, duplicates: duplicateRows, suggestions: suggestionsCreated },
        source: "dashboard",
      },
      admin,
    );

    return NextResponse.json({
      ok: true,
      import_id: imp.id,
      total: parsed.transactions.length,
      imported: importedRows,
      duplicates: duplicateRows,
      suggestions: suggestionsCreated,
      skipped: parsed.skipped,
    });
  } catch (e) {
    await admin
      .from("bank_statement_imports")
      .update({ status: "failed", error_message: e instanceof Error ? e.message.slice(0, 500) : "erro" })
      .eq("id", imp.id);
    return NextResponse.json({ error: "Falha ao processar movimentos." }, { status: 500 });
  }
}
