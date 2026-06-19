import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit";
import {
  SERVICE_PHOTOS_BUCKET,
  buildServicePhotoPath,
  validatePhotoUploadRequest,
  isValidPhotoKind,
} from "@/lib/service-photos";

/**
 * TASK 01 — Cria uma signed upload URL para o telemóvel enviar a foto
 * diretamente ao Supabase Storage. A Vercel só valida permissão, gera o
 * caminho e grava metadata (nunca recebe o ficheiro).
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await rateLimit(rateLimitKey("upload-sign", user.id), 30, 60_000);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  }

  const service_id = body.service_id as string | undefined;
  const kind = (body.kind as string | undefined) ?? "durante";
  const content_type = body.content_type as string | undefined;
  const size_bytes = body.size_bytes as number | undefined;
  const client_event_id = body.client_event_id as string | undefined;
  const width = body.width as number | undefined;
  const height = body.height as number | undefined;

  if (!service_id) return NextResponse.json({ error: "service_id required" }, { status: 400 });
  if (!client_event_id) return NextResponse.json({ error: "client_event_id required" }, { status: 400 });

  const valid = validatePhotoUploadRequest({ contentType: content_type, sizeBytes: size_bytes, kind });
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from("profiles").select("company_id").eq("id", user.id).single();
  if (!profile) return NextResponse.json({ error: "Perfil não encontrado" }, { status: 404 });

  const { data: service } = await admin
    .from("services_full")
    .select("id, company_id, team_id, status")
    .eq("id", service_id)
    .eq("company_id", profile.company_id)
    .single();
  if (!service) return NextResponse.json({ error: "Serviço não encontrado" }, { status: 404 });

  if (["cancelado", "arquivado"].includes(service.status ?? "")) {
    return NextResponse.json(
      { error: `Este serviço está ${service.status} e não aceita fotos.` },
      { status: 409 }
    );
  }

  // Autorização: membro da equipa OU reforço do serviço.
  const [{ data: membership }, { data: reinforcement }] = await Promise.all([
    service.team_id
      ? admin.from("team_members").select("id").eq("team_id", service.team_id).eq("collaborator_id", user.id).is("left_at", null).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("service_reinforcements").select("id").eq("service_id", service_id).eq("collaborator_id", user.id).maybeSingle(),
  ]);
  if (!membership && !reinforcement) {
    return NextResponse.json({ error: "Sem permissão para este serviço" }, { status: 403 });
  }

  const safeKind = isValidPhotoKind(kind) ? kind : "durante";
  const storage_path = buildServicePhotoPath({
    companyId: profile.company_id,
    serviceId: service_id,
    clientEventId: client_event_id,
    mimeType: content_type!,
  });

  // Idempotência: se já existe metadata para este client_event_id, devolver
  // o registo existente (retry após falha de rede) em vez de duplicar.
  const { data: existing } = await admin
    .from("service_photos")
    .select("id, storage_path, status")
    .eq("company_id", profile.company_id)
    .eq("client_event_id", client_event_id)
    .maybeSingle();

  if (existing && existing.status === "uploaded") {
    return NextResponse.json({ duplicate: true, upload_id: existing.id, storage_path: existing.storage_path });
  }

  // Gerar signed upload URL (path determinístico → mesmo path em retry).
  const path = existing?.storage_path ?? storage_path;
  const { data: signed, error: signErr } = await admin.storage
    .from(SERVICE_PHOTOS_BUCKET)
    .createSignedUploadUrl(path, { upsert: true });

  if (signErr || !signed) {
    return NextResponse.json(
      { error: signErr?.message ?? "Não foi possível preparar o envio." },
      { status: 500 }
    );
  }

  let uploadId = existing?.id;
  if (!existing) {
    const { data: row, error: insErr } = await admin
      .from("service_photos")
      .insert({
        company_id: profile.company_id,
        service_id,
        collaborator_id: user.id,
        storage_path: path,
        kind: safeKind,
        status: "pending",
        original_size_bytes: size_bytes ?? null,
        mime_type: content_type,
        width: width ?? null,
        height: height ?? null,
        client_event_id,
      })
      .select("id")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
    uploadId = row.id;
  }

  return NextResponse.json({
    upload_id: uploadId,
    storage_path: path,
    bucket: SERVICE_PHOTOS_BUCKET,
    signed_url: signed.signedUrl,
    token: signed.token,
    // Supabase signed upload URLs expiram em 2h por defeito.
    expires_in: 7200,
  });
}
