import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  profile: { id: "profile-admin", auth_user_id: "auth-admin", company_id: "company-canonical", role: "admin" } as null | Record<string, string>,
  user: { id: "auth-admin" } as null | { id: string },
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: vi.fn(async () => state.user),
  getCurrentProfile: vi.fn(async () => state.profile),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (value: Record<string, unknown>) => {
        if (table === "profiles") state.inserts.push(value);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/query-error", () => ({
  isNoRowsError: vi.fn(() => false), logQueryFailure: vi.fn(), queryFailure: vi.fn(),
}));

import { createColaborador } from "@/app/actions/colaboradores";

describe("createColaborador - autoridade server-side", () => {
  beforeEach(() => {
    state.profile = {
      id: "profile-admin", auth_user_id: "auth-admin",
      company_id: "company-canonical", role: "admin",
    };
    state.user = { id: "auth-admin" };
    state.inserts = [];
  });

  it("COL01/COL13/COL14 cria name-only na empresa canonica sem company_id do browser", async () => {
    const result = await createColaborador({ full_name: "Ana" });
    expect(result.ok).toBe(true);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      company_id: "company-canonical", full_name: "Ana",
      email: null, phone: null, nif: null, iban: null,
    });
  });

  it("COL15/COL16 ignora company_id falso enviado fora do contrato", async () => {
    const result = await createColaborador({
      full_name: "Ana", company_id: "company-attacker",
    } as never);
    expect(result.ok).toBe(true);
    expect(state.inserts[0].company_id).toBe("company-canonical");
    expect(state.inserts[0]).not.toHaveProperty("company-attacker");
  });

  it("COL17/COL18 falha fechada quando o perfil nao tem empresa", async () => {
    state.profile = null;
    const result = await createColaborador({ full_name: "Ana" });
    expect(result).toEqual({ ok: false, error: "COMPANY_CONTEXT_MISSING" });
    expect(state.inserts).toEqual([]);
  });

  it("COL19 permite criar duas pessoas com o mesmo nome", async () => {
    expect((await createColaborador({ full_name: "Ana" })).ok).toBe(true);
    expect((await createColaborador({ full_name: "Ana" })).ok).toBe(true);
    expect(state.inserts.map((row) => row.full_name)).toEqual(["Ana", "Ana"]);
  });
});
