import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireProfile, auditLog, invalidateBusinessState } = vi.hoisted(() => ({
  requireProfile: vi.fn(), auditLog: vi.fn(), invalidateBusinessState: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({ requireProfile,
  AUTH_GUARD_CODES: { UNAUTHENTICATED: "UNAUTHENTICATED" },
}));
vi.mock("@/lib/audit", () => ({ auditLog }));
vi.mock("@/lib/revalidate-business", () => ({ invalidateBusinessState }));

import { excluirRegistoCrm } from "@/app/actions/crm-excluir";

const ID = "33333333-3333-4333-8333-333333333333";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup(data: { id: string } | null = { id: ID }, error: unknown = null) {
  const query = {
    delete: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  const from = vi.fn(() => query);
  requireProfile.mockResolvedValue({ ok: true, admin: { from },
    profile: { company_id: COMPANY, id: ACTOR },
  });
  return { from, query };
}

beforeEach(() => vi.clearAllMocks());

describe("exclusão CRM", () => {
  it.each(["lead", "visita", "orcamento"] as const)("exclui %s só na empresa da sessão", async (tipo) => {
    const { from, query } = setup();
    expect(await excluirRegistoCrm(tipo, ID)).toEqual({ ok: true, data: { id: ID } });
    expect(requireProfile).toHaveBeenCalledWith({ roles: ["admin", "gestor"] });
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith({ lead: "crm_leads", visita: "crm_visits", orcamento: "crm_quotes" }[tipo]);
    expect(query.delete).toHaveBeenCalledOnce();
    expect(query.eq).toHaveBeenCalledWith("company_id", COMPANY);
    expect(query.eq).toHaveBeenCalledWith("id", ID);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, actorId: ACTOR, entityId: ID }), expect.anything());
    expect(invalidateBusinessState).toHaveBeenCalledWith({ domains: ["leads"] });
  });

  it("não restringe a exclusão pelo estado ou conversão da lead", async () => {
    const { query } = setup();
    expect(await excluirRegistoCrm("lead", ID)).toMatchObject({ ok: true });
    expect(query.is).not.toHaveBeenCalled();
    expect(query.neq).not.toHaveBeenCalled();
  });

  it("um id inexistente ou de outra empresa não anuncia a exclusão", async () => {
    const { query } = setup(null);
    const result = await excluirRegistoCrm("lead", ID);
    expect(query.eq).toHaveBeenCalledWith("company_id", COMPANY);
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(auditLog).not.toHaveBeenCalled();
    expect(invalidateBusinessState).not.toHaveBeenCalled();
  });

  it("recusa acessos sem autorização antes da query", async () => {
    const { from } = setup();
    requireProfile.mockResolvedValue({ ok: false, code: "FORBIDDEN" });
    expect(await excluirRegistoCrm("visita", ID)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(from).not.toHaveBeenCalled();
  });

  it("valida o id e o tipo recebido antes da query", async () => {
    const { from } = setup();
    expect(await excluirRegistoCrm("lead", "invalid")).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    // @ts-expect-error entrada adulterada vinda do browser
    expect(await excluirRegistoCrm("clients", ID)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(from).not.toHaveBeenCalled();
  });

  it("uma visita usada por um orçamento devolve uma instrução sem expor SQL", async () => {
    setup(null, { code: "23503", message: "private_constraint" });
    const result = await excluirRegistoCrm("visita", ID);
    expect(result).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE", message: expect.stringContaining("Exclua primeiro o orçamento") } });
    expect(auditLog).not.toHaveBeenCalled();
    expect(invalidateBusinessState).not.toHaveBeenCalled();
  });

  it("uma falha técnica não anuncia nem audita uma exclusão", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setup(null, { code: "XX000", message: "private_table" });
    const result = await excluirRegistoCrm("orcamento", ID);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private_table");
    expect(auditLog).not.toHaveBeenCalled();
    expect(invalidateBusinessState).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
