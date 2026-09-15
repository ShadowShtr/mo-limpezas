// ============================================================================
// 101 — estado, diário e ordem: atómicos, contra o schema REAL de produção
// ============================================================================
//
// 🔴 O que a versão anterior do código permitia, e que estas provas fecham.
//
//    `moveLeadStage` fazia `UPDATE crm_leads` e depois chamava o diário em
//    best-effort, engolindo o erro. Dois estados proibidos passavam:
//
//      STAGE_CHANGED = YES + DIARY_ENTRY = MISSING
//      duas pessoas a arrastar o mesmo cartão → last-write-wins
//
//    `reorderLeads` fazia N `UPDATE` sequenciais. Se o terceiro falhasse, os
//    dois primeiros ficavam gravados e o quadro ficava numa ordem que ninguém
//    escolheu.
//
// Agora são duas RPCs, e o que se mede aqui é o que acontece quando as coisas
// correm mal — que é onde a atomicidade se nota.
// ============================================================================

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import {
  ACTOR,
  ACTOR_OUTRA,
  EMPRESA,
  OUTRA,
  contar,
  erroDe,
  montarPalcoCrm,
  novaLead,
} from "./helpers/crm-pg-harness";

const CONTAINER = `crmstage-${process.pid}`;

let container: PostgresContainer;
let pool: pg.Pool;

function mover(
  args: {
    leadId: string;
    de?: string | null;
    para: string;
    empresa?: string;
    actor?: string;
    motivo?: string | null;
    notas?: string | null;
  },
  db: pg.Pool | pg.Client = pool,
) {
  return db.query(
    "SELECT * FROM public.move_crm_lead_stage_atomic($1,$2,$3,$4,$5,$6,$7)",
    [
      args.empresa ?? EMPRESA,
      args.leadId,
      args.de === undefined ? null : args.de,
      args.para,
      args.actor ?? ACTOR,
      args.motivo ?? null,
      args.notas ?? null,
    ],
  );
}

function reordenar(
  args: { stage: string; itens: { leadId: string; boardOrder: number }[]; empresa?: string },
  db: pg.Pool | pg.Client = pool,
) {
  return db.query("SELECT * FROM public.reorder_crm_leads_atomic($1,$2,$3::jsonb,$4)", [
    args.empresa ?? EMPRESA,
    args.stage,
    JSON.stringify(args.itens),
    ACTOR,
  ]);
}

const lerLead = async (id: string) =>
  (await pool.query("SELECT * FROM public.crm_leads WHERE id = $1", [id])).rows[0];

const diario = async (id: string) =>
  (await pool.query(
    "SELECT count(*)::int n FROM public.crm_lead_interactions WHERE lead_id = $1", [id],
  )).rows[0].n as number;

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "crmstage",
    serverFlags: ["shared_buffers=24MB", "max_connections=30", "work_mem=1MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 8 });
}, 240_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

beforeEach(async () => {
  await montarPalcoCrm(pool);
});

// ═══════════════════════════════════════════════════════════════════════════
// ESTADO + DIÁRIO
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 VALID_TRANSITION — estado e diário na mesma transação", () => {
  it("mover escreve os dois", async () => {
    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "contactado" });

    expect((await lerLead(id)).stage).toBe("contactado");
    expect(await diario(id), "NO_MISSING_DIARY").toBe(1);
  });

  it("o diário diz de onde veio e para onde foi", async () => {
    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "visita_agendada" });

    const { rows } = await pool.query(
      "SELECT kind, summary FROM public.crm_lead_interactions WHERE lead_id = $1", [id],
    );
    expect(rows[0].kind).toBe("sistema");
    expect(rows[0].summary).toContain("Novo");
    expect(rows[0].summary).toContain("Visita agendada");
  });

  it("perder guarda motivo e data, e regista no diário", async () => {
    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "perdido", motivo: "preco", notas: "Acharam caro" });

    const lead = await lerLead(id);
    expect(lead.stage).toBe("perdido");
    expect(lead.lost_reason).toBe("preco");
    expect(lead.lost_reason_notes).toBe("Acharam caro");
    expect(lead.lost_at).not.toBeNull();
    expect(await diario(id)).toBe(1);
  });

  it("reabrir uma lead perdida limpa o desfecho", async () => {
    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "perdido", motivo: "adiou" });
    await mover({ leadId: id, de: "perdido", para: "contactado" });

    const lead = await lerLead(id);
    expect(lead.lost_reason, "deixaria de contar como perdida no relatório").toBeNull();
    expect(lead.lost_at).toBeNull();
    expect(await diario(id)).toBe(2);
  });
});

