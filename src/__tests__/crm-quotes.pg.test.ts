// ============================================================================
// 103 — orçamentos: numeração, revisões e estados, contra um Postgres a sério
// ============================================================================
//
// A suite existe sobretudo por causa de UM defeito, que é o mais provável de
// todo o módulo e o mais silencioso:
//
//   copiar o `regexp_match(numero, '/(\d+)$')` das facturas faria com que,
//   depois de existir uma revisão `ORC2026/001-R1`, o próximo orçamento
//   voltasse a ser o 001 — porque o regexp não casa e o MAX devolve NULL.
//
// O teste «depois de rever, o número seguinte é 002» é a razão de este
// ficheiro existir. Tudo o resto é o que se costuma provar.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import {
  EMPRESA,
  OUTRA,
  ACTOR,
  ACTOR_OUTRA,
  CLIENTE_A,
  comoUtilizador,
  montarPalcoCrm,
} from "./helpers/crm-pg-harness";

const ROOT = process.cwd();
const CONTAINER = `crmquotes-${process.pid}`;


let container: PostgresContainer;
let pool: pg.Pool;

const sql = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ITENS = JSON.stringify([
  { description: "Limpeza de manutenção", quantity: 20, unit: "hora", unit_price: 12 },
  { description: "Vidros exteriores", quantity: 1, unit: "servico", unit_price: 80 },
]);

/**
 * O palco: a forma REAL do schema de produção + as migrations do CRM.
 *
 * 🔴 A versão anterior escrevia aqui um baseline à mão, com 7 tabelas. Provava
 *    coisas verdadeiras sobre um mundo que não é o nosso — sem as FKs reais,
 *    sem as políticas reais, sem os grants reais, e com `service_role` sem
 *    BYPASSRLS (o que fazia uma recusa passar pela razão errada).
 *
 *    Ver `helpers/crm-pg-harness.ts` para o porquê e para o que o fixture não
 *    traz.
 */
async function baseline(opts: { aplicarCrm?: boolean } = {}) {
  await montarPalcoCrm(pool, opts);
}

async function novaLead(empresa = EMPRESA): Promise<string> {
  const { rows } = await pool.query(
    "INSERT INTO public.crm_leads (company_id, name) VALUES ($1, 'Condomínio Teste') RETURNING id",
    [empresa],
  );
  return rows[0].id as string;
}

/** Cria um orçamento pela RPC e devolve `{ id, numero }`. */
async function criar(opts: {
  leadId?: string | null;
  clientId?: string | null;
  ano?: number;
  empresa?: string;
  itens?: string;
  validoAte?: string;
  descontoPct?: number;
  comIva?: boolean;
  client?: pg.Client | pg.Pool;
} = {}) {
  const c = opts.client ?? pool;
  const empresa = opts.empresa ?? EMPRESA;
  const leadId = opts.leadId === undefined ? await novaLead(empresa) : opts.leadId;
  // 🔴 O autor tem de ser da MESMA empresa do orçamento: a FK composta
  //    `crm_quotes_created_by_mesma_empresa` recusa o contrário. Foi
  //    exactamente o que aconteceu quando este palco passou a ser o real.
  const actor = empresa === EMPRESA ? ACTOR : ACTOR_OUTRA;

  const { rows } = await c.query(
    `SELECT * FROM public.create_crm_quote_with_items(
       $1, $2, $3, NULL, 'ORC', $4, current_date, $5,
       'pontual', $6, $7, 23, NULL, NULL, NULL, NULL, NULL, $8, $9::jsonb)`,
    [
      empresa,
      leadId,
      opts.clientId ?? null,
      opts.ano ?? 2026,
      opts.validoAte ?? "2030-12-31",
      opts.descontoPct ?? 0,
      opts.comIva ?? true,
      actor,
      opts.itens ?? ITENS,
    ],
  );
  return { id: rows[0].quote_id as string, numero: rows[0].quote_number as string };
}

