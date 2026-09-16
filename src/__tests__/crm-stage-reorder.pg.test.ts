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

import {
  LEAD_STAGES,
  TRANSICOES,
  type LeadStage,
} from "@/lib/crm/stages";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import {
  ACTOR,
  ACTOR_OUTRA,
  EMPRESA,
  OUTRA,
  contar,
  erroDe,
  migrationCrm,
  rollbackCrm,
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

  // 🔴 Esta prova substitui uma anterior que DOCUMENTAVA last-write-wins com
  //    `p_expected_stage` NULL («a interface envia-o sempre»). Enquanto o NULL
  //    era aceite, o controlo de concorrência era opcional — e um controlo que
  //    o chamador pode desligar não é fail-closed. O contrato passou a exigi-lo
  //    nas duas pontas: o schema da Server Action e a própria RPC.
  it("🔴 EXPECTED_STAGE_NULL — recusado, sem escrever", async () => {
    const id = await novaLead(pool);
    const erro = await erroDe(() => mover({ leadId: id, de: null, para: "contactado" }));

    expect(erro).toContain("LEAD_EXPECTED_STAGE_REQUIRED");
    expect((await lerLead(id)).stage, "zero writes").toBe("novo");
    expect(await diario(id)).toBe(0);
  });

  it("🔴 EXPECTED_STAGE_STALE — recusado com CONFLICT, sem escrever", async () => {
    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "contactado" });

    // Quem ainda via o cartão em 'novo' chega atrasado.
    const erro = await erroDe(() => mover({ leadId: id, de: "novo", para: "orcamento_enviado" }));

    expect(erro).toContain("LEAD_STAGE_CONFLICT");
    expect((await lerLead(id)).stage, "ZERO_WRITES_ON_CONFLICT").toBe("contactado");
    expect(await diario(id), "ZERO_WRITES_ON_CONFLICT").toBe(1);
  });

  it("EXPECTED_STAGE_CORRECT — passa", async () => {
    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "contactado" });
    expect((await lerLead(id)).stage).toBe("contactado");
  });

  it("um expected_stage inventado é recusado sem escrever", async () => {
    const id = await novaLead(pool);
    const erro = await erroDe(() => mover({ leadId: id, de: "negociacao", para: "contactado" }));

    expect(erro).toContain("LEAD_STAGE_UNKNOWN");
    expect((await lerLead(id)).stage).toBe("novo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 A MATRIZ — a RPC é a autoridade, ou não é
// ═══════════════════════════════════════════════════════════════════════════
//
// Antes desta ronda a RPC verificava estado conhecido, `ganho` só por conversão,
// não sair de `ganho`, motivo na perda e o `expected_stage` — mas NÃO o par
// (origem → destino) contra a matriz canónica. `visita_agendada → novo` passava
// na base apesar de a interface nunca o oferecer, e a frase «as regras de
// transição vivem na RPC» era falsa: viviam no ecrã.
//
// Isto percorre as 36 combinações e compara a base com `TRANSICOES` do
// TypeScript, uma a uma.

describe("🔴 TRANSITION_MATRIX_PARITY — SQL e TypeScript dizem o mesmo", () => {
  /**
   * Põe a lead no estado pedido, seja qual for — incluindo `ganho`, que a RPC
   * não deixa assumir por movimento. Escreve direto com service_role, que é
   * exactamente o caminho privilegiado contra o qual as invariantes existem.
   */
  async function leadEm(stage: LeadStage): Promise<string> {
    const id = await novaLead(pool);
    if (stage === "novo") return id;

    if (stage === "ganho") {
      const { rows: c } = await pool.query(
        "INSERT INTO public.clients (company_id, name) VALUES ($1,'C') RETURNING id", [EMPRESA]);
      const { rows: l } = await pool.query(
        "INSERT INTO public.locations (company_id, client_id, name, address) VALUES ($1,$2,'L','R') RETURNING id",
        [EMPRESA, c[0].id]);
      await pool.query(
        `UPDATE public.crm_leads SET stage='ganho', won_at=now(),
                converted_client_id=$2, converted_location_id=$3 WHERE id=$1`,
        [id, c[0].id, l[0].id]);
      return id;
    }

    if (stage === "perdido") {
      await pool.query(
        "UPDATE public.crm_leads SET stage='perdido', lost_at=now(), lost_reason='preco' WHERE id=$1",
        [id]);
      return id;
    }

    await pool.query("UPDATE public.crm_leads SET stage=$2 WHERE id=$1", [id, stage]);
    return id;
  }

  for (const origem of LEAD_STAGES) {
    for (const destino of LEAD_STAGES) {
      if (origem === destino) continue; // idempotente, coberto noutro bloco

      const permitidoNoTs = TRANSICOES[origem].includes(destino);

      it(`${origem} -> ${destino} — ${permitidoNoTs ? "ALLOWED" : "REJECTED"} no TypeScript`, async () => {
        const id = await leadEm(origem);
        const erro = await erroDe(() =>
          mover({ leadId: id, de: origem, para: destino, motivo: "preco" }),
        );

        // 🔴 `ganho` é o único ponto onde as duas regras não coincidem, e é
        //    deliberado: a matriz diz que chegar a `ganho` é um percurso
        //    legítimo do funil — e é. O que muda é o CAMINHO DE ESCRITA:
        //    ganhar é converter (104), não arrastar o cartão. A conversão cria
        //    o cliente; marcar `ganho` aqui deixaria uma lead ganha sem ninguém
        //    a quem faturar, que a constraint `crm_leads_ganho_exige_conversao`
        //    também já não permite.
        if (destino === "ganho") {
          expect(erro, "ganho só por conversão").toContain(
            origem === "ganho" ? "LEAD_ALREADY_WON" : "LEAD_WIN_REQUIRES_CONVERSION",
          );
          return;
        }

        if (origem === "ganho") {
          expect(erro, "sair de ganho reescreveria a história de um cliente real")
            .toContain("LEAD_ALREADY_WON");
          expect(permitidoNoTs, "o TypeScript também fecha ganho").toBe(false);
          return;
        }

        if (permitidoNoTs) {
          expect(erro, `a matriz TS permite ${origem} -> ${destino}, a base recusou`).toBeNull();
          expect((await lerLead(id)).stage).toBe(destino);
        } else {
          expect(erro, `a matriz TS recusa ${origem} -> ${destino}, a base deixou passar`)
            .toContain("LEAD_TRANSITION_NOT_ALLOWED");
          expect((await lerLead(id)).stage, "zero writes").toBe(origem);
          expect(await diario(id)).toBe(0);
        }
      });
    }
  }

  it("UNKNOWN / FORBIDDEN = FAIL_CLOSED — nenhum estado fora da matriz passa", async () => {
    const id = await novaLead(pool);
    for (const inventado of ["negociacao", "", "GANHO", "novo ", "'; DROP TABLE crm_leads; --"]) {
      const erro = await erroDe(() => mover({ leadId: id, de: "novo", para: inventado }));
      expect(erro, `«${inventado}» não pode passar`).toContain("LEAD_STAGE_UNKNOWN");
    }
    expect((await lerLead(id)).stage).toBe("novo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 GANHO_SEM_CONVERSAO — a invariante nas DUAS direcções
// ═══════════════════════════════════════════════════════════════════════════
//
// `crm_leads_conversao_so_se_ganha` só proibia apontar para um cliente fora de
// `ganho`. O estado simétrico — `stage='ganho'` com `converted_client_id` NULL
// — passava, e é um negócio dado como fechado que nunca produziu ninguém a quem
// faturar. Escreve-se aqui com service_role direto, que é o caminho
// privilegiado real: BYPASSRLS e com escrita concedida.

describe("🔴 GANHO_SEM_CONVERSAO_REJECTED — service_role direto", () => {
  it("GANHO_SEM_CLIENTE = REJECTED", async () => {
    const id = await novaLead(pool);
    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_leads SET stage='ganho', won_at=now() WHERE id=$1", [id]),
    );

    expect(erro).toContain("crm_leads_ganho_exige_conversao");
    expect((await lerLead(id)).stage, "zero writes").toBe("novo");
  });

  it("GANHO_SEM_LOCAL = REJECTED", async () => {
    const id = await novaLead(pool);
    const { rows: c } = await pool.query(
      "INSERT INTO public.clients (company_id, name) VALUES ($1,'C') RETURNING id", [EMPRESA]);

    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads SET stage='ganho', won_at=now(), converted_client_id=$2
          WHERE id=$1`, [id, c[0].id]),
    );

    // Barrado pelo par (`crm_leads_conversao_coerente`) ou pela invariante
    // nova — as duas dizem a mesma coisa sobre este estado. O que importa é
    // que NÃO passa.
    expect(erro).toMatch(/crm_leads_conversao_coerente|crm_leads_ganho_exige_conversao/);
    expect((await lerLead(id)).stage, "zero writes").toBe("novo");
  });

  it("CONVERTED_IDS_FORA_DE_GANHO = REJECTED", async () => {
    const id = await novaLead(pool);
    const { rows: c } = await pool.query(
      "INSERT INTO public.clients (company_id, name) VALUES ($1,'C') RETURNING id", [EMPRESA]);
    const { rows: l } = await pool.query(
      "INSERT INTO public.locations (company_id, client_id, name, address) VALUES ($1,$2,'L','R') RETURNING id",
      [EMPRESA, c[0].id]);

    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads SET converted_client_id=$2, converted_location_id=$3
          WHERE id=$1`, [id, c[0].id, l[0].id]),
    );

    expect(erro).toContain("crm_leads_conversao_so_se_ganha");
    expect((await lerLead(id)).converted_client_id, "zero writes").toBeNull();
  });

  it("CONVERSAO_VALIDA = PASS — as três coisas juntas passam", async () => {
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

    const lead = await lerLead(id);
    expect(lead.stage).toBe("ganho");
    expect(lead.converted_client_id).toBe(c[0].id);
    expect(lead.converted_location_id).toBe(l[0].id);
  });
});

describe("🔴 isolamento — a lead de outra empresa não se move", () => {
  it("mesmo com o id certo, a empresa errada não encontra a lead", async () => {
    const idB = await novaLead(pool, { empresa: OUTRA });
    const erro = await erroDe(() =>
      mover({ leadId: idB, de: "novo", para: "contactado", empresa: EMPRESA }),
    );
    expect(erro).toContain("LEAD_NOT_FOUND");
    expect((await lerLead(idB)).stage).toBe("novo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REORDENAR
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 REORDER_VS_STAGE_MOVE — a janela de corrida que existia entre as duas RPC
// ═══════════════════════════════════════════════════════════════════════════
//
// A versão anterior de `reorder_crm_leads_atomic` validava que todos os cartões
// estavam em `p_stage` com um SELECT SEM LOCK, e o UPDATE final filtrava por
// `id` e `company_id` — não por `stage`. Entre as duas coisas,
// `move_crm_lead_stage_atomic` podia mover um dos cartões para outra coluna; o
// reorder, já decidido com a leitura velha, escrevia na mesma o `board_order`
// de um cartão que entretanto deixara de estar ali.
//
// Agora o reorder tranca TODAS as leads-alvo (por id, ordenadas — nunca por
// `stage`, que é o campo que pode ter mudado) ANTES de decidir. O resultado
// passa a ser serializável: ou o move entra primeiro e o reorder recusa o
// pedido stale inteiro, ou o reorder entra primeiro e o move acontece depois.

describe("🔴 REORDER_VS_STAGE_MOVE — serializável, nos dois sentidos", () => {
  async function tresNovas() {
    return [
      await novaLead(pool, { nome: "A" }),
      await novaLead(pool, { nome: "B" }),
      await novaLead(pool, { nome: "C" }),
    ];
  }

  const lerOrdem = async (id: string) =>
    (await pool.query("SELECT stage, board_order FROM public.crm_leads WHERE id=$1", [id])).rows[0];

  it("o move entra primeiro → o reorder recusa o pedido stale, e não escreve nada", async () => {
    const [a, b, c] = await tresNovas();

    const sMove = new pg.Client({ ...container.connection });
    const sReorder = new pg.Client({ ...container.connection });
    await sMove.connect();
    await sReorder.connect();

    try {
      // Sessão 1 move `b` para outra coluna e COMMITA — é o estado real quando
      // o reorder chegar.
      await sMove.query("BEGIN");
      await mover({ leadId: b, de: "novo", para: "contactado" }, sMove);
      await sMove.query("COMMIT");

      // Sessão 2 chega com a leitura antiga: ainda julga que `b` está em 'novo'.
      await sReorder.query("BEGIN");
      const erro = await erroDe(() =>
        reordenar(
          {
            stage: "novo",
            itens: [
              { leadId: c, boardOrder: 0 },
              { leadId: b, boardOrder: 1 },
              { leadId: a, boardOrder: 2 },
            ],
          },
          sReorder,
        ),
      );
      await sReorder.query("ROLLBACK");

      expect(erro, "o pedido inteiro é stale").toContain("REORDER_INVALID_ITEMS");
    } finally {
      await sMove.end();
      await sReorder.end();
    }

    // 🔴 ZERO_PARTIAL_REORDER: nem os cartões que NÃO se moveram foram tocados.
    expect((await lerOrdem(a)).board_order, "ZERO_PARTIAL_REORDER").toBe(0);
    expect((await lerOrdem(c)).board_order, "ZERO_PARTIAL_REORDER").toBe(0);

    // E o cartão movido ficou onde o move o pôs, com a ordem que já tinha —
    // nunca com uma posição atribuída na coluna antiga.
    const movido = await lerOrdem(b);
    expect(movido.stage).toBe("contactado");
    expect(movido.board_order).toBe(0);
  });

  it("o reorder entra primeiro → o move espera no lock e acontece depois", async () => {
    const [a, b, c] = await tresNovas();

    const sReorder = new pg.Client({ ...container.connection });
    const sMove = new pg.Client({ ...container.connection });
    await sReorder.connect();
    await sMove.connect();

    try {
      // Sessão 1 reordena e NÃO commita: os locks ficam de pé.
      await sReorder.query("BEGIN");
      await reordenar(
        {
          stage: "novo",
          itens: [
            { leadId: c, boardOrder: 0 },
            { leadId: b, boardOrder: 1 },
            { leadId: a, boardOrder: 2 },
          ],
        },
        sReorder,
      );

      // Sessão 2 tenta mover `b`. Tem de BLOQUEAR — se passasse já, a janela
      // de corrida continuaria aberta.
      let moveTerminou = false;
      const move = mover({ leadId: b, de: "novo", para: "contactado" }, sMove)
        .then(() => { moveTerminou = true; });

      await new Promise((r) => setTimeout(r, 400));
      expect(moveTerminou, "o move tem de esperar pelo lock do reorder").toBe(false);

      await sReorder.query("COMMIT");
      await move;
      expect(moveTerminou).toBe(true);
    } finally {
      await sReorder.end();
      await sMove.end();
    }

    // A ordem do reorder ficou aplicada, e o move aconteceu por cima dela.
    expect((await lerOrdem(a)).board_order).toBe(2);
    expect((await lerOrdem(c)).board_order).toBe(0);
    const movido = await lerOrdem(b);
    expect(movido.stage).toBe("contactado");
    expect(movido.board_order, "a posição que o reorder lhe deu, na coluna onde estava").toBe(1);
  });

  it("dois reorders concorrentes não entram em deadlock — a ordem de lock é determinística", async () => {
    const [a, b, c] = await tresNovas();

    const s1 = new pg.Client({ ...container.connection });
    const s2 = new pg.Client({ ...container.connection });
    await s1.connect();
    await s2.connect();

    try {
      // As duas listas em ordens OPOSTAS: é o padrão que produz deadlock quando
      // cada sessão tranca pela ordem em que os itens chegam.
      const r1 = reordenar(
        { stage: "novo", itens: [
          { leadId: a, boardOrder: 0 }, { leadId: b, boardOrder: 1 }, { leadId: c, boardOrder: 2 }] },
        s1,
      );
      const r2 = reordenar(
        { stage: "novo", itens: [
          { leadId: c, boardOrder: 0 }, { leadId: b, boardOrder: 1 }, { leadId: a, boardOrder: 2 }] },
        s2,
      );

      const resultados = await Promise.allSettled([r1, r2]);
      const mortos = resultados.filter(
        (r) => r.status === "rejected" && String((r as PromiseRejectedResult).reason).includes("deadlock"),
      );
      expect(mortos, "ordem de lock determinística = sem deadlock").toHaveLength(0);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    } finally {
      await s1.end();
      await s2.end();
    }
  });
});

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

  // 🔴 As provas equivalentes para `crm_visits` e `crm_quotes` NÃO vivem nesta
  //    PR, e é deliberado: esta PR porta apenas a 101, e essas tabelas nascem
  //    na 102 e na 103. Escrevê-las aqui obrigaria a trazer duas migrations que
  //    esta PR não pede autorização para aplicar — e uma prova que depende de
  //    schema ausente é uma prova que não corre.
  //
  //    Ficam na PR dessas migrations, onde o objecto que elas medem existe.

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

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 101 — a migration e o seu rollback, contra Postgres real
// ═══════════════════════════════════════════════════════════════════════════
//
// Uma migration que não se sabe desfazer é uma migration que não se deve
// aplicar. Isto é o ensaio do caminho de saída, não uma formalidade.

describe("🔴 101 — aplicar, desfazer, reaplicar", () => {
  it("correr a 101 duas vezes não parte nada", async () => {
    // Idempotência: o palco já a aplicou uma vez no beforeEach.
    await expect(pool.query(migrationCrm("101_crm_leads"))).resolves.toBeDefined();

    // E o pós-estado continua a dar-se por satisfeito — que é o que distingue
    // «não deu erro» de «ficou como se queria».
    await expect(pool.query(migrationCrm("101_crm_leads"))).resolves.toBeDefined();
  });

  it("🔴 ROLLBACK_101 — leva as tabelas e as RPC, e deixa o resto intacto", async () => {
    const clientesAntes = await contar(pool, "clients");
    const locaisAntes = await contar(pool, "locations");
    const perfisAntes = await contar(pool, "profiles");

    await pool.query(rollbackCrm("101_crm_leads"));

    const { rows: objetos } = await pool.query(`
      SELECT to_regclass('public.crm_leads')             AS leads,
             to_regclass('public.crm_lead_interactions') AS interacoes,
             to_regprocedure('public.move_crm_lead_stage_atomic(uuid,uuid,text,text,uuid,text,text)') AS mover,
             to_regprocedure('public.reorder_crm_leads_atomic(uuid,text,jsonb,uuid)') AS reordenar`);

    expect(objetos[0].leads).toBeNull();
    expect(objetos[0].interacoes).toBeNull();
    expect(objetos[0].mover).toBeNull();
    expect(objetos[0].reordenar).toBeNull();

    // 🔴 E NÃO leva nada que não seja seu. A 101 é aditiva: não toca em
    //    clientes, locais nem perfis, e o rollback também não pode tocar.
    expect(await contar(pool, "clients")).toBe(clientesAntes);
    expect(await contar(pool, "locations")).toBe(locaisAntes);
    expect(await contar(pool, "profiles")).toBe(perfisAntes);
  });

  it("reaplicar depois do rollback devolve o schema completo", async () => {
    await pool.query(rollbackCrm("101_crm_leads"));
    await pool.query(migrationCrm("101_crm_leads"));

    const id = await novaLead(pool);
    await mover({ leadId: id, de: "novo", para: "contactado" });

    expect((await lerLead(id)).stage).toBe("contactado");
    expect(await diario(id)).toBe(1);
  });
});
