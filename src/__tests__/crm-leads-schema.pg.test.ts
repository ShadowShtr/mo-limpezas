// ============================================================================
// 101 — a fundação do CRM, provada contra um Postgres a sério
// ============================================================================
//
// Um teste que procura strings num ficheiro SQL não prova que a tabela existe,
// nem que o CHECK recusa o que deve recusar. Esta suite aplica a migration
// real e depois tenta partir as regras uma a uma.
//
// O que aqui se prova:
//
//   · a migration corre de ponta a ponta, e correr duas vezes não parte nada;
//   · as precondições falham em fecho quando falta o que a 101 exige;
//   · perder uma lead sem motivo é impossível na base, não só no formulário;
//   · uma lead não pode apontar para o cliente de outra empresa;
//   · uma lead não convertida não pode ter cliente, e uma ganha tem de ter data;
//   · o diário de contactos morre com a lead, e não sobrevive noutra empresa;
//   · `authenticated` lê e não escreve; `anon` não vê nada.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `crmleads-${process.pid}`;

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const CLIENTE_A = "c1111111-1111-4111-8111-111111111111";
const LOCAL_A = "10cac111-1111-4111-8111-111111111111";
const CLIENTE_B = "c2222222-2222-4222-8222-222222222222";
const LOCAL_B = "10cab222-2222-4222-8222-222222222222";

let container: PostgresContainer;
let pool: pg.Pool;

const MIGRATION = () => readFileSync(join(ROOT, "supabase/migrations/101_crm_leads.sql"), "utf8");
const ROLLBACK = () =>
  readFileSync(join(ROOT, "supabase/migrations/rollback/101_crm_leads.down.sql"), "utf8");

/**
 * O que existe em produção ANTES da 101 — e só isso.
 *
 * Reproduzir aqui o mundo inteiro tornaria o teste uma cópia do schema; o que
 * interessa é exactamente aquilo de que a 101 diz depender, para que uma
 * dependência esquecida apareça como falha e não como sorte.
 */
