// ============================================================================
// 104 — a conversão de uma lead, provada contra o schema REAL de produção
// ============================================================================
//
// 🔴 O que a versão anterior desta suite provava, e que NÃO chegava.
//
//    Provava que a RPC era idempotente. Mas a Server Action criava o cliente e
//    o local ANTES de a chamar, e commitava-os. Dois pedidos simultâneos
//    criavam DOIS clientes e DOIS locais antes de qualquer um chegar à RPC; a
//    RPC rejeitava o segundo, e o cliente que ele já tinha criado ficava lá.
//
//    «A RPC é idempotente» e «o fluxo é idempotente» não são a mesma coisa, e
//    a diferença entre as duas é onde nascem os registos duplicados que só se
//    descobrem semanas depois.
//
// Agora a RPC recebe os DADOS e cria tudo dentro da transação. Estas provas
// medem o que interessa: quantos clientes e locais EXISTEM no fim.
//
// Palco: a forma real do schema de produção — ver `crm-pg-harness.ts`.
// ============================================================================

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import {
  ACTOR,
  ACTOR_OUTRA,
  CLIENTE_B,
  EMPRESA,
  LOCAL_B,
  OUTRA,
  contar,
  erroDe,
  migrationCrm,
  montarPalcoCrm,
  novaLead,
  rollbackCrm,
} from "./helpers/crm-pg-harness";

const CONTAINER = `crmconv-${process.pid}`;

let container: PostgresContainer;
let pool: pg.Pool;

const ITENS = JSON.stringify([
  { description: "Avença mensal", quantity: 1, unit: "mes", unit_price: 300 },
]);

/** A conversão, com os dados do local — a assinatura nova. */
function converter(
  args: {
    leadId: string;
    quoteId?: string | null;
    empresa?: string;
    actor?: string;
    address?: string | null;
    locationName?: string | null;
    serviceType?: string | null;
    hourlyRate?: number | null;
  },
  db: pg.Pool | pg.Client = pool,
) {
  return db.query(
    `SELECT * FROM public.convert_crm_lead_atomic($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL)`,
    [
      args.empresa ?? EMPRESA,
      args.leadId,
      args.actor ?? ACTOR,
      args.quoteId ?? null,
      args.locationName ?? null,
      args.address === undefined ? "Rua da Lead, 10" : args.address,
      args.serviceType ?? null,
      args.hourlyRate ?? null,
    ],
  );
}

async function leadComMorada(nome = "Condomínio X", empresa = EMPRESA) {
  return novaLead(pool, {
    nome,
    empresa,
    campos: { address: "Rua da Lead, 10", email: "geral@cond.pt", phone: "912345678", nif: "501234567" },
  });
}

async function orcamentoAceite(leadId: string, empresa = EMPRESA, actor = ACTOR) {
  const { rows } = await pool.query(
    `SELECT * FROM public.create_crm_quote_with_items(
       $1, $2, NULL, NULL, 'ORC', 2026, current_date, '2030-12-31',
       'mensal', 0, true, 23, NULL, NULL, NULL, NULL, NULL, $3, $4::jsonb)`,
    [empresa, leadId, actor, ITENS],
  );
  const id = rows[0].quote_id as string;
  await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'enviado',NULL)", [empresa, id, actor]);
  await pool.query("SELECT public.set_crm_quote_status($1,$2,$3,'aceite',NULL)", [empresa, id, actor]);
  return id;
}

