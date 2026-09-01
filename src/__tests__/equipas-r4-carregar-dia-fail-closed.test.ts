import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
let falhaEm: string | null = null;
const chamadas: Array<{ table: string; filters: Array<[string, unknown]> }> = [];

const ok = { data: [], error: null };
const erro = { data: null, error: { message: "falha controlada" } };

function builder(table: string) {
  const state = { table, filters: [] as Array<[string, unknown]> };
  chamadas.push(state);
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn((col: string, val: unknown) => {
      state.filters.push([col, val]);
      return b;
    }),
    order: vi.fn(() => b),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(falhaEm === table ? erro : ok).then(resolve),
  };
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string) => Promise.resolve(falhaEm === name ? erro : { data: name === "team_day_snapshot" ? "s0" : [], error: null }),
    from: (table: string) => builder(table),
  }),
}));

vi.mock("@/lib/equipas/actor", () => ({
  resolverActorEquipas: vi.fn(async () => ({
    ok: true,
    actor: { companyId: "empresa-1", profileId: "actor-1", role: "admin" },
  })),
}));

vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/app/actions/vehicles", () => ({ notifyDayTeam: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => {
  falhaEm = null;
  chamadas.length = 0;
  getUser.mockResolvedValue({ data: { user: { id: "actor-1" } } });
  vi.resetModules();
});

async function carregar() {
  const mod = await import("@/app/actions/equipas-r4");
  return mod.carregarDia("empresa-1", "2026-08-31");
}

describe("carregarDia — leituras obrigatórias falham fechado", () => {
  it.each([
    "team_day_effective",
    "team_day_snapshot",
    "teams",
    "profiles",
    "vehicles",
    "vehicle_allocations",
  ])("%s em erro devolve ok:false", async (fonte) => {
    falhaEm = fonte;
    const r = await carregar();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("carregarDia devolveu ok:true");
    expect(r.error).toBe("falha controlada");
  });

  it("profiles é filtrado para role=colaborador", async () => {
    const r = await carregar();
    expect(r.ok).toBe(true);
    const profiles = chamadas.find((c) => c.table === "profiles");
    expect(profiles?.filters).toContainEqual(["role", "colaborador"]);
    expect(profiles?.filters).toContainEqual(["status", "ativo"]);
  });
});
