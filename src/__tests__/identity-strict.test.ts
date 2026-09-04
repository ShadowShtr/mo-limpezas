import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideIdentity,
  resolveProfileByAuthUser,
  IDENTITY_CODES,
  IDENTITY_COLUMNS,
} from "@/lib/identity";
import { AUTH_GUARD_CODES } from "@/lib/auth-guard";

// ============================================================================
// PAYROLL-0 — identidade estrita
//
// O defeito, medido em produção a 2026-09-04 por leitura read-only:
//
//   profiles                       46
//   com auth_user_id (têm login)   29
//   id = auth_user_id              29   ← por isso a consulta antiga funciona
//   id <> auth_user_id              0
//   SEM login (auth_user_id NULL)  17   ← a bomba-relógio
//
// As 17 sem login são colaboradoras criadas só com o nome. Quando alguma
// receber acesso, `createCollaboratorAccess` cria a conta no Auth e grava
// `auth_user_id = <id da conta nova>` num perfil que JÁ tem outro `id`.
// A partir daí `profiles.id <> auth.uid()`, e `.eq("id", user.id)` deixa de a
// encontrar: entra com a password certa e o sistema age como se não existisse.
//
// A ligação canónica é `auth_user_id`, e SÓ ela. Sem fallback: um fallback é o
// que faz a mesma consulta significar duas coisas conforme a pessoa.
// ============================================================================

const UID = "11111111-1111-4111-8111-111111111111";
const PERFIL = "22222222-2222-4222-8222-222222222222";
const EMPRESA = "33333333-3333-4333-8333-333333333333";

const linha = (over: Record<string, unknown> = {}) => ({
  id: PERFIL, company_id: EMPRESA, role: "gestor", ...over,
});

describe("decideIdentity — a política, isolada da base", () => {
  it("uma linha bem formada resolve", () => {
    const r = decideIdentity({ rows: [linha()] });
    expect(r).toEqual({ ok: true, profile: { id: PERFIL, company_id: EMPRESA, role: "gestor" } });
  });

  // 🔴 Os três fail-closed. Cada um por uma razão diferente, e é por isso que
  //    têm códigos diferentes em vez de um "não autorizado" para tudo.
  it("erro de leitura NÃO é 'não existe' — pede retry", () => {
    const r = decideIdentity({ error: { message: "timeout" }, rows: null });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe(IDENTITY_CODES.IDENTITY_LOOKUP_FAILED);
  });

  it("zero linhas é perfil não encontrado", () => {
    const r = decideIdentity({ rows: [] });
    expect(r.ok === false && r.code).toBe(IDENTITY_CODES.PROFILE_NOT_FOUND);
  });

  it("duas linhas é ambíguo — nunca escolher uma", () => {
    const r = decideIdentity({ rows: [linha(), linha({ id: "outro", company_id: "outra-empresa" })] });
    expect(r.ok === false && r.code).toBe(IDENTITY_CODES.IDENTITY_AMBIGUOUS);
  });

  it("erro tem prioridade sobre linhas devolvidas", () => {
    const r = decideIdentity({ error: { message: "falhou" }, rows: [linha()] });
    expect(r.ok === false && r.code).toBe(IDENTITY_CODES.IDENTITY_LOOKUP_FAILED);
  });

  // Sem company_id não há isolamento nenhum: um `undefined` a viajar como
  // filtro de empresa devolve tudo o que existe, de todas as empresas.
  it.each([
    ["company_id ausente", { company_id: undefined }],
    ["company_id nulo", { company_id: null }],
    ["id ausente", { id: undefined }],
    ["role ausente", { role: undefined }],
    ["company_id não é texto", { company_id: 42 }],
  ])("fail-closed: %s", (_caso, over) => {
    const r = decideIdentity({ rows: [linha(over)] });
    expect(r.ok).toBe(false);
  });

  it("rows nulo sem erro é tratado como zero linhas", () => {
    expect(decideIdentity({ rows: null }).ok).toBe(false);
  });

  it("a mensagem de falha nunca expõe o detalhe do driver", () => {
    const r = decideIdentity({ error: { message: "FATAL: password authentication failed for user postgres" } });
    expect(r.ok === false && r.error).not.toContain("password");
    expect(r.ok === false && r.error).not.toContain("postgres");
  });
});