const lerLead = async (id: string) =>
  (await pool.query("SELECT * FROM public.crm_leads WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "crmconv",
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

describe("104 — a migration", () => {
  it("aplica-se sobre o schema real, e correr duas vezes não parte nada", async () => {
    await expect(pool.query(migrationCrm("104_crm_conversao_lead"))).resolves.toBeDefined();
  });

  it("🔴 a assinatura antiga não sobrevive — era o caminho não-atómico", async () => {
    const { rows } = await pool.query(`
      SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname='public' AND p.proname='link_crm_lead_conversion'
    `);
    expect(rows[0].n).toBe(0);
  });

  it("sem a 101, recusa-se a correr", async () => {
    await montarPalcoCrm(pool, { aplicarCrm: false });
    const erro = await erroDe(() => pool.query(migrationCrm("104_crm_conversao_lead")));
    expect(erro).toContain("CRM_CONV_104_PRECONDITION_FAILED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A — SUCESSO
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 A — conversão numa transação só", () => {
  it("cria exactamente um cliente e um local, e a lead aponta para eles", async () => {
    const leadId = await leadComMorada();
    const clientesAntes = await contar(pool, "clients");
    const locaisAntes = await contar(pool, "locations");

    const { rows } = await converter({ leadId });

    expect(await contar(pool, "clients"), "N+1").toBe(clientesAntes + 1);
    expect(await contar(pool, "locations"), "M+1").toBe(locaisAntes + 1);

    const lead = await lerLead(leadId);
    expect(lead.stage).toBe("ganho");
    expect(lead.won_at).not.toBeNull();
    expect(lead.converted_client_id).toBe(rows[0].client_id);
    expect(lead.converted_location_id).toBe(rows[0].location_id);
    expect(rows[0].ja_convertida).toBe(false);
  });

  it("os dados da lead chegam ao cliente e ao local", async () => {
    const leadId = await leadComMorada();
    const { rows } = await converter({ leadId, hourlyRate: 12.5, serviceType: "manutencao" });

    const c = (await pool.query("SELECT * FROM public.clients WHERE id = $1", [rows[0].client_id])).rows[0];
    expect(c.name).toBe("Condomínio X");
    expect(c.email).toBe("geral@cond.pt");
    expect(c.nif).toBe("501234567");
    expect(c.company_id).toBe(EMPRESA);

    const l = (await pool.query("SELECT * FROM public.locations WHERE id = $1", [rows[0].location_id])).rows[0];
    expect(l.address).toBe("Rua da Lead, 10");
    expect(Number(l.hourly_rate)).toBe(12.5);
    expect(l.service_type).toBe("manutencao");
    expect(l.client_id).toBe(rows[0].client_id);
  });

  it("a timeline recebe a última linha da história, na mesma transação", async () => {
    const leadId = await leadComMorada();
    await converter({ leadId });
    const { rows } = await pool.query(
      "SELECT kind, summary FROM public.crm_lead_interactions WHERE lead_id = $1", [leadId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("sistema");
  });

  it("o orçamento aceite passa a apontar para o cliente", async () => {
    const leadId = await leadComMorada();
    const quoteId = await orcamentoAceite(leadId);
    const { rows } = await converter({ leadId, quoteId });

    const q = (await pool.query("SELECT lead_id, client_id FROM public.crm_quotes WHERE id = $1", [quoteId])).rows[0];
    expect(q.client_id).toBe(rows[0].client_id);
    expect(q.lead_id).toBeNull();
  });

  it("converter sem orçamento funciona — há negócios fechados ao telefone", async () => {
    const leadId = await leadComMorada();
    await expect(converter({ leadId, quoteId: null })).resolves.toBeDefined();
    expect((await lerLead(leadId)).stage).toBe("ganho");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B — DOUBLE CLICK / CONCORRÊNCIA
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 B — double click e concorrência", () => {
  it("duas sessões simultâneas: UM cliente, UM local, UMA conversão", async () => {
    // É esta a prova que faltava. Não basta a segunda RPC devolver o existente
    // — tem de não ter criado nada antes de chegar lá.
    const leadId = await leadComMorada();
    const clientesAntes = await contar(pool, "clients");
    const locaisAntes = await contar(pool, "locations");

    const c1 = new pg.Client({ ...container.connection });
    const c2 = new pg.Client({ ...container.connection });
    await c1.connect();
    await c2.connect();

    let r1, r2;
    try {
      [r1, r2] = await Promise.all([
        converter({ leadId }, c1),
        converter({ leadId }, c2),
      ]);
    } finally {
      await c1.end();
      await c2.end();
    }

    expect(await contar(pool, "clients") - clientesAntes, "CLIENTS_CREATED").toBe(1);
    expect(await contar(pool, "locations") - locaisAntes, "LOCATIONS_CREATED").toBe(1);

    const { rows: leads } = await pool.query(
      "SELECT count(*)::int n FROM public.crm_leads WHERE id = $1 AND stage = 'ganho'", [leadId],
    );
    expect(leads[0].n, "LEAD_CONVERSIONS").toBe(1);

    // As duas respostas apontam para os MESMOS ids.
    expect(r1.rows[0].client_id).toBe(r2.rows[0].client_id);
    expect(r1.rows[0].location_id).toBe(r2.rows[0].location_id);

    // Exactamente uma delas criou; a outra encontrou já feito.
    const marcas = [r1.rows[0].ja_convertida, r2.rows[0].ja_convertida].sort();
    expect(marcas).toEqual([false, true]);
  });

  it("cinco sessões simultâneas continuam a dar um só cliente", async () => {
    const leadId = await leadComMorada();
    const antes = await contar(pool, "clients");

    const clientes = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const c = new pg.Client({ ...container.connection });
        await c.connect();
        return c;
      }),
    );

    try {
      const rs = await Promise.all(clientes.map((c) => converter({ leadId }, c)));
      const ids = new Set(rs.map((r) => r.rows[0].client_id));
      expect(ids.size, "todas apontam para o mesmo cliente").toBe(1);
    } finally {
      await Promise.all(clientes.map((c) => c.end()));
    }

    expect(await contar(pool, "clients") - antes).toBe(1);
  });

  it("a timeline não fica com uma linha por tentativa", async () => {
    const leadId = await leadComMorada();
    const c1 = new pg.Client({ ...container.connection });
    const c2 = new pg.Client({ ...container.connection });
    await c1.connect(); await c2.connect();
    try {
      await Promise.all([converter({ leadId }, c1), converter({ leadId }, c2)]);
    } finally {
      await c1.end(); await c2.end();
    }

    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM public.crm_lead_interactions WHERE lead_id = $1", [leadId],
    );
    expect(rows[0].n).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C — FAILURE INJECTION
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 C — falha depois do ponto de criação: ROLLBACK de tudo", () => {
  /**
   * Injecta a falha onde interessa: DEPOIS de o cliente e o local serem
   * criados, e ANTES de a transação fechar.
   *
   * O gatilho `AFTER INSERT` em `crm_lead_interactions` rebenta no passo 9 da
   * RPC — o último. Nessa altura, o cliente, o local, o UPDATE da lead e o do
   * orçamento já foram todos escritos.
   */
  async function comFalhaNoFim<T>(fn: () => Promise<T>): Promise<string | null> {
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.rebentar_no_fim() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'FALHA_INJECTADA_APOS_CRIACAO';
        END $$;
      CREATE TRIGGER trg_falha_injectada
        AFTER INSERT ON public.crm_lead_interactions
        FOR EACH ROW EXECUTE FUNCTION public.rebentar_no_fim();
    `);
    try {
      return await erroDe(fn);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS trg_falha_injectada ON public.crm_lead_interactions");
    }
  }

  it("CLIENT_DELTA=0, LOCATION_DELTA=0, LEAD_CONVERTED=NO, QUOTE=0, INTERACTION=0", async () => {
    const leadId = await leadComMorada();
    const quoteId = await orcamentoAceite(leadId);

    const clientes = await contar(pool, "clients");
    const locais = await contar(pool, "locations");
    const interacoes = await contar(pool, "crm_lead_interactions");
    const quoteAntes = (await pool.query(
      "SELECT lead_id, client_id FROM public.crm_quotes WHERE id=$1", [quoteId])).rows[0];

    const erro = await comFalhaNoFim(() => converter({ leadId, quoteId }));
    expect(erro).toContain("FALHA_INJECTADA_APOS_CRIACAO");

    expect(await contar(pool, "clients") - clientes, "CLIENT_DELTA").toBe(0);
    expect(await contar(pool, "locations") - locais, "LOCATION_DELTA").toBe(0);
    expect(await contar(pool, "crm_lead_interactions") - interacoes, "INTERACTION_DELTA").toBe(0);

    const lead = await lerLead(leadId);
    expect(lead.stage, "LEAD_CONVERTED").not.toBe("ganho");
    expect(lead.converted_client_id).toBeNull();
    expect(lead.converted_location_id).toBeNull();

    const quoteDepois = (await pool.query(
      "SELECT lead_id, client_id FROM public.crm_quotes WHERE id=$1", [quoteId])).rows[0];
    expect(quoteDepois.lead_id, "QUOTE_MUTATION").toBe(quoteAntes.lead_id);
    expect(quoteDepois.client_id).toBe(quoteAntes.client_id);
  });

  it("depois de a falha sair do caminho, a conversão funciona à primeira", async () => {
    const leadId = await leadComMorada();
    const erro = await comFalhaNoFim(() => converter({ leadId }));
    expect(erro).toBeTruthy();

    const antes = await contar(pool, "clients");
    await converter({ leadId });
    expect(await contar(pool, "clients") - antes).toBe(1);
    expect((await lerLead(leadId)).stage).toBe("ganho");
  });

  it("sem morada, nada é criado — a validação corre antes de escrever", async () => {
    const leadId = await novaLead(pool, { nome: "Sem morada" });
    const clientes = await contar(pool, "clients");

    const erro = await erroDe(() => converter({ leadId, address: null }));
    expect(erro).toContain("CONVERSION_ADDRESS_REQUIRED");
    expect(await contar(pool, "clients") - clientes).toBe(0);
    expect((await lerLead(leadId)).stage).toBe("novo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — RETRY
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 D — retry depois do sucesso", () => {
  it("NEW_CLIENTS=0, NEW_LOCATIONS=0, mesmos ids", async () => {
    const leadId = await leadComMorada();
    const primeira = await converter({ leadId });

    const clientes = await contar(pool, "clients");
    const locais = await contar(pool, "locations");

    const segunda = await converter({ leadId });

    expect(await contar(pool, "clients") - clientes, "NEW_CLIENTS").toBe(0);
    expect(await contar(pool, "locations") - locais, "NEW_LOCATIONS").toBe(0);
    expect(segunda.rows[0].client_id).toBe(primeira.rows[0].client_id);
    expect(segunda.rows[0].location_id).toBe(primeira.rows[0].location_id);
    expect(segunda.rows[0].ja_convertida).toBe(true);
  });

  it("o retry não acrescenta linhas à timeline", async () => {
    const leadId = await leadComMorada();
    await converter({ leadId });
    await converter({ leadId });
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM public.crm_lead_interactions WHERE lead_id = $1", [leadId]);
    expect(rows[0].n).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 2 — ORÇAMENTO DE OUTRA LEAD
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 orçamento de outra lead: REJECTED, com zero escritas", () => {
  it("a lead A não converte com o orçamento aceite da lead B", async () => {
    const leadA = await leadComMorada("Lead A");
    const leadB = await leadComMorada("Lead B");
    const quoteB = await orcamentoAceite(leadB);

    const clientes = await contar(pool, "clients");
    const locais = await contar(pool, "locations");
    const quoteAntes = (await pool.query(
      "SELECT lead_id, client_id, status FROM public.crm_quotes WHERE id=$1", [quoteB])).rows[0];

    const erro = await erroDe(() => converter({ leadId: leadA, quoteId: quoteB }));
    expect(erro, "WRONG_LEAD_ACCEPTED_QUOTE").toContain("QUOTE_LEAD_MISMATCH");

    expect(await contar(pool, "clients") - clientes, "CLIENT_DELTA").toBe(0);
    expect(await contar(pool, "locations") - locais, "LOCATION_DELTA").toBe(0);

    const leadDepois = await lerLead(leadA);
    expect(leadDepois.stage, "LEAD_CHANGE").toBe("novo");
    expect(leadDepois.converted_client_id).toBeNull();

    const quoteDepois = (await pool.query(
      "SELECT lead_id, client_id, status FROM public.crm_quotes WHERE id=$1", [quoteB])).rows[0];
    expect(quoteDepois, "QUOTE_CHANGE").toEqual(quoteAntes);
  });

  it("um orçamento por aceitar também não converte", async () => {
    const leadId = await leadComMorada();
    const { rows } = await pool.query(
      `SELECT * FROM public.create_crm_quote_with_items(
         $1,$2,NULL,NULL,'ORC',2026,current_date,'2030-12-31','mensal',0,true,23,
         NULL,NULL,NULL,NULL,NULL,$3,$4::jsonb)`,
      [EMPRESA, leadId, ACTOR, ITENS],
    );
    const clientes = await contar(pool, "clients");

    const erro = await erroDe(() => converter({ leadId, quoteId: rows[0].quote_id }));
    expect(erro).toContain("QUOTE_NOT_ACCEPTED");
    expect(await contar(pool, "clients") - clientes).toBe(0);
  });

  it("um orçamento de outra EMPRESA não é sequer encontrado", async () => {
    const leadA = await leadComMorada("Lead A");
    const leadB = await leadComMorada("Lead B", OUTRA);
    const quoteB = await orcamentoAceite(leadB, OUTRA, ACTOR_OUTRA);

    const erro = await erroDe(() => converter({ leadId: leadA, quoteId: quoteB }));
    expect(erro).toContain("QUOTE_NOT_FOUND");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ISOLAMENTO E PERMISSÕES
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 isolamento entre empresas", () => {
  it("a lead de outra empresa não é encontrada", async () => {
    const leadB = await leadComMorada("Lead B", OUTRA);
    const erro = await erroDe(() => converter({ leadId: leadB, empresa: EMPRESA }));
    expect(erro).toContain("LEAD_NOT_FOUND");
  });

  it("o cliente criado fica na empresa da lead, nunca noutra", async () => {
    const leadB = await leadComMorada("Lead B", OUTRA);
    const { rows } = await converter({ leadId: leadB, empresa: OUTRA, actor: ACTOR_OUTRA });
    const c = (await pool.query("SELECT company_id FROM public.clients WHERE id=$1", [rows[0].client_id])).rows[0];
    expect(c.company_id).toBe(OUTRA);
  });

  it("um cliente de outra empresa não pode ser ligado à lead (FK composta da 101)", async () => {
    const leadA = await leadComMorada();
    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads SET stage='ganho', won_at=now(),
                converted_client_id=$2, converted_location_id=$3 WHERE id=$1`,
        [leadA, CLIENTE_B, LOCAL_B],
      ),
    );
    expect(erro).toMatch(/crm_leads_cliente_mesma_empresa|violates foreign key/i);
  });

  it("🔴 authenticated não executa a RPC", async () => {
    const leadId = await leadComMorada();
    const c = new pg.Client({ ...container.connection });
    await c.connect();
    try {
      await c.query("SET ROLE authenticated");
      const erro = await erroDe(() => converter({ leadId }, c));
      expect(erro).toMatch(/permission denied/i);
    } finally {
      await c.end();
    }
  });
});

describe("104 — o rollback", () => {
  it("leva a função e não desfaz conversões", async () => {
    const leadId = await leadComMorada();
    const { rows } = await converter({ leadId });

    await pool.query(rollbackCrm("104_crm_conversao_lead"));

    const { rows: f } = await pool.query(`
      SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname='public' AND p.proname='convert_crm_lead_atomic'`);
    expect(f[0].n).toBe(0);

    // 🔴 O cliente convertido fica: pode já ter contrato e dinheiro cobrado.
    const lead = await lerLead(leadId);
    expect(lead.stage).toBe("ganho");
    expect(lead.converted_client_id).toBe(rows[0].client_id);
  });
});
