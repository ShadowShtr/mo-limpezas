import { describe, expect, it } from "vitest";
import {
  sanitizeAttachmentFileName,
  buildPaymentAttachmentPath,
  isPaymentAttachmentPathInCompany,
} from "@/lib/payment-attachments";

describe("payment attachments", () => {
  it("sanitiza nomes de ficheiro e mantém extensão", () => {
    expect(sanitizeAttachmentFileName("fatura nº1 (contabilista).pdf")).toBe("fatura_n_1__contabilista_.pdf");
    expect(sanitizeAttachmentFileName("")).toBe("anexo");
  });

  it("cria path no formato esperado pelo storage", () => {
    expect(buildPaymentAttachmentPath({
      companyId: "empresa-1",
      paymentId: "pag-1",
      fileName: "fatura contabilista.pdf",
      now: 123,
    })).toBe("empresa-1/pag-1/123-fatura_contabilista.pdf");
  });

  describe("isolamento multi-tenant (isPaymentAttachmentPathInCompany)", () => {
    it("aceita ficheiros da própria empresa", () => {
      expect(isPaymentAttachmentPathInCompany("empresa-1/pag-1/123-fatura.pdf", "empresa-1")).toBe(true);
    });

    it("rejeita ficheiros de outra empresa", () => {
      expect(isPaymentAttachmentPathInCompany("empresa-2/pag-9/fatura.pdf", "empresa-1")).toBe(false);
    });

    it("rejeita prefixos parciais (empresa-1 vs empresa-12)", () => {
      expect(isPaymentAttachmentPathInCompany("empresa-12/pag-1/fatura.pdf", "empresa-1")).toBe(false);
    });

    it("rejeita travessia de diretórios", () => {
      expect(isPaymentAttachmentPathInCompany("empresa-1/../empresa-2/fatura.pdf", "empresa-1")).toBe(false);
    });

    it("rejeita path ou companyId vazios", () => {
      expect(isPaymentAttachmentPathInCompany("", "empresa-1")).toBe(false);
      expect(isPaymentAttachmentPathInCompany("empresa-1/fatura.pdf", "")).toBe(false);
    });
  });
});
