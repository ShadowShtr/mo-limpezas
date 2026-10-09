import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTOR, ACTOR_OUTRA, EMPRESA, OUTRA, CLIENTE_A, LOCAL_A, montarPalcoCrm, novaLead } from "./helpers/crm-pg-harness";
import { LEAD_STAGES } from "@/lib/crm/stages";

const MIGRATION = "supabase/migrations/20261009142848_crm_extra_columns.sql";
const SIGNATURE = "public.move_crm_lead_board_atomic(uuid,uuid,uuid,text,uuid,uuid,text,text,text)";
let db: PGlite;
let adapter: pg.Pool;
let colA: string, colB: string;
beforeEach(async () => {
  db = new PGlite();
  adapter = { query: async (sql: string, args?: unknown[]) => args
    ? db.query(sql, args) : (await db.exec(sql)).at(-1) ?? { rows: [] },
  } as unknown as pg.Pool;
  await montarPalcoCrm(adapter);
  await db.exec(readFileSync(MIGRATION, "utf8"));
  colA = (await db.query<{ id: string }>("INSERT INTO crm_board_columns(company_id,name) VALUES ($1,'A') RETURNING id", [EMPRESA])).rows[0].id;
  colB = (await db.query<{ id: string }>("INSERT INTO crm_board_columns(company_id,name) VALUES ($1,'B') RETURNING id", [EMPRESA])).rows[0].id;
});
afterEach(async () => db.close());

const move = (id: string, expectedStage: string, from: string | null, to: string | null, stage: string | null = null, company = EMPRESA, actor = ACTOR) =>
  db.query<{ stage: string; extra_column_id: string | null }>(`SELECT * FROM move_crm_lead_board_atomic($1,$2,$3,$4,$5,$6,$7)`,
    [company, actor, id, expectedStage, from, to, stage]);

describe("colunas livres no banco", () => {
  it.each(LEAD_STAGES)("organiza %s sem alterar o estado nem os dados comerciais", async (stage) => {
    const campos = stage === "ganho" ? { stage, won_at: "2026-10-01T12:00:00Z", converted_client_id: CLIENTE_A, converted_location_id: LOCAL_A }
      : stage === "perdido" ? { stage, lost_at: "2026-10-01T12:00:00Z", lost_reason: "preco" } : { stage };
    const id = await novaLead(adapter, { campos });
    const before = (await db.query("SELECT stage,won_at,lost_at,lost_reason,converted_client_id,converted_location_id,board_order FROM crm_leads WHERE id=$1", [id])).rows[0];
    expect((await move(id, stage, null, colA)).rows[0]).toEqual({ stage, extra_column_id: colA });
    expect((await move(id, stage, colA, colB)).rows[0]).toEqual({ stage, extra_column_id: colB });
    expect((await move(id, stage, colB, null, stage)).rows[0]).toEqual({ stage, extra_column_id: null });
    expect((await db.query("SELECT stage,won_at,lost_at,lost_reason,converted_client_id,converted_location_id,board_order FROM crm_leads WHERE id=$1", [id])).rows[0]).toEqual(before);
  });

  it("apagar uma coluna devolve os cartões e mantém a empresa e o estado", async () => {
    const id = await novaLead(adapter);
    await move(id, "novo", null, colA);
    await db.query("DELETE FROM crm_board_columns WHERE company_id=$1 AND id=$2", [EMPRESA,colA]);
    expect((await db.query("SELECT company_id,stage,extra_column_id FROM crm_leads WHERE id=$1", [id])).rows[0])
      .toEqual({ company_id: EMPRESA, stage: "novo", extra_column_id: null });
  });

  it("recusa colunas e cartões de outra empresa, mesmo com service_role", async () => {
    const id = await novaLead(adapter);
    const foreign = (await db.query<{ id: string }>("INSERT INTO crm_board_columns(company_id,name) VALUES ($1,'Outra') RETURNING id", [OUTRA])).rows[0].id;
    await db.exec("SET ROLE service_role");
    await expect(move(id,"novo",null,foreign)).rejects.toThrow("CRM_BOARD_COLUMN_NOT_FOUND");
    await expect(move(id,"novo",null,colA,null,OUTRA,ACTOR_OUTRA)).rejects.toThrow("CRM_BOARD_COLUMN_NOT_FOUND");
    await expect(move(id,"novo",null,colA,null,EMPRESA,ACTOR_OUTRA)).rejects.toThrow("CRM_BOARD_FORBIDDEN");
    await expect(db.query("UPDATE crm_leads SET extra_column_id=$2 WHERE id=$1", [id,foreign])).rejects.toMatchObject({ code: "23503" });
    await db.exec("RESET ROLE");
  });

  it("deteta movimentos concorrentes e preserva as regras dos estados normais", async () => {
    const id = await novaLead(adapter);
    await move(id,"novo",null,colA);
    await expect(move(id,"novo",null,colB)).rejects.toThrow("CRM_BOARD_CONFLICT");
    await expect(move(id,"novo",colA,null,"ganho")).rejects.toThrow("LEAD_WIN_REQUIRES_CONVERSION");
    await expect(move(id,"novo",colA,null,"perdido")).rejects.toThrow("LEAD_LOST_REQUIRES_REASON");
    expect((await db.query("SELECT stage,extra_column_id FROM crm_leads WHERE id=$1", [id])).rows[0]).toEqual({ stage: "novo", extra_column_id: colA });
    expect((await move(id,"novo",colA,null,"contactado")).rows[0]).toEqual({ stage: "contactado", extra_column_id: null });
  });

  it("falha no diário repõe o estado e a coluna juntos", async () => {
    const id = await novaLead(adapter);
    await move(id,"novo",null,colA);
    await db.exec(`CREATE FUNCTION fail_diary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'DIARY_FAILURE'; END; $$;
      CREATE TRIGGER fail_diary BEFORE INSERT ON crm_lead_interactions FOR EACH ROW EXECUTE FUNCTION fail_diary();`);
    await expect(move(id,"novo",colA,null,"contactado")).rejects.toThrow("DIARY_FAILURE");
    expect((await db.query("SELECT stage,extra_column_id FROM crm_leads WHERE id=$1", [id])).rows[0]).toEqual({ stage: "novo", extra_column_id: colA });
  });

  it("ACL fecha escrita pública e RLS filtra a leitura", async () => {
    for (const role of ["anon","authenticated"]) {
      expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role,SIGNATURE])).rows[0].allowed).toBe(false);
    }
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('service_role',$1,'EXECUTE') allowed", [SIGNATURE])).rows[0].allowed).toBe(true);
    await db.query("INSERT INTO crm_board_columns(company_id,name) VALUES ($1,'Outra')", [OUTRA]);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [ACTOR]);
    await db.exec("SET ROLE authenticated");
    expect((await db.query("SELECT id FROM crm_board_columns")).rows).toHaveLength(2);
    await expect(db.query("DELETE FROM crm_board_columns WHERE id=$1", [colA])).rejects.toMatchObject({ code: "42501" });
    await db.exec("RESET ROLE");
  });

  it("rollback remove apenas a organização extra", async () => {
    const id = await novaLead(adapter);
    await move(id,"novo",null,colA);
    await db.exec(readFileSync("supabase/migrations/rollback/20261009142848_crm_extra_columns.down.sql","utf8"));
    expect((await db.query("SELECT stage FROM crm_leads WHERE id=$1", [id])).rows[0]).toEqual({ stage: "novo" });
    expect((await db.query<{ name: string | null }>("SELECT to_regclass('public.crm_board_columns')::text name")).rows[0].name).toBeNull();
  });
});