async function erroDe(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const estadoDe = async (id: string) =>
  (await pool.query("SELECT * FROM public.crm_quotes WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "crmquotes",
    serverFlags: ["shared_buffers=16MB", "max_connections=25", "work_mem=1MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 6 });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

beforeEach(async () => {
  await baseline();
});

describe("103 — a migration", () => {
  it("corre, e correr duas vezes não parte nada", async () => {
    await expect(pool.query(sql("supabase/migrations/103_crm_orcamentos.sql"))).resolves.toBeDefined();
  });

  it("sem a 101, recusa-se a correr", async () => {
    await pool.query("DROP TABLE public.crm_quote_items, public.crm_quotes, public.crm_visits, public.crm_lead_interactions, public.crm_leads CASCADE");
    const erro = await erroDe(() => pool.query(sql("supabase/migrations/103_crm_orcamentos.sql")));
    expect(erro).toContain("CRM_QUOTES_103_PRECONDITION_FAILED");
  });

  it("acrescenta o prefixo dos orçamentos às configurações, sem tocar no das faturas", async () => {
    const { rows } = await pool.query(
      "SELECT quote_prefix, invoice_prefix FROM public.company_settings WHERE company_id = $1",
      [EMPRESA],
    );
    expect(rows[0].quote_prefix).toBe("ORC");
    expect(rows[0].invoice_prefix).toBe("F");
  });
});

describe("103 — a numeração", () => {
  it("começa no 001 e anda de um em um", async () => {
    expect((await criar()).numero).toBe("ORC2026/001");
    expect((await criar()).numero).toBe("ORC2026/002");
    expect((await criar()).numero).toBe("ORC2026/003");
  });

  it("🔴 depois de rever, o número seguinte é 002 — e não outra vez 001", async () => {
    // ESTE é o teste que justifica a coluna `quote_seq`.
    //
    // Com o `regexp_match(numero, '/(\d+)$')` das facturas, o 'ORC2026/001-R1'
    // não casaria, o MAX daria NULL, o COALESCE daria 0, e este orçamento
    // sairia como 001 — colidindo com um documento já enviado a um cliente.
    const primeiro = await criar();
    expect(primeiro.numero).toBe("ORC2026/001");

    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)", [EMPRESA, primeiro.id, ACTOR]);
    const revisto = await pool.query(
      `SELECT * FROM public.revise_crm_quote($1,$2,$3,current_date,'2030-12-31',0,true,23,NULL,$4::jsonb)`,
      [EMPRESA, primeiro.id, ACTOR, ITENS],
    );
    expect(revisto.rows[0].quote_number).toBe("ORC2026/001-R1");

    const seguinte = await criar();
    expect(seguinte.numero).toBe("ORC2026/002");
  });

  it("cada empresa tem a sua sequência", async () => {
    expect((await criar({ empresa: EMPRESA })).numero).toBe("ORC2026/001");
    expect((await criar({ empresa: OUTRA })).numero).toBe("ORC2026/001");
    expect((await criar({ empresa: EMPRESA })).numero).toBe("ORC2026/002");
  });

  it("o ano novo recomeça no 001", async () => {
    expect((await criar({ ano: 2026 })).numero).toBe("ORC2026/001");
    expect((await criar({ ano: 2027 })).numero).toBe("ORC2027/001");
    expect((await criar({ ano: 2026 })).numero).toBe("ORC2026/002");
  });

  it("🔴 sessões em simultâneo não geram o mesmo número", async () => {
    // O advisory lock por empresa+ano é o que serializa isto. Sem ele, duas
    // sessões leriam o mesmo MAX e produziriam dois 001.
    const leads = await Promise.all([novaLead(), novaLead(), novaLead(), novaLead(), novaLead()]);

    const resultados = await Promise.all(
      leads.map((leadId) => criar({ leadId })),
    );

    const numeros = resultados.map((r) => r.numero).sort();
    expect(new Set(numeros).size).toBe(5);
    expect(numeros).toEqual([
      "ORC2026/001", "ORC2026/002", "ORC2026/003", "ORC2026/004", "ORC2026/005",
    ]);
  });
});

describe("103 — os totais são calculados no servidor", () => {
  it("soma as linhas, aplica desconto e IVA", async () => {
    // 20 × 12 = 240 ; 1 × 80 = 80 ; subtotal 320
    const { id } = await criar();
    const q = await estadoDe(id);
    expect(Number(q.subtotal)).toBe(320);
    expect(Number(q.vat_amount)).toBe(73.6);   // 320 × 23%
    expect(Number(q.total)).toBe(393.6);
  });

  it("o desconto entra antes do IVA", async () => {
    const { id } = await criar({ descontoPct: 10 });
    const q = await estadoDe(id);
    expect(Number(q.subtotal)).toBe(320);       // o subtotal é sempre o bruto
    expect(Number(q.vat_amount)).toBe(66.24);   // 288 × 23%
    expect(Number(q.total)).toBe(354.24);       // 288 + 66,24
  });

  it("sem IVA, o total é a base", async () => {
    const { id } = await criar({ comIva: false });
    const q = await estadoDe(id);
    expect(Number(q.vat_amount)).toBe(0);
    expect(Number(q.total)).toBe(320);
  });

  it("🔴 o total de linha nunca vem do cliente", async () => {
    // Uma linha com `line_total` mentiroso no payload é ignorada: o servidor
    // recalcula 10 × 50.
    const { id } = await criar({
      itens: JSON.stringify([
        { description: "Mentira", quantity: 10, unit: "hora", unit_price: 50, line_total: 1 },
      ]),
    });
    const { rows } = await pool.query("SELECT line_total FROM public.crm_quote_items WHERE quote_id = $1", [id]);
    expect(Number(rows[0].line_total)).toBe(500);
  });

  it("um orçamento sem linhas é recusado", async () => {
    const erro = await erroDe(() => criar({ itens: "[]" }));
    expect(erro).toContain("sem linhas");
  });

  it("as linhas entram todas, e pela ordem dada", async () => {
    const { id } = await criar();
    const { rows } = await pool.query(
      "SELECT position, description FROM public.crm_quote_items WHERE quote_id = $1 ORDER BY position",
      [id],
    );
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[0].description).toBe("Limpeza de manutenção");
  });
});

describe("103 — as revisões", () => {
  async function enviado() {
    const q = await criar();
    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)", [EMPRESA, q.id, ACTOR]);
    return q;
  }

  const rever = (id: string) =>
    pool.query(
      `SELECT * FROM public.revise_crm_quote($1,$2,$3,current_date,'2030-12-31',0,true,23,NULL,$4::jsonb)`,
      [EMPRESA, id, ACTOR, ITENS],
    );

  it("rever um enviado cria R1, em rascunho, com o mesmo sequencial", async () => {
    const q = await enviado();
    const { rows } = await rever(q.id);
    const nova = await estadoDe(rows[0].quote_id);

    expect(nova.quote_number).toBe("ORC2026/001-R1");
    expect(nova.revision).toBe(1);
    expect(nova.quote_seq).toBe(1);
    expect(nova.status).toBe("rascunho");
    expect(nova.sent_at).toBeNull();
  });

  it("🔴 a revisão anterior MANTÉM o seu estado — foi enviada, e isso é história", async () => {
    const q = await enviado();
    await rever(q.id);
    const antiga = await estadoDe(q.id);

    expect(antiga.status).toBe("enviado");
    expect(antiga.sent_at).not.toBeNull();
    expect(antiga.superseded_by_id).not.toBeNull();
  });

  it("a cadeia toda partilha a mesma raiz, e o sufixo não se acumula", async () => {
    const q = await enviado();
    const r1 = await rever(q.id);
    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)", [EMPRESA, r1.rows[0].quote_id, ACTOR]);
    const r2 = await rever(r1.rows[0].quote_id);

    expect(r2.rows[0].quote_number).toBe("ORC2026/001-R2");  // e não '-R1-R2'

    const { rows } = await pool.query(
      "SELECT root_quote_id FROM public.crm_quotes WHERE company_id = $1",
      [EMPRESA],
    );
    expect(new Set(rows.map((r) => r.root_quote_id)).size).toBe(1);
  });

  it("🔴 um orçamento ACEITE é imutável", async () => {
    const q = await enviado();
    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'aceite',NULL)", [EMPRESA, q.id, ACTOR]);

    const erro = await erroDe(() => rever(q.id));
    expect(erro).toContain("QUOTE_ACCEPTED_IMMUTABLE");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 🔴 SUPERSEDED — uma revisão substituída é histórico, e histórico não muda
  // ═════════════════════════════════════════════════════════════════════════
  //
  // `revise_crm_quote` já preenchia `superseded_by_id` na antiga e preservava o
  // estado dela. O que faltava era impedir operações NOVAS sobre esse
  // documento: `set_crm_quote_status` não olhava para `superseded_by_id`, e por
  // isso a sequência abaixo era possível.
  //
  //   R0 enviada → cria-se R1 → R0 fica superseded, ainda 'enviado'
  //              → alguém marca R0 como 'aceite'
  //              → R0 volta a circular e pode até dar origem à conversão
  //
  // A revisão antiga continua LEGÍVEL como história. O que não pode é voltar a
  // participar em nada.

  it("🔴 SUPERSEDED_STATUS_CHANGE = REJECTED", async () => {
    const q = await enviado();
    await rever(q.id);

    const antes = await estadoDe(q.id);
    const erro = await erroDe(() =>
      pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'recusado','mudou de ideias')",
        [EMPRESA, q.id, ACTOR]),
    );

    expect(erro).toContain("QUOTE_ALREADY_SUPERSEDED");

    // ZERO_SIDE_EFFECTS: nem o estado, nem as datas, nem o motivo.
    const depois = await estadoDe(q.id);
    expect(depois.status).toBe(antes.status);
    expect(depois.rejected_at).toBeNull();
    expect(depois.rejection_reason).toBeNull();
  });

  it("🔴 SUPERSEDED_ACCEPT = REJECTED — é este que alimentava a conversão", async () => {
    const q = await enviado();
    await rever(q.id);

    const erro = await erroDe(() =>
      pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'aceite',NULL)",
        [EMPRESA, q.id, ACTOR]),
    );

    expect(erro).toContain("QUOTE_ALREADY_SUPERSEDED");
    const depois = await estadoDe(q.id);
    expect(depois.status, "ZERO_SIDE_EFFECTS").toBe("enviado");
    expect(depois.accepted_at).toBeNull();
  });

  it("a revisão antiga continua LEGÍVEL como histórico — não se apaga nem reescreve", async () => {
    const q = await enviado();
    const r1 = await rever(q.id);
    const antiga = await estadoDe(q.id);

    expect(antiga, "a linha continua lá").toBeDefined();
    expect(antiga.status, "com o estado que teve").toBe("enviado");
    expect(antiga.sent_at, "e a data em que o teve").not.toBeNull();
    expect(antiga.superseded_by_id).toBe(r1.rows[0].quote_id);
  });

  it("a revisão VIVA continua a aceitar operações — o guarda não fecha a porta toda", async () => {
    const q = await enviado();
    const r1 = await rever(q.id);

    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)",
      [EMPRESA, r1.rows[0].quote_id, ACTOR]);
    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'aceite',NULL)",
      [EMPRESA, r1.rows[0].quote_id, ACTOR]);

    expect((await estadoDe(r1.rows[0].quote_id)).status).toBe("aceite");
  });

  it("um rascunho não se revê — edita-se em cima", async () => {
    const q = await criar();
    const erro = await erroDe(() => rever(q.id));
    expect(erro).toContain("QUOTE_DRAFT_EDIT_IN_PLACE");
  });

  it("uma revisão já substituída não se revê outra vez", async () => {
    const q = await enviado();
    await rever(q.id);
    const erro = await erroDe(() => rever(q.id));
    expect(erro).toContain("QUOTE_ALREADY_SUPERSEDED");
  });

  it("🔴 só há uma revisão viva por documento", async () => {
    const q = await enviado();
    await rever(q.id);

    // Forçar uma segunda viva pelo caminho de baixo tem de bater no índice
    // parcial — é ele que impede duas versões vivas do mesmo orçamento.
    const erro = await erroDe(() =>
      pool.query(
        `INSERT INTO public.crm_quotes (
           company_id, lead_id, quote_number, quote_year, quote_seq, revision, root_quote_id,
           issue_date, valid_until, subtotal, vat_rate, vat_amount, total)
         SELECT company_id, lead_id, 'ORC2026/001-R9', quote_year, quote_seq, 9, root_quote_id,
                current_date, '2030-12-31', 0, 23, 0, 0
           FROM public.crm_quotes WHERE id = $1`,
        [q.id],
      ),
    );
    expect(erro).toMatch(/uq_crm_quotes_revisao_viva|duplicate key/i);
  });

  it("rever não consome número: a numeração conta documentos, não versões", async () => {
    const q = await enviado();
    await rever(q.id);
    const { rows } = await pool.query(
      "SELECT DISTINCT quote_seq FROM public.crm_quotes WHERE company_id = $1",
      [EMPRESA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quote_seq).toBe(1);
  });
});

describe("103 — os estados", () => {
  const mudar = (id: string, estado: string, motivo: string | null = null) =>
    pool.query("SELECT public.set_crm_quote_status($1,$2,$3,$4,$5)", [EMPRESA, id, ACTOR, estado, motivo]);

  it("rascunho → enviado carimba a data", async () => {
    const q = await criar();
    await mudar(q.id, "enviado");
    const depois = await estadoDe(q.id);
    expect(depois.status).toBe("enviado");
    expect(depois.sent_at).not.toBeNull();
  });

  it("🔴 não se aceita um orçamento que nunca foi enviado", async () => {
    const q = await criar();
    const erro = await erroDe(() => mudar(q.id, "aceite"));
    expect(erro).toContain("QUOTE_TRANSITION_NOT_ALLOWED");
  });

  it("🔴 não se aceita um orçamento fora de validade", async () => {
    // A validade é posta no passado directamente, e não na criação: o CHECK
    // `crm_quotes_validade_coerente` impede emitir um documento já expirado.
    // O que se quer provar é o outro caso — o que expirou com o tempo.
    const q = await criar();
    await mudar(q.id, "enviado");
    // As duas datas recuam juntas: `valid_until >= issue_date` continua a ter
    // de valer — é um documento antigo, não um documento incoerente.
    await pool.query(
      "UPDATE public.crm_quotes SET issue_date = '2019-01-01', valid_until = '2019-02-01' WHERE id = $1",
      [q.id],
    );

    const erro = await erroDe(() => mudar(q.id, "aceite"));
    expect(erro).toContain("QUOTE_EXPIRED_CANNOT_ACCEPT");
  });

  it("recusar guarda o motivo e a data", async () => {
    const q = await criar();
    await mudar(q.id, "enviado");
    await mudar(q.id, "recusado", "Escolheram mais barato");
    const depois = await estadoDe(q.id);
    expect(depois.status).toBe("recusado");
    expect(depois.rejection_reason).toBe("Escolheram mais barato");
    expect(depois.rejected_at).not.toBeNull();
  });

  it("um aceite não volta atrás", async () => {
    const q = await criar();
    await mudar(q.id, "enviado");
    await mudar(q.id, "aceite");
    const erro = await erroDe(() => mudar(q.id, "recusado"));
    expect(erro).toContain("QUOTE_TRANSITION_NOT_ALLOWED");
  });

  it("repetir o mesmo estado não é erro nem muda a data", async () => {
    const q = await criar();
    await mudar(q.id, "enviado");
    const primeira = (await estadoDe(q.id)).sent_at;
    await mudar(q.id, "enviado");
    expect((await estadoDe(q.id)).sent_at).toEqual(primeira);
  });
});

describe("103 — isolamento e integridade", () => {
  it("🔴 um orçamento não pode apontar para a lead de outra empresa", async () => {
    const leadDaOutra = await novaLead(OUTRA);
    const erro = await erroDe(() => criar({ leadId: leadDaOutra, empresa: EMPRESA }));
    expect(erro).toMatch(/crm_quotes_lead_mesma_empresa|violates foreign key/i);
  });

  it("exactamente um destinatário: lead ou cliente", async () => {
    const lead = await novaLead();
    const erro = await erroDe(() => criar({ leadId: lead, clientId: CLIENTE_A }));
    expect(erro).toContain("crm_quotes_tem_destinatario");
  });

  it("a validade não pode ser anterior à emissão", async () => {
    const erro = await erroDe(() => criar({ validoAte: "2000-01-01" }));
    expect(erro).toContain("crm_quotes_validade_coerente");
  });

  it("apagar a lead leva os orçamentos dela", async () => {
    const lead = await novaLead();
    await criar({ leadId: lead });
    await pool.query("DELETE FROM public.crm_leads WHERE id = $1", [lead]);
    const { rows } = await pool.query("SELECT count(*)::int n FROM public.crm_quotes");
    expect(rows[0].n).toBe(0);
  });

  it("apagar o orçamento leva as linhas", async () => {
    const q = await criar();
    await pool.query("DELETE FROM public.crm_quotes WHERE id = $1", [q.id]);
    const { rows } = await pool.query("SELECT count(*)::int n FROM public.crm_quote_items");
    expect(rows[0].n).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 🔴 QUOTE_CHAIN_CROSS_COMPANY — as auto-referências eram a porta aberta
  // ═════════════════════════════════════════════════════════════════════════
  //
  // `lead_id`, `client_id`, `visit_id` e `created_by` já eram FKs COMPOSTAS. As
  // referências da tabela para SI PRÓPRIA — `superseded_by_id` e
  // `root_quote_id` — não eram: a primeira tinha uma FK simples para
  // `crm_quotes(id)`, a segunda não tinha FK nenhuma.
  //
  // Escreve-se aqui com service_role direto, que é o caminho real: BYPASSRLS e
  // com escrita concedida. Confiar em RLS para isto seria confiar na camada que
  // este papel ignora por desenho.

  it("🔴 CROSS_COMPANY_QUOTE_CHAIN — superseded_by_id não atravessa empresas", async () => {
    const a = await criar({ empresa: EMPRESA });
    const b = await criar({ empresa: OUTRA });

    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_quotes SET superseded_by_id = $2 WHERE id = $1", [a.id, b.id]),
    );

    expect(erro).toMatch(/crm_quotes_superseded_fk|violates foreign key/i);
    expect((await estadoDe(a.id)).superseded_by_id, "zero writes").toBeNull();
  });

  it("🔴 CROSS_COMPANY_QUOTE_CHAIN — root_quote_id não atravessa empresas", async () => {
    const a = await criar({ empresa: EMPRESA });
    const b = await criar({ empresa: OUTRA });

    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_quotes SET root_quote_id = $2 WHERE id = $1", [a.id, b.id]),
    );

    expect(erro).toMatch(/crm_quotes_root_fk|violates foreign key/i);
    expect((await estadoDe(a.id)).root_quote_id, "zero writes").toBe(a.id);
  });

  it("CROSS_COMPANY_QUOTE_CHAIN = 0 — nenhuma cadeia cruzada sobrevive na base", async () => {
    await criar({ empresa: EMPRESA });
    await criar({ empresa: OUTRA });

    const { rows } = await pool.query(`
      SELECT count(*)::int n
        FROM public.crm_quotes q
        JOIN public.crm_quotes alvo
          ON alvo.id IN (q.superseded_by_id, q.root_quote_id)
       WHERE alvo.company_id <> q.company_id`);

    expect(rows[0].n).toBe(0);
  });

  it("apagar uma revisão que substituiu outra é BLOQUEADO — não ressuscita a antiga", async () => {
    // Com `ON DELETE SET NULL` (a versão anterior), apagar a R1 punha
    // `superseded_by_id` a NULL na R0 — e o índice parcial
    // `uq_crm_quotes_revisao_viva` passava a contar a R0 como a revisão VIVA
    // do documento, sem ninguém o ter decidido.
    const q = await criar();
    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)", [EMPRESA, q.id, ACTOR]);
    const r1 = await pool.query(
      `SELECT * FROM public.revise_crm_quote($1,$2,$3,current_date,'2030-12-31',0,true,23,NULL,$4::jsonb)`,
      [EMPRESA, q.id, ACTOR, ITENS],
    );

    const erro = await erroDe(() =>
      pool.query("DELETE FROM public.crm_quotes WHERE id = $1", [r1.rows[0].quote_id]),
    );

    expect(erro).toMatch(/crm_quotes_superseded_fk|crm_quotes_root_fk|violates foreign key/i);
    expect((await estadoDe(q.id)).superseded_by_id, "a antiga continua substituída")
      .toBe(r1.rows[0].quote_id);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 🔴 PROVENIÊNCIA — de que lead nasceu este orçamento
  // ═════════════════════════════════════════════════════════════════════════

  it("source_lead_id nasce igual a lead_id", async () => {
    const lead = await novaLead();
    const q = await criar({ leadId: lead });
    const linha = await estadoDe(q.id);

    expect(linha.lead_id).toBe(lead);
    expect(linha.source_lead_id).toBe(lead);
  });

  it("um orçamento a um cliente que já existe não tem proveniência de lead", async () => {
    const q = await criar({ leadId: null, clientId: CLIENTE_A });
    expect((await estadoDe(q.id)).source_lead_id, "não houve lead nenhuma").toBeNull();
  });

  it("a revisão herda a proveniência — é o mesmo documento", async () => {
    const lead = await novaLead();
    const q = await criar({ leadId: lead });
    await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)", [EMPRESA, q.id, ACTOR]);
    const r1 = await pool.query(
      `SELECT * FROM public.revise_crm_quote($1,$2,$3,current_date,'2030-12-31',0,true,23,NULL,$4::jsonb)`,
      [EMPRESA, q.id, ACTOR, ITENS],
    );

    expect((await estadoDe(r1.rows[0].quote_id)).source_lead_id).toBe(lead);
  });

  it("🔴 a proveniência é IMUTÁVEL — nem service_role a reescreve", async () => {
    const lead = await novaLead();
    const outra = await novaLead();
    const q = await criar({ leadId: lead });

    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_quotes SET source_lead_id = $2 WHERE id = $1", [q.id, outra]),
    );

    expect(erro).toContain("QUOTE_SOURCE_LEAD_IMMUTABLE");
    expect((await estadoDe(q.id)).source_lead_id).toBe(lead);
  });

  it("apagá-la também é reescrever história", async () => {
    const lead = await novaLead();
    const q = await criar({ leadId: lead });

    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_quotes SET source_lead_id = NULL WHERE id = $1", [q.id]),
    );

    expect(erro).toContain("QUOTE_SOURCE_LEAD_IMMUTABLE");
  });

  it("🔴 source_lead_id não aponta para lead de outra empresa", async () => {
    const leadDaOutra = await novaLead(OUTRA);

    // 🔴 Um orçamento endereçado a um CLIENTE: nasce com `source_lead_id` NULL.
    //    Tem de ser este o palco — num orçamento que já tem proveniência, quem
    //    recusa primeiro é o trigger de imutabilidade, e o teste passaria sem
    //    nunca chegar a exercer a FK. O que se quer provar aqui é a FK.
    const q = await criar({ leadId: null, clientId: CLIENTE_A, empresa: EMPRESA });
    expect((await estadoDe(q.id)).source_lead_id).toBeNull();

    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_quotes SET source_lead_id = $2 WHERE id = $1",
        [q.id, leadDaOutra]),
    );

    expect(erro).toMatch(/crm_quotes_source_lead_mesma_empresa|violates foreign key/i);
    expect((await estadoDe(q.id)).source_lead_id, "zero writes").toBeNull();
  });

  it("as duas guardas da proveniência cobrem casos diferentes, e as duas fecham", async () => {
    // O trigger protege uma proveniência JÁ conhecida de ser alterada.
    // A FK protege QUALQUER escrita de apontar para fora da empresa.
    // Nenhuma das duas sozinha cobre os dois casos.
    const lead = await novaLead();
    const q = await criar({ leadId: lead });
    const outraDaMesmaEmpresa = await novaLead();

    expect(
      await erroDe(() =>
        pool.query("UPDATE public.crm_quotes SET source_lead_id = $2 WHERE id = $1",
          [q.id, outraDaMesmaEmpresa]),
      ),
      "mesma empresa, mas reescrita → o trigger",
    ).toContain("QUOTE_SOURCE_LEAD_IMMUTABLE");

    const semProveniencia = await criar({ leadId: null, clientId: CLIENTE_A });
    const leadDaOutra = await novaLead(OUTRA);
    expect(
      await erroDe(() =>
        pool.query("UPDATE public.crm_quotes SET source_lead_id = $2 WHERE id = $1",
          [semProveniencia.id, leadDaOutra]),
      ),
      "em branco, mas outra empresa → a FK",
    ).toMatch(/crm_quotes_source_lead_mesma_empresa|violates foreign key/i);
  });
});

