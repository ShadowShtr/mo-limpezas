/**
 * 106-B — a saída de um colaborador, do lado do runtime.
 *
 * 🔴 O ensaio K é o motivo de esta unidade existir.
 *
 *    A migration 106 fechou as políticas de RLS. Mas `requireProfile` e
 *    `getCurrentProfile` resolvem identidade com `createAdminClient()`, que é
 *    `service_role` — e `service_role` tem `BYPASSRLS`. Nenhuma política se
 *    aplica ao que passa por ali.
 *
 *    Antes desta unidade, uma pessoa suspensa com o token ainda válido
 *    executava todas as server actions do produto. A base dizia que não e o
 *    runtime passava-lhe por cima. Não era um problema teórico: oito pessoas
 *    em produção estão nessa situação, e nenhuma delas tem a conta de Auth
 *    banida.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getUser = vi.fn();
const single = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single }) }) }),
  }),
}));

beforeEach(() => { getUser.mockReset(); single.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const PERFIL = { id: "p1", company_id: "c1", role: "admin" };

describe("106-B — sessão antiga de quem já não está activo", () => {
  it("🔴 A. quem está 'ativo' continua a passar", async () => {
    const { requireProfile } = await import("@/lib/auth-guard");
    getUser.mockResolvedValue({ data: { user: { id: "p1" } } });
    single.mockResolvedValue({ data: { ...PERFIL, status: "ativo" } });

    const guard = await requireProfile();
    expect(guard.ok).toBe(true);
  });

  for (const estado of ["inativo", "suspenso"] as const) {
    it(`🔴 B/C. '${estado}' perde acesso, com código próprio`, async () => {
      const { requireProfile, AUTH_GUARD_CODES } = await import("@/lib/auth-guard");
      getUser.mockResolvedValue({ data: { user: { id: "p1" } } });
      single.mockResolvedValue({ data: { ...PERFIL, status: estado } });

      const guard = await requireProfile();

      expect(guard.ok).toBe(false);
      if (guard.ok) return;

      // 🔴 INACTIVE, e não FORBIDDEN: quem não tem acesso nenhum não deve
      //    receber «Sem permissão», que sugere que outro papel resolveria.
      expect(guard.code).toBe(AUTH_GUARD_CODES.INACTIVE);
      expect(guard.error).toMatch(/desativado/i);
    });
  }

  it("🔴 K. o papel de admin NÃO compra acesso a quem está suspenso", async () => {
    // 🔴 O caso perigoso. A verificação de estado vem ANTES da de papel; se
    //    viesse depois, uma admin suspensa passava em toda a action que não
    //    restringe papéis — que são a maioria.
    const { requireProfile, AUTH_GUARD_CODES } = await import("@/lib/auth-guard");
    getUser.mockResolvedValue({ data: { user: { id: "p1" } } });
    single.mockResolvedValue({ data: { ...PERFIL, role: "admin", status: "suspenso" } });

    const guard = await requireProfile({ roles: ["admin", "gestor"] });

    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.code).toBe(AUTH_GUARD_CODES.INACTIVE);
  });

  it("🔴 K-bis. um estado que este código não conhece NÃO autoriza", async () => {
    // FAIL CLOSED. Se amanhã a base aceitar um estado novo, ele fica de fora
    // da autorização por omissão — que é o lado seguro.
    const { requireProfile, AUTH_GUARD_CODES } = await import("@/lib/auth-guard");
    getUser.mockResolvedValue({ data: { user: { id: "p1" } } });
    single.mockResolvedValue({ data: { ...PERFIL, status: "ferias_prolongadas" } });

    const guard = await requireProfile();
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.code).toBe(AUTH_GUARD_CODES.INACTIVE);
  });

  it("🔴 status ausente não autoriza — o campo tem de ser pedido", async () => {
    // 🔴 Se alguém tirar `status` do `select`, isto fica vermelho em vez de
    //    reabrir o acesso em silêncio.
    const { requireProfile, AUTH_GUARD_CODES } = await import("@/lib/auth-guard");
    getUser.mockResolvedValue({ data: { user: { id: "p1" } } });
    single.mockResolvedValue({ data: { ...PERFIL } });

    const guard = await requireProfile();
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.code).toBe(AUTH_GUARD_CODES.INACTIVE);
  });
});
