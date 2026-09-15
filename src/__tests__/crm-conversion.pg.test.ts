// ============================================================================
// 104 — fechar a conversão de uma lead, contra um Postgres a sério
// ============================================================================
//
// O que aqui se prova, e que nenhum teste de código puro conseguiria:
//
//   🔴 converter duas vezes não cria dois clientes. É o defeito mais provável
//      deste fluxo — um duplo-clique, um retry de rede, um refresh a meio —
//      e o mais caro de descobrir, porque só aparece na lista de Clientes
//      semanas depois, com dois registos iguais e ninguém a saber qual usar.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `crmconv-${process.pid}`;

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;

const sql = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

async function baseline() {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      full_name text NOT NULL, role text NOT NULL DEFAULT 'gestor'
    );
    CREATE TABLE public.clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      name text NOT NULL, type text DEFAULT 'empresa', status text DEFAULT 'ativo'
    );
    CREATE TABLE public.locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
      name text NOT NULL, address text NOT NULL
    );
    CREATE TABLE public.company_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      vat_rate numeric(5,2) NOT NULL DEFAULT 23, invoice_prefix text NOT NULL DEFAULT 'F'
    );
    CREATE TABLE public.data_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text NOT NULL, row_id uuid,
      op text NOT NULL, old_data jsonb, new_data jsonb, actor uuid,
      changed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION public.update_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE FUNCTION public.fn_capture_history() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
    CREATE FUNCTION public.get_my_company_id() RETURNS uuid
      LANGUAGE sql STABLE AS $$ SELECT current_setting('teste.company', true)::uuid $$;
    CREATE FUNCTION public.get_my_role() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT current_setting('teste.role', true) $$;
    CREATE UNIQUE INDEX clients_id_company_unique ON public.clients (id, company_id);
  `);

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query(
    "INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')",
    [ACTOR, EMPRESA],
  );
  await pool.query("INSERT INTO public.company_settings (company_id) VALUES ($1), ($2)", [EMPRESA, OUTRA]);

  await pool.query(sql("supabase/migrations/101_crm_leads.sql"));
  await pool.query(sql("supabase/migrations/102_crm_visitas_comerciais.sql"));
  await pool.query(sql("supabase/migrations/103_crm_orcamentos.sql"));
  await pool.query(sql("supabase/migrations/104_crm_conversao_lead.sql"));
}

/** Uma lead, e o cliente + local que a conversão teria criado. */
async function palco(empresa = EMPRESA) {
  const { rows: lead } = await pool.query(
    "INSERT INTO public.crm_leads (company_id, name) VALUES ($1, 'Condomínio X') RETURNING id",
    [empresa],
  );
  const { rows: cliente } = await pool.query(
    "INSERT INTO public.clients (company_id, name) VALUES ($1, 'Condomínio X') RETURNING id",
    [empresa],
  );
  const { rows: local } = await pool.query(
    "INSERT INTO public.locations (company_id, client_id, name, address) VALUES ($1, $2, 'Sede', 'Rua X') RETURNING id",
    [empresa, cliente[0].id],
  );
  return { leadId: lead[0].id as string, clientId: cliente[0].id as string, locationId: local[0].id as string };
}

const converter = (
  p: { leadId: string; clientId: string; locationId: string },
  quoteId: string | null = null,
  empresa = EMPRESA,
  client: pg.Client | pg.Pool = pool,
) =>
  client.query(
    "SELECT * FROM public.link_crm_lead_conversion($1, $2, $3, $4, $5, $6)",
    [empresa, p.leadId, p.clientId, p.locationId, quoteId, ACTOR],
  );

async function erroDe(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const lerLead = async (id: string) =>
  (await pool.query("SELECT * FROM public.crm_leads WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "crmconv",
    serverFlags: ["shared_buffers=16MB", "max_connections=25", "work_mem=1MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 6 });
  await pool.query(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

beforeEach(async () => {
  await baseline();
});

describe("104 — a migration", () => {
  it("corre, e correr duas vezes não parte nada", async () => {
    await expect(pool.query(sql("supabase/migrations/104_crm_conversao_lead.sql"))).resolves.toBeDefined();
  });

  it("sem a 101, recusa-se a correr", async () => {
    await pool.query("DROP FUNCTION public.link_crm_lead_conversion(uuid,uuid,uuid,uuid,uuid,uuid)");
    await pool.query("DROP TABLE public.crm_quote_items, public.crm_quotes, public.crm_visits, public.crm_lead_interactions, public.crm_leads CASCADE");
    const erro = await erroDe(() => pool.query(sql("supabase/migrations/104_crm_conversao_lead.sql")));
    expect(erro).toContain("CRM_CONV_104_PRECONDITION_FAILED");
  });
});

describe("104 — a conversão", () => {
  it("marca ganho, liga cliente e local, e carimba a data", async () => {
    const p = await palco();
    await converter(p);

    const lead = await lerLead(p.leadId);
    expect(lead.stage).toBe("ganho");
    expect(lead.converted_client_id).toBe(p.clientId);
    expect(lead.converted_location_id).toBe(p.locationId);
    expect(lead.won_at).not.toBeNull();
  });

  it("escreve a última linha da história na timeline", async () => {
    const p = await palco();
    await converter(p);

    const { rows } = await pool.query(
      "SELECT kind, summary FROM public.crm_lead_interactions WHERE lead_id = $1",
      [p.leadId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("sistema");
    expect(rows[0].summary).toContain("Convertida em cliente");
  });

  it("uma lead que esteve perdida e voltou deixa de contar como perdida", async () => {
    const p = await palco();
    await pool.query(
      `UPDATE public.crm_leads SET stage = 'perdido', lost_reason = 'preco', lost_at = now() WHERE id = $1`,
      [p.leadId],
    );
    await pool.query(`UPDATE public.crm_leads SET stage = 'contactado', lost_reason = NULL, lost_at = NULL WHERE id = $1`, [p.leadId]);
    // Volta a marcar perdida para provar que a conversão limpa mesmo.
    await pool.query(
      `UPDATE public.crm_leads SET stage = 'perdido', lost_reason = 'adiou', lost_at = now() WHERE id = $1`,
      [p.leadId],
    );

    await converter(p);

    const lead = await lerLead(p.leadId);
    expect(lead.stage).toBe("ganho");
    // Sem isto, a lead continuaria a aparecer no relatório de motivos de perda.
    expect(lead.lost_reason).toBeNull();
    expect(lead.lost_at).toBeNull();
  });

  it("uma lead que não existe dá erro claro", async () => {
    const p = await palco();
    const erro = await erroDe(() =>
      converter({ ...p, leadId: "99999999-9999-4999-8999-999999999999" }),
    );
    expect(erro).toContain("LEAD_NOT_FOUND");
  });
});

describe("🔴 104 — converter duas vezes", () => {
  it("a segunda tentativa levanta, em vez de criar outro cliente", async () => {
    const p = await palco();
    await converter(p);

    const erro = await erroDe(() => converter(p));
    expect(erro).toContain("LEAD_ALREADY_CONVERTED");
  });

  it("e a lead continua a apontar para o PRIMEIRO cliente", async () => {
    const p = await palco();
    await converter(p);

    // O segundo cliente existe (a action criou-o antes de chamar a RPC), mas a
    // lead não passa a apontar para ele — é o que impede a troca silenciosa.
    const { rows: outro } = await pool.query(
      "INSERT INTO public.clients (company_id, name) VALUES ($1, 'Condomínio X') RETURNING id",
      [EMPRESA],
    );
    const { rows: outroLocal } = await pool.query(
      "INSERT INTO public.locations (company_id, client_id, name, address) VALUES ($1, $2, 'Sede', 'Rua X') RETURNING id",
      [EMPRESA, outro[0].id],
    );

    await erroDe(() =>
      converter({ leadId: p.leadId, clientId: outro[0].id, locationId: outroLocal[0].id }),
    );

    const lead = await lerLead(p.leadId);
    expect(lead.converted_client_id).toBe(p.clientId);
  });

  it("🔴 duas conversões em simultâneo: uma ganha, a outra levanta", async () => {
    // É o caso do duplo-clique. O `FOR UPDATE` serializa; a segunda encontra
    // `converted_client_id` preenchido e não encontra linha para actualizar.
    const p = await palco();

    const c1 = new pg.Client({ ...container.connection });
    const c2 = new pg.Client({ ...container.connection });
    await c1.connect();
    await c2.connect();

    try {
      const resultados = await Promise.allSettled([
        converter(p, null, EMPRESA, c1),
        converter(p, null, EMPRESA, c2),
      ]);

      const ok = resultados.filter((r) => r.status === "fulfilled");
      const falhou = resultados.filter((r) => r.status === "rejected");

      expect(ok).toHaveLength(1);
      expect(falhou).toHaveLength(1);
      expect(String((falhou[0] as PromiseRejectedResult).reason)).toContain("LEAD_ALREADY_CONVERTED");
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});

describe("104 — o orçamento que fechou o negócio", () => {
  async function comOrcamento() {
    const p = await palco();
    const { rows } = await pool.query(
      `SELECT * FROM public.create_crm_quote_with_items(
         $1, $2, NULL, NULL, 'ORC', 2026, current_date, '2030-12-31',
         'mensal', 0, true, 23, NULL, NULL, NULL, NULL, NULL, $3,
         '[{"description":"Avença","quantity":1,"unit":"mes","unit_price":300}]'::jsonb)`,
      [EMPRESA, p.leadId, ACTOR],
    );
    return { ...p, quoteId: rows[0].quote_id as string };
  }

  it("passa a apontar para o cliente em vez da lead", async () => {
    const p = await comOrcamento();
    await converter(p, p.quoteId);

    const { rows } = await pool.query(
      "SELECT lead_id, client_id FROM public.crm_quotes WHERE id = $1",
      [p.quoteId],
    );
    expect(rows[0].client_id).toBe(p.clientId);
    // Deixa de estar preso à lead: o negócio já é de um cliente real.
    expect(rows[0].lead_id).toBeNull();
  });

  it("converter sem orçamento também funciona — há negócios fechados ao telefone", async () => {
    const p = await palco();
    await expect(converter(p, null)).resolves.toBeDefined();
    expect((await lerLead(p.leadId)).stage).toBe("ganho");
  });
});

describe("🔴 104 — isolamento entre empresas", () => {
  it("não se liga uma lead ao cliente de outra empresa", async () => {
    const a = await palco(EMPRESA);
    const b = await palco(OUTRA);

    const erro = await erroDe(() =>
      converter({ leadId: a.leadId, clientId: b.clientId, locationId: b.locationId }),
    );
    // A FK composta da 101 é a rede: recusa na base, não na aplicação.
    expect(erro).toMatch(/crm_leads_cliente_mesma_empresa|violates foreign key/i);
  });

  it("a lead de outra empresa não é encontrada", async () => {
    const b = await palco(OUTRA);
    const a = await palco(EMPRESA);
    const erro = await erroDe(() =>
      converter({ leadId: b.leadId, clientId: a.clientId, locationId: a.locationId }, null, EMPRESA),
    );
    expect(erro).toContain("LEAD_NOT_FOUND");
  });
});

describe("104 — permissões", () => {
  it("🔴 authenticated não executa a RPC", async () => {
    const p = await palco();
    const c = new pg.Client({ ...container.connection });
    await c.connect();
    try {
      await c.query("SET ROLE authenticated");
      const erro = await erroDe(() => converter(p, null, EMPRESA, c));
      expect(erro).toMatch(/permission denied/i);
    } finally {
      await c.end();
    }
  });
});

describe("104 — o rollback", () => {
  it("leva a função e não desfaz conversões", async () => {
    const p = await palco();
    await converter(p);

    await pool.query(sql("supabase/migrations/rollback/104_crm_conversao_lead.down.sql"));

    const { rows: f } = await pool.query(`
      SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname = 'link_crm_lead_conversion'
    `);
    expect(f[0].n).toBe(0);

    // 🔴 O cliente convertido fica. Pode já ter contrato e dinheiro cobrado —
    //    desfazer a ligação deixá-lo-ia sem a história que o explica.
    const lead = await lerLead(p.leadId);
    expect(lead.stage).toBe("ganho");
    expect(lead.converted_client_id).toBe(p.clientId);

    const { rows: c } = await pool.query("SELECT count(*)::int n FROM public.clients");
    expect(c[0].n).toBe(1);
  });
});