describe("resolveProfileByAuthUser — consulta por auth_user_id, e só", () => {
  /** Cliente mínimo: regista a consulta feita e devolve o que lhe mandarem. */
  function admin(resposta: { data?: unknown; error?: unknown }) {
    const visto: { tabela?: string; coluna?: string; valor?: string; limite?: number } = {};
    const client = {
      from(tabela: string) {
        visto.tabela = tabela;
        return {
          select() { return this; },
          eq(coluna: string, valor: string) { visto.coluna = coluna; visto.valor = valor; return this; },
          limit(n: number) { visto.limite = n; return Promise.resolve(resposta); },
        };
      },
    };
    return { client: client as never, visto };
  }

  it("procura por auth_user_id — nunca por id", async () => {
    const { client, visto } = admin({ data: [linha()], error: null });
    const r = await resolveProfileByAuthUser(client, UID);
    expect(visto.tabela).toBe("profiles");
    expect(visto.coluna).toBe("auth_user_id");
    expect(visto.valor).toBe(UID);
    expect(r.ok).toBe(true);
  });

  // 🔴 O caso que motiva esta frente: perfil com id DIFERENTE do uid.
  //    A consulta antiga não o encontrava; esta encontra.
  it("resolve quando profiles.id é diferente de auth.uid()", async () => {
    const { client } = admin({ data: [linha({ id: PERFIL })], error: null });
    const r = await resolveProfileByAuthUser(client, UID);
    expect(r.ok && r.profile.id).toBe(PERFIL);
    expect(r.ok && r.profile.id).not.toBe(UID);
  });

  it("pede 2 linhas para poder detetar ambiguidade", async () => {
    const { client, visto } = admin({ data: [linha()], error: null });
    await resolveProfileByAuthUser(client, UID);
    expect(visto.limite).toBe(2);
  });

  it("uid vazio falha fechado sem sequer consultar", async () => {
    const { client, visto } = admin({ data: [linha()], error: null });
    const r = await resolveProfileByAuthUser(client, "");
    expect(r.ok).toBe(false);
    expect(visto.tabela).toBeUndefined();
  });

  it("erro da base propaga como IDENTITY_LOOKUP_FAILED", async () => {
    const { client } = admin({ data: null, error: { message: "conexão perdida" } });
    const r = await resolveProfileByAuthUser(client, UID);
    expect(r.ok === false && r.code).toBe(IDENTITY_CODES.IDENTITY_LOOKUP_FAILED);
  });

  it("duas contas ligadas ao mesmo uid recusam", async () => {
    const { client } = admin({ data: [linha(), linha({ id: "b", company_id: "outra" })], error: null });
    const r = await resolveProfileByAuthUser(client, UID);
    expect(r.ok === false && r.code).toBe(IDENTITY_CODES.IDENTITY_AMBIGUOUS);
  });
});

// ============================================================================
// O guard e o resto do código. Verificado na fonte porque o que interessa é
// que o fallback tenha DESAPARECIDO, não que exista uma função nova ao lado.
// ============================================================================

const ROOT = join(__dirname, "..");
const guard = readFileSync(join(ROOT, "lib", "auth-guard.ts"), "utf8");

describe("requireProfile — o fallback saiu", () => {
  it("usa o resolver por auth_user_id", () => {
    expect(guard).toContain("resolveProfileByAuthUser");
  });

  it("já não procura o perfil por profiles.id = auth.uid()", () => {
    expect(guard).not.toContain(`.eq("id", user.id)`);
  });

  it("distingue os três motivos de recusa", () => {
    expect(AUTH_GUARD_CODES.IDENTITY_LOOKUP_FAILED).toBe("IDENTITY_LOOKUP_FAILED");
    expect(AUTH_GUARD_CODES.IDENTITY_AMBIGUOUS).toBe("IDENTITY_AMBIGUOUS");
    expect(AUTH_GUARD_CODES.PROFILE_NOT_FOUND).toBe("PROFILE_NOT_FOUND");
  });

  it("continua a devolver sempre o company_id da sessão", () => {
    expect(guard).toContain("company_id");
  });
});

describe("contrato do módulo de identidade", () => {
  it("as colunas de identidade incluem auth_user_id", () => {
    expect(IDENTITY_COLUMNS).toContain("auth_user_id");
    expect(IDENTITY_COLUMNS).toContain("company_id");
  });

  it("os códigos de identidade estão registados no trace de observabilidade", () => {
    // A guarda de compilação de payment-status-trace.ts já obriga a isto; este
    // teste diz porquê, para quem acrescentar um código a seguir.
    const trace = readFileSync(join(ROOT, "lib", "observability", "payment-status-trace.ts"), "utf8");
    expect(trace).toContain("IDENTITY_LOOKUP_FAILED");
    expect(trace).toContain("IDENTITY_AMBIGUOUS");
  });
});