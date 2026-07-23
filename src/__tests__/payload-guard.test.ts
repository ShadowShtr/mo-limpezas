import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody } from "@/lib/payload-guard";

// Fonte única de "payload control" (defesa em profundidade) para as rotas de
// API que recebem JSON de fora — limite de tamanho, parse seguro e validação
// de forma/tipo via Zod, antes de qualquer lógica de negócio correr.

function fakeRequest(body: string): Request {
  return { text: async () => body } as unknown as Request;
}

const schema = z.object({
  name: z.string().min(1).max(50),
  age: z.number().finite().nonnegative().optional(),
});

describe("parseJsonBody", () => {
  it("aceita um payload válido e devolve os dados tipados", async () => {
    const res = await parseJsonBody(fakeRequest(JSON.stringify({ name: "Ana", age: 30 })), schema);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ name: "Ana", age: 30 });
  });

  it("rejeita JSON malformado com 400, sem lançar exceção", async () => {
    const res = await parseJsonBody(fakeRequest("{ isto não é json"), schema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("rejeita corpo vazio quando o schema exige campos obrigatórios", async () => {
    const res = await parseJsonBody(fakeRequest(""), schema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("rejeita campo com tipo errado (400) — nunca deixa passar para a lógica de negócio", async () => {
    const res = await parseJsonBody(fakeRequest(JSON.stringify({ name: 123 })), schema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("rejeita campo em falta (obrigatório)", async () => {
    const res = await parseJsonBody(fakeRequest(JSON.stringify({ age: 10 })), schema);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });

  it("rejeita payloads maiores que o limite (413), antes de sequer tentar o parse", async () => {
    const huge = JSON.stringify({ name: "a".repeat(200) });
    const res = await parseJsonBody(fakeRequest(huge), schema, { maxBytes: 50 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });

  it("aceita payloads dentro do limite de tamanho configurado", async () => {
    const small = JSON.stringify({ name: "Zé" });
    const res = await parseJsonBody(fakeRequest(small), schema, { maxBytes: 1024 });
    expect(res.ok).toBe(true);
  });

  it("campos extra não esperados pelo schema são ignorados (Zod strip por omissão), não rebentam", async () => {
    const res = await parseJsonBody(
      fakeRequest(JSON.stringify({ name: "Ana", extra_field_inesperado: "xyz" })),
      schema,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).extra_field_inesperado).toBeUndefined();
  });
});