async function baseline() {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);

    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      full_name text NOT NULL,
      role text NOT NULL DEFAULT 'colaborador'
    );

    CREATE TABLE public.clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      name text NOT NULL,
      type text DEFAULT 'empresa',
      status text DEFAULT 'ativo'
    );

    CREATE TABLE public.locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
      name text NOT NULL,
      address text NOT NULL
    );

    CREATE TABLE public.data_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_name text NOT NULL, row_id uuid, op text NOT NULL,
      old_data jsonb, new_data jsonb, actor uuid,
      changed_at timestamptz NOT NULL DEFAULT now()
    );

    -- 001
    CREATE FUNCTION public.update_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

    -- 059
    CREATE FUNCTION public.fn_capture_history() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          INSERT INTO public.data_history (table_name, row_id, op, old_data)
          VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD));
          RETURN OLD;
        END IF;
        IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
          INSERT INTO public.data_history (table_name, row_id, op, old_data, new_data)
          VALUES (TG_TABLE_NAME, OLD.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW));
        END IF;
        RETURN NEW;
      END $$;

    -- 014: em produção leem auth.uid(); aqui basta a identidade da sessão,
    -- que é o que as policies consultam.
    CREATE FUNCTION public.get_my_company_id() RETURNS uuid
      LANGUAGE sql STABLE AS $$ SELECT current_setting('teste.company', true)::uuid $$;
    CREATE FUNCTION public.get_my_role() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT current_setting('teste.role', true) $$;

    -- 086
    CREATE UNIQUE INDEX clients_id_company_unique ON public.clients (id, company_id);
  `);

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [
    EMPRESA,
    OUTRA,
  ]);
  await pool.query(
    "INSERT INTO public.profiles (id, company_id, full_name, role) VALUES ($1, $2, 'Gestora', 'gestor')",
    [ACTOR, EMPRESA],
  );
  await pool.query(
    "INSERT INTO public.clients (id, company_id, name) VALUES ($1, $2, 'Cliente A'), ($3, $4, 'Cliente B')",
    [CLIENTE_A, EMPRESA, CLIENTE_B, OUTRA],
  );
  await pool.query(
    `INSERT INTO public.locations (id, company_id, client_id, name, address)
     VALUES ($1, $2, $3, 'Sede A', 'Rua A'), ($4, $5, $6, 'Sede B', 'Rua B')`,
    [LOCAL_A, EMPRESA, CLIENTE_A, LOCAL_B, OUTRA, CLIENTE_B],
  );
}

/**
 * Insere uma lead mínima e devolve o id.
 *
 * `extra` substitui os valores por omissão em vez de os acompanhar — sem isso,
 * passar `name` produzia `column "name" specified more than once` e o teste
 * falhava por uma razão que não era a que estava a tentar provar.
 */
async function novaLead(extra: Record<string, unknown> = {}, empresa = EMPRESA): Promise<string> {
  const campos: Record<string, unknown> = {
    company_id: empresa,
    name: "Condomínio Teste",
    ...extra,
  };
  const colunas = Object.keys(campos);
  const valores = Object.values(campos);
  const marcas = colunas.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `INSERT INTO public.crm_leads (${colunas.join(", ")}) VALUES (${marcas}) RETURNING id`,
    valores,
  );
  return rows[0].id as string;
}

/** Corre `fn` e devolve a mensagem de erro, ou null se não levantou. */
async function erroDe(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "crmleads",
    serverFlags: ["shared_buffers=16MB", "max_connections=25", "work_mem=1MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });
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
  await pool.query(MIGRATION());
});

describe("101 — a migration corre", () => {
  it("aplica-se de ponta a ponta sobre o estado real anterior", async () => {
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'crm_%'
       ORDER BY table_name
    `);
    expect(rows.map((r) => r.table_name)).toEqual(["crm_lead_interactions", "crm_leads"]);
  });

  it("correr duas vezes não parte nada (é idempotente)", async () => {
    await expect(pool.query(MIGRATION())).resolves.toBeDefined();
  });

  it("o rollback deixa o schema como estava, sem tocar em clients nem locations", async () => {
    await pool.query(ROLLBACK());

    const { rows: crm } = await pool.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'crm_%'
    `);
    expect(crm).toHaveLength(0);

    // O que existia antes continua lá, com as linhas todas.
    const { rows: c } = await pool.query("SELECT count(*)::int n FROM public.clients");
    expect(c[0].n).toBe(2);
    const { rows: l } = await pool.query("SELECT count(*)::int n FROM public.locations");
    expect(l[0].n).toBe(2);
  });
});

describe("101 — as precondições falham em fecho", () => {
  it("sem o índice da 086, recusa-se a correr em vez de o criar por sua conta", async () => {
    await baseline();
    await pool.query("DROP INDEX public.clients_id_company_unique");

    const erro = await erroDe(() => pool.query(MIGRATION()));
    expect(erro).toContain("CRM_LEADS_101_PRECONDITION_FAILED");
    expect(erro).toContain("clients_id_company_unique");

    // E não deixou nada a meio.
    const { rows } = await pool.query(`
      SELECT count(*)::int n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'crm_%'
    `);
    expect(rows[0].n).toBe(0);
  });

  it("sem fn_capture_history (059), recusa antes de criar a tabela", async () => {
    await baseline();
    await pool.query("DROP FUNCTION public.fn_capture_history() CASCADE");

    const erro = await erroDe(() => pool.query(MIGRATION()));
    expect(erro).toContain("CRM_LEADS_101_PRECONDITION_FAILED");
    expect(erro).toContain("fn_capture_history");
  });
});

describe("101 — perder uma lead exige dizer porquê", () => {
  it("🔴 stage='perdido' sem motivo é recusado pela base", async () => {
    const id = await novaLead();
    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_leads SET stage = 'perdido', lost_at = now() WHERE id = $1", [id]),
    );
    expect(erro).toContain("crm_leads_perdida_exige_motivo");
  });

  it("com motivo e data, passa", async () => {
    const id = await novaLead();
    await expect(
      pool.query(
        `UPDATE public.crm_leads SET stage = 'perdido', lost_reason = 'preco', lost_at = now()
          WHERE id = $1`,
        [id],
      ),
    ).resolves.toBeDefined();
  });

  it("um motivo fora da lista não entra — é o que permite contá-los depois", async () => {
    const id = await novaLead();
    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads SET stage = 'perdido', lost_reason = 'porque sim', lost_at = now()
          WHERE id = $1`,
        [id],
      ),
    );
    expect(erro).toContain("crm_leads_lost_reason_check");
  });
});

