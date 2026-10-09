import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { baselineCompleto } from "./helpers/production-baseline";

it("a cascata real remove a lead e dependentes; uma visita usada por orçamento recusa a exclusão", async () => {
  const db = new PGlite();
  try {
    await db.exec(baselineCompleto());
    await db.exec(`
      ALTER ROLE service_role BYPASSRLS;
      CREATE UNIQUE INDEX IF NOT EXISTS clients_id_company_unique ON clients(id, company_id);
      CREATE OR REPLACE FUNCTION update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
      CREATE OR REPLACE FUNCTION fn_capture_history() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RETURN COALESCE(NEW,OLD); END; $$;
      CREATE TABLE IF NOT EXISTS _migrations(name text PRIMARY KEY, checksum text, applied_at timestamptz DEFAULT now());
    `);
    for (const name of ["101_crm_leads", "101a_crm_rpc_acl_hardening", "101b_identity_reconciliation", "102_crm_visitas_comerciais", "103_crm_orcamentos"]) {
      const sql = readFileSync(`supabase/migrations/${name}.sql`, "utf8");
      await db.exec(sql);
      const checksum = createHash("sha256").update(sql.replace(/\r\n?/g, "\n")).digest("hex");
      await db.query("INSERT INTO _migrations(name,checksum) VALUES ($1,$2)", [`${name}.sql`, checksum]);
    }
    const company = "11111111-1111-4111-8111-111111111111";
    const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.query("INSERT INTO companies(id,name,slug) VALUES ($1,'Teste','teste')", [company]);
    await db.query("INSERT INTO company_settings(company_id) VALUES ($1)", [company]);
    await db.query("INSERT INTO auth.users(id,email) VALUES ($1,'teste@local.test')", [actor]);
    await db.query("INSERT INTO profiles(id,company_id,full_name,role,status,auth_user_id) VALUES ($1,$2,'Gestor','gestor','ativo',$1)", [actor, company]);
    const lead = (await db.query<{ id: string }>("INSERT INTO crm_leads(company_id,name) VALUES ($1,'Teste') RETURNING id", [company])).rows[0].id;
    const visit = (await db.query<{ id: string }>(`INSERT INTO crm_visits(company_id,lead_id,scheduled_start,scheduled_end)
      VALUES ($1,$2,now(),now()+interval '1 hour') RETURNING id`, [company, lead])).rows[0].id;
    await db.query("INSERT INTO crm_lead_interactions(company_id,lead_id,kind,summary) VALUES ($1,$2,'chamada','Teste')", [company, lead]);
    await db.query(`SELECT * FROM create_crm_quote_with_items(
      $1,$2,NULL,$3,'ORC',2026,CURRENT_DATE,CURRENT_DATE+30,
      'pontual',0,false,0,NULL,NULL,NULL,NULL,NULL,$4,$5::jsonb)`,
    [company, lead, visit, actor, JSON.stringify([{ description: "Teste", quantity: 1, unit: "unidade", unit_price: 10 }])]);

    await expect(db.query("DELETE FROM crm_visits WHERE id=$1 AND company_id=$2", [visit, company])).rejects.toMatchObject({ code: "23503" });
    expect((await db.query("SELECT id FROM crm_visits WHERE id=$1", [visit])).rows).toHaveLength(1);
    // O filtro de empresa usado pela action recusa ids de outra empresa.
    expect((await db.query("DELETE FROM crm_leads WHERE id=$1 AND company_id=$2 RETURNING id", [lead, actor])).rows).toHaveLength(0);
    expect((await db.query(`DELETE FROM crm_leads WHERE id=$1 AND company_id=$2
      AND converted_client_id IS NULL AND stage <> 'ganho' RETURNING id`, [lead, company])).rows).toHaveLength(1);
    for (const table of ["crm_leads", "crm_visits", "crm_quotes", "crm_quote_items", "crm_lead_interactions"]) {
      expect((await db.query(`SELECT id FROM ${table}`)).rows, table).toHaveLength(0);
    }
  } finally {
    await db.close();
  }
}, 60_000);
