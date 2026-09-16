// ============================================================================
// O schema do CRM, provado contra um Postgres a sério
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
import {
  EMPRESA,
  OUTRA,
  CLIENTE_A,
  LOCAL_A,
  CLIENTE_B,
  LOCAL_B,
  ACTOR,
  ACTOR_OUTRA,
  comoUtilizador,
  montarPalcoCrm,
  novaLead,
} from "./helpers/crm-pg-harness";

const ROOT = process.cwd();
const CONTAINER = `crmschema-${process.pid}`;



let container: PostgresContainer;
let pool: pg.Pool;

const MIGRATION = () => readFileSync(join(ROOT, "supabase/migrations/101_crm_leads.sql"), "utf8");
const ROLLBACK = () =>
  readFileSync(join(ROOT, "supabase/migrations/rollback/101_crm_leads.down.sql"), "utf8");

const MIGRATION_102 = () =>
  readFileSync(join(ROOT, "supabase/migrations/102_crm_visitas_comerciais.sql"), "utf8");
const ROLLBACK_102 = () =>
  readFileSync(join(ROOT, "supabase/migrations/rollback/102_crm_visitas_comerciais.down.sql"), "utf8");
const ROLLBACK_103 = () =>
  readFileSync(join(ROOT, "supabase/migrations/rollback/103_crm_orcamentos.down.sql"), "utf8");
const ROLLBACK_104 = () =>
  readFileSync(join(ROOT, "supabase/migrations/rollback/104_crm_conversao_lead.down.sql"), "utf8");

/**
 * O que existe em produção ANTES da 101 — e só isso.
 *
 * Reproduzir aqui o mundo inteiro tornaria o teste uma cópia do schema; o que
 * interessa é exactamente aquilo de que a 101 diz depender, para que uma
 * dependência esquecida apareça como falha e não como sorte.
 */
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
    // 🔴 Cinco, e não duas: o palco aplica as QUATRO migrations do CRM, tal
    //    como aconteceria na base real. Provar a 101 isolada sobre um schema
    //    onde as outras não existem seria provar um mundo que nunca existe.
    expect(rows.map((r) => r.table_name)).toEqual([
      "crm_lead_interactions", "crm_leads", "crm_quote_items", "crm_quotes", "crm_visits",
    ]);
  });

  it("correr duas vezes não parte nada (é idempotente)", async () => {
    await expect(pool.query(MIGRATION())).resolves.toBeDefined();
  });

  it("o rollback deixa o schema como estava, sem tocar em clients nem locations", async () => {
    // 🔴 Pela ordem inversa: 104, 103, 102 e só depois 101. As outras
    //    migrations dependem das tabelas e chaves da 101, e um `down` fora de
    //    ordem falha com «other objects depend on it» — que é o próprio
    //    Postgres a dizer que a ordem importa.
    await pool.query(ROLLBACK_104());
    await pool.query(ROLLBACK_103());
    await pool.query(ROLLBACK_102());
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
    await baseline({ aplicarCrm: false });
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
    await baseline({ aplicarCrm: false });
    await pool.query("DROP FUNCTION public.fn_capture_history() CASCADE");

    const erro = await erroDe(() => pool.query(MIGRATION()));
    expect(erro).toContain("CRM_LEADS_101_PRECONDITION_FAILED");
    expect(erro).toContain("fn_capture_history");
  });
});

