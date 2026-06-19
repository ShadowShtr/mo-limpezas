import { describe, it, expect } from "vitest";
import { sanitize } from "@/lib/audit";

describe("audit sanitize", () => {
  it("remove chaves sensíveis", () => {
    const out = sanitize({
      name: "Ana",
      password: "segredo",
      token: "abc",
      signedUrl: "https://...",
      access_token: "x",
      secret: "y",
      status: "pago",
    }) as Record<string, unknown>;
    expect(out.name).toBe("Ana");
    expect(out.status).toBe("pago");
    expect(out.password).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.signedUrl).toBeUndefined();
    expect(out.access_token).toBeUndefined();
    expect(out.secret).toBeUndefined();
  });

  it("trunca strings longas", () => {
    const long = "a".repeat(600);
    const out = sanitize({ note: long }) as Record<string, string>;
    expect(out.note.length).toBeLessThanOrEqual(501);
    expect(out.note.endsWith("…")).toBe(true);
  });

  it("limita arrays e profundidade", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const out = sanitize(arr) as number[];
    expect(out.length).toBe(50);
  });

  it("remove chaves sensíveis aninhadas", () => {
    const out = sanitize({ user: { name: "Z", token: "t" } }) as { user: Record<string, unknown> };
    expect(out.user.name).toBe("Z");
    expect(out.user.token).toBeUndefined();
  });

  it("passa valores primitivos e null", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
  });
});
