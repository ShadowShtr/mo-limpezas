import { describe, it, expect } from "vitest";
import {
  buildServicePhotoPath,
  isServicePhotoPathInCompany,
  validatePhotoUploadRequest,
  isAllowedPhotoMime,
  isValidPhotoKind,
  extForMime,
  MAX_PHOTO_BYTES,
} from "@/lib/service-photos";

describe("buildServicePhotoPath", () => {
  it("usa estrutura company/service/yyyy/mm/dd/event.ext", () => {
    const path = buildServicePhotoPath({
      companyId: "c1",
      serviceId: "s1",
      clientEventId: "ev1",
      mimeType: "image/jpeg",
      now: new Date(Date.UTC(2026, 0, 5)), // 2026-01-05
    });
    expect(path).toBe("c1/s1/2026/01/05/ev1.jpg");
  });

  it("escolhe extensão por mime", () => {
    expect(extForMime("image/webp")).toBe("webp");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/heic")).toBe("heic");
    expect(extForMime("application/x")).toBe("jpg");
  });
});

describe("isServicePhotoPathInCompany", () => {
  it("aceita só paths da própria empresa", () => {
    expect(isServicePhotoPathInCompany("c1/s1/2026/01/05/e.jpg", "c1")).toBe(true);
    expect(isServicePhotoPathInCompany("c2/s1/x.jpg", "c1")).toBe(false);
  });
  it("bloqueia travessia de diretórios", () => {
    expect(isServicePhotoPathInCompany("c1/../c2/x.jpg", "c1")).toBe(false);
  });
  it("rejeita vazios", () => {
    expect(isServicePhotoPathInCompany("", "c1")).toBe(false);
    expect(isServicePhotoPathInCompany("c1/x", "")).toBe(false);
  });
});

describe("validatePhotoUploadRequest", () => {
  it("aceita imagem válida dentro do limite", () => {
    expect(validatePhotoUploadRequest({ contentType: "image/jpeg", sizeBytes: 500_000, kind: "depois" }).ok).toBe(true);
  });
  it("rejeita não-imagem", () => {
    const r = validatePhotoUploadRequest({ contentType: "application/pdf", sizeBytes: 1000 });
    expect(r.ok).toBe(false);
  });
  it("rejeita ficheiro vazio", () => {
    expect(validatePhotoUploadRequest({ contentType: "image/png", sizeBytes: 0 }).ok).toBe(false);
  });
  it("rejeita acima do limite", () => {
    expect(validatePhotoUploadRequest({ contentType: "image/png", sizeBytes: MAX_PHOTO_BYTES + 1 }).ok).toBe(false);
  });
  it("rejeita kind inválido", () => {
    expect(validatePhotoUploadRequest({ contentType: "image/png", sizeBytes: 100, kind: "video" }).ok).toBe(false);
  });
});

describe("mime/kind guards", () => {
  it("aceita mimes de imagem suportados", () => {
    expect(isAllowedPhotoMime("image/webp")).toBe(true);
    expect(isAllowedPhotoMime("image/heic")).toBe(true);
    expect(isAllowedPhotoMime("video/mp4")).toBe(false);
    expect(isAllowedPhotoMime(null)).toBe(false);
  });
  it("valida kinds", () => {
    expect(isValidPhotoKind("antes")).toBe(true);
    expect(isValidPhotoKind("xpto")).toBe(false);
  });
});
