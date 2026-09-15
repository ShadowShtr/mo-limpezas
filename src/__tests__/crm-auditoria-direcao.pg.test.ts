// ============================================================================
// CRM — as provas pedidas na auditoria de direção (2026-09-15)
// ============================================================================
//
// As outras suites cobrem cada migration. Esta cobre, contra um Postgres a
// sério, os invariantes que a direção nomeou e que ainda NÃO estavam provados:
//
//   · revisão de orçamento em CONCORRÊNCIA (as anteriores provavam sequencial);
//   · ausência de estado parcial de revisão em erro;
//   · IVA fail-closed também na base, e não só na Server Action;
//   · retenção: o que acontece a leads com visitas, orçamentos e histórico;
//   · transições inválidas de lead e ausência de audit duplicado em retry.
//
// 🔴 Nenhum destes testes toca em produção. Sobem um container descartável.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `crmaudit-${process.pid}`;

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;

const sql = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ITENS = JSON.stringify([
  { description: "Limpeza", quantity: 10, unit: "hora", unit_price: 12 },
]);

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
    -- A de produção (059) escreve mesmo; aqui também, para o teste de retenção
    -- poder provar que o histórico sobrevive ao DELETE.
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

  for (const m of [
    "101_crm_leads",
    "102_crm_visitas_comerciais",
    "103_crm_orcamentos",
    "104_crm_conversao_lead",
  ]) {
    await pool.query(sql(`supabase/migrations/${m}.sql`));
  }
}

async function novaLead(nome = "Lead"): Promise<string> {
  const { rows } = await pool.query(
    "INSERT INTO public.crm_leads (company_id, name) VALUES ($1, $2) RETURNING id",
    [EMPRESA, nome],
  );
  return rows[0].id as string;
}

async function criarOrcamento(
  leadId: string,
  taxa: number | null = 23,
  client: pg.Client | pg.Pool = pool,
) {
  const { rows } = await client.query(
    `SELECT * FROM public.create_crm_quote_with_items(
       $1, $2, NULL, NULL, 'ORC', 2026, current_date, '2030-12-31',
       'pontual', 0, true, $3, NULL, NULL, NULL, NULL, NULL, $4, $5::jsonb)`,
    [EMPRESA, leadId, taxa, ACTOR, ITENS],
  );
  return { id: rows[0].quote_id as string, numero: rows[0].quote_number as string };
}

const enviar = (id: string) =>
  pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)", [EMPRESA, id, ACTOR]);

