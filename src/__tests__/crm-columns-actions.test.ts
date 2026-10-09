import { beforeEach, describe, expect, it, vi } from "vitest";
const { requireProfile, auditLog, invalidateBusinessState } = vi.hoisted(() => ({
  requireProfile: vi.fn(), auditLog: vi.fn(), invalidateBusinessState: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({ requireProfile }));
vi.mock("@/lib/audit", () => ({ auditLog }));
vi.mock("@/lib/revalidate-business", () => ({ invalidateBusinessState }));
import { saveCrmColumn, deleteCrmColumn, getCrmColumns, moveLeadBoard } from "@/app/actions/crm-colunas";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
function setup() {
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { id: ID,name: "Teste",color: "blue" },error:null }),
  };
  const from = vi.fn(() => query);
  const rpc = vi.fn().mockResolvedValue({ data: [{ stage:"ganho",extra_column_id:ID }],error:null });
  requireProfile.mockResolvedValue({ ok:true,admin:{ from,rpc },profile:{ id:ACTOR,company_id:COMPANY } });
  return { query, from, rpc };
}
const movement = { leadId: LEAD,expectedStage:"ganho" as const,expectedExtraColumnId:null,extraColumnId:ID };
beforeEach(() => vi.clearAllMocks());
describe("ações de colunas", () => {
  it("cria com a empresa da sessão e valida nome e cor", async () => {
    const { query }=setup();
    expect(await saveCrmColumn(null,{name:"  Teste  ",color:"blue"})).toMatchObject({ok:true});
    expect(query.insert).toHaveBeenCalledWith({name:"Teste",color:"blue",company_id:COMPANY});
    expect(requireProfile).toHaveBeenCalledWith({roles:["admin","gestor"]});
    expect(await saveCrmColumn(null,{name:"",color:"blue"})).toMatchObject({ok:false,error:{code:"VALIDATION"}});
    expect(query.insert).toHaveBeenCalledOnce();
  });
  it("renomeia e apaga apenas uma coluna da empresa da sessão", async () => {
    const { query }=setup();
    await saveCrmColumn(ID,{name:"Outro",color:"red"});
    await deleteCrmColumn(ID);
    expect(query.eq).toHaveBeenCalledWith("company_id",COMPANY);
    expect(query.eq).toHaveBeenCalledWith("id",ID);
    expect(query.update).toHaveBeenCalledWith({name:"Outro",color:"red"});
    expect(query.delete).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledTimes(2);
    expect(invalidateBusinessState).toHaveBeenCalledTimes(2);
  });
  it("nenhum acesso sem autorização chega à base", async () => {
    const { from,rpc }=setup(); requireProfile.mockResolvedValue({ok:false,code:"FORBIDDEN"});
    for (const call of [() => getCrmColumns(),() => saveCrmColumn(null,{name:"Teste",color:"blue"}),() => deleteCrmColumn(ID),() => moveLeadBoard(movement)]) {
      expect(await call()).toMatchObject({ok:false,error:{code:"FORBIDDEN"}});
    }
    expect(from).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
  });
  it("mover cartão chama uma única RPC com empresa, actor e origem da sessão", async () => {
    const { from,rpc }=setup();
    expect(await moveLeadBoard(movement)).toEqual({ok:true,data:{stage:"ganho",extra_column_id:ID}});
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("move_crm_lead_board_atomic",{
      p_company_id:COMPANY,p_actor:ACTOR,p_lead_id:LEAD,p_expected_stage:"ganho",p_expected_extra_column_id:null,
      p_extra_column_id:ID,p_stage:null,p_lost_reason:null,p_lost_reason_notes:null,
    });
  });
  it("origem inválida ou retorno sem estado é recusado antes da RPC", async () => {
    const { rpc }=setup();
    expect(await moveLeadBoard({...movement,leadId:"bad"})).toMatchObject({ok:false,error:{code:"VALIDATION"}});
    expect(await moveLeadBoard({...movement,extraColumnId:null})).toMatchObject({ok:false,error:{code:"VALIDATION"}});
    expect(rpc).not.toHaveBeenCalled();
  });
  it("conflito e coluna removida não são anunciados como sucesso", async () => {
    const { rpc }=setup();
    rpc.mockResolvedValueOnce({data:null,error:{message:"CRM_BOARD_CONFLICT"}});
    expect(await moveLeadBoard(movement)).toMatchObject({ok:false,error:{code:"CONFLICT"}});
    rpc.mockResolvedValueOnce({data:null,error:{message:"CRM_BOARD_COLUMN_NOT_FOUND"}});
    expect(await moveLeadBoard(movement)).toMatchObject({ok:false,error:{code:"NOT_FOUND"}});
    expect(auditLog).not.toHaveBeenCalled();expect(invalidateBusinessState).not.toHaveBeenCalled();
  });
});