describe("101 — perder uma lead exige dizer porquê", () => {
  it("🔴 stage='perdido' sem motivo é recusado pela base", async () => {
    const id = await novaLead(pool);
    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_leads SET stage = 'perdido', lost_at = now() WHERE id = $1", [id]),
    );
    expect(erro).toContain("crm_leads_perdida_exige_motivo");
  });

  it("com motivo e data, passa", async () => {
    const id = await novaLead(pool);
    await expect(
      pool.query(
        `UPDATE public.crm_leads SET stage = 'perdido', lost_reason = 'preco', lost_at = now()
          WHERE id = $1`,
        [id],
      ),
    ).resolves.toBeDefined();
  });

  it("um motivo fora da lista não entra — é o que permite contá-los depois", async () => {
    const id = await novaLead(pool);
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
    const id = await novaLead(pool);
    const erro = await erroDe(() =>
      pool.query(
        `UPDATE public.crm_leads SET converted_client_id = $2, converted_location_id = $3 WHERE id = $1`,
        [id, CLIENTE_A, LOCAL_A],
      ),
    );
    expect(erro).toContain("crm_leads_conversao_so_se_ganha");
  });

  it("cliente sem local (ou local sem cliente) é uma conversão a meio, e é recusada", async () => {
    const id = await novaLead(pool);
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
    const id = await novaLead(pool);
    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_leads SET stage = 'ganho' WHERE id = $1", [id]),
    );
    expect(erro).toContain("crm_leads_ganha_exige_data");
  });

  it("ganho + data + cliente + local da mesma empresa passa", async () => {
    const id = await novaLead(pool);
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
    const id = await novaLead(pool);
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
    const leadDaOutra = await novaLead(pool, { empresa: OUTRA });
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
    const id = await novaLead(pool);
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
    const erro = await erroDe(() => novaLead(pool, { campos: { name: "   " } }));
    expect(erro).toContain("crm_leads_name_nao_vazio");
  });

  it("valor estimado negativo é recusado", async () => {
    const erro = await erroDe(() => novaLead(pool, { campos: { estimated_value: -1 } }));
    expect(erro).toContain("crm_leads_estimated_value_check");
  });

  it("a natureza do valor tem de ser dita, e por omissão é mensal", async () => {
    const id = await novaLead(pool, { campos: { estimated_value: 300 } });
    const { rows } = await pool.query(
      "SELECT estimated_value_kind FROM public.crm_leads WHERE id = $1",
      [id],
    );
    // 300 € pontuais e 300 €/mês não são o mesmo número; o campo nunca é nulo.
    expect(rows[0].estimated_value_kind).toBe("mensal");
  });

  it("uma lead nasce em 'novo'", async () => {
    const id = await novaLead(pool);
    const { rows } = await pool.query("SELECT stage, board_order FROM public.crm_leads WHERE id = $1", [id]);
    expect(rows[0].stage).toBe("novo");
    expect(rows[0].board_order).toBe(0);
  });

  it("updated_at acompanha a edição", async () => {
    const id = await novaLead(pool);
    const antes = (await pool.query("SELECT updated_at FROM public.crm_leads WHERE id = $1", [id]))
      .rows[0].updated_at;
    await pool.query("UPDATE public.crm_leads SET notes = 'nota' WHERE id = $1", [id]);
    const depois = (await pool.query("SELECT updated_at FROM public.crm_leads WHERE id = $1", [id]))
      .rows[0].updated_at;
    expect(depois.getTime()).toBeGreaterThanOrEqual(antes.getTime());
  });

  it("a edição fica registada no histórico", async () => {
    const id = await novaLead(pool);
    await pool.query("UPDATE public.crm_leads SET notes = 'combinou visita' WHERE id = $1", [id]);

    const { rows } = await pool.query(
      "SELECT op FROM public.data_history WHERE table_name = 'crm_leads' AND row_id = $1",
      [id],
    );
    expect(rows.map((r) => r.op)).toContain("UPDATE");
  });
});

