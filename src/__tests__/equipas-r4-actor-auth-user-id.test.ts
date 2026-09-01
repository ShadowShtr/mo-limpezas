import { beforeEach, describe, expect, it } from "vitest";
import { resolverActorEquipas } from "@/lib/equipas/actor";

type Profile = { id: string; company_id: string; role: string; auth_user_id?: string | null };

const AUTH = "aaaaaaaa-1111-4111-8111-111111111111";
const PROFILE = "bbbbbbbb-2222-4222-8222-222222222222";
const EMP = "cccccccc-3333-4333-8333-333333333333";

let profiles: Profile[] = [];
let queryError: { message: string } | null = null;
const filters: Array<[string, string]> = [];

function adminMock() {
  return {
    from: (table: string) => {
      expect(table).toBe("profiles");
      return {
        select: () => ({
          eq: (column: string, value: string) => {
            filters.push([column, value]);
            return {
              maybeSingle: async () => {
                if (queryError) return { data: null, error: queryError };
                const found = profiles.find((p) => (p as Record<string, unknown>)[column] === value) ?? null;
                return { data: found, error: null };
              },
            };
          },
        }),
      };
    },
  };
}

beforeEach(() => {
  profiles = [];
  queryError = null;
  filters.length = 0;
});

describe("resolverActorEquipas — só auth_user_id", () => {
  it("auth_user_id correto resolve profile.id diferente do auth id", async () => {
    profiles = [{ id: PROFILE, auth_user_id: AUTH, company_id: EMP, role: "gestor" }];
    const r = await resolverActorEquipas(adminMock(), AUTH);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.actor.profileId).toBe(PROFILE);
    expect(filters).toEqual([["auth_user_id", AUTH]]);
  });

  it("não resolve por coincidência quando só profiles.id bate com auth id", async () => {
    profiles = [{ id: AUTH, auth_user_id: null, company_id: EMP, role: "gestor" }];
    const r = await resolverActorEquipas(adminMock(), AUTH);
    expect(r).toMatchObject({ ok: false, motivo: "SEM_PERFIL" });
    expect(filters).toEqual([["auth_user_id", AUTH]]);
  });

  it("gestor atual com auth_user_id preenchido continua a funcionar", async () => {
    profiles = [{ id: AUTH, auth_user_id: AUTH, company_id: EMP, role: "admin" }];
    const r = await resolverActorEquipas(adminMock(), AUTH);
    expect(r.ok).toBe(true);
  });

  it("colaborador autenticado é SEM_PERMISSAO", async () => {
    profiles = [{ id: PROFILE, auth_user_id: AUTH, company_id: EMP, role: "colaborador" }];
    const r = await resolverActorEquipas(adminMock(), AUTH);
    expect(r).toMatchObject({ ok: false, motivo: "SEM_PERMISSAO" });
  });

  it("erro de query é ERRO_LEITURA e não fallback", async () => {
    profiles = [{ id: AUTH, auth_user_id: null, company_id: EMP, role: "admin" }];
    queryError = { message: "timeout" };
    const r = await resolverActorEquipas(adminMock(), AUTH);
    expect(r).toMatchObject({ ok: false, motivo: "ERRO_LEITURA" });
    expect(filters).toEqual([["auth_user_id", AUTH]]);
  });
});
