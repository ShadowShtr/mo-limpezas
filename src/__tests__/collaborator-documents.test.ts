import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDamageReportNotificationRows,
  buildDocumentStoragePath,
  isCollaboratorProfileRole,
  sanitizeDocumentFileName,
} from "@/lib/collaborator-documents";

describe("collaborator documents", () => {
  it("sanitiza nomes de ficheiro e mantém extensão", () => {
    expect(sanitizeDocumentFileName("foto avaria nº1.heic")).toBe("foto_avaria_n_1.heic");
    expect(sanitizeDocumentFileName("")).toBe("documento");
  });

  it("cria path no formato esperado pelo storage policy", () => {
    expect(buildDocumentStoragePath({
      companyId: "empresa-1",
      collaboratorId: "colab-1",
      fileName: "dano porta.jpg",
      now: 123,
    })).toBe("empresa-1/colab-1/123-dano_porta.jpg");
  });

  it("usa o role real do schema para colaboradoras", () => {
    expect(isCollaboratorProfileRole("colaborador")).toBe(true);
    expect(isCollaboratorProfileRole("colaboradora")).toBe(false);
  });

  it("cria notificações para todos os gestores", () => {
    expect(buildDamageReportNotificationRows({
      companyId: "empresa-1",
      collaboratorId: "colab-1",
      collaboratorName: "Maria Silva",
      documentId: "doc-1",
      notes: "Vidro partido",
      managers: [{ id: "gestor-1" }, { id: "admin-1" }],
    })).toEqual([
      {
        company_id: "empresa-1",
        user_id: "gestor-1",
        type: "damage_report_submitted",
        title: "Maria Silva enviou um relatório de avaria",
        body: "\"Vidro partido\"",
        data: { document_id: "doc-1", collaborator_id: "colab-1" },
      },
      {
        company_id: "empresa-1",
        user_id: "admin-1",
        type: "damage_report_submitted",
        title: "Maria Silva enviou um relatório de avaria",
        body: "\"Vidro partido\"",
        data: { document_id: "doc-1", collaborator_id: "colab-1" },
      },
    ]);
  });

  it("migration de correção permite role colaborador e remove restrição de MIME", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/023_fix_collaborator_documents_upload.sql"), "utf8");
    expect(sql).toContain("role = 'colaborador'");
    expect(sql).not.toContain("role = 'colaboradora'");
    expect(sql).toContain("allowed_mime_types = NULL");
  });
});
