import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn());
const resolverActorEquipas = vi.hoisted(() => vi.fn());
const chamadas = vi.hoisted(() => [] as Array<{ table: string; filters: Array<[string, unknown]> }>);
let falhaEm: string | null = null;
let snapshot: unknown = "membership-s0";

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
    then: (resolve: (v: unknown) => unknown) => {
      const ok = {
        data: table === "teams_with_members"
          ? [{ id: "team-1", name: "Equipa 1", color: "#16A34A", active: true, leader_id: null, revision: 1, members: [] }]
          : [],
        error: null,
      };
      return Promise.resolve(falhaEm === table ? erro : ok).then(resolve);
    },
  };
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (name: string) => Promise.resolve(falhaEm === name ? erro : { data: snapshot, error: null }),
    from: (table: string) => builder(table),
  }),
}));

vi.mock("@/lib/equipas/actor", () => ({ resolverActorEquipas }));
vi.mock("@/components/layout/header", () => ({
  Header: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <header data-header={title} data-subtitle={subtitle}>{actions}</header>
  ),
}));
vi.mock("@/app/(dashboard)/dashboard/equipas/_components/grid", () => ({
  EquipasGrid: () => <div data-testid="mutable-grid" />,
}));
vi.mock("@/app/(dashboard)/dashboard/equipas/_components/sheet", () => ({
  EquipaSheet: () => <div data-testid="mutable-sheet" />,
}));

async function renderPage() {
  vi.resetModules();
  const mod = await import("@/app/(dashboard)/dashboard/equipas/page");
  return renderToStaticMarkup(await mod.default());
}

describe("EquipasPage — FAIL_CLOSED", () => {
  beforeEach(() => {
    falhaEm = null;
    snapshot = "membership-s0";
    chamadas.length = 0;
    getUser.mockResolvedValue({ data: { user: { id: "auth-1" } }, error: null });
    resolverActorEquipas.mockResolvedValue({
      ok: true,
      actor: { profileId: "profile-1", companyId: "empresa-1", role: "gestor" },
    });
  });

  it("A. sessão em erro falha fechado", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "auth down" } });
    const html = await renderPage();
    expect(html).toContain("role=\"alert\"");
    expect(html).not.toContain("mutable-grid");
    expect(html).not.toContain("mutable-sheet");
  });

  it("B. actor não resolvido falha fechado", async () => {
    resolverActorEquipas.mockResolvedValue({ ok: false, motivo: "SEM_PERFIL", error: "Perfil não encontrado." });
    const html = await renderPage();
    expect(html).toContain("role=\"alert\"");
    expect(html).not.toContain("mutable-grid");
    expect(html).not.toContain("mutable-sheet");
  });

  it.each(["teams_with_members", "profiles", "permanent_membership_snapshot"])(
    "C-E. %s em erro não mostra UI mutável",
    async (fonte) => {
      falhaEm = fonte;
      const html = await renderPage();
      expect(html).toContain("role=\"alert\"");
      expect(html).not.toContain("mutable-grid");
      expect(html).not.toContain("mutable-sheet");
    },
  );

  it("usa company_id do resolver e nunca fallback vazio", async () => {
    const html = await renderPage();
    expect(html).toContain("mutable-grid");
    expect(chamadas.flatMap((c) => c.filters)).toContainEqual(["company_id", "empresa-1"]);
    expect(chamadas.flatMap((c) => c.filters)).not.toContainEqual(["company_id", ""]);
  });
});
