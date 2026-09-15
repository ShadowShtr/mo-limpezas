// ============================================================================
// CRM — o número no ecrã e o número na base têm de ser o mesmo
// ============================================================================
//
// Há dois caminhos que calculam o total de um orçamento:
//
//   · `computeQuoteTotals` (src/domain/crm/quote-totals.ts), para a interface
//     mostrar o total enquanto se escreve;
//   · `create_crm_quote_with_items` (migration 103), que é a autoridade — é o
//     que fica gravado.
//
// Se divergirem, o utilizador vê um valor antes de gravar e outro depois, e
// deixa de confiar no ecrã. Um teste que só exercitasse a função pura não
// apanharia isso: os dois estão certos cada um por si, e errados em conjunto.
//
// Esta suite corre os MESMOS casos nos DOIS caminhos e compara cêntimo a
// cêntimo. É a única forma de provar que a duplicação é segura.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

import { computeQuoteTotals } from "@/domain/crm/quote-totals";
import { CASOS } from "./crm-quote-totals.test";

const ROOT = process.cwd();
const CONTAINER = `crmparity-${process.pid}`;

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;

const sql = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "crmparity",
    serverFlags: ["shared_buffers=16MB", "max_connections=20", "work_mem=1MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });

  await pool.query(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      full_name text NOT NULL, role text NOT NULL DEFAULT 'gestor'
    );
    CREATE TABLE public.clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE, name text NOT NULL
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

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A')", [EMPRESA]);
  await pool.query(
    "INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')",
    [ACTOR, EMPRESA],
  );
  await pool.query("INSERT INTO public.company_settings (company_id) VALUES ($1)", [EMPRESA]);

  await pool.query(sql("supabase/migrations/101_crm_leads.sql"));
  await pool.query(sql("supabase/migrations/102_crm_visitas_comerciais.sql"));
  await pool.query(sql("supabase/migrations/103_crm_orcamentos.sql"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

/** Cria o orçamento pela RPC e devolve o que ficou gravado. */
async function pelaRpc(caso: (typeof CASOS)[number]) {
  const { rows: lead } = await pool.query(
    "INSERT INTO public.crm_leads (company_id, name) VALUES ($1, 'Lead') RETURNING id",
    [EMPRESA],
  );

  const itens = JSON.stringify(
    caso.linhas.map((l) => ({
      description: "Linha",
      quantity: l.quantity,
      unit: "servico",
      unit_price: l.unitPrice,
    })),
  );

  const { rows } = await pool.query(
    `SELECT * FROM public.create_crm_quote_with_items(
       $1, $2, NULL, NULL, 'ORC', 2026, current_date, '2030-12-31',
       'pontual', $3, $4, $5, NULL, NULL, NULL, NULL, NULL, $6, $7::jsonb)`,
    [EMPRESA, lead[0].id, caso.discountPct, caso.applyVat, caso.vatRatePct, ACTOR, itens],
  );

  const { rows: q } = await pool.query(
    "SELECT subtotal, vat_amount, total FROM public.crm_quotes WHERE id = $1",
    [rows[0].quote_id],
  );

  return {
    subtotal: Number(q[0].subtotal),
    vatAmount: Number(q[0].vat_amount),
    total: Number(q[0].total),
  };
}

describe("🔴 paridade: o total mostrado e o total gravado", () => {
  for (const caso of CASOS) {
    it(caso.nome, async () => {
      const naBase = await pelaRpc(caso);
      const noEcra = computeQuoteTotals(caso.linhas, {
        discountPct: caso.discountPct,
        applyVat: caso.applyVat,
        vatRatePct: caso.vatRatePct,
      });

      expect(naBase.subtotal, "subtotal").toBe(noEcra.subtotal);
      expect(naBase.vatAmount, "IVA").toBe(noEcra.vatAmount);
      expect(naBase.total, "total").toBe(noEcra.total);
    });
  }

  it("e o valor gravado é o que o caso previa — os dois certos, não os dois errados", async () => {
    // Sem esta verificação, a paridade provaria apenas que ambos os caminhos
    // concordam — mesmo que concordassem no valor errado.
    for (const caso of CASOS) {
      const naBase = await pelaRpc(caso);
      expect(naBase.total, caso.nome).toBe(caso.esperado.total);
    }
  });
});