describe("🔴 INVALID_TRANSITION — zero writes", () => {
  it("perder sem motivo não escreve nada", async () => {
    const id = await novaLead(pool);
    const erro = await erroDe(() => mover({ leadId: id, de: "novo", para: "perdido" }));

    expect(erro).toContain("LEAD_LOST_REQUIRES_REASON");
    expect((await lerLead(id)).stage, "zero writes").toBe("novo");
    expect(await diario(id)).toBe(0);
  });

  it("🔴 'ganho' não se marca por aqui — exige conversão", async () => {
    const id = await novaLead(pool);
    const erro = await erroDe(() => mover({ leadId: id, de: "novo", para: "ganho" }));

    expect(erro).toContain("LEAD_WIN_REQUIRES_CONVERSION");
    expect((await lerLead(id)).stage).toBe("novo");
    expect(await diario(id)).toBe(0);
  });

  it("um estado inventado é recusado sem escrever", async () => {
    const id = await novaLead(pool);
    const erro = await erroDe(() => mover({ leadId: id, de: "novo", para: "negociacao" }));

    expect(erro).toContain("LEAD_STAGE_UNKNOWN");
    expect((await lerLead(id)).stage).toBe("novo");
    expect(await diario(id)).toBe(0);
  });

  it("uma lead já ganha não volta ao funil", async () => {
    const id = await novaLead(pool);
    const { rows: c } = await pool.query(
      "INSERT INTO public.clients (company_id, name) VALUES ($1,'C') RETURNING id", [EMPRESA]);
    const { rows: l } = await pool.query(
      "INSERT INTO public.locations (company_id, client_id, name, address) VALUES ($1,$2,'L','R') RETURNING id",
      [EMPRESA, c[0].id]);
    await pool.query(
      `UPDATE public.crm_leads SET stage='ganho', won_at=now(),
              converted_client_id=$2, converted_location_id=$3 WHERE id=$1`,
      [id, c[0].id, l[0].id]);

    const erro = await erroDe(() => mover({ leadId: id, de: "ganho", para: "contactado" }));
    expect(erro).toContain("LEAD_ALREADY_WON");
  });
});

