import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { parseCsvStatement, fileHash } from "@/lib/bank-import";
import { confirmBankStatementImport, fetchExistingFingerprints } from "@/lib/bank-import/reconcile-db";
import type { FieldKey } from "@/lib/bank-import";

export const maxDuration = 60;

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB
const CSV_ONLY_MSG =
  "Nesta versão, a conciliação bancária aceita apenas CSV. Exporte o extrato bancário em CSV e tente novamente.";

function isCsvFile(name: string): boolean {
  return name.toLowerCase().endsWith(".csv");
}

function parseColumnMap(raw: FormDataEntryValue | null): Partial<Record<FieldKey, number | null>> | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Partial<Record<FieldKey, number | null>>;
  } catch {
    // ignora mapeamento inválido — usa deteção automática
  }
  return undefined;
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
  const mode = String(form.get("mode") ?? "preview"); // "preview" | "commit"
  const bankAccountId = (form.get("bank_account_id") as string) || null;
  const columnOverride = parseColumnMap(form.get("column_map"));

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Ficheiro em falta." }, { status: 400 });
  }
  if (!isCsvFile(file.name)) {
    return NextResponse.json({ error: CSV_ONLY_MSG }, { status: 400 });
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

  // ── Parse + pré-visualização ──
  const existingFingerprints = await fetchExistingFingerprints(admin, companyId, bankAccountId);
  const parsed = parseCsvStatement(buffer, { columnOverride, existingFingerprints });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 422 });
  }
  const { preview } = parsed;

  if (mode === "preview") {
    return NextResponse.json({
      ok: true,
      preview: true,
      headers: preview.headers,
      detected_mapping: preview.detectedMapping,
      has_recognized_header: preview.hasRecognizedHeader,
      total: preview.totalRows,
      valid: preview.validCount,
      errors: preview.errorCount,
      duplicates_internal: preview.duplicateInternalCount,
      duplicates_existing: preview.duplicateExistingCount,
      sample_errors: preview.sampleErrors,
      rows: preview.rows.slice(0, 200),
      file_hash: hash,
    });
  }

  // ── Commit ──
  if (preview.validCount === 0) {
    return NextResponse.json({ error: "Nenhum movimento válido para importar. Reveja o mapeamento de colunas." }, { status: 422 });
  }

  const result = await confirmBankStatementImport(admin, {
    companyId,
    bankAccountId,
    fileName: file.name,
    fileHash: hash,
    userId: user.id,
    transactions: preview.transactions,
    totalRows: preview.totalRows,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, duplicate_import: result.status === 409 || undefined }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    import_id: result.importId,
    total: preview.totalRows,
    imported: result.imported,
    duplicates: result.duplicates,
    suggestions: result.suggestions,
    errors: preview.errorCount,
  });
}