describe("101 — a conversão só existe depois de ganhar", () => {
  it("🔴 uma lead 'novo' não pode apontar para um cliente", async () => {
    const id = await novaLead();
    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads SET converted_client_id = $2, converted_location_id = $3 WHERE id = $1`,
        [id, CLIENTE_A, LOCAL_A],
      ),
    );
    expect(erro).toContain("crm_leads_conversao_so_se_ganha");
  });

  it("cliente sem local (ou local sem cliente) é uma conversão a meio, e é recusada", async () => {
    const id = await novaLead();
    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads
            SET stage = 'ganho', won_at = now(), converted_client_id = $2
          WHERE id = $1`,
        [id, CLIENTE_A],
      ),
    );
    expect(erro).toContain("crm_leads_conversao_coerente");
  });

  it("ganhar sem data é recusado", async () => {
    const id = await novaLead();
    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_leads SET stage = 'ganho' WHERE id = $1", [id]),
    );
    expect(erro).toContain("crm_leads_ganha_exige_data");
  });

  it("ganho + data + cliente + local da mesma empresa passa", async () => {
    const id = await novaLead();
    await expect(
      pool.query(
        `UPDATE public.crm_leads
            SET stage = 'ganho', won_at = now(),
                converted_client_id = $2, converted_location_id = $3
          WHERE id = $1`,
        [id, CLIENTE_A, LOCAL_A],
      ),
    ).resolves.toBeDefined();
  });
});