describe("🔴 INTERACTION_FAILURE — o estado volta atrás com o diário", () => {
  it("se o diário falhar, a lead não muda de coluna", async () => {
    const id = await novaLead(pool);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.rebentar_diario() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'DIARIO_INDISPONIVEL'; END $$;
      CREATE TRIGGER trg_diario_falha
        BEFORE INSERT ON public.crm_lead_interactions
        FOR EACH ROW EXECUTE FUNCTION public.rebentar_diario();
    `);

    try {
      const erro = await erroDe(() => mover({ leadId: id, de: "novo", para: "contactado" }));
      expect(erro).toContain("DIARIO_INDISPONIVEL");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS trg_diario_falha ON public.crm_lead_interactions");
    }

    // 🔴 É esta a asserção que a versão anterior não passava.
    expect((await lerLead(id)).stage, "STAGE_CHANGED sem DIARY_ENTRY").toBe("novo");
    expect(await diario(id)).toBe(0);
  });
});

describe("🔴 SAME_STAGE — idempotente, sem audit duplicado", () => {
  it("repetir a mesma transição não escreve e não regista", async () => {
    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "contactado" });

    const historico = await contar(pool, "data_history");
    await mover({ leadId: id, de: "contactado", para: "contactado" });

    expect(await diario(id), "sem linha nova no diário").toBe(1);
    expect(await contar(pool, "data_history"), "sem histórico novo").toBe(historico);
  });
});

describe("🔴 CONCURRENT_STAGE_CHANGE — só uma vence", () => {
  it("duas sessões a mover do mesmo estado: uma passa, a outra é recusada", async () => {
    const id = await novaLead(pool);

    const c1 = new pg.Client({ ...container.connection });
    const c2 = new pg.Client({ ...container.connection });
    await c1.connect();
    await c2.connect();

    let resultados;
    try {
      resultados = await Promise.allSettled([
        mover({ leadId: id, de: "novo", para: "contactado" }, c1),
        mover({ leadId: id, de: "novo", para: "visita_agendada" }, c2),
      ]);
    } finally {
      await c1.end();
      await c2.end();
    }

    const ok = resultados.filter((r) => r.status === "fulfilled");
    const falhou = resultados.filter((r) => r.status === "rejected");

    expect(ok, "exactamente uma transição válida").toHaveLength(1);
    expect(falhou).toHaveLength(1);
    expect(String((falhou[0] as PromiseRejectedResult).reason)).toContain("LEAD_STAGE_CONFLICT");

    // E o diário tem UMA linha — não duas, não zero.
    expect(await diario(id)).toBe(1);
  });

  it("sem expected_stage, a última escrita ganha — e é por isso que a UI o envia", async () => {
    // Documenta o comportamento: `p_expected_stage` NULL desliga o controlo de
    // concorrência. A interface envia-o sempre; este teste existe para que a
    // consequência de o omitir esteja escrita.
    const id = await novaLead(pool);
    await mover({ leadId: id, de: null, para: "contactado" });
    await mover({ leadId: id, de: null, para: "visita_agendada" });
    expect((await lerLead(id)).stage).toBe("visita_agendada");
  });
});

describe("🔴 isolamento — a lead de outra empresa não se move", () => {
  it("mesmo com o id certo, a empresa errada não encontra a lead", async () => {
    const idB = await novaLead(pool, { empresa: OUTRA });
    const erro = await erroDe(() => mover({ leadId: idB, para: "contactado", empresa: EMPRESA }));
    expect(erro).toContain("LEAD_NOT_FOUND");
    expect((await lerLead(idB)).stage).toBe("novo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REORDENAR
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 REORDER — tudo ou nada", () => {
  async function tresNaMesmaColuna() {
    const a = await novaLead(pool, { nome: "A" });
    const b = await novaLead(pool, { nome: "B" });
    const c = await novaLead(pool, { nome: "C" });
    return [a, b, c];
  }

  const ordens = async (ids: string[]) => {
    const { rows } = await pool.query(
      "SELECT id, board_order FROM public.crm_leads WHERE id = ANY($1) ORDER BY board_order", [ids]);
    return rows.map((r) => r.board_order as number);
  };

  it("a ordem é aplicada toda", async () => {
    const [a, b, c] = await tresNaMesmaColuna();
    await reordenar({
      stage: "novo",
      itens: [{ leadId: c, boardOrder: 0 }, { leadId: a, boardOrder: 1 }, { leadId: b, boardOrder: 2 }],
    });

    expect(await ordens([a, b, c])).toEqual([0, 1, 2]);
    const { rows } = await pool.query("SELECT board_order FROM public.crm_leads WHERE id=$1", [c]);
    expect(rows[0].board_order).toBe(0);
  });

  it("🔴 FAIL_MIDDLE — um id inválido no meio não deixa ordem parcial", async () => {
    const [a, b, c] = await tresNaMesmaColuna();
    const antes = await ordens([a, b, c]);

    const erro = await erroDe(() =>
      reordenar({
        stage: "novo",
        itens: [
          { leadId: a, boardOrder: 0 },
          { leadId: "99999999-9999-4999-8999-999999999999", boardOrder: 1 },
          { leadId: c, boardOrder: 2 },
        ],
      }),
    );

    expect(erro).toContain("REORDER_INVALID_ITEMS");
    expect(await ordens([a, b, c]), "ZERO_PARTIAL_REORDER").toEqual(antes);
  });

  it("🔴 um cartão de OUTRA coluna invalida o pedido inteiro", async () => {
    const [a, b] = await tresNaMesmaColuna();
    await mover({ leadId: b, de: "novo", para: "contactado" });
    const antes = await ordens([a, b]);

    const erro = await erroDe(() =>
      reordenar({ stage: "novo", itens: [{ leadId: a, boardOrder: 0 }, { leadId: b, boardOrder: 1 }] }),
    );

    expect(erro).toContain("REORDER_INVALID_ITEMS");
    expect(await ordens([a, b])).toEqual(antes);
  });

  it("🔴 um cartão de OUTRA empresa invalida o pedido inteiro", async () => {
    const [a] = await tresNaMesmaColuna();
    const b = await novaLead(pool, { empresa: OUTRA });

    const erro = await erroDe(() =>
      reordenar({ stage: "novo", itens: [{ leadId: a, boardOrder: 0 }, { leadId: b, boardOrder: 1 }] }),
    );
    expect(erro).toContain("REORDER_INVALID_ITEMS");
  });

  it("ids repetidos são recusados", async () => {
    const [a] = await tresNaMesmaColuna();
    const erro = await erroDe(() =>
      reordenar({ stage: "novo", itens: [{ leadId: a, boardOrder: 0 }, { leadId: a, boardOrder: 1 }] }),
    );
    expect(erro).toContain("REORDER_DUPLICATE_IDS");
  });

  it("uma posição fora de limites é recusada, sem escrever", async () => {
    const [a, b, c] = await tresNaMesmaColuna();
    const antes = await ordens([a, b, c]);
    const erro = await erroDe(() =>
      reordenar({ stage: "novo", itens: [{ leadId: a, boardOrder: 999999 }] }),
    );
    expect(erro).toContain("REORDER_INVALID_POSITION");
    expect(await ordens([a, b, c])).toEqual(antes);
  });

  it("uma lista vazia não é erro — é um não-pedido", async () => {
    const { rows } = await reordenar({ stage: "novo", itens: [] });
    expect(rows[0].atualizadas).toBe(0);
  });

  it("reordenar não escreve no diário — priorizar não é mudar de estado", async () => {
    const [a, b, c] = await tresNaMesmaColuna();
    await reordenar({
      stage: "novo",
      itens: [{ leadId: a, boardOrder: 0 }, { leadId: b, boardOrder: 1 }, { leadId: c, boardOrder: 2 }],
    });
    expect(await contar(pool, "crm_lead_interactions")).toBe(0);
  });
});

describe("🔴 permissões das RPCs do funil", () => {
  it("authenticated não executa nenhuma delas", async () => {
    const id = await novaLead(pool);
    const c = new pg.Client({ ...container.connection });
    await c.connect();
    try {
      await c.query("SET ROLE authenticated");
      expect(await erroDe(() => mover({ leadId: id, para: "contactado" }, c))).toMatch(/permission denied/i);
      expect(await erroDe(() => reordenar({ stage: "novo", itens: [] }, c))).toMatch(/permission denied/i);
    } finally {
      await c.end();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-COMPANY PELA VIA PRIVILEGIADA — o que o RLS não cobre
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 CROSS_COMPANY_SERVICE_ROLE — as FKs compostas são a rede", () => {
  /**
   * 🔴 Porque é que um teste de RLS com `authenticated` NÃO chega.
   *
   *    As Server Actions escrevem com `service_role`, que é BYPASSRLS. O RLS
   *    protege a leitura pelo browser; não protege nada do que a aplicação
   *    escreve. O que protege é a integridade referencial — e é isso que se
   *    mede aqui, pela MESMA via privilegiada que as actions usam.
   */
  async function comoServiceRole<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ ...container.connection });
    await c.connect();
    try {
      await c.query("SET ROLE service_role");
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  it("lead da empresa A com owner da empresa B → REJEITADO", async () => {
    const erro = await comoServiceRole((c) =>
      erroDe(() =>
        c.query(
          "INSERT INTO public.crm_leads (company_id, name, owner_id) VALUES ($1, 'X', $2)",
          [EMPRESA, ACTOR_OUTRA],
        ),
      ),
    );
    expect(erro).toMatch(/crm_leads_owner_mesma_empresa|violates foreign key/i);
    expect(await contar(pool, "crm_leads"), "ZERO mutation").toBe(0);
  });

  it("lead da empresa A criada por perfil da empresa B → REJEITADO", async () => {
    const erro = await comoServiceRole((c) =>
      erroDe(() =>
        c.query(
          "INSERT INTO public.crm_leads (company_id, name, created_by) VALUES ($1, 'X', $2)",
          [EMPRESA, ACTOR_OUTRA],
        ),
      ),
    );
    expect(erro).toMatch(/crm_leads_created_by_mesma_empresa|violates foreign key/i);
  });

  it("interacção da empresa A com autor da empresa B → REJEITADO", async () => {
    const id = await novaLead(pool);
    const erro = await comoServiceRole((c) =>
      erroDe(() =>
        c.query(
          `INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary, author_id)
           VALUES ($1, $2, 'nota', 'X', $3)`,
          [EMPRESA, id, ACTOR_OUTRA],
        ),
      ),
    );
    expect(erro).toMatch(/crm_lead_interactions_author_mesma_empresa|violates foreign key/i);
  });

  it("visita da empresa A atribuída a perfil da empresa B → REJEITADO", async () => {
    const id = await novaLead(pool);
    const erro = await comoServiceRole((c) =>
      erroDe(() =>
        c.query(
          `INSERT INTO public.crm_visits (company_id, lead_id, scheduled_start, scheduled_end, assigned_to)
           VALUES ($1, $2, now(), now() + interval '1 hour', $3)`,
          [EMPRESA, id, ACTOR_OUTRA],
        ),
      ),
    );
    expect(erro).toMatch(/crm_visits_assigned_mesma_empresa|violates foreign key/i);
    expect(await contar(pool, "crm_visits")).toBe(0);
  });

  it("orçamento da empresa A com visita da empresa B → REJEITADO", async () => {
    const idB = await novaLead(pool, { empresa: OUTRA });
    const { rows: vB } = await pool.query(
      `INSERT INTO public.crm_visits (company_id, lead_id, scheduled_start, scheduled_end)
       VALUES ($1,$2, now(), now() + interval '1 hour') RETURNING id`,
      [OUTRA, idB],
    );
    const idA = await novaLead(pool);

    const erro = await comoServiceRole((c) =>
      erroDe(() =>
        c.query(
          `INSERT INTO public.crm_quotes
             (company_id, lead_id, visit_id, quote_number, quote_year, quote_seq, root_quote_id,
              issue_date, valid_until, subtotal, vat_rate, vat_amount, total)
           VALUES ($1,$2,$3,'ORC2026/900',2026,900,gen_random_uuid(),current_date,current_date,0,23,0,0)`,
          [EMPRESA, idA, vB[0].id],
        ),
      ),
    );
    expect(erro).toMatch(/crm_quotes_visita_mesma_empresa|violates foreign key/i);
    expect(await contar(pool, "crm_quotes")).toBe(0);
  });

  it("orçamento da empresa A criado por perfil da empresa B → REJEITADO", async () => {
    const idA = await novaLead(pool);
    const erro = await comoServiceRole((c) =>
      erroDe(() =>
        c.query(
          `INSERT INTO public.crm_quotes
             (company_id, lead_id, created_by, quote_number, quote_year, quote_seq, root_quote_id,
              issue_date, valid_until, subtotal, vat_rate, vat_amount, total)
           VALUES ($1,$2,$3,'ORC2026/901',2026,901,gen_random_uuid(),current_date,current_date,0,23,0,0)`,
          [EMPRESA, idA, ACTOR_OUTRA],
        ),
      ),
    );
    expect(erro).toMatch(/crm_quotes_created_by_mesma_empresa|violates foreign key/i);
  });

  it("o mesmo perfil, na SUA empresa, passa — a rede não é um muro", async () => {
    const ok = await comoServiceRole((c) =>
      erroDe(() =>
        c.query(
          "INSERT INTO public.crm_leads (company_id, name, owner_id, created_by) VALUES ($1,'Legítima',$2,$2)",
          [EMPRESA, ACTOR],
        ),
      ),
    );
    expect(ok).toBeNull();
    expect(await contar(pool, "crm_leads")).toBe(1);
  });
});