describe("103 — quem pode ler e escrever", () => {
  const comoGestora = <T,>(userId: string, fn: (c: pg.Client) => Promise<T>) =>
    comoUtilizador(container.connection, { papel: "authenticated", userId }, fn);

  it("gestor lê os orçamentos da sua empresa e não os de outra", async () => {
    await criar({ empresa: EMPRESA });
    await criar({ empresa: OUTRA });

    const meus = await comoGestora(ACTOR, (c) =>
      c.query("SELECT count(*)::int n FROM public.crm_quotes"));
    expect(meus.rows[0].n).toBe(1);
  });

  it("🔴 colaboradora não vê orçamentos", async () => {
    await criar();
    await pool.query("UPDATE public.profiles SET role='colaborador' WHERE id=$1", [ACTOR]);
    const r = await comoGestora(ACTOR, (c) =>
      c.query("SELECT count(*)::int n FROM public.crm_quotes"));
    expect(r.rows[0].n).toBe(0);
  });

  it("🔴 authenticated não escreve, e não executa as RPC", async () => {
    const erroEscrita = await erroDe(() =>
      comoGestora(ACTOR, (c) =>
        c.query(
          `INSERT INTO public.crm_quotes (company_id, lead_id, quote_number, quote_year, quote_seq,
             root_quote_id, issue_date, valid_until, subtotal, vat_rate, vat_amount, total)
           VALUES ($1, NULL, 'X', 2026, 1, gen_random_uuid(), current_date, current_date, 0, 23, 0, 0)`,
          [EMPRESA],
        ),
      ),
    );
    expect(erroEscrita).toMatch(/permission denied|row-level security/i);

    const erroRpc = await erroDe(() =>
      comoGestora(ACTOR, (c) =>
        c.query("SELECT public.set_crm_quote_status($1, gen_random_uuid(), $2, 'enviado', NULL)",
          [EMPRESA, ACTOR]),
      ),
    );
    expect(erroRpc).toMatch(/permission denied/i);
  });

  it("🔴 anon não lê nada", async () => {
    await criar();
    const erro = await erroDe(() =>
      comoUtilizador(container.connection, { papel: "anon" }, (c) =>
        c.query("SELECT * FROM public.crm_quotes")),
    );
    expect(erro).toMatch(/permission denied/i);
  });
});

describe("103 — o rollback", () => {
  it("leva tabelas e RPC, e deixa o prefixo nas configurações", async () => {
    await criar();
    await pool.query(sql("supabase/migrations/rollback/103_crm_orcamentos.down.sql"));

    const { rows: t } = await pool.query(`
      SELECT count(*)::int n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'crm_quote%'
    `);
    expect(t[0].n).toBe(0);

    const { rows: f } = await pool.query(`
      SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname LIKE '%crm_quote%'
    `);
    expect(f[0].n).toBe(0);

    // O prefixo fica: apagá-lo obrigaria a reescrever a configuração de cada
    // empresa, e a 103 volta a encontrá-lo se correr outra vez.
    const { rows: c } = await pool.query(
      "SELECT quote_prefix FROM public.company_settings WHERE company_id = $1",
      [EMPRESA],
    );
    expect(c[0].quote_prefix).toBe("ORC");

    // E as leads continuam lá.
    const { rows: l } = await pool.query("SELECT count(*)::int n FROM public.crm_leads");
    expect(l[0].n).toBe(1);
  });
});