const rever = (id: string, client: pg.Client | pg.Pool = pool) =>
  client.query(
    `SELECT * FROM public.revise_crm_quote($1,$2,$3,current_date,'2030-12-31',0,true,23,NULL,$4::jsonb)`,
    [EMPRESA, id, ACTOR, ITENS],
  );

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
    database: "crmaudit",
    serverFlags: ["shared_buffers=16MB", "max_connections=30", "work_mem=1MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 10 });
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

// ═══════════════════════════════════════════════════════════════════════════
// 5 — NUMERAÇÃO SOB CONCORRÊNCIA
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 5 — numeração: DUPLICATE_BASE_NUMBERS = 0", () => {
  it("8 sessões em simultâneo produzem 8 números distintos e contíguos", async () => {
    const leads = await Promise.all(Array.from({ length: 8 }, (_, i) => novaLead(`L${i}`)));

    const clientes = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const c = new pg.Client({ ...container.connection });
        await c.connect();
        return c;
      }),
    );

    try {
      const resultados = await Promise.all(
        leads.map((leadId, i) => criarOrcamento(leadId, 23, clientes[i])),
      );

      const numeros = resultados.map((r) => r.numero).sort();
      expect(new Set(numeros).size, "DUPLICATE_BASE_NUMBERS deve ser 0").toBe(8);
      expect(numeros).toEqual([
        "ORC2026/001", "ORC2026/002", "ORC2026/003", "ORC2026/004",
        "ORC2026/005", "ORC2026/006", "ORC2026/007", "ORC2026/008",
      ]);
    } finally {
      await Promise.all(clientes.map((c) => c.end()));
    }
  });

  it("não há buracos nem repetições na sequência gravada", async () => {
    const leads = await Promise.all(Array.from({ length: 6 }, (_, i) => novaLead(`L${i}`)));
    await Promise.all(leads.map((l) => criarOrcamento(l)));

    const { rows } = await pool.query(`
      SELECT array_agg(quote_seq ORDER BY quote_seq) seqs,
             count(*)::int total,
             count(DISTINCT quote_seq)::int distintos
        FROM public.crm_quotes WHERE company_id = $1
    `, [EMPRESA]);

    expect(rows[0].total).toBe(6);
    expect(rows[0].distintos).toBe(6);
    expect(rows[0].seqs).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 + 7 — REVISÃO SOB CONCORRÊNCIA
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 7 — revisão concorrente: uma só vence", () => {
  it("duas revisões em simultâneo do mesmo orçamento: uma passa, a outra levanta", async () => {
    const q = await criarOrcamento(await novaLead());
    await enviar(q.id);

    const c1 = new pg.Client({ ...container.connection });
    const c2 = new pg.Client({ ...container.connection });
    await c1.connect();
    await c2.connect();

    try {
      const r = await Promise.allSettled([rever(q.id, c1), rever(q.id, c2)]);

      const ok = r.filter((x) => x.status === "fulfilled");
      const falhou = r.filter((x) => x.status === "rejected");

      expect(ok, "exactamente uma revisão devia passar").toHaveLength(1);
      expect(falhou).toHaveLength(1);
    } finally {
      await c1.end();
      await c2.end();
    }

    // TWO_LIVE_REVISIONS = 0
    const { rows } = await pool.query(`
      SELECT count(*)::int vivas FROM public.crm_quotes
       WHERE company_id = $1 AND root_quote_id = $2 AND superseded_by_id IS NULL
    `, [EMPRESA, q.id]);
    expect(rows[0].vivas, "TWO_LIVE_REVISIONS").toBe(1);
  });

  it("🔴 PARTIAL_REVISION_STATE = 0: a transação toda, ou nada", async () => {
    const q = await criarOrcamento(await novaLead());
    await enviar(q.id);

    // Uma revisão com linhas inválidas (quantidade negativa viola o CHECK)
    // tem de deixar tudo como estava: nem revisão nova, nem a antiga marcada.
    const erro = await erroDe(() =>
      pool.query(
        `SELECT * FROM public.revise_crm_quote($1,$2,$3,current_date,'2030-12-31',0,true,23,NULL,$4::jsonb)`,
        [EMPRESA, q.id, ACTOR, JSON.stringify([{ description: "X", quantity: -5, unit: "hora", unit_price: 10 }])],
      ),
    );
    expect(erro).toBeTruthy();

    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM public.crm_quotes WHERE company_id = $1",
      [EMPRESA],
    );
    expect(rows[0].n, "não pode ter nascido uma revisão").toBe(1);

    const { rows: antiga } = await pool.query(
      "SELECT status, superseded_by_id FROM public.crm_quotes WHERE id = $1",
      [q.id],
    );
    // OLD_INACTIVE + NEW_MISSING é o estado proibido: a antiga não pode ter
    // ficado marcada como substituída por uma revisão que não existe.
    expect(antiga[0].superseded_by_id, "OLD_INACTIVE + NEW_MISSING").toBeNull();
    expect(antiga[0].status).toBe("enviado");
  });

  it("uma revisão nunca reutiliza o número de outro documento", async () => {
    const q1 = await criarOrcamento(await novaLead("A"));
    await enviar(q1.id);
    await rever(q1.id);
    const q2 = await criarOrcamento(await novaLead("B"));

    const { rows } = await pool.query(`
      SELECT count(*)::int total, count(DISTINCT quote_number)::int distintos
        FROM public.crm_quotes WHERE company_id = $1
    `, [EMPRESA]);

    expect(rows[0].total, "DUPLICATE_REVISION_NUMBERS").toBe(rows[0].distintos);
    expect(q2.numero).toBe("ORC2026/002");
  });

  it("documentos enviados não são reescritos nem apagados por uma revisão", async () => {
    const q = await criarOrcamento(await novaLead());
    await enviar(q.id);
    const antes = (await pool.query(
      "SELECT total, subtotal, sent_at, status, quote_number FROM public.crm_quotes WHERE id = $1", [q.id],
    )).rows[0];

    await rever(q.id);

    const depois = (await pool.query(
      "SELECT total, subtotal, sent_at, status, quote_number FROM public.crm_quotes WHERE id = $1", [q.id],
    )).rows[0];

    expect(depois.total).toEqual(antes.total);
    expect(depois.subtotal).toEqual(antes.subtotal);
    expect(depois.sent_at).toEqual(antes.sent_at);
    expect(depois.status).toBe("enviado");
    expect(depois.quote_number).toBe(antes.quote_number);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — IVA FAIL-CLOSED
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 6 — IVA: fail-closed também na base", () => {
  it("uma taxa nula não grava um orçamento com imposto inventado", async () => {
    // A Server Action recusa antes de chegar aqui (não lê config → não emite).
    // Esta é a segunda linha de defesa: `vat_rate` é NOT NULL, por isso nem
    // sequer existe a hipótese de gravar 0 ou 23 por omissão.
    const leadId = await novaLead();
    const erro = await erroDe(() => criarOrcamento(leadId, null));
    expect(erro).toMatch(/null value in column "vat_rate"|not-null/i);

    const { rows } = await pool.query("SELECT count(*)::int n FROM public.crm_quotes");
    expect(rows[0].n, "nenhum documento pode ter nascido").toBe(0);
  });

  it("a taxa fica snapshotada: mudar as configurações não altera documentos emitidos", async () => {
    const q = await criarOrcamento(await novaLead(), 23);
    const antes = (await pool.query(
      "SELECT vat_rate, vat_amount, total FROM public.crm_quotes WHERE id = $1", [q.id],
    )).rows[0];

    // O IVA da empresa muda amanhã.
    await pool.query("UPDATE public.company_settings SET vat_rate = 6 WHERE company_id = $1", [EMPRESA]);

    const depois = (await pool.query(
      "SELECT vat_rate, vat_amount, total FROM public.crm_quotes WHERE id = $1", [q.id],
    )).rows[0];

    expect(Number(depois.vat_rate), "a taxa do documento não pode mudar").toBe(Number(antes.vat_rate));
    expect(Number(depois.total)).toBe(Number(antes.total));
    expect(Number(depois.vat_rate)).toBe(23);
  });

  it("subtotal, IVA e total são coerentes entre si no que ficou gravado", async () => {
    const q = await criarOrcamento(await novaLead(), 23);
    const { rows } = await pool.query(
      "SELECT subtotal, discount_pct, vat_amount, total FROM public.crm_quotes WHERE id = $1", [q.id],
    );
    const r = rows[0];
    const base = Number(r.subtotal) * (1 - Number(r.discount_pct) / 100);
    expect(Number(r.total)).toBeCloseTo(base + Number(r.vat_amount), 2);
  });

  it("a soma das linhas é o subtotal", async () => {
    const q = await criarOrcamento(await novaLead(), 23);
    const { rows } = await pool.query(`
      SELECT (SELECT sum(line_total) FROM public.crm_quote_items WHERE quote_id = $1) soma,
             (SELECT subtotal FROM public.crm_quotes WHERE id = $1) subtotal
    `, [q.id]);
    expect(Number(rows[0].soma)).toBe(Number(rows[0].subtotal));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — ESTADOS DA LEAD
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 11 — leads: transições e integridade", () => {
  it("os seis estados são exactamente os esperados", async () => {
    const { rows } = await pool.query(`
      SELECT pg_get_constraintdef(oid) d FROM pg_constraint
       WHERE conname = 'crm_leads_stage_check'
    `);
    for (const s of ["novo", "contactado", "visita_agendada", "orcamento_enviado", "ganho", "perdido"]) {
      expect(rows[0].d).toContain(`'${s}'`);
    }
  });

  it("um estado inventado é recusado pela base", async () => {
    const id = await novaLead();
    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_leads SET stage = 'negociacao' WHERE id = $1", [id]),
    );
    expect(erro).toContain("crm_leads_stage_check");
  });

  it("documenta o comportamento real do histórico num UPDATE repetido", async () => {
    // 🔴 Medido, não assumido — e o resultado NÃO é o intuitivo.
    //
    // `fn_capture_history` (059) só regista quando `to_jsonb(OLD)` difere de
    // `to_jsonb(NEW)`. Mas `update_updated_at` (001) corre ANTES e mexe em
    // `updated_at` — por isso as linhas diferem SEMPRE, e um UPDATE repetido
    // com os mesmos valores de negócio gera na mesma uma linha de histórico.
    //
    // Isto é herdado do padrão do projeto e vale para todas as tabelas com os
    // dois triggers (clients, locations, contracts, …). O CRM não o introduz
    // nem o agrava; fica registado para a direção saber que `data_history`
    // conta UPDATEs, não mudanças de negócio.
    //
    // A protecção contra audit duplicado está no caminho da aplicação, não
    // aqui — ver o teste seguinte.
    const id = await novaLead();
    await pool.query("UPDATE public.crm_leads SET stage = 'contactado' WHERE id = $1", [id]);
    const n1 = (await pool.query(
      "SELECT count(*)::int n FROM public.data_history WHERE row_id = $1", [id])).rows[0].n;

    await pool.query("UPDATE public.crm_leads SET stage = 'contactado' WHERE id = $1", [id]);
    const n2 = (await pool.query(
      "SELECT count(*)::int n FROM public.data_history WHERE row_id = $1", [id])).rows[0].n;

    expect(n1).toBe(1);
    expect(n2, "um UPDATE repetido gera histórico por causa de updated_at").toBe(2);
  });

  it("🔴 a action não repete a escrita quando o estado não muda", async () => {
    // É esta a guarda real contra audit duplicado em retry: `moveLeadStage`
    // sai cedo se o destino for igual à origem, sem UPDATE, sem interacção de
    // sistema e sem `auditLog`.
    const src = readFileSync(join(ROOT, "src/app/actions/crm-leads.ts"), "utf8");
    const corpo = src.slice(src.indexOf("export async function moveLeadStage"));
    const saidaCedo = corpo.indexOf("if (origem === destino) return actionSuccess");
    const primeiraEscrita = corpo.indexOf(".update(");

    expect(saidaCedo, "a saída antecipada tem de existir").toBeGreaterThan(-1);
    expect(saidaCedo, "e tem de vir ANTES de qualquer escrita").toBeLessThan(primeiraEscrita);
  });

  it("🔴 a RPC de estado do orçamento também sai cedo em retry", async () => {
    const q = await criarOrcamento(await novaLead());
    await enviar(q.id);
    const antes = (await pool.query(
      "SELECT count(*)::int n FROM public.data_history WHERE row_id = $1", [q.id])).rows[0].n;

    // Repetir 'enviado' não reescreve: `IF v_atual.status = p_status THEN RETURN`.
    await enviar(q.id);
    const depois = (await pool.query(
      "SELECT count(*)::int n FROM public.data_history WHERE row_id = $1", [q.id])).rows[0].n;

    expect(depois, "a RPC não pode reescrever em retry").toBe(antes);
  });

  it("a interação de sistema da conversão é escrita na mesma transação da mudança", async () => {
    // STATUS_CHANGED = YES + CONTACT_LOG_ENTRY = MISSING é o estado proibido.
    const leadId = await novaLead();
    const { rows: cli } = await pool.query(
      "INSERT INTO public.clients (company_id, name) VALUES ($1, 'C') RETURNING id", [EMPRESA]);
    const { rows: loc } = await pool.query(
      "INSERT INTO public.locations (company_id, client_id, name, address) VALUES ($1,$2,'L','R') RETURNING id",
      [EMPRESA, cli[0].id]);

    await pool.query("SELECT public.link_crm_lead_conversion($1,$2,$3,$4,NULL,$5)",
      [EMPRESA, leadId, cli[0].id, loc[0].id, ACTOR]);

    const lead = (await pool.query("SELECT stage FROM public.crm_leads WHERE id = $1", [leadId])).rows[0];
    const inter = (await pool.query(
      "SELECT count(*)::int n FROM public.crm_lead_interactions WHERE lead_id = $1 AND kind = 'sistema'",
      [leadId])).rows[0];

    expect(lead.stage).toBe("ganho");
    expect(inter.n, "CONTACT_LOG_ENTRY não pode faltar").toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15 — RETENÇÃO E HARD DELETE
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 15 — retenção: NO_HISTORY_LOSS", () => {
  it("arquivar uma lead não apaga nada", async () => {
    const id = await novaLead();
    await pool.query("UPDATE public.crm_leads SET archived_at = now() WHERE id = $1", [id]);

    const { rows } = await pool.query("SELECT count(*)::int n FROM public.crm_leads WHERE id = $1", [id]);
    expect(rows[0].n, "arquivar é soft — a linha fica").toBe(1);
  });

  it("uma lead convertida não pode ser apagada sem que o cliente saia primeiro", async () => {
    // `converted_client_id` é RESTRICT contra `clients`: apagar o cliente é
    // que fica bloqueado, protegendo a história comercial.
    const leadId = await novaLead();
    const { rows: cli } = await pool.query(
      "INSERT INTO public.clients (company_id, name) VALUES ($1, 'C') RETURNING id", [EMPRESA]);
    const { rows: loc } = await pool.query(
      "INSERT INTO public.locations (company_id, client_id, name, address) VALUES ($1,$2,'L','R') RETURNING id",
      [EMPRESA, cli[0].id]);
    await pool.query("SELECT public.link_crm_lead_conversion($1,$2,$3,$4,NULL,$5)",
      [EMPRESA, leadId, cli[0].id, loc[0].id, ACTOR]);

    const erro = await erroDe(() => pool.query("DELETE FROM public.clients WHERE id = $1", [cli[0].id]));
    expect(erro, "o cliente de uma lead convertida está protegido").toMatch(
      /crm_leads_cliente_mesma_empresa|violates foreign key/i,
    );
  });

  it("apagar uma lead leva visitas, orçamentos e linhas — e deixa rasto no histórico", async () => {
    const leadId = await novaLead();
    await pool.query(
      `INSERT INTO public.crm_visits (company_id, lead_id, scheduled_start, scheduled_end)
       VALUES ($1,$2,'2026-10-01 10:00+01','2026-10-01 11:00+01')`, [EMPRESA, leadId]);
    const q = await criarOrcamento(leadId);
    await enviar(q.id);

    await pool.query("DELETE FROM public.crm_leads WHERE id = $1", [leadId]);

    for (const t of ["crm_visits", "crm_quotes", "crm_quote_items", "crm_lead_interactions"]) {
      const { rows } = await pool.query(`SELECT count(*)::int n FROM public.${t}`);
      expect(rows[0].n, `${t} devia ter sido levada em cascata`).toBe(0);
    }

    // 🔴 O histórico sobrevive: é o que permite reconstruir o que se apagou.
    const { rows: h } = await pool.query(
      "SELECT count(*)::int n FROM public.data_history WHERE table_name = 'crm_leads' AND op = 'DELETE'");
    expect(h[0].n, "NO_HISTORY_LOSS").toBeGreaterThan(0);
  });

  it("inventário: que DELETEs em cascata existem, e para onde apontam", async () => {
    const { rows } = await pool.query(`
      SELECT rel.relname AS tabela, con.conname, con.confdeltype
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname = 'public' AND rel.relname LIKE 'crm%' AND con.contype = 'f'
       ORDER BY rel.relname, con.conname
    `);

    // 'c' = CASCADE, 'r' = RESTRICT, 'n' = SET NULL, 'a' = NO ACTION.
    const porTipo = (t: string) => rows.filter((r) => r.confdeltype === t).map((r) => r.conname);

    // As entidades de HISTÓRICO comercial (cliente convertido) são RESTRICT.
    expect(porTipo("r")).toContain("crm_leads_cliente_mesma_empresa");
    expect(porTipo("r")).toContain("crm_visits_cliente_mesma_empresa");
    expect(porTipo("r")).toContain("crm_quotes_cliente_mesma_empresa");

    // Os FILHOS de uma lead são CASCADE — não fazem sentido sem ela.
    expect(porTipo("c")).toContain("crm_lead_interactions_lead_mesma_empresa");
    expect(porTipo("c")).toContain("crm_visits_lead_mesma_empresa");
    expect(porTipo("c")).toContain("crm_quotes_lead_mesma_empresa");
    expect(porTipo("c")).toContain("crm_quote_items_quote_mesma_empresa");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — CONVERSÃO: SEM ESTADO PARCIAL
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 8 — conversão: NO_PARTIAL_STATE", () => {
  it("cliente e local andam sempre juntos — o CHECK impede meia conversão", async () => {
    const id = await novaLead();
    const { rows: cli } = await pool.query(
      "INSERT INTO public.clients (company_id, name) VALUES ($1, 'C') RETURNING id", [EMPRESA]);

    const erro = await erroDe(() =>
      pool.query(
        "UPDATE public.crm_leads SET stage='ganho', won_at=now(), converted_client_id=$2 WHERE id=$1",
        [id, cli[0].id],
      ),
    );
    expect(erro).toContain("crm_leads_conversao_coerente");
  });

  it("uma conversão falhada a meio não deixa a lead ganha sem cliente", async () => {
    const id = await novaLead();
    // Um local de outra árvore (cliente diferente) faz a FK composta recusar;
    // a transação inteira é revertida.
    const erro = await erroDe(() =>
      pool.query("SELECT public.link_crm_lead_conversion($1,$2,$3,$4,NULL,$5)",
        [EMPRESA, id, "99999999-9999-4999-8999-999999999999", "88888888-8888-4888-8888-888888888888", ACTOR]),
    );
    expect(erro).toBeTruthy();

    const lead = (await pool.query("SELECT stage, converted_client_id FROM public.crm_leads WHERE id=$1", [id])).rows[0];
    expect(lead.stage, "a lead não pode ter ficado ganha").toBe("novo");
    expect(lead.converted_client_id).toBeNull();
  });
});
