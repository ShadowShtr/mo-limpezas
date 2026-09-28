import { beforeEach, describe, expect, it, vi } from "vitest";

const requireProfile = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  requireProfile: (...args: unknown[]) => requireProfile(...args),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const { createBuildingCard, deleteBuildingCard } =
  await import("@/app/actions/building-cards");

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const PERFIL = "22222222-2222-4222-8222-222222222222";
const PREDIO = "33333333-3333-4333-8333-333333333333";

function clienteDuplo() {
  const inserts: Record<string, unknown>[] = [];
  const tabelas: string[] = [];

  function builder(resposta: { data: unknown; error: null }) {
    const api = {
      select: () => api,
      insert: (valor: Record<string, unknown>) => { inserts.push(valor); return api; },
      delete: () => api,
      eq: () => api,
      order: () => api,
      limit: () => api,
      single: () => Promise.resolve({ data: { id: PREDIO }, error: null }),
      then: (ok: (v: typeof resposta) => unknown, erro?: (e: unknown) => unknown) =>
        Promise.resolve(resposta).then(ok, erro),
    };
    return api;
  }

  const admin = {
    from: (tabela: string) => {
      tabelas.push(tabela);
      return builder({ data: [], error: null });
    },
  };

  return { admin, inserts, tabelas };
}

beforeEach(() => vi.clearAllMocks());

describe("building_cards — autorização da Server Action", () => {
  it("perfil inativo recebe erro claro e não chega à base", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    requireProfile.mockResolvedValue({
      ok: false,
      code: "INACTIVE",
      error: "O seu acesso está desativado. Contacte a gestão.",
    });

    const resultado = await deleteBuildingCard(PREDIO);

    expect(resultado).toEqual({
      ok: false,
      error: "O seu acesso está desativado. Contacte a gestão.",
    });
    expect(requireProfile).toHaveBeenCalledWith({ roles: ["admin", "gestor"] });
  });

  it("conta ligada usa profile.id como created_by", async () => {
    const duplo = clienteDuplo();
    requireProfile.mockResolvedValue({
      ok: true,
      profile: { id: PERFIL, company_id: EMPRESA, role: "gestor" },
      admin: duplo.admin,
    });

    const resultado = await createBuildingCard({ weekday: "mon", name: "  Alfa  " });

    expect(resultado).toEqual({ ok: true, id: PREDIO });
    expect(requireProfile).toHaveBeenCalledWith({ roles: ["admin", "gestor"] });
    expect(duplo.inserts).toEqual([
      expect.objectContaining({
        company_id: EMPRESA,
        created_by: PERFIL,
        name: "Alfa",
      }),
    ]);
    expect(duplo.tabelas).toEqual(["building_cards", "building_cards"]);
  });
});
