import { describe, expect, it } from "vitest";
import {
  sanitizeTaskAttachmentFileName,
  buildTaskAttachmentPath,
  isTaskAttachmentPathInCompany,
} from "@/lib/task-attachments";

describe("task attachments", () => {
  it("sanitiza nomes de ficheiro e mantém extensão", () => {
    expect(sanitizeTaskAttachmentFileName("orçamento nº1 (cliente).pdf")).toBe("or_amento_n_1__cliente_.pdf");
    expect(sanitizeTaskAttachmentFileName("")).toBe("anexo");
  });

  it("cria path no formato esperado pelo storage", () => {
    expect(buildTaskAttachmentPath({
      companyId: "empresa-1",
      taskId: "tarefa-1",
      fileName: "orçamento cliente.pdf",
      now: 123,
    })).toBe("empresa-1/tarefa-1/123-or_amento_cliente.pdf");
  });

  describe("isolamento multi-tenant (isTaskAttachmentPathInCompany)", () => {
    it("aceita ficheiros da própria empresa", () => {
      expect(isTaskAttachmentPathInCompany("empresa-1/tarefa-1/123-orcamento.pdf", "empresa-1")).toBe(true);
    });

    it("rejeita ficheiros de outra empresa", () => {
      expect(isTaskAttachmentPathInCompany("empresa-2/tarefa-9/orcamento.pdf", "empresa-1")).toBe(false);
    });

    it("rejeita prefixos parciais (empresa-1 vs empresa-12)", () => {
      expect(isTaskAttachmentPathInCompany("empresa-12/tarefa-1/orcamento.pdf", "empresa-1")).toBe(false);
    });

    it("rejeita travessia de diretórios", () => {
      expect(isTaskAttachmentPathInCompany("empresa-1/../empresa-2/orcamento.pdf", "empresa-1")).toBe(false);
    });

    it("rejeita path ou companyId vazios", () => {
      expect(isTaskAttachmentPathInCompany("", "empresa-1")).toBe(false);
      expect(isTaskAttachmentPathInCompany("empresa-1/orcamento.pdf", "")).toBe(false);
    });
  });
});
