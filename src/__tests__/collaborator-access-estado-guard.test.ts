/**
 * 106-B — gerir o acesso de terceiros: quem pode, e com que estados.
 *
 * 🔴 Dois buracos, ambos invisíveis à migration 106.
 *
 *    1. `resolverActor()` fazia a sua própria consulta com `service_role`
 *       (BYPASSRLS) e não olhava para `status`. Uma admin suspensa, com a
 *       sessão ainda válida, invocava directamente estas actions.
 *
 *    2. `desativarAcesso(id, novoEstado)` confiava no tipo TypeScript. O tipo
 *       desaparece na compilação; o valor vem do outro lado da rede. O caso
 *       perigoso não é um valor absurdo — é `"ativo"`: gravava-o, banava a
 *       conta, e a sessão já aberta continuava AUTORIZADA, porque desde a 106
 *       é o estado que autoriza. Uma operação chamada «desactivar» deixava o
 *       acesso aberto, com ar de ter corrido bem.
 *
 *    Daí as contagens explícitas de escritas: provar a recusa não basta se não
 *    se provar que nada foi escrito ANTES dela.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();

/** Contadores das duas escritas possíveis. */
const profileUpdate = vi.fn();
const authUpdate = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      update: (valores: unknown) => {
        profileUpdate(valores);
        return { eq: async () => ({ error: null }) };
      },
    }),
    auth: {
      admin: {
        updateUserById: async (...args: unknown[]) => {
          authUpdate(...args);
          return { error: null };
        },
      },
    },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ auditLog: async () => {} }));

const ADMIN_ATIVO = {
  id: "actor-1", company_id: "empresa-1", role: "admin", status: "ativo",
};
const PESSOA = {
  id: "alvo-1", company_id: "empresa-1", full_name: "Pessoa",
  auth_user_id: "auth-alvo-1", status: "ativo",
};

beforeEach(() => {
  getUser.mockReset(); maybeSingle.mockReset();
  profileUpdate.mockReset(); authUpdate.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

/** Primeiro a consulta do actor, depois a da pessoa-alvo. */
function cenario(actor: Record<string, unknown> | null) {
  getUser.mockResolvedValue({ data: { user: { id: "actor-1" } } });
  maybeSingle
    .mockResolvedValueOnce({ data: actor, error: null })   // resolver: ligação
    .mockResolvedValueOnce({ data: actor, error: null })   // resolver: legado
    .mockResolvedValue({ data: PESSOA, error: null });     // carregarPessoa
}

describe("SUSPENDED_ADMIN_CANNOT_MANAGE_ACCESS", () => {
  for (const estado of ["inativo", "suspenso"] as const) {
    it(`🔴 admin '${estado}' não gere o acesso de terceiros`, async () => {
      const { desativarAcesso } = await import("@/app/actions/collaborator-access");
      cenario({ ...ADMIN_ATIVO, status: estado });

      const r = await desativarAcesso("alvo-1", "inativo");

      expect(r.ok).toBe(false);
      // 🔴 E não escreveu nada em lado nenhum.
      expect(profileUpdate).not.toHaveBeenCalled();
      expect(authUpdate).not.toHaveBeenCalled();
    });
  }

  it("🔴 admin activo continua a conseguir", async () => {
    const { desativarAcesso } = await import("@/app/actions/collaborator-access");
    cenario(ADMIN_ATIVO);

    const r = await desativarAcesso("alvo-1", "suspenso");

    expect(r.ok).toBe(true);
    // 🔴 A ORDEM: estado primeiro, banimento depois. Se o segundo falhar, a
    //    pessoa já não autoriza — o estado intermédio seguro.
    expect(profileUpdate).toHaveBeenCalledWith({ status: "suspenso" });
    expect(authUpdate).toHaveBeenCalled();
    expect(profileUpdate.mock.invocationCallOrder[0])
      .toBeLessThan(authUpdate.mock.invocationCallOrder[0]);
  });
});

describe("novoEstado é entrada de runtime, não uma promessa do tipo", () => {
  const INVALIDOS = [
    ["ativo", "o caso perigoso: deixaria o acesso aberto"],
    ["arquivado", "reconhecido pelo código antigo, recusado pela base"],
    ["", "vazio"],
    ["ATIVO", "maiúsculas não são o mesmo valor"],
    ["qualquer-coisa", "desconhecido"],
  ] as const;

  for (const [valor, porque] of INVALIDOS) {
    it(`🔴 desativar("${valor}") é RECUSADO — ${porque}`, async () => {
      const { desativarAcesso } = await import("@/app/actions/collaborator-access");
      cenario(ADMIN_ATIVO);

      const r = await desativarAcesso(
        "alvo-1",
        // O tipo não existe em runtime: é exactamente esse o ponto.
        valor as unknown as "inativo",
      );

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/Estado inválido/i);

      // 🔴 INVALID_PROFILE_WRITES = 0 · INVALID_AUTH_WRITES = 0
      expect(profileUpdate).toHaveBeenCalledTimes(0);
      expect(authUpdate).toHaveBeenCalledTimes(0);
    });
  }

  for (const valor of ["inativo", "suspenso"] as const) {
    it(`🔴 desativar("${valor}") é permitido`, async () => {
      const { desativarAcesso } = await import("@/app/actions/collaborator-access");
      cenario(ADMIN_ATIVO);

      const r = await desativarAcesso("alvo-1", valor);

      expect(r.ok).toBe(true);
      expect(profileUpdate).toHaveBeenCalledWith({ status: valor });
    });
  }

  it("🔴 a recusa acontece ANTES de sequer resolver o actor", async () => {
    // 🔴 Fail fast: um estado impossível não justifica ir à base.
    const { desativarAcesso } = await import("@/app/actions/collaborator-access");
    getUser.mockResolvedValue({ data: { user: { id: "actor-1" } } });
    maybeSingle.mockResolvedValue({ data: ADMIN_ATIVO, error: null });

    await desativarAcesso("alvo-1", "ativo" as unknown as "inativo");

    expect(maybeSingle).not.toHaveBeenCalled();
    expect(profileUpdate).not.toHaveBeenCalled();
    expect(authUpdate).not.toHaveBeenCalled();
  });
});
