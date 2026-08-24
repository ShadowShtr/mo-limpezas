/**
 * Cron: eliminação automática de documentos expirados
 *
 * 🔴 «Arquivo» é um eufemismo, e o nome do ficheiro mantém-no por compatibilidade
 *    de rota. O que esta rota faz é:
 *
 *      1. gerar um manifesto JSON com **metadados** dos documentos;
 *      2. guardar o manifesto em `archives/YYYY-MM/`;
 *      3. marcar `archived_at` na base;
 *      4. `storage.remove()` — os ficheiros **deixam de existir**.
 *
 *    O manifesto tem nome, tamanho, categoria e datas. Não tem o conteúdo.
 *    Depois desta rota correr, o documento não é recuperável a partir dela.
 *    Chamar-lhe «arquivado com segurança» seria falso.
 *
 * Executa uma vez por dia (configurado no vercel.json).
 *
 * ---------------------------------------------------------------------------
 * A proteção por política
 * ---------------------------------------------------------------------------
 *
 * Nem toda a categoria pode ser destruída pelo relógio. A regra vive em
 * `src/domain/documents/retention-policy.ts` e é aplicada **duas vezes**:
 *
 *   · na consulta, para não trazer o que não se pode apagar;
 *   · por documento, imediatamente antes de apagar.
 *
 * A segunda não é redundância defensiva por hábito. É o que garante que, se
 * alguém um dia simplificar a consulta e tirar o filtro, um recibo de
 * vencimento continua a sobreviver. Numa operação destrutiva e automática, a
 * proteção tem de estar colada ao ato de destruir.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/cron-auth";
import {
  podeArquivarAutomaticamente,
  CATEGORIAS_PROTEGIDAS,
} from "@/domain/documents/retention-policy";

export const maxDuration = 60;

const BUCKET = "collaborator-documents";
// Limite por empresa para evitar timeout em empresas com muitos documentos expirados.
const DOCS_PER_COMPANY = 100;

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
        // 2. Buscar documentos expirados desta empresa (limite para não saturar)
        // Primeira barreira: não trazer o que não se pode apagar.
        const { data: expiredRaw, error: expiredErr } = await admin
          .from("collaborator_documents")
          .select("id, file_name, file_url, file_size, mime_type, category, notes, visible_to_collaborator, uploaded_by_role, expires_at, created_at, collaborator_id")
          .eq("company_id", company.id)
          .lt("expires_at", now.toISOString())
          .is("archived_at", null)
          .not("category", "in", `(${CATEGORIAS_PROTEGIDAS.join(",")})`)
          .limit(DOCS_PER_COMPANY);

        // Numa operação destrutiva, uma consulta falhada não pode ser lida como
        // «nada a apagar» nem como «apaga o que vier». Passa-se à empresa
        // seguinte e regista-se — nada é destruído com base numa leitura
        // incompleta.
        if (expiredErr) {
          results.push({
            company_id: company.id, company_name: company.name,
            archived: 0, manifest_path: null,
            error: "query_failed",
          });
          continue;
        }

        // Segunda barreira, por documento e colada ao ato de destruir. Uma
        // categoria que a política não reconheça **não** herda o comportamento
        // por omissão: apagar exige certeza, guardar a mais não custa nada.
        const protegidos: string[] = [];
        const expired = (expiredRaw ?? []).filter((d) => {
          if (podeArquivarAutomaticamente(d.category)) return true;
          protegidos.push(String(d.category));
          return false;
        });

        if (protegidos.length > 0) {
          console.warn("[retention] documentos preservados por política", {
            company_id: company.id,
            count: protegidos.length,
            categorias: [...new Set(protegidos)],
          });
        }

        // Nome do colaborador buscado separadamente para evitar joins complexos
        const collabIds = [...new Set((expired ?? []).map((d) => d.collaborator_id))];
        const { data: collabRows } = collabIds.length > 0
          ? await admin.from("profiles").select("id, full_name").in("id", collabIds)
          : { data: [] };
        const collabNameMap: Record<string, string> = {};
        for (const p of collabRows ?? []) collabNameMap[p.id] = p.full_name;

        if (expired.length === 0) {
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
          const collabName = collabNameMap[doc.collaborator_id] ?? "Desconhecida";
          const collabId   = doc.collaborator_id;

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

        // 6. Marcar como arquivados na DB ANTES de apagar storage.
        // Se a DB falhar, os ficheiros ficam intactos e o cron pode repetir.
        // Se o storage falhar depois, os metadados já estão corretos — ficheiros
        // órfãos serão apanhados pela reconciliação.
        const expiredIds = (expired as Array<{ id: string }>).map((d) => d.id);
        const { error: archiveErr } = await admin
          .from("collaborator_documents")
          .update({ archived_at: now.toISOString() })
          .in("id", expiredIds);

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

        // 7. Apagar ficheiros originais do storage (após DB confirmada)
        //
        // `expired` já passou pela política acima; este `filter` é o último
        // ponto antes da destruição e mantém-se explícito de propósito — é a
        // linha que alguém teria de apagar deliberadamente para reintroduzir o
        // defeito.
        const storagePaths = expired
          .filter((d) => podeArquivarAutomaticamente(d.category))
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
