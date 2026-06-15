/**
 * Cron: Arquivo automático de documentos com 3+ meses
 *
 * Executa uma vez por dia (configurado no vercel.json).
 * Para cada empresa, arquiva e apaga documentos expirados.
 *
 * Antes de apagar:
 *  1. Gera um JSON de manifesto com metadados de todos os documentos
 *  2. Guarda o manifesto em storage na pasta "archives/YYYY-MM/"
 *  3. Apaga os ficheiros originais do storage
 *  4. Marca registos na DB como archived_at = now()
 *
 * O gestor pode aceder a archives/ no painel de documentos para
 * fazer download antes de o link signed URL expirar (7 dias).
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "collaborator-documents";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Cron secret not configured" }, { status: 500 });
  }

  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");

  if (!secret || secret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();
  const archiveMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  try {
    // 1. Buscar todas as empresas
    const { data: companies } = await admin
      .from("companies")
      .select("id, name");

    const results: Array<{
      company_id: string;
      company_name: string;
      archived: number;
      manifest_path: string | null;
      error?: string;
    }> = [];

    for (const company of companies ?? []) {
      try {
        // 2. Buscar documentos expirados desta empresa
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: expired } = await (admin as any)
          .from("collaborator_documents")
          .select(`
            id, file_name, file_url, file_size, mime_type,
            category, notes, visible_to_collaborator,
            uploaded_by_role, expires_at, created_at,
            collaborator_id,
            profiles!collaborator_id(full_name)
          `)
          .eq("company_id", company.id)
          .lt("expires_at", now.toISOString())
          .is("archived_at", null);

        if (!expired || expired.length === 0) {
          results.push({ company_id: company.id, company_name: company.name, archived: 0, manifest_path: null });
          continue;
        }

        // 3. Organizar manifesto por funcionária
        const byCollaborator: Record<string, {
          name: string;
          documents: Array<{
            file_name: string;
            file_url: string;
            category: string;
            notes: string | null;
            size_bytes: number | null;
            mime_type: string | null;
            created_at: string;
            expires_at: string | null;
          }>;
        }> = {};

        for (const doc of expired) {
          const collabName = (doc.profiles as { full_name?: string } | null)?.full_name ?? "Desconhecida";
          const collabId   = doc.collaborator_id as string;

          if (!byCollaborator[collabId]) {
            byCollaborator[collabId] = { name: collabName, documents: [] };
          }
          byCollaborator[collabId].documents.push({
            file_name:  doc.file_name,
            file_url:   doc.file_url,
            category:   doc.category,
            notes:      doc.notes,
            size_bytes: doc.file_size,
            mime_type:  doc.mime_type,
            created_at: doc.created_at,
            expires_at: doc.expires_at,
          });
        }

        // 4. Gerar manifesto JSON organizado por funcionária
        const manifest = {
          generated_at:  now.toISOString(),
          archive_month: archiveMonth,
          company_id:    company.id,
          company_name:  company.name,
          total_docs:    expired.length,
          by_collaborator: Object.entries(byCollaborator).map(([id, data]) => ({
            collaborator_id:   id,
            collaborator_name: data.name,
            document_count:    data.documents.length,
            documents:         data.documents,
          })),
        };

        const manifestJson = JSON.stringify(manifest, null, 2);
        const manifestPath = `${company.id}/archives/${archiveMonth}/manifesto_${archiveMonth}.json`;

        // 5. Guardar manifesto no storage
        await admin.storage
          .from(BUCKET)
          .upload(manifestPath, Buffer.from(manifestJson, "utf-8"), {
            contentType: "application/json",
            upsert: true,
          });

        // 6. Apagar ficheiros originais do storage
        type ExpiredDoc = { id: string; file_url: string };
        const storagePaths = (expired as ExpiredDoc[])
          .map((d) => {
            const prefix = `/${BUCKET}/`;
            return typeof d.file_url === "string" && d.file_url.includes(prefix)
              ? decodeURIComponent(d.file_url.split(prefix)[1])
              : null;
          })
          .filter((p): p is string => p !== null);

        if (storagePaths.length > 0) {
          await admin.storage.from(BUCKET).remove(storagePaths);
        }

        // 7. Marcar como arquivados na DB
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: archiveErr } = await (admin as any)
          .from("collaborator_documents")
          .update({ archived_at: now.toISOString() })
          .eq("company_id", company.id)
          .lt("expires_at", now.toISOString())
          .is("archived_at", null);

        if (archiveErr) {
          results.push({
            company_id:    company.id,
            company_name:  company.name,
            archived:      0,
            manifest_path: null,
            error:         archiveErr.message,
          });
          continue;
        }

        results.push({
          company_id:    company.id,
          company_name:  company.name,
          archived:      expired.length,
          manifest_path: manifestPath,
        });
      } catch (companyErr) {
        results.push({
          company_id:   company.id,
          company_name: company.name,
          archived:     0,
          manifest_path: null,
          error:        String(companyErr),
        });
      }
    }

    const totalArchived = results.reduce((sum, r) => sum + r.archived, 0);

    return NextResponse.json({
      ok:           true,
      archive_month: archiveMonth,
      total_archived: totalArchived,
      companies:    results,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
