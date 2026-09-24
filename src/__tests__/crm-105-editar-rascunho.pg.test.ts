// ============================================================================
// 105 — editar um rascunho in place, contra Postgres real
// ============================================================================
//
// 🔴 O palco é a cadeia como está EM PRODUÇÃO hoje:
//
//        baseline canónico + 101 + 101a + 101b + 102 + 103 + 103a + 104  →  105
//
//    A 104 entrou no ledger a 23/09. A 105 depende de toda a cadeia: edita o
//    documento da 103, e a 104 é a próxima a lê-lo.
//
// ---------------------------------------------------------------------------
// O que só Postgres real responde
// ---------------------------------------------------------------------------
//
//   · que uma falha DEPOIS do DELETE devolve as linhas antigas intactas — a
//     prova central desta unidade, e a única razão de isto ser uma RPC;
//   · que uma edição e um envio concorrentes se serializam pelo `FOR UPDATE`,
//     e que quem chega depois revalida em vez de escrever por baixo;
//   · que a ACL nasce fechada apesar do `ALTER DEFAULT PRIVILEGES` do projecto;
//   · que os portões de proveniência distinguem mesmo os quatro estados de
//     (ledger, efeito);
//   · que a aritmética desta RPC dá exactamente o mesmo que a das duas da 103.
//
// Nenhuma destas se prova com mocks.
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import { baselineCompleto } from "./helpers/production-baseline";
import { MIGRATIONS_CRM, migrationCrm } from "./helpers/crm-pg-harness";

const CONTAINER = `crm105-${process.pid}`;
const LENTO = { timeout: 120_000 };

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const GESTORA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GESTORA_OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENTE_A = "c1111111-1111-4111-8111-111111111111";
const CLIENTE_B = "c2222222-2222-4222-8222-222222222222";

const M_101B = "supabase/migrations/101b_identity_reconciliation.sql";
const M_102 = "supabase/migrations/102_crm_visitas_comerciais.sql";
const M_103 = "supabase/migrations/103_crm_orcamentos.sql";
const M_103A = "supabase/migrations/103a_crm_rpc_acl_hardening.sql";
const M_104 = "supabase/migrations/104_crm_conversao_lead.sql";
const M_105 = "supabase/migrations/105_crm_orcamento_editar_rascunho.sql";
const ROLLBACK_105 = "supabase/migrations/rollback/105_crm_orcamento_editar_rascunho.down.sql";

const NOME_102 = "102_crm_visitas_comerciais.sql";
const NOME_103 = "103_crm_orcamentos.sql";
const NOME_103A = "103a_crm_rpc_acl_hardening.sql";
const NOME_104 = "104_crm_conversao_lead.sql";
const NOME_105 = "105_crm_orcamento_editar_rascunho.sql";

/** A assinatura exacta — a mesma string que a migration, o rollback e a ACL usam. */
const ASSINATURA =
  "public.edit_crm_quote_draft(uuid, uuid, uuid, uuid, date, date, text, numeric, boolean, numeric, text, text, text, text, jsonb)";

/** A cadeia que já vive no ledger antes da 102. */
const CADEIA = [
  "101_crm_leads.sql",
  "101a_crm_rpc_acl_hardening.sql",
  "101b_identity_reconciliation.sql",
] as const;

// 🔴 O ano corrente, e não uma constante fixa. `set_crm_quote_status` recusa
//    aceitar um orçamento já expirado, por isso os documentos do palco têm de
//    ser deste ano — com 2026 escrito à mão, esta suite passaria a falhar
//    sozinha a 1 de Janeiro.
const ANO = new Date().getFullYear();

let container: PostgresContainer;
let pool: pg.Pool;
let leadA = "";

const lerSql = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** O `checksumForNewMigration()` do runner: SHA-256 do conteúdo normalizado a LF. */
const checksumLf = (ficheiro: string): string =>
  createHash("sha256")
    .update(lerSql(`supabase/migrations/${ficheiro}`).split("\r\n").join("\n").split("\r").join("\n"))
    .digest("hex");

async function registarNoLedger(nome: string, checksum?: string): Promise<void> {
  await pool.query(
    `INSERT INTO public._migrations (name, checksum) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum`,
    [nome, checksum ?? checksumLf(nome)],
  );
}

/**
 * A cadeia real até à 104. `aplicar105` fecha o palco com a migration em prova.
 *
 * 🔴 A linha de ledger de cada migration entra DEPOIS de ela correr — é o que o
 *    runner faz, e escrever antes daria `LEDGER_WITHOUT_EFFECT` ao portão
 *    seguinte.
 */
async function palco(aplicar105 = true): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS auth CASCADE;");
  await pool.query(baselineCompleto());
  await pool.query("ALTER ROLE service_role BYPASSRLS;");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS clients_id_company_unique ON public.clients (id, company_id);
    ALTER TABLE public.data_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
    CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS TRIGGER AS $upd$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $upd$ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION public.fn_capture_history() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $h$
      BEGIN RETURN COALESCE(NEW, OLD); END; $h$;
  `);
  // 🔴 O default privilege que obriga a 105 a revogar `anon`/`authenticated`
  //    explicitamente. Sem isto no palco, a ACL passaria por acidente.
  await pool.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);

  for (const m of MIGRATIONS_CRM) await pool.query(migrationCrm(m));
  await pool.query(lerSql(M_101B));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const nome of CADEIA) await registarNoLedger(nome);

  await pool.query(lerSql(M_102));
  await registarNoLedger(NOME_102);

  await semear();

  await pool.query(lerSql(M_103));
  await registarNoLedger(NOME_103);
  await pool.query(lerSql(M_103A));
  await registarNoLedger(NOME_103A);
  await pool.query(lerSql(M_104));
  await registarNoLedger(NOME_104);

  if (aplicar105) {
    await pool.query(lerSql(M_105));
    await registarNoLedger(NOME_105);
  }
}

async function semear(): Promise<void> {
  await pool.query("INSERT INTO public.companies (id,name,slug) VALUES ($1,'A','a'),($2,'B','b')",
    [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO public.company_settings (company_id) VALUES ($1),($2)",
    [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO auth.users (id,email) VALUES ($1,'g@a.pt'),($2,'g@b.pt')",
    [GESTORA, GESTORA_OUTRA]);
  await pool.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status, auth_user_id) VALUES
      ($1,$2,'Gestora A','gestor','ativo',$1),
      ($3,$4,'Gestora B','gestor','ativo',$3)`,
    [GESTORA, EMPRESA, GESTORA_OUTRA, OUTRA],
  );
  await pool.query(
    "INSERT INTO public.clients (id,company_id,name) VALUES ($1,$2,'Cliente A'), ($3,$4,'Cliente B')",
    [CLIENTE_A, EMPRESA, CLIENTE_B, OUTRA],
  );
}

async function novaLead(over: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO public.crm_leads (company_id, name, lead_type, email, address, service_type)
     VALUES ($1,$2,'empresa','geral@alfa.pt','Rua da Lead 1, Lisboa','manutencao') RETURNING id`,
    [(over.company_id as string) ?? EMPRESA, (over.name as string) ?? "Condomínio Alfa"],
  );
  return rows[0].id as string;
}

async function novaVisita(destino: { lead?: string; cliente?: string; empresa?: string }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO public.crm_visits (company_id, lead_id, client_id, scheduled_start, scheduled_end, address)
     VALUES ($1,$2,$3, now(), now() + interval '1 hour', 'Rua da Visita 9') RETURNING id`,
    [destino.empresa ?? EMPRESA, destino.lead ?? null, destino.cliente ?? null],
  );
  return rows[0].id as string;
}

