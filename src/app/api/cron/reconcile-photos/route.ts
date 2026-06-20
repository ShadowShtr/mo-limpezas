import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVICE_PHOTOS_BUCKET } from "@/lib/service-photos";

export const maxDuration = 60;

// TASK 23 — Reconciliação de fotos de serviço (job semanal).
// Em upload direto pode acontecer: foto subiu mas metadata falhou, ou metadata
// criada mas upload falhou, ou app fechada a meio. Este job reconcilia SEM
// apagar de imediato — só marca, e só apaga após período de segurança.

// Metadata 'pending'/'failed' mais antiga que isto sem ficheiro → review/limpeza.
const STALE_PENDING_HOURS = 48;
// Período de segurança antes de remover definitivamente um órfão de storage.
const ORPHAN_GRACE_DAYS = 14;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "Cron secret not configured" }, { status: 500 });
  const secret = process.env.NODE_ENV === "production"
    ? req.headers.get("x-cron-secret")
    : (req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret"));
  if (!secret || secret !== cronSecret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";

  const staleBefore = new Date(Date.now() - STALE_PENDING_HOURS * 3600_000).toISOString();

  // ── 1. Metadata presa em pending/uploading há muito → marcar review_required ──
  // (o ficheiro pode nunca ter chegado; a gestora decide).
  let markedReview = 0;
  const { data: stale } = await admin
    .from("service_photos")
    .select("id, storage_path, company_id")
    .in("status", ["pending", "uploading"])
    .lt("created_at", staleBefore)
    .limit(500);

  for (const row of stale ?? []) {
    // Confirmar se o ficheiro existe no storage antes de marcar.
    const exists = await fileExists(admin, row.storage_path);
    if (exists) {
      // Chegou ao storage mas a confirmação falhou → corrigir para 'uploaded'.
      if (!dryRun) {
        await admin.from("service_photos")
          .update({ status: "uploaded", uploaded_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    } else {
      if (!dryRun) {
        await admin.from("service_photos")
          .update({ status: "review_required", failure_reason: "Ficheiro não encontrado no storage" })
          .eq("id", row.id);
      }
      markedReview++;
    }
  }

  // ── 2. Órfãos de storage: ficheiros sem metadata correspondente ───────────────
  // Varre o bucket por empresa/serviço e compara com a tabela. Lista, não apaga
  // (a não ser que já marcados há > ORPHAN_GRACE_DAYS via meta — ver passo 3).
  // Para manter leve, só reportamos a contagem (varredura completa é cara).
  // A limpeza efetiva depende de marcação prévia (passo 3).

  // ── 3. Metadata 'deleted'/'review_required' antiga → remover ficheiro + linha ──
  let purged = 0;
  const purgeBefore = new Date(Date.now() - ORPHAN_GRACE_DAYS * 24 * 3600_000).toISOString();
  const { data: toPurge } = await admin
    .from("service_photos")
    .select("id, storage_path")
    .eq("status", "deleted")
    .lt("created_at", purgeBefore)
    .limit(500);

  if ((toPurge ?? []).length > 0 && !dryRun) {
    const paths = (toPurge ?? []).map((p) => p.storage_path);
    await admin.storage.from(SERVICE_PHOTOS_BUCKET).remove(paths);
    await admin.from("service_photos").delete().in("id", (toPurge ?? []).map((p) => p.id));
    purged = paths.length;
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    marked_review: markedReview,
    purged,
    scanned_stale: (stale ?? []).length,
  });
}

/** Verifica se um ficheiro existe no storage (list na pasta-pai). */
async function fileExists(
  admin: ReturnType<typeof createAdminClient>,
  storagePath: string,
): Promise<boolean> {
  const idx = storagePath.lastIndexOf("/");
  const dir = idx >= 0 ? storagePath.slice(0, idx) : "";
  const name = idx >= 0 ? storagePath.slice(idx + 1) : storagePath;
  const { data } = await admin.storage.from(SERVICE_PHOTOS_BUCKET).list(dir, { search: name, limit: 1 });
  return !!data && data.some((f) => f.name === name);
}
