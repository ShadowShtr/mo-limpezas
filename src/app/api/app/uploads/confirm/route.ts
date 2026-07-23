import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRouteMetrics } from "@/lib/observability/route-metrics";
import { auditLog } from "@/lib/audit";
import { parseJsonBody } from "@/lib/payload-guard";

const confirmSchema = z.object({
  client_event_id: z.string().min(1).max(100),
  status: z.enum(["uploaded", "failed"]).optional(),
  compressed_size_bytes: z.number().finite().nonnegative().max(500_000_000).optional(),
  failure_reason: z.string().max(500).optional(),
});

/**
 * TASK 01/04 — Confirma que a foto chegou ao Storage e atualiza a metadata.
 * Chamado pelo telemóvel após o upload direto via signed URL. Idempotente:
 * uma segunda confirmação do mesmo client_event_id é tratada como sucesso.
 */
async function handle(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await rateLimit(rateLimitKey("upload-confirm", user.id), 40, 60_000);
  if (limited) return limited;

  const parsed = await parseJsonBody(req, confirmSchema);
  if (!parsed.ok) return parsed.response;
  const { client_event_id, compressed_size_bytes, failure_reason } = parsed.data;
  const status = parsed.data.status ?? "uploaded";

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile) return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });

  const { data: photo } = await admin
    .from("service_photos")
    .select("id, status, collaborator_id")
    .eq("company_id", profile.company_id)
    .eq("client_event_id", client_event_id)
    .maybeSingle();

  if (!photo) return NextResponse.json({ error: "Registo de foto não encontrado" }, { status: 404 });
  if (photo.collaborator_id !== user.id) {
    return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  }

  // Já confirmada antes → sucesso idempotente.
  if (photo.status === "uploaded" && status === "uploaded") {
    return NextResponse.json({ ok: true, upload_id: photo.id, duplicate: true });
  }

  const patch =
    status === "uploaded"
      ? {
          status: "uploaded",
          uploaded_at: new Date().toISOString(),
          compressed_size_bytes: compressed_size_bytes ?? null,
          failed_at: null,
          failure_reason: null,
        }
      : {
          status: "failed",
          failed_at: new Date().toISOString(),
          failure_reason: failure_reason ?? "Falha no upload",
        };

  const { error } = await admin
    .from("service_photos")
    .update(patch)
    .eq("id", photo.id)
    .eq("company_id", profile.company_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Auditoria central (TASK 22).
  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: status === "uploaded" ? "service_photo_uploaded" : "service_photo_failed",
    entityType: "service_photo",
    entityId: photo.id,
    meta: { client_event_id, status },
    source: "mobile",
  }, admin);

  return NextResponse.json({ ok: true, upload_id: photo.id });
}

export const POST = withRouteMetrics("/api/app/uploads/confirm", handle);