type Item = { description: string; quantity: number; unit?: string; unit_price: number };

const ITENS_INICIAIS: Item[] = [
  { description: "Limpeza inicial", quantity: 1, unit: "servico", unit_price: 100 },
];

/** Um orçamento criado pela RPC da 103, que nasce sempre em rascunho. */
async function novoOrcamento(opts: {
  lead?: string; cliente?: string; visita?: string | null; empresa?: string; itens?: Item[];
} = {}): Promise<{ id: string; numero: string }> {
  const empresa = opts.empresa ?? EMPRESA;
  const actor = empresa === EMPRESA ? GESTORA : GESTORA_OUTRA;
  const { rows } = await pool.query(
    `SELECT * FROM public.create_crm_quote_with_items(
       $1,$2,$3,$4,'ORC',$5,$6::date,$7::date,
       'pontual',0,true,23,NULL,NULL,NULL,NULL,NULL,$8,$9::jsonb)`,
    [
      empresa, opts.lead ?? null, opts.cliente ?? null, opts.visita ?? null, ANO,
      `${ANO}-01-15`, `${ANO}-12-31`, actor,
      JSON.stringify(opts.itens ?? ITENS_INICIAIS),
    ],
  );
  return { id: rows[0].quote_id as string, numero: rows[0].quote_number as string };
}

interface Edicao {
  empresa?: string;
  actor?: string;
  visita?: string | null;
  issueDate?: string;
  validUntil?: string;
  pricingKind?: string | null;
  desconto?: number | null;
  aplicaIva?: boolean | null;
  taxaIva?: number | null;
  frequencia?: string | null;
  condicoes?: string | null;
  notas?: string | null;
  notasInternas?: string | null;
  itens?: unknown;
  cliente?: pg.Pool | pg.Client;
}

/** Uma edição nominal; cada campo pode ser substituído. */
async function editar(quoteId: string | null, over: Edicao = {}) {
  const exec = over.cliente ?? pool;
  const { rows } = await exec.query(
    `SELECT * FROM public.edit_crm_quote_draft(
       $1,$2,$3,$4,$5::date,$6::date,$7,$8::numeric,$9::boolean,$10::numeric,$11,$12,$13,$14,$15::jsonb)`,
    [
      over.empresa ?? EMPRESA,
      quoteId,
      over.actor === undefined ? GESTORA : over.actor,
      over.visita ?? null,
      // 🔴 `=== undefined`, e não `??`. Com `??`, um `null` explícito caía no
      //    valor por omissão e os ensaios de data a NULL mediam uma data
      //    válida — passavam a verde sem nunca exercitar o guard.
      over.issueDate === undefined ? `${ANO}-03-01` : over.issueDate,
      over.validUntil === undefined ? `${ANO}-04-01` : over.validUntil,
      over.pricingKind === undefined ? "pontual" : over.pricingKind,
      over.desconto === undefined ? 0 : over.desconto,
      over.aplicaIva === undefined ? true : over.aplicaIva,
      over.taxaIva === undefined ? 23 : over.taxaIva,
      over.frequencia ?? null,
      over.condicoes ?? null,
      over.notas ?? null,
      over.notasInternas ?? null,
      JSON.stringify(
        over.itens === undefined
          ? [{ description: "Limpeza revista", quantity: 2, unit: "hora", unit_price: 50 }]
          : over.itens,
      ),
    ],
  );
  return rows[0] as { quote_id: string; quote_number: string; updated_at: Date };
}

/** O documento inteiro, para comparar antes e depois. */
async function ler(quoteId: string) {
  // 🔴 `::text` nas datas. O driver devolve um `date` como Date de JS à
  //    meia-noite LOCAL; `toISOString()` sobre isso desloca um dia sempre que
  //    Lisboa está à frente de UTC (hora de verão). Pedir o texto ao Postgres
  //    é a única leitura que não depende do fuso do processo.
  const { rows } = await pool.query(
    `SELECT *, issue_date::text AS issue_date_txt, valid_until::text AS valid_until_txt
       FROM public.crm_quotes WHERE id = $1`, [quoteId]);
  const { rows: itens } = await pool.query(
    "SELECT position, description, quantity, unit, unit_price, line_total FROM public.crm_quote_items WHERE quote_id = $1 ORDER BY position",
    [quoteId],
  );
  return { quote: rows[0], itens };
}

async function ligacao(): Promise<pg.Client> {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  return c;
}

async function limpar(): Promise<void> {
  await pool.query("DELETE FROM public.crm_lead_interactions");
  await pool.query("DELETE FROM public.crm_quote_items");
  // 🔴 Sem `UPDATE ... SET superseded_by_id = NULL` antes do DELETE. Limpar o
  //    ponteiro devolveria duas revisões VIVAS à mesma raiz e
  //    `uq_crm_quotes_revisao_viva` recusa-o — e com razão. O DELETE de todas
  //    as linhas numa só instrução chega: `crm_quotes_superseded_fk` é
  //    DEFERRABLE INITIALLY DEFERRED e só verifica no fim da transação.
  await pool.query("DELETE FROM public.crm_quotes");
  await pool.query("DELETE FROM public.crm_visits");
  await pool.query("DELETE FROM public.crm_leads");
  await pool.query("DELETE FROM public.locations");
  await pool.query("DELETE FROM public.clients WHERE id NOT IN ($1,$2)", [CLIENTE_A, CLIENTE_B]);
}

beforeAll(async () => {
  container = await startPostgresContainer({ name: CONTAINER, database: "crm105", memory: "512m" });
  pool = new pg.Pool({ ...container.connection, max: 8 });
  await palco();
}, 240_000);

afterAll(async () => {
  await pool?.end().catch(() => { /* já fechado */ });
  container?.stop();
});

beforeEach(async () => {
  await limpar();
  leadA = await novaLead();
});