describe("101 — quem pode ler e quem pode escrever", () => {
  /**
   * 🔴 A identidade vem de `auth.uid()`, como em produção.
   *
   *    O palco anterior inventava `current_setting('teste.company')` e as
   *    políticas do fixture nem sequer lhe tocavam — o ensaio media uma regra
   *    que a base real não tem. Agora define-se `request.jwt.claim.sub`, que é
   *    o que `auth.uid()` lê.
   */
  const comoGestoraA = <T,>(fn: (c: pg.Client) => Promise<T>) =>
    comoUtilizador(container.connection, { papel: "authenticated", userId: ACTOR }, fn);

  const comoGestoraB = <T,>(fn: (c: pg.Client) => Promise<T>) =>
    comoUtilizador(container.connection, { papel: "authenticated", userId: ACTOR_OUTRA }, fn);

  it("gestor da empresa lê as leads da sua empresa", async () => {
    await novaLead(pool);
    const r = await comoGestoraA((c) => c.query("SELECT count(*)::int n FROM public.crm_leads"));
    expect(r.rows[0].n).toBe(1);
  });

  it("🔴 gestor de outra empresa não vê nada", async () => {
    await novaLead(pool);
    const r = await comoGestoraB((c) => c.query("SELECT count(*)::int n FROM public.crm_leads"));
    expect(r.rows[0].n).toBe(0);
  });

  it("🔴 colaboradora não vê o funil comercial", async () => {
    await novaLead(pool);
    // A mesma empresa, outro papel: a política exige admin/gestor.
    await pool.query("UPDATE public.profiles SET role = 'colaborador' WHERE id = $1", [ACTOR]);
    const r = await comoGestoraA((c) => c.query("SELECT count(*)::int n FROM public.crm_leads"));
    expect(r.rows[0].n).toBe(0);
  });

  it("🔴 authenticated não escreve — nem sequer o gestor da própria empresa", async () => {
    const erro = await erroDe(() =>
      comoGestoraA((c) =>
        c.query("INSERT INTO public.crm_leads (company_id, name) VALUES ($1, 'Pelo browser')", [EMPRESA]),
      ),
    );
    expect(erro).toMatch(/permission denied|row-level security/i);
  });

  it("🔴 anon não lê nada", async () => {
    await novaLead(pool);
    const erro = await erroDe(() =>
      comoUtilizador(container.connection, { papel: "anon" }, (c) =>
        c.query("SELECT * FROM public.crm_leads"),
      ),
    );
    expect(erro).toMatch(/permission denied/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 102 — a visita comercial
// ═══════════════════════════════════════════════════════════════════════════

describe("102 — a visita comercial", () => {
  const AMANHA = "2026-09-16 10:00:00+01";
  const AMANHA_FIM = "2026-09-16 11:00:00+01";

  async function novaVisita(extra: Record<string, unknown> = {}) {
    const leadId = (extra.lead_id as string) ?? (await novaLead(pool));
    const campos: Record<string, unknown> = {
      company_id: EMPRESA,
      lead_id: leadId,
      scheduled_start: AMANHA,
      scheduled_end: AMANHA_FIM,
      ...extra,
    };
    const colunas = Object.keys(campos);
    const marcas = colunas.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await pool.query(
      `INSERT INTO public.crm_visits (${colunas.join(", ")}) VALUES (${marcas}) RETURNING id`,
      Object.values(campos),
    );
    return rows[0].id as string;
  }

  it("a migration corre, e correr duas vezes não parte nada", async () => {
    await expect(pool.query(MIGRATION_102())).resolves.toBeDefined();
  });

  it("sem a 101, recusa-se a correr", async () => {
    await baseline({ aplicarCrm: false });
    const erro = await erroDe(() => pool.query(MIGRATION_102()));
    expect(erro).toContain("CRM_VISITS_102_PRECONDITION_FAILED");
    expect(erro).toContain("crm_leads");
  });

  it("🔴 uma visita comercial não é um serviço: não tem equipa nem valor", async () => {
    // A ausência destas colunas é uma decisão, e o pós-estado da migration
    // falha se alguma aparecer. Aqui confirma-se no schema real.
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'crm_visits'
    `);
    const colunas = rows.map((r) => r.column_name);
    for (const proibida of ["team_id", "calculated_value", "payment_status", "hourly_rate"]) {
      expect(colunas, `crm_visits não pode ter ${proibida}`).not.toContain(proibida);
    }
  });

  it("🔴 exactamente um destinatário: lead ou cliente, nunca ambos", async () => {
    const leadId = await novaLead(pool);
    const erroAmbos = await erroDe(() =>
      novaVisita({ lead_id: leadId, client_id: CLIENTE_A }),
    );
    expect(erroAmbos).toContain("crm_visits_um_destinatario");

    const erroNenhum = await erroDe(() =>
      pool.query(
        `INSERT INTO public.crm_visits (company_id, scheduled_start, scheduled_end)
         VALUES ($1, $2, $3)`,
        [EMPRESA, AMANHA, AMANHA_FIM],
      ),
    );
    expect(erroNenhum).toContain("crm_visits_um_destinatario");
  });

  it("a um cliente existente também se pode ir — é uma proposta de serviço novo", async () => {
    await expect(
      pool.query(
        `INSERT INTO public.crm_visits (company_id, client_id, scheduled_start, scheduled_end)
         VALUES ($1, $2, $3, $4)`,
        [EMPRESA, CLIENTE_A, AMANHA, AMANHA_FIM],
      ),
    ).resolves.toBeDefined();
  });

  it("uma janela que acaba antes de começar é recusada", async () => {
    const erro = await erroDe(() =>
      novaVisita({ scheduled_start: AMANHA_FIM, scheduled_end: AMANHA }),
    );
    expect(erro).toContain("crm_visits_janela_valida");
  });

  it("dar uma visita como realizada exige a data", async () => {
    const id = await novaVisita();
    const erro = await erroDe(() =>
      pool.query("UPDATE public.crm_visits SET status = 'realizada' WHERE id = $1", [id]),
    );
    expect(erro).toContain("crm_visits_realizada_tem_data");
  });

  it("'não compareceu' é um estado próprio, e não um cancelamento", async () => {
    const id = await novaVisita();
    // Não exige data: quem não apareceu não produziu nenhum momento a datar.
    await expect(
      pool.query("UPDATE public.crm_visits SET status = 'nao_compareceu' WHERE id = $1", [id]),
    ).resolves.toBeDefined();
  });

  it("o que se mede no local fica guardado, e recusa valores impossíveis", async () => {
    const id = await novaVisita();
    await pool.query(
      `UPDATE public.crm_visits
          SET status = 'realizada', completed_at = now(),
              area_sqm = 240.5, estimated_hours = 3.5,
              frequency_hint = '2x por semana', outcome_notes = 'Escadas e 3 pisos'
        WHERE id = $1`,
      [id],
    );
    const { rows } = await pool.query("SELECT area_sqm, estimated_hours FROM public.crm_visits WHERE id = $1", [id]);
    expect(Number(rows[0].area_sqm)).toBe(240.5);
    expect(Number(rows[0].estimated_hours)).toBe(3.5);

    const erro = await erroDe(() => novaVisita({ area_sqm: 0 }));
    expect(erro).toContain("crm_visits_area_sqm_check");
  });

  it("🔴 uma visita não pode ser marcada à lead de outra empresa", async () => {
    const leadDaOutra = await novaLead(pool, { empresa: OUTRA });
    const erro = await erroDe(() => novaVisita({ lead_id: leadDaOutra }));
    expect(erro).toContain("crm_visits_lead_mesma_empresa");
  });

  it("apagar a lead leva as visitas dela", async () => {
    const leadId = await novaLead(pool);
    await novaVisita({ lead_id: leadId });
    await pool.query("DELETE FROM public.crm_leads WHERE id = $1", [leadId]);
    const { rows } = await pool.query("SELECT count(*)::int n FROM public.crm_visits");
    expect(rows[0].n).toBe(0);
  });

  it("🔴 um cliente com visitas não desaparece por baixo delas", async () => {
    await pool.query(
      `INSERT INTO public.crm_visits (company_id, client_id, scheduled_start, scheduled_end)
       VALUES ($1, $2, $3, $4)`,
      [EMPRESA, CLIENTE_A, AMANHA, AMANHA_FIM],
    );
    // RESTRICT, e não CASCADE: apagar um cliente não pode levar em silêncio o
    // histórico comercial que explica como ele apareceu.
    const erro = await erroDe(() =>
      pool.query("DELETE FROM public.clients WHERE id = $1", [CLIENTE_A]),
    );
    expect(erro).toMatch(/crm_visits_cliente_mesma_empresa|violates foreign key/i);
  });

  it("o rollback leva a tabela e deixa as leads onde estão", async () => {
    await novaVisita();

    // 🔴 Pela ordem inversa. `crm_quotes.visit_id` é uma FK composta para
    //    `crm_visits`, por isso a 103 tem de sair primeiro — o Postgres recusa
    //    com «other objects depend on it», que é ele a confirmar a dependência.
    await pool.query(ROLLBACK_104());
    await pool.query(ROLLBACK_103());
    await pool.query(ROLLBACK_102());

    const { rows: t } = await pool.query(`
      SELECT count(*)::int n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'crm_visits'
    `);
    expect(t[0].n).toBe(0);

    const { rows: l } = await pool.query("SELECT count(*)::int n FROM public.crm_leads");
    expect(l[0].n).toBe(1);
  });
});