describe("101 — isolamento entre empresas, garantido pela base", () => {
  it("🔴 uma lead não pode ser convertida no cliente de outra empresa", async () => {
    const id = await novaLead();
    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads
            SET stage = 'ganho', won_at = now(),
                converted_client_id = $2, converted_location_id = $3
          WHERE id = $1`,
        [id, CLIENTE_B, LOCAL_B],
      ),
    );
    expect(erro).toContain("crm_leads_cliente_mesma_empresa");
  });

  it("🔴 uma interacção não pode pertencer à lead de outra empresa", async () => {
    const leadDaOutra = await novaLead({}, OUTRA);
    const erro = await erroDe(() =>
      pool.query(
        `INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary)
         VALUES ($1, $2, 'nota', 'roubo de contexto')`,
        [EMPRESA, leadDaOutra],
      ),
    );
    expect(erro).toContain("crm_lead_interactions_lead_mesma_empresa");
  });

  it("apagar a lead leva o diário com ela", async () => {
    const id = await novaLead();
    await pool.query(
      `INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary)
       VALUES ($1, $2, 'chamada', 'Primeiro contacto')`,
      [EMPRESA, id],
    );
    await pool.query("DELETE FROM public.crm_leads WHERE id = $1", [id]);

    const { rows } = await pool.query("SELECT count(*)::int n FROM public.crm_lead_interactions");
    expect(rows[0].n).toBe(0);
  });
});

describe("101 — o que a base exige de uma lead", () => {
  it("um nome em branco não é um nome", async () => {
    const erro = await erroDe(() => novaLead({ name: "   " }));
    expect(erro).toContain("crm_leads_name_nao_vazio");
  });

  it("valor estimado negativo é recusado", async () => {
    const erro = await erroDe(() => novaLead({ estimated_value: -1 }));
    expect(erro).toContain("crm_leads_estimated_value_check");
  });

  it("a natureza do valor tem de ser dita, e por omissão é mensal", async () => {
    const id = await novaLead({ estimated_value: 300 });
    const { rows } = await pool.query(
      "SELECT estimated_value_kind FROM public.crm_leads WHERE id = $1",
      [id],
    );
    // 300 € pontuais e 300 €/mês não são o mesmo número; o campo nunca é nulo.
    expect(rows[0].estimated_value_kind).toBe("mensal");
  });

  it("uma lead nasce em 'novo'", async () => {
    const id = await novaLead();
    const { rows } = await pool.query("SELECT stage, board_order FROM public.crm_leads WHERE id = $1", [id]);
    expect(rows[0].stage).toBe("novo");
    expect(rows[0].board_order).toBe(0);
  });

  it("updated_at acompanha a edição", async () => {
    const id = await novaLead();
    const antes = (await pool.query("SELECT updated_at FROM public.crm_leads WHERE id = $1", [id]))
      .rows[0].updated_at;
    await pool.query("UPDATE public.crm_leads SET notes = 'nota' WHERE id = $1", [id]);
    const depois = (await pool.query("SELECT updated_at FROM public.crm_leads WHERE id = $1", [id]))
      .rows[0].updated_at;
    expect(depois.getTime()).toBeGreaterThanOrEqual(antes.getTime());
  });

  it("a edição fica registada no histórico", async () => {
    const id = await novaLead();
    await pool.query("UPDATE public.crm_leads SET notes = 'combinou visita' WHERE id = $1", [id]);

    const { rows } = await pool.query(
      "SELECT op FROM public.data_history WHERE table_name = 'crm_leads' AND row_id = $1",
      [id],
    );
    expect(rows.map((r) => r.op)).toContain("UPDATE");
  });
});

describe("101 — quem pode ler e quem pode escrever", () => {
  /** Corre `sql` como um papel, com a identidade que as policies consultam. */
  async function como(
    papel: "anon" | "authenticated",
    identidade: { company: string; role: string } | null,
    sql: string,
    params: unknown[] = [],
  ) {
    const c = new pg.Client({ ...container.connection });
    await c.connect();
    try {
      await c.query(`SET ROLE ${papel}`);
      if (identidade) {
        await c.query("SELECT set_config('teste.company', $1, false)", [identidade.company]);
        await c.query("SELECT set_config('teste.role', $1, false)", [identidade.role]);
      }
      return await c.query(sql, params);
    } finally {
      await c.end();
    }
  }

  it("gestor da empresa lê as leads da sua empresa", async () => {
    await novaLead();
    const r = await como("authenticated", { company: EMPRESA, role: "gestor" },
      "SELECT count(*)::int n FROM public.crm_leads");
    expect(r.rows[0].n).toBe(1);
  });

  it("🔴 gestor de outra empresa não vê nada", async () => {
    await novaLead();
    const r = await como("authenticated", { company: OUTRA, role: "gestor" },
      "SELECT count(*)::int n FROM public.crm_leads");
    expect(r.rows[0].n).toBe(0);
  });

  it("🔴 colaboradora não vê o funil comercial", async () => {
    await novaLead();
    const r = await como("authenticated", { company: EMPRESA, role: "colaborador" },
      "SELECT count(*)::int n FROM public.crm_leads");
    expect(r.rows[0].n).toBe(0);
  });

  it("🔴 authenticated não escreve — nem sequer o gestor da própria empresa", async () => {
    const erro = await erroDe(() =>
      como("authenticated", { company: EMPRESA, role: "gestor" },
        "INSERT INTO public.crm_leads (company_id, name) VALUES ($1, 'Pelo browser')", [EMPRESA]),
    );
    expect(erro).toMatch(/permission denied|row-level security/i);
  });

  it("🔴 anon não lê nada", async () => {
    await novaLead();
    const erro = await erroDe(() => como("anon", null, "SELECT * FROM public.crm_leads"));
    expect(erro).toMatch(/permission denied/i);
  });
});