// ───────────────────────────────────────────────────────────────────────────
describe("1-6. a identidade do documento sobrevive à edição", () => {
  it("🔴 1-5. mesmo id, número, revisão, raiz e proveniência", LENTO, async () => {
    const { id, numero } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    const r = await editar(id, { notas: "corrigido" });

    expect(r.quote_id).toBe(id);
    expect(r.quote_number).toBe(numero);

    const depois = await ler(id);
    expect(depois.quote.id).toBe(antes.quote.id);
    expect(depois.quote.quote_number).toBe(antes.quote.quote_number);
    expect(depois.quote.quote_year).toBe(antes.quote.quote_year);
    expect(depois.quote.quote_seq).toBe(antes.quote.quote_seq);
    expect(depois.quote.revision).toBe(antes.quote.revision);
    expect(depois.quote.root_quote_id).toBe(antes.quote.root_quote_id);
    expect(depois.quote.source_lead_id).toBe(antes.quote.source_lead_id);
    expect(depois.quote.created_by).toBe(antes.quote.created_by);
    expect(depois.quote.created_at).toEqual(antes.quote.created_at);
    // E continua a ser a revisão viva: não nasceu documento nenhum ao lado.
    expect(depois.quote.superseded_by_id).toBeNull();
    expect(depois.quote.status).toBe("rascunho");
  });

  it("🔴 NÃO cria revisão nem documento novo", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, { notas: "uma" });
    await editar(id, { notas: "duas" });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.crm_quotes");
    expect(rows[0].n).toBe(1);
  });

  it("🔴 6. o destinatário não muda — nem de lead para lead, nem para cliente", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const outraLead = await novaLead({ name: "Beta" });
    const antes = await ler(id);

    await editar(id, { notas: "tentativa" });

    const depois = await ler(id);
    expect(depois.quote.lead_id).toBe(antes.quote.lead_id);
    expect(depois.quote.lead_id).toBe(leadA);
    expect(depois.quote.client_id).toBeNull();
    // A outra lead existe, e continua sem orçamento nenhum.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM public.crm_quotes WHERE lead_id = $1", [outraLead]);
    expect(rows[0].n).toBe(0);
  });

  it("🔴 um orçamento de CLIENTE também mantém o seu destinatário", LENTO, async () => {
    const { id } = await novoOrcamento({ cliente: CLIENTE_A });
    await editar(id, { notas: "x" });

    const { quote } = await ler(id);
    expect(quote.client_id).toBe(CLIENTE_A);
    expect(quote.lead_id).toBeNull();
    // Nasceu de um cliente: nunca houve lead, e a proveniência fica NULL.
    expect(quote.source_lead_id).toBeNull();
  });

  it("🔴 a RPC não menciona as colunas de identidade no UPDATE", LENTO, async () => {
    // A lista de colunas do UPDATE É o mecanismo da imutabilidade. Este ensaio
    // lê o corpo instalado na base, e não o ficheiro: é o que lá está a correr.
    const { rows } = await pool.query(
      "SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)", [ASSINATURA]);
    const corpo = String(rows[0].prosrc);
    const update = corpo.slice(corpo.indexOf("UPDATE public.crm_quotes"), corpo.indexOf("DELETE FROM"));

    for (const proibida of [
      "quote_number", "quote_year", "quote_seq", "revision", "root_quote_id",
      "source_lead_id", "lead_id", "client_id", "created_by", "created_at", "status",
    ]) {
      expect(update, `o UPDATE escreve ${proibida}`).not.toMatch(
        new RegExp(`\\b${proibida}\\s*=`),
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("7-8. a visita", () => {
  it("🔴 7. corrige a visita para outra do mesmo destinatário", LENTO, async () => {
    const errada = await novaVisita({ lead: leadA });
    const certa = await novaVisita({ lead: leadA });
    const { id } = await novoOrcamento({ lead: leadA, visita: errada });

    await editar(id, { visita: certa });

    const { quote } = await ler(id);
    expect(quote.visit_id).toBe(certa);
  });

  it("a visita pode ser retirada", LENTO, async () => {
    const v = await novaVisita({ lead: leadA });
    const { id } = await novoOrcamento({ lead: leadA, visita: v });

    await editar(id, { visita: null });

    const { quote } = await ler(id);
    expect(quote.visit_id).toBeNull();
  });

  it("🔴 8. a visita de OUTRA lead é recusada, e nada muda", LENTO, async () => {
    const outraLead = await novaLead({ name: "Beta" });
    const alheia = await novaVisita({ lead: outraLead });
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    await expect(editar(id, { visita: alheia })).rejects.toThrow(/QUOTE_VISIT_MISMATCH/);

    const depois = await ler(id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);
  });

  it("🔴 a visita de um CLIENTE não serve a um orçamento de lead", LENTO, async () => {
    const doCliente = await novaVisita({ cliente: CLIENTE_A });
    const { id } = await novoOrcamento({ lead: leadA });

    await expect(editar(id, { visita: doCliente })).rejects.toThrow(/QUOTE_VISIT_MISMATCH/);
  });

  it("🔴 a visita de outra EMPRESA é recusada", LENTO, async () => {
    const leadB = await novaLead({ company_id: OUTRA, name: "Alheia" });
    const alheia = await novaVisita({ lead: leadB, empresa: OUTRA });
    const { id } = await novoOrcamento({ lead: leadA });

    await expect(editar(id, { visita: alheia })).rejects.toThrow(/QUOTE_VISIT_MISMATCH/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("9-11. as datas", () => {
  it("9. muda o dia dentro do mesmo ano", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });

    await editar(id, { issueDate: `${ANO}-12-31`, validUntil: `${ANO + 1}-01-30` });

    const { quote } = await ler(id);
    expect(quote.issue_date_txt).toBe(`${ANO}-12-31`);
    // 🔴 A VALIDADE pode cair no ano seguinte — é normal um orçamento de
    //    Dezembro valer até Janeiro. O que não pode mudar de ano é a EMISSÃO,
    //    porque é ela que o número representa.
    expect(quote.valid_until_txt).toBe(`${ANO + 1}-01-30`);
  });

  it("🔴 10. mover a emissão para outro ano é recusado", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    await expect(
      editar(id, { issueDate: `${ANO + 1}-01-02`, validUntil: `${ANO + 1}-02-02` }),
    ).rejects.toThrow(/QUOTE_DRAFT_YEAR_IMMUTABLE/);

    const depois = await ler(id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);
  });

  it("🔴 recuar para o ano anterior também é recusado", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await expect(
      editar(id, { issueDate: `${ANO - 1}-12-31`, validUntil: `${ANO}-01-30` }),
    ).rejects.toThrow(/QUOTE_DRAFT_YEAR_IMMUTABLE/);
  });

  it("🔴 emissão a NULL cai no mesmo guard, e não passa em silêncio", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await expect(
      editar(id, { issueDate: null as unknown as string }),
    ).rejects.toThrow(/QUOTE_DRAFT_YEAR_IMMUTABLE/);
  });

  it("🔴 11. validade anterior à emissão é recusada", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await expect(
      editar(id, { issueDate: `${ANO}-03-10`, validUntil: `${ANO}-03-09` }),
    ).rejects.toThrow(/QUOTE_VALIDITY_INVALID/);
  });

  it("🔴 validade a NULL é recusada — e não passa por a comparação dar NULL", LENTO, async () => {
    // Escrito como `NOT (valid_until >= issue_date)`, um NULL daria NULL, o IF
    // não dispararia e a validação passava ao lado. É o ensaio dessa armadilha.
    const { id } = await novoOrcamento({ lead: leadA });
    await expect(
      editar(id, { validUntil: null as unknown as string }),
    ).rejects.toThrow(/QUOTE_VALIDITY_INVALID/);
  });

  it("a mesma data para emissão e validade é aceite", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, { issueDate: `${ANO}-05-05`, validUntil: `${ANO}-05-05` });
    const { quote } = await ler(id);
    expect(quote.valid_until_txt).toBe(`${ANO}-05-05`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("12-15. os totais são recalculados no servidor", () => {
  it("🔴 12-15. subtotal, desconto, IVA e total", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });

    await editar(id, {
      desconto: 10,
      aplicaIva: true,
      taxaIva: 23,
      itens: [
        { description: "Horas", quantity: 10, unit: "hora", unit_price: 12.5 },
        { description: "Material", quantity: 3, unit: "unidade", unit_price: 25 },
      ],
    });

    const { quote, itens } = await ler(id);
    // 10×12,50 = 125,00   3×25 = 75,00   subtotal 200,00
    expect(quote.subtotal).toBe("200.00");
    // base = 200 × 0,90 = 180,00
    // iva  = 180 × 0,23 = 41,40
    expect(quote.vat_amount).toBe("41.40");
    expect(quote.total).toBe("221.40");
    expect(quote.discount_pct).toBe("10.00");
    expect(itens.map((i) => i.line_total)).toEqual(["125.00", "75.00"]);
  });

  it("sem IVA, o total é a base", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, {
      aplicaIva: false, taxaIva: 23, desconto: 0,
      itens: [{ description: "X", quantity: 1, unit: "servico", unit_price: 80 }],
    });

    const { quote } = await ler(id);
    expect(quote.vat_amount).toBe("0.00");
    expect(quote.total).toBe("80.00");
  });

  it("🔴 o line_total vem SEMPRE do servidor, nunca do payload", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, {
      itens: [
        // Um payload que mente: 10 × 50 = 500, mas diz 1.
        { description: "Mentiroso", quantity: 10, unit: "hora", unit_price: 50, line_total: 1 },
      ],
    });

    const { quote, itens } = await ler(id);
    expect(itens[0].line_total).toBe("500.00");
    expect(quote.subtotal).toBe("500.00");
  });

  it("🔴 TOTAL_PARITY: a mesma aritmética das duas RPC da 103", LENTO, async () => {
    // 🔴 O ensaio que justifica a duplicação controlada. Se alguém mexer numa
    //    das três fórmulas, os números deixam de bater e isto fica vermelho.
    const itens = [
      { description: "A", quantity: 3, unit: "hora", unit_price: 33.33 },
      { description: "B", quantity: 7, unit: "m2", unit_price: 1.05 },
    ];
    const desconto = 12.5;
    const iva = 23;

    // (1) criação
    const criado = await novoOrcamento({ lead: leadA, itens });
    await pool.query(
      `UPDATE public.crm_quotes SET discount_pct = $2 WHERE id = $1`, [criado.id, 0]);

    // (2) edição — a RPC em prova
    const editado = await novoOrcamento({ lead: await novaLead({ name: "Par" }) });
    await editar(editado.id, { desconto, taxaIva: iva, itens });
    const viaEdicao = (await ler(editado.id)).quote;

    // (3) revisão — a RPC da 103 sobre um documento enviado
    const paraRever = await novoOrcamento({ lead: await novaLead({ name: "Rev" }) });
    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)",
      [EMPRESA, paraRever.id, GESTORA]);
    const { rows: rev } = await pool.query(
      `SELECT * FROM public.revise_crm_quote($1,$2,$3,$4::date,$5::date,$6::numeric,true,$7::numeric,NULL,$8::jsonb)`,
      [EMPRESA, paraRever.id, GESTORA, `${ANO}-03-01`, `${ANO}-04-01`, desconto, iva,
        JSON.stringify(itens)],
    );
    const viaRevisao = (await ler(rev[0].quote_id as string)).quote;

    expect(viaEdicao.subtotal).toBe(viaRevisao.subtotal);
    expect(viaEdicao.vat_amount).toBe(viaRevisao.vat_amount);
    expect(viaEdicao.total).toBe(viaRevisao.total);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("16-18. as linhas são substituídas por inteiro", () => {
  it("🔴 16-17. substitui o conjunto e renumera as posições", LENTO, async () => {
    const { id } = await novoOrcamento({
      lead: leadA,
      itens: [
        { description: "Velha 1", quantity: 1, unit: "servico", unit_price: 10 },
        { description: "Velha 2", quantity: 1, unit: "servico", unit_price: 20 },
        { description: "Velha 3", quantity: 1, unit: "servico", unit_price: 30 },
      ],
    });

    await editar(id, {
      itens: [
        { description: "Nova A", quantity: 2, unit: "hora", unit_price: 15 },
        { description: "Nova B", quantity: 1, unit: "m2", unit_price: 5 },
      ],
    });

    const { itens } = await ler(id);
    expect(itens.map((i) => i.description)).toEqual(["Nova A", "Nova B"]);
    expect(itens.map((i) => i.position)).toEqual([0, 1]);
    // Nenhuma linha antiga sobreviveu — nem órfã noutro orçamento.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.crm_quote_items");
    expect(rows[0].n).toBe(2);
  });

  it("a ordem do payload é a ordem das posições", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, {
      itens: [
        { description: "Terceira", quantity: 1, unit: "servico", unit_price: 3 },
        { description: "Primeira", quantity: 1, unit: "servico", unit_price: 1 },
        { description: "Segunda", quantity: 1, unit: "servico", unit_price: 2 },
      ],
    });

    const { itens } = await ler(id);
    expect(itens.map((i) => [i.position, i.description])).toEqual([
      [0, "Terceira"], [1, "Primeira"], [2, "Segunda"],
    ]);
  });

  it("🔴 18. zero linhas é recusado, e as antigas ficam", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    await expect(editar(id, { itens: [] })).rejects.toThrow(/QUOTE_ITEMS_REQUIRED/);

    const depois = await ler(id);
    expect(depois.itens).toEqual(antes.itens);
    expect(depois.quote).toEqual(antes.quote);
  });

  it("🔴 linhas a NULL é recusado", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await expect(editar(id, { itens: null })).rejects.toThrow(/QUOTE_ITEMS_REQUIRED/);
  });

  it("acima de 100 linhas é recusado; 100 passa", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const linha = (n: number) => ({ description: `L${n}`, quantity: 1, unit: "servico", unit_price: 1 });

    await expect(
      editar(id, { itens: Array.from({ length: 101 }, (_, i) => linha(i)) }),
    ).rejects.toThrow(/QUOTE_ITEMS_TOO_MANY/);

    await editar(id, { itens: Array.from({ length: 100 }, (_, i) => linha(i)) });
    const { itens } = await ler(id);
    expect(itens).toHaveLength(100);
  });

  const MAUS: Array<{ nome: string; item: Record<string, unknown>; sentinela: RegExp }> = [
    { nome: "descrição vazia", item: { description: "   ", quantity: 1, unit_price: 1 },
      sentinela: /QUOTE_ITEM_DESCRIPTION_REQUIRED/ },
    { nome: "descrição ausente", item: { quantity: 1, unit_price: 1 },
      sentinela: /QUOTE_ITEM_DESCRIPTION_REQUIRED/ },
    { nome: "quantidade zero", item: { description: "X", quantity: 0, unit_price: 1 },
      sentinela: /QUOTE_ITEM_QUANTITY_INVALID/ },
    { nome: "quantidade negativa", item: { description: "X", quantity: -1, unit_price: 1 },
      sentinela: /QUOTE_ITEM_QUANTITY_INVALID/ },
    { nome: "quantidade em texto", item: { description: "X", quantity: "1", unit_price: 1 },
      sentinela: /QUOTE_ITEM_QUANTITY_INVALID/ },
    // 🔴 Chave AUSENTE, e não chave com valor errado. `jsonb_typeof` de uma
    //    chave que não existe devolve NULL, e `NULL <> 'number'` é NULL — o
    //    guard não disparava e a linha seguia para o INSERT. Estes três casos
    //    existem porque a primeira versão falhava aberta neles.
    { nome: "quantidade ausente", item: { description: "X", unit_price: 1 },
      sentinela: /QUOTE_ITEM_QUANTITY_INVALID/ },
    { nome: "quantidade a null em JSON", item: { description: "X", quantity: null, unit_price: 1 },
      sentinela: /QUOTE_ITEM_QUANTITY_INVALID/ },
    { nome: "preço ausente", item: { description: "X", quantity: 1 },
      sentinela: /QUOTE_ITEM_PRICE_INVALID/ },
    { nome: "descrição a null em JSON", item: { description: null, quantity: 1, unit_price: 1 },
      sentinela: /QUOTE_ITEM_DESCRIPTION_REQUIRED/ },
    { nome: "quantidade com 3 casas", item: { description: "X", quantity: 1.555, unit_price: 1 },
      sentinela: /QUOTE_ITEM_QUANTITY_INVALID/ },
    { nome: "preço negativo", item: { description: "X", quantity: 1, unit_price: -0.01 },
      sentinela: /QUOTE_ITEM_PRICE_INVALID/ },
    { nome: "preço em texto", item: { description: "X", quantity: 1, unit_price: "10,50" },
      sentinela: /QUOTE_ITEM_PRICE_INVALID/ },
    { nome: "preço com 3 casas", item: { description: "X", quantity: 1, unit_price: 9.999 },
      sentinela: /QUOTE_ITEM_PRICE_INVALID/ },
    { nome: "unidade fora do domínio", item: { description: "X", quantity: 1, unit: "litro", unit_price: 1 },
      sentinela: /QUOTE_ITEM_UNIT_INVALID/ },
    { nome: "linha que não é objecto", item: { __escalar: true },
      sentinela: /QUOTE_ITEM_SHAPE_INVALID|QUOTE_ITEM_DESCRIPTION_REQUIRED/ },
  ];

  for (const caso of MAUS) {
    it(`🔴 ${caso.nome}: recusa e nada muda`, LENTO, async () => {
      const { id } = await novoOrcamento({ lead: leadA });
      const antes = await ler(id);

      const carga = caso.item.__escalar ? [42] : [caso.item];
      await expect(editar(id, { itens: carga })).rejects.toThrow(caso.sentinela);

      const depois = await ler(id);
      expect(depois.itens).toEqual(antes.itens);
      expect(depois.quote).toEqual(antes.quote);
    });
  }

  it("a unidade em falta cai no default da 103", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, { itens: [{ description: "Sem unidade", quantity: 1, unit_price: 7 }] });
    const { itens } = await ler(id);
    expect(itens[0].unit).toBe("servico");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("19-23. só um rascunho vivo e coerente se edita", () => {
  const ESTADOS: Array<{ nome: string; estado: string }> = [
    { nome: "19. enviado", estado: "enviado" },
    { nome: "20. aceite", estado: "aceite" },
    { nome: "21. anulado", estado: "anulado" },
    { nome: "recusado", estado: "recusado" },
    { nome: "expirado", estado: "expirado" },
  ];

  for (const caso of ESTADOS) {
    it(`🔴 ${caso.nome} → QUOTE_NOT_DRAFT, e ZERO_SIDE_EFFECTS`, LENTO, async () => {
      const { id } = await novoOrcamento({ lead: leadA });
      await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)",
        [EMPRESA, id, GESTORA]);
      if (caso.estado !== "enviado") {
        await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,$4,NULL)",
          [EMPRESA, id, GESTORA, caso.estado]);
      }
      const antes = await ler(id);

      await expect(editar(id, { notas: "não devia entrar" })).rejects.toThrow(/QUOTE_NOT_DRAFT/);

      const depois = await ler(id);
      expect(depois.quote).toEqual(antes.quote);
      expect(depois.itens).toEqual(antes.itens);
    });
  }

  it("🔴 22. um rascunho SUBSTITUÍDO é história → QUOTE_ALREADY_SUPERSEDED", LENTO, async () => {
    // O substituído é verificado ANTES do estado, de propósito: uma revisão
    // histórica não se edita, seja qual for o estado em que ficou congelada.
    const a = await novoOrcamento({ lead: leadA });
    const b = await novoOrcamento({ lead: await novaLead({ name: "Outro doc" }) });
    await pool.query("UPDATE public.crm_quotes SET superseded_by_id = $2 WHERE id = $1",
      [a.id, b.id]);
    const antes = await ler(a.id);

    await expect(editar(a.id, { notas: "x" })).rejects.toThrow(/QUOTE_ALREADY_SUPERSEDED/);

    const depois = await ler(a.id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);
  });

  const DRIFT: Array<{ nome: string; coluna: string; valor: string }> = [
    { nome: "sent_at", coluna: "sent_at", valor: "now()" },
    { nome: "accepted_at", coluna: "accepted_at", valor: "now()" },
    { nome: "rejected_at", coluna: "rejected_at", valor: "now()" },
    { nome: "rejection_reason", coluna: "rejection_reason", valor: "'porque sim'" },
  ];

  for (const caso of DRIFT) {
    it(`🔴 23. rascunho com ${caso.nome} → DIVERGED, e NÃO se repara`, LENTO, async () => {
      const { id } = await novoOrcamento({ lead: leadA });
      await pool.query(
        `UPDATE public.crm_quotes SET ${caso.coluna} = ${caso.valor} WHERE id = $1`, [id]);
      const antes = await ler(id);

      await expect(editar(id, { notas: "x" })).rejects.toThrow(/QUOTE_DRAFT_STATE_DIVERGED/);

      const depois = await ler(id);
      // 🔴 O timestamp divergente CONTINUA LÁ. A RPC não limpa o que não
      //    percebe: apagá-lo destruiria a prova de que algo correu mal.
      expect(depois.quote[caso.coluna]).toEqual(antes.quote[caso.coluna]);
      expect(depois.quote).toEqual(antes.quote);
      expect(depois.itens).toEqual(antes.itens);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
describe("24-25. empresa e actor", () => {
  it("🔴 24. actor de outra empresa → ACTOR_NOT_IN_COMPANY", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    await expect(editar(id, { actor: GESTORA_OUTRA })).rejects.toThrow(/ACTOR_NOT_IN_COMPANY/);

    const depois = await ler(id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);
  });

  it("🔴 actor a NULL também é recusado", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await expect(editar(id, { actor: null as unknown as string }))
      .rejects.toThrow(/ACTOR_NOT_IN_COMPANY/);
  });

  it("🔴 25. orçamento de outra empresa → QUOTE_NOT_FOUND", LENTO, async () => {
    const leadB = await novaLead({ company_id: OUTRA, name: "Alheia" });
    const alheio = await novoOrcamento({ lead: leadB, empresa: OUTRA });
    const antes = await ler(alheio.id);

    // Pedido pela empresa A, com o actor de A: o documento é de B.
    await expect(editar(alheio.id, { empresa: EMPRESA, actor: GESTORA }))
      .rejects.toThrow(/QUOTE_NOT_FOUND/);

    const depois = await ler(alheio.id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);
  });

  it("orçamento inexistente → QUOTE_NOT_FOUND", LENTO, async () => {
    await expect(editar("99999999-9999-4999-8999-999999999999"))
      .rejects.toThrow(/QUOTE_NOT_FOUND/);
  });

  it("id a NULL → QUOTE_NOT_FOUND, e não um erro cru", LENTO, async () => {
    await expect(editar(null)).rejects.toThrow(/QUOTE_NOT_FOUND/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("26-27. concorrência — o FOR UPDATE serializa", () => {
  it("🔴 26. edit vs edit: a segunda espera e a última escrita vence", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const a = await ligacao();
    const b = await ligacao();

    try {
      await a.query("BEGIN");
      await editar(id, {
        cliente: a, notas: "A",
        itens: [
          { description: "A1", quantity: 1, unit: "servico", unit_price: 10 },
          { description: "A2", quantity: 1, unit: "servico", unit_price: 20 },
          { description: "A3", quantity: 1, unit: "servico", unit_price: 30 },
        ],
      });

      // B pede a mesma linha enquanto A ainda não fez commit: fica à espera.
      const pedidoB = editar(id, {
        cliente: b, notas: "B",
        itens: [{ description: "B1", quantity: 1, unit: "servico", unit_price: 99 }],
      });

      let bTerminou = false;
      void pedidoB.then(() => { bTerminou = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(bTerminou, "B não pode ter passado por cima do lock de A").toBe(false);

      await a.query("COMMIT");
      await pedidoB;

      const { quote, itens } = await ler(id);
      expect(quote.notes).toBe("B");
      expect(itens.map((i) => i.description)).toEqual(["B1"]);
      // 🔴 As três linhas de A não sobreviveram ao conjunto de B: a substituição
      //    é integral mesmo quando a edição anterior deixou mais linhas.
      expect(itens).toHaveLength(1);
    } finally {
      await a.query("ROLLBACK").catch(() => { /* já fechada */ });
      await a.end();
      await b.end();
    }
  });

  it("🔴 27. um envio concorrente ESPERA pela edição, e leva-a consigo", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const a = await ligacao();
    const b = await ligacao();

    try {
      await a.query("BEGIN");
      await editar(id, { cliente: a, notas: "editado antes de enviar" });

      const envio = b.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)",
        [EMPRESA, id, GESTORA]);

      let enviou = false;
      void envio.then(() => { enviou = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(enviou, "o envio não pode ignorar o lock da edição").toBe(false);

      await a.query("COMMIT");
      await envio;

      const { quote } = await ler(id);
      expect(quote.status).toBe("enviado");
      expect(quote.notes).toBe("editado antes de enviar");
    } finally {
      await a.query("ROLLBACK").catch(() => { /* já fechada */ });
      await a.end();
      await b.end();
    }
  });

  it("🔴 27-inverso: NENHUMA edição passa por baixo de um envio que ganhou", LENTO, async () => {
    // 🔴 Este é o ensaio que importa. A edição fica à espera do lock, e quando
    //    o recebe RELÊ a linha — já com `status = 'enviado'` — e recusa. Uma
    //    implementação que lesse antes do lock validaria um passado e
    //    escreveria por cima de um documento que já saiu para o cliente.
    const { id } = await novoOrcamento({ lead: leadA });
    const a = await ligacao();
    const b = await ligacao();

    try {
      await b.query("BEGIN");
      await b.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)",
        [EMPRESA, id, GESTORA]);

      const edicao = editar(id, { cliente: a, notas: "tarde demais" });
      const resultado = edicao.then(() => "passou").catch((e: Error) => e.message);

      await new Promise((r) => setTimeout(r, 400));
      await b.query("COMMIT");

      expect(await resultado).toMatch(/QUOTE_NOT_DRAFT/);

      const { quote } = await ler(id);
      expect(quote.status).toBe("enviado");
      expect(quote.notes).toBeNull();
    } finally {
      await b.query("ROLLBACK").catch(() => { /* já fechada */ });
      await a.end();
      await b.end();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("28-29. atomicidade — a prova central desta unidade", () => {
  it("🔴 28. falha DEPOIS do DELETE: as linhas antigas voltam inteiras", LENTO, async () => {
    // 🔴 Este é o ensaio que justifica a RPC existir.
    //
    //    Um trigger que rebenta no INSERT coloca a falha exactamente na janela
    //    perigosa: as linhas antigas JÁ foram apagadas e as novas ainda não
    //    entraram. Se as três operações não estivessem na mesma transação, o
    //    orçamento ficaria sem linhas para sempre.
    const { id } = await novoOrcamento({
      lead: leadA,
      itens: [
        { description: "Original 1", quantity: 2, unit: "hora", unit_price: 40 },
        { description: "Original 2", quantity: 1, unit: "m2", unit_price: 15 },
      ],
    });
    const antes = await ler(id);
    expect(antes.itens).toHaveLength(2);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.rebenta_no_insert() RETURNS trigger
      LANGUAGE plpgsql AS $t$
      BEGIN RAISE EXCEPTION 'SABOTAGEM_NO_INSERT'; END; $t$;
      CREATE TRIGGER sabotagem_items BEFORE INSERT ON public.crm_quote_items
        FOR EACH ROW EXECUTE FUNCTION public.rebenta_no_insert();
    `);

    try {
      await expect(
        editar(id, { itens: [{ description: "Nunca entra", quantity: 1, unit_price: 1 }] }),
      ).rejects.toThrow(/SABOTAGEM_NO_INSERT/);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS sabotagem_items ON public.crm_quote_items");
      await pool.query("DROP FUNCTION IF EXISTS public.rebenta_no_insert()");
    }

    const depois = await ler(id);
    // As linhas antigas, INTEIRAS: descrição, quantidade, unidade, preço, total.
    expect(depois.itens).toEqual(antes.itens);
    // E o cabeçalho também não ficou com os totais novos.
    expect(depois.quote).toEqual(antes.quote);
  });

  it("🔴 nunca existe o estado «cabeçalho novo + zero linhas»", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.rebenta_no_insert() RETURNS trigger
      LANGUAGE plpgsql AS $t$
      BEGIN RAISE EXCEPTION 'SABOTAGEM_NO_INSERT'; END; $t$;
      CREATE TRIGGER sabotagem_items BEFORE INSERT ON public.crm_quote_items
        FOR EACH ROW EXECUTE FUNCTION public.rebenta_no_insert();
    `);
    try {
      await expect(editar(id, { desconto: 50 })).rejects.toThrow(/SABOTAGEM_NO_INSERT/);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS sabotagem_items ON public.crm_quote_items");
      await pool.query("DROP FUNCTION IF EXISTS public.rebenta_no_insert()");
    }

    const depois = await ler(id);
    expect(depois.itens.length).toBeGreaterThan(0);
    expect(depois.quote.discount_pct).toBe(antes.quote.discount_pct);
    expect(depois.quote.total).toBe(antes.quote.total);
  });

  it("🔴 uma linha que desaparece em silêncio é apanhada pela contagem", LENTO, async () => {
    // 🔴 O ensaio da verificação `count(*) = jsonb_array_length(p_items)`.
    //
    //    Um trigger BEFORE INSERT que devolve NULL não rebenta: DESCARTA a
    //    linha, sem erro nenhum. É o caso perigoso — um INSERT que "corre bem"
    //    e grava menos linhas do que lhe pediram. Sem a contagem, o orçamento
    //    ficaria com um total calculado sobre duas linhas e só uma gravada, e
    //    ninguém saberia. Medido por mutação: sem esta verificação, este ensaio
    //    é o único que fica vermelho.
    const { id } = await novoOrcamento({
      lead: leadA,
      itens: [{ description: "Original", quantity: 1, unit: "servico", unit_price: 10 }],
    });
    const antes = await ler(id);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.engole_linha() RETURNS trigger
      LANGUAGE plpgsql AS $t$
      BEGIN
        IF NEW.description = 'FANTASMA' THEN RETURN NULL; END IF;
        RETURN NEW;
      END; $t$;
      CREATE TRIGGER engole_items BEFORE INSERT ON public.crm_quote_items
        FOR EACH ROW EXECUTE FUNCTION public.engole_linha();
    `);

    try {
      await expect(
        editar(id, {
          itens: [
            { description: "Fica", quantity: 1, unit: "servico", unit_price: 5 },
            { description: "FANTASMA", quantity: 1, unit: "servico", unit_price: 5 },
          ],
        }),
      ).rejects.toThrow(/CRM_QUOTE_ITEMS_MISMATCH/);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS engole_items ON public.crm_quote_items");
      await pool.query("DROP FUNCTION IF EXISTS public.engole_linha()");
    }

    // E a transação inteira reverteu: as linhas originais continuam lá.
    const depois = await ler(id);
    expect(depois.itens).toEqual(antes.itens);
    expect(depois.quote).toEqual(antes.quote);
  });

  it("🔴 29. overflow do total: recusa com sentinela, e nada muda", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    await expect(
      editar(id, {
        itens: [
          { description: "Muito", quantity: 99999.99, unit: "unidade", unit_price: 99999.99 },
        ],
      }),
    ).rejects.toThrow(/QUOTE_AMOUNT_OVERFLOW/);

    const depois = await ler(id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);
  });

  it("🔴 overflow pela SOMA de linhas que isoladamente cabem", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    await expect(
      editar(id, {
        itens: [
          { description: "Metade", quantity: 1, unit: "servico", unit_price: 60000000 },
          { description: "Outra", quantity: 1, unit: "servico", unit_price: 60000000 },
        ],
      }),
    ).rejects.toThrow(/QUOTE_AMOUNT_OVERFLOW/);

    const depois = await ler(id);
    expect(depois.itens).toEqual(antes.itens);
  });

  it("o maior valor que cabe continua a passar", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, {
      aplicaIva: false, taxaIva: 0, desconto: 0,
      itens: [{ description: "Limite", quantity: 1, unit: "servico", unit_price: 99999999.99 }],
    });
    const { quote } = await ler(id);
    expect(quote.total).toBe("99999999.99");
  });

  it("🔴 o cabeçalho de preço inválido é recusado antes de qualquer escrita", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    const antes = await ler(id);

    const casos: Array<[Edicao, RegExp]> = [
      [{ pricingKind: "semanal" }, /QUOTE_PRICING_KIND_INVALID/],
      [{ pricingKind: null }, /QUOTE_PRICING_KIND_INVALID/],
      [{ desconto: 101 }, /QUOTE_DISCOUNT_INVALID/],
      [{ desconto: -1 }, /QUOTE_DISCOUNT_INVALID/],
      [{ desconto: null }, /QUOTE_DISCOUNT_INVALID/],
      [{ aplicaIva: null }, /QUOTE_APPLY_VAT_REQUIRED/],
      [{ taxaIva: null }, /QUOTE_VAT_RATE_INVALID/],
      [{ taxaIva: 101 }, /QUOTE_VAT_RATE_INVALID/],
    ];

    for (const [over, sentinela] of casos) {
      await expect(editar(id, over), JSON.stringify(over)).rejects.toThrow(sentinela);
    }

    const depois = await ler(id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("30-32. segurança da RPC — canónica desde o primeiro dia", () => {
  it("🔴 30. ACL: só o owner e service_role, sem WITH GRANT OPTION", LENTO, async () => {
    const { rows } = await pool.query(
      `SELECT array_agg(DISTINCT acl.grantee::regrole::text ORDER BY acl.grantee::regrole::text) AS grantees,
              bool_or(acl.is_grantable) AS grantable,
              (SELECT p2.proowner::regrole::text FROM pg_proc p2 WHERE p2.oid = p.oid) AS owner
         FROM pg_proc p,
              LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE p.oid = to_regprocedure($1)
          AND acl.privilege_type = 'EXECUTE'
        GROUP BY p.oid`,
      [ASSINATURA],
    );

    expect(rows[0].grantees.slice().sort()).toEqual([rows[0].owner, "service_role"].sort());
    expect(rows[0].grantable).toBe(false);
    expect(rows[0].grantees).not.toContain("anon");
    expect(rows[0].grantees).not.toContain("authenticated");
    expect(rows[0].grantees).not.toContain("public");
  });

  it("🔴 anon e authenticated NÃO executam", LENTO, async () => {
    for (const papel of ["anon", "authenticated"]) {
      const c = await ligacao();
      try {
        await c.query(`SET ROLE ${papel}`);
        await expect(
          c.query(`SELECT public.edit_crm_quote_draft(
            $1,$2,$3,NULL,$4::date,$5::date,'pontual',0,true,23,NULL,NULL,NULL,NULL,'[]'::jsonb)`,
          [EMPRESA, "99999999-9999-4999-8999-999999999999", GESTORA,
            `${ANO}-03-01`, `${ANO}-04-01`]),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await c.end();
      }
    }
  });

  it("🔴 31-32. SECURITY INVOKER e search_path exacto", LENTO, async () => {
    const { rows } = await pool.query(
      "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = to_regprocedure($1)", [ASSINATURA]);
    expect(rows[0].prosecdef).toBe(false);
    expect(rows[0].proconfig).toEqual(["search_path=pg_catalog, public"]);
  });

  const SABOTAGENS = [
    {
      nome: "SECURITY DEFINER",
      patch: (sql: string) => sql.replace(
        /SECURITY INVOKER\nSET search_path/,
        "SECURITY DEFINER\nSET search_path"),
      erro: /SECURITY DEFINER/,
    },
    {
      nome: "search_path alargado",
      patch: (sql: string) => sql.replace(
        "SET search_path = pg_catalog, public",
        "SET search_path = pg_catalog, public, pg_temp"),
      erro: /search_path/,
    },
    {
      nome: "sem o REVOKE de anon/authenticated",
      patch: (sql: string) => sql.replace(
        /REVOKE ALL ON FUNCTION public\.edit_crm_quote_draft[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        "-- revoke removido pela sabotagem"),
      erro: /grantees de EXECUTE/,
    },
    {
      nome: "GRANT a mais para authenticated",
      patch: (sql: string) => sql.replace(
        /GRANT EXECUTE ON FUNCTION public\.edit_crm_quote_draft([\s\S]*?)TO service_role;/,
        "GRANT EXECUTE ON FUNCTION public.edit_crm_quote_draft$1TO service_role, authenticated;"),
      erro: /grantees de EXECUTE/,
    },
  ];

  for (const s of SABOTAGENS) {
    it(`🔴 ${s.nome}: a migration FALHA FECHADA`, LENTO, async () => {
      await palco(false);
      const sabotada = s.patch(lerSql(M_105));
      expect(sabotada, "a sabotagem não alterou o SQL").not.toBe(lerSql(M_105));

      await expect(pool.query(sabotada)).rejects.toThrow(s.erro);

      // E a função NÃO fica instalada: a migration inteira reverte.
      const { rows } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
      expect(rows[0].f).toBeNull();

      await palco();
      leadA = await novaLead();
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
describe("33. proveniência e efeito exclusivo", () => {
  it("🔴 JA_APLICADA: não corre duas vezes", LENTO, async () => {
    await expect(pool.query(lerSql(M_105))).rejects.toThrow(/CRM_EDIT_105_JA_APLICADA/);
  });

  it("🔴 EFFECT_WITHOUT_LEDGER: a RPC existe sem linha de ledger", LENTO, async () => {
    await pool.query("DELETE FROM public._migrations WHERE name = $1", [NOME_105]);
    await expect(pool.query(lerSql(M_105)))
      .rejects.toThrow(/CRM_EDIT_105_EFFECT_WITHOUT_LEDGER/);
    await registarNoLedger(NOME_105);
  });

  it("🔴 LEDGER_WITHOUT_EFFECT: a linha existe e a RPC não", LENTO, async () => {
    await pool.query(`DROP FUNCTION IF EXISTS ${ASSINATURA}`);
    await expect(pool.query(lerSql(M_105)))
      .rejects.toThrow(/CRM_EDIT_105_LEDGER_WITHOUT_EFFECT/);
    await palco();
    leadA = await novaLead();
  });

  it("🔴 ledger ausente + efeito ausente → APLICA", LENTO, async () => {
    await palco(false);
    const { rows: antes } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
    expect(antes[0].f).toBeNull();

    await pool.query(lerSql(M_105));

    const { rows } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
    expect(rows[0].f).not.toBeNull();
    await registarNoLedger(NOME_105);
    leadA = await novaLead();
  });

  it("🔴 falta a linha de ledger da 104 → DEPENDENCY_LEDGER_MISSING", LENTO, async () => {
    await palco(false);
    await pool.query("DELETE FROM public._migrations WHERE name = $1", [NOME_104]);

    await expect(pool.query(lerSql(M_105)))
      .rejects.toThrow(/CRM_EDIT_105_DEPENDENCY_LEDGER_MISSING/);

    const { rows } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
    expect(rows[0].f, "nada pode ter sido criado").toBeNull();

    await palco();
    leadA = await novaLead();
  });

  it("🔴 checksum da 103 divergente → DEPENDENCY_CHECKSUM_DIVERGED", LENTO, async () => {
    await palco(false);
    await pool.query("UPDATE public._migrations SET checksum = $2 WHERE name = $1",
      [NOME_103, "0".repeat(64)]);

    await expect(pool.query(lerSql(M_105)))
      .rejects.toThrow(/CRM_EDIT_105_DEPENDENCY_CHECKSUM_DIVERGED/);

    const { rows } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
    expect(rows[0].f).toBeNull();

    await palco();
    leadA = await novaLead();
  });

  it("🔴 uma RPC da cadeia em falta → PRECONDITION_FAILED", LENTO, async () => {
    await palco(false);
    await pool.query("DROP FUNCTION public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)");

    await expect(pool.query(lerSql(M_105)))
      .rejects.toThrow(/CRM_EDIT_105_PRECONDITION_FAILED/);

    await palco();
    leadA = await novaLead();
  });

  it("🔴 sem o trigger de imutabilidade da 103 → PRECONDITION_FAILED", LENTO, async () => {
    await palco(false);
    await pool.query("DROP TRIGGER crm_quotes_proveniencia_imutavel ON public.crm_quotes");

    await expect(pool.query(lerSql(M_105)))
      .rejects.toThrow(/crm_quotes_proveniencia_imutavel/);

    await palco();
    leadA = await novaLead();
  });

  it("os checksums fixados na 105 são os dos ficheiros do repositório", LENTO, async () => {
    // 🔴 Se uma migration da cadeia for editada sem alguém actualizar o valor
    //    aqui, a 105 passaria a recusar-se a instalar em produção — e o erro
    //    apareceria no apply, não no CI. Este ensaio traz isso para a frente.
    const sql = lerSql(M_105);
    const fixados = [...sql.matchAll(/\('(\d{3}[a-z]?_[a-z_]+\.sql)',\s*'([0-9a-f]{64})'\)/g)];
    expect(fixados.length).toBe(7);

    for (const [, ficheiro, checksum] of fixados) {
      expect(checksum, `checksum fixado de ${ficheiro}`).toBe(checksumLf(ficheiro));
    }
  });

  it("🔴 a 105 é a última migration numerada desta unidade", LENTO, async () => {
    const { readdirSync } = await import("node:fs");
    const maiores = readdirSync(join(process.cwd(), "supabase/migrations"))
      .filter((m) => /^\d{3}[a-z]?_/.test(m))
      .filter((m) => Number(m.slice(0, 3)) > 105);
    expect(maiores).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("34-36. rollback", () => {
  it("o checksum fixado no rollback é o da 105 deste repositório", LENTO, async () => {
    const down = lerSql(ROLLBACK_105);
    const m = down.match(/CHECKSUM_105 CONSTANT text := '([0-9a-f]{64})'/);
    expect(m, "o rollback tem de fixar o checksum").not.toBeNull();
    expect(m![1]).toBe(checksumLf(NOME_105));
  });

  it("🔴 34. rollback estrutural: remove a RPC e NÃO toca nos orçamentos", LENTO, async () => {
    const { id } = await novoOrcamento({ lead: leadA });
    await editar(id, { notas: "editado antes do rollback" });
    const antes = await ler(id);

    await pool.query(lerSql(ROLLBACK_105));

    const { rows } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
    expect(rows[0].f).toBeNull();
    const { rows: led } = await pool.query(
      "SELECT count(*)::int AS n FROM public._migrations WHERE name = $1", [NOME_105]);
    expect(led[0].n).toBe(0);

    // 🔴 O documento editado FICA como estava. O rollback é estrutural.
    const depois = await ler(id);
    expect(depois.quote).toEqual(antes.quote);
    expect(depois.itens).toEqual(antes.itens);

    // As três RPC da 103 e a da 104 não foram tocadas.
    for (const f of [
      "public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)",
      "public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)",
      "public.set_crm_quote_status(uuid, uuid, uuid, text, text)",
      "public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)",
    ]) {
      const { rows: r } = await pool.query("SELECT to_regprocedure($1) AS f", [f]);
      expect(r[0].f, `${f} foi removida`).not.toBeNull();
    }

    await palco();
    leadA = await novaLead();
  });

  it("🔴 35. ledger sem efeito: FAIL CLOSED, e a linha não é apagada", LENTO, async () => {
    await pool.query(`DROP FUNCTION IF EXISTS ${ASSINATURA}`);

    await expect(pool.query(lerSql(ROLLBACK_105)))
      .rejects.toThrow(/CRM_EDIT_105_ROLLBACK_LEDGER_WITHOUT_EFFECT/);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM public._migrations WHERE name = $1", [NOME_105]);
    expect(rows[0].n, "a linha de ledger não pode ser apagada num estado que não se percebe").toBe(1);

    await palco();
    leadA = await novaLead();
  });

  it("🔴 efeito sem ledger: ALIENADO, e a RPC não é removida", LENTO, async () => {
    await pool.query("DELETE FROM public._migrations WHERE name = $1", [NOME_105]);

    await expect(pool.query(lerSql(ROLLBACK_105)))
      .rejects.toThrow(/CRM_EDIT_105_ROLLBACK_ALIENADO/);

    const { rows } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
    expect(rows[0].f, "uma função que não é desta migration não se remove").not.toBeNull();

    await registarNoLedger(NOME_105);
  });

  it("🔴 36. checksum divergente: nada é removido", LENTO, async () => {
    await pool.query("UPDATE public._migrations SET checksum = $2 WHERE name = $1",
      [NOME_105, "f".repeat(64)]);

    await expect(pool.query(lerSql(ROLLBACK_105)))
      .rejects.toThrow(/CRM_EDIT_105_ROLLBACK_CHECKSUM_DIVERGENTE/);

    const { rows } = await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA]);
    expect(rows[0].f).not.toBeNull();
    const { rows: led } = await pool.query(
      "SELECT count(*)::int AS n FROM public._migrations WHERE name = $1", [NOME_105]);
    expect(led[0].n).toBe(1);

    await registarNoLedger(NOME_105);
  });

  it("rollback sem ledger e sem efeitos é no-op", LENTO, async () => {
    await palco(false);
    await expect(pool.query(lerSql(ROLLBACK_105))).resolves.toBeDefined();
    await palco();
    leadA = await novaLead();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("37. a sequência inteira, como o runner a correria", () => {
  it("🔴 clean install 101→104 → 105 → rollback → 105 outra vez", LENTO, async () => {
    await palco(false);

    // 1. A 105 instala-se sobre a cadeia real.
    await pool.query(lerSql(M_105));
    await registarNoLedger(NOME_105);

    // 2. E funciona: uma edição completa, de ponta a ponta.
    const lead = await novaLead({ name: "Sequência" });
    const { id, numero } = await novoOrcamento({ lead });
    const r = await editar(id, {
      notas: "ciclo completo",
      itens: [{ description: "Única", quantity: 4, unit: "hora", unit_price: 25 }],
    });
    expect(r.quote_number).toBe(numero);
    expect((await ler(id)).quote.total).toBe("123.00"); // 100 + 23% IVA

    // 3. O rollback desfaz a estrutura e deixa o documento.
    await pool.query(lerSql(ROLLBACK_105));
    expect((await pool.query("SELECT to_regprocedure($1) AS f", [ASSINATURA])).rows[0].f).toBeNull();
    expect((await ler(id)).quote.notes).toBe("ciclo completo");

    // 4. E volta a instalar-se sobre o estado que o rollback deixou.
    await pool.query(lerSql(M_105));
    await registarNoLedger(NOME_105);
    await editar(id, { notas: "segunda volta" });
    expect((await ler(id)).quote.notes).toBe("segunda volta");

    await palco();
    leadA = await novaLead();
  });
});
