// ============================================================================
// CRM — a visita comercial, do lado do código
// ============================================================================
//
// A prova de que a tabela existe e recusa o que deve recusar está em
// `crm-schema.pg.test.ts`, contra um Postgres a sério. Aqui prova-se o que é
// código puro: que as listas não divergiram da migration, e que as actions
// mantêm as propriedades que as tornam seguras.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  VISIT_STATUSES,
  VISIT_CLOSING_STATUSES,
  VISIT_OPEN_STATUS,
  VISIT_STATUS_LABELS,
  VISIT_STATUS_COLORS,
  VISIT_DEFAULT_DURATION_MIN,
  isVisitStatus,
  isVisitClosed,
  requiresCompletionDate,
  requiresCancellationDate,
} from "@/lib/crm/visits";
import { CRM_VIEWS } from "@/components/crm/crm-nav";

const ROOT = process.cwd();
const ler = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SQL = ler("supabase/migrations/102_crm_visitas_comerciais.sql");
const ACTIONS = ler("src/app/actions/crm-visitas.ts");

function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("CRM visitas — paridade com a migration 102", () => {
  it("os estados são exactamente os do CHECK", () => {
    const m = SQL.match(/status\s+text NOT NULL DEFAULT 'agendada'[\s\S]{0,200}?IN \(([^)]*)\)/);
    expect(m, "CHECK de status não encontrado na 102").not.toBeNull();
    const naBase = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...VISIT_STATUSES].sort()).toEqual(naBase.sort());
  });

  it("uma visita nasce agendada", () => {
    expect(SQL).toContain("DEFAULT 'agendada'");
    expect(VISIT_STATUSES[0]).toBe("agendada");
  });
});

describe("CRM visitas — o vocabulário", () => {
  it("cada estado tem etiqueta e cor", () => {
    expect(Object.keys(VISIT_STATUS_LABELS).sort()).toEqual([...VISIT_STATUSES].sort());
    expect(Object.keys(VISIT_STATUS_COLORS).sort()).toEqual([...VISIT_STATUSES].sort());
  });

  it("🔴 'não compareceu' é distinto de 'cancelada'", () => {
    // Quem marca e não aparece diz alguma coisa sobre a oportunidade que um
    // cancelamento combinado não diz. Fundir os dois perderia isso.
    expect(VISIT_STATUS_LABELS.nao_compareceu).not.toBe(VISIT_STATUS_LABELS.cancelada);
    expect(VISIT_STATUSES).toContain("nao_compareceu");
    expect(VISIT_STATUSES).toContain("cancelada");
  });

  it("a guarda de tipo recusa o que não conhece", () => {
    expect(isVisitStatus("realizada")).toBe(true);
    expect(isVisitStatus("feita")).toBe(false);
    for (const v of [null, undefined, 1, {}, []]) expect(isVisitStatus(v)).toBe(false);
  });

  it("só 'agendada' está por acontecer", () => {
    expect(isVisitClosed("agendada")).toBe(false);
    for (const s of VISIT_STATUSES) {
      if (s === "agendada") continue;
      expect(isVisitClosed(s), `${s} devia estar fechada`).toBe(true);
    }
  });

  it("a duração por omissão é uma hora", () => {
    expect(VISIT_DEFAULT_DURATION_MIN).toBe(60);
  });
});

describe("CRM visitas — o que cada desfecho exige espelha os CHECK", () => {
  it("realizada exige data de conclusão; cancelada exige data de cancelamento", () => {
    expect(requiresCompletionDate("realizada")).toBe(true);
    expect(requiresCancellationDate("cancelada")).toBe(true);

    expect(SQL).toContain("crm_visits_realizada_tem_data");
    expect(SQL).toContain("crm_visits_cancelada_tem_data");
  });

  it("'não compareceu' não exige data — não houve momento a datar", () => {
    expect(requiresCompletionDate("nao_compareceu")).toBe(false);
    expect(requiresCancellationDate("nao_compareceu")).toBe(false);
  });
});

describe("CRM visitas — a fronteira com a operação", () => {
  const CODIGO = semComentarios(ACTIONS);

  it("🔴 a action nunca cria serviços, contratos nem locais", () => {
    // Marcar uma visita não pode fazer aparecer trabalho a fingir no
    // calendário, na escala ou nas cobranças. É a razão de `crm_visits`
    // existir como tabela própria.
    for (const tabela of ["services", "contracts", "locations", "invoices", "cash_flow_entries"]) {
      expect(CODIGO, `as visitas não podem escrever em ${tabela}`).not.toContain(`.from("${tabela}")`);
    }
  });

  it("🔴 a tabela não tem equipa, valor, nem estado de pagamento", () => {
    // O pós-estado da migration também falha se aparecerem. Aqui garante-se
    // que ninguém as acrescenta ao ficheiro sem reparar.
    for (const coluna of ["team_id", "calculated_value", "payment_status", "hourly_rate"]) {
      expect(SQL, `crm_visits não pode ter ${coluna}`).not.toMatch(
        new RegExp(`^\\s+${coluna}\\s+`, "m"),
      );
    }
  });

  it("a migration diz por escrito que uma visita não é um serviço", () => {
    // O comentário da tabela é o que sobrevive a este ficheiro e é lido por
    // quem abrir a base daqui a dois anos.
    expect(SQL).toMatch(/COMMENT ON TABLE public\.crm_visits/);
    expect(SQL).toMatch(/NAO e um servico/i);
  });
});

describe("CRM visitas — as actions", () => {
  const CODIGO = semComentarios(ACTIONS);

  it("só exporta funções", () => {
    const objetos = [...CODIGO.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)].map((m) => m[1]);
    expect(objetos).toEqual([]);
    expect(ACTIONS.trimStart().startsWith('"use server"')).toBe(true);
  });

  it("toda a action passa pelo guard e filtra a empresa", () => {
    for (const fn of ["getVisits", "scheduleVisit", "setVisitOutcome"]) {
      expect(CODIGO, `${fn} em falta`).toContain(`export async function ${fn}`);
    }
    const chamadas = CODIGO.match(/requireProfile\(/g) ?? [];
    expect(chamadas.length).toBe(3);
    expect(CODIGO).toContain('eq("company_id", profile.company_id)');
  });

  // 🔴 `rescheduleVisit` existia na branch ampla e nenhum ecrã lhe chamava.
  //    Trazer código morto por arrasto é trazer superfície que ninguém revê —
  //    e, neste caso, uma superfície que reagendaria uma visita já fechada,
  //    porque não tinha guarda de estado nenhuma. Entra quando houver UX de
  //    reagendamento, e com compare-and-set.
  it("🔴 não traz reagendamento por arrasto", () => {
    expect(CODIGO).not.toContain("rescheduleVisit");
  });
});

describe("CRM visitas — fechar é de ida", () => {
  const CODIGO = semComentarios(ACTIONS);

  it("os desfechos não incluem 'agendada'", () => {
    expect([...VISIT_CLOSING_STATUSES]).toEqual(["realizada", "nao_compareceu", "cancelada"]);
    expect(VISIT_CLOSING_STATUSES as readonly string[]).not.toContain(VISIT_OPEN_STATUS);
  });

  it("os desfechos são os estados todos menos o inicial", () => {
    expect([VISIT_OPEN_STATUS, ...VISIT_CLOSING_STATUSES].sort())
      .toEqual([...VISIT_STATUSES].sort());
  });

  // 🔴 O defeito: a versão anterior lia a visita e só depois gravava. Dois
  //    gestores a fechar ao mesmo tempo liam ambos `agendada` e a segunda
  //    escrita ganhava em silêncio. A prova de que a corrida está fechada é
  //    em Postgres real, em `crm-visitas-runtime.pg.test.ts`; aqui garante-se
  //    que a condição não desaparece do código sem se dar por isso.
  it("🔴 o fecho traz a guarda de concorrência no próprio UPDATE", () => {
    expect(CODIGO).toContain('eq("status", VISIT_OPEN_STATUS)');
    expect(CODIGO).toContain("ACTION_ERROR_CODES.CONFLICT");
  });

  it("🔴 o desfecho não aceita 'agendada' como destino", () => {
    expect(CODIGO).toContain("z.enum(VISIT_CLOSING_STATUSES)");
    expect(CODIGO).not.toContain("z.enum(VISIT_STATUSES)");
  });
});

describe("CRM visitas — o que NÃO entra nesta unidade", () => {
  const CODIGO = semComentarios(ACTIONS);

  // 🔴 A notificação era best-effort e o retry/dedup continua por resolver.
  //    Um efeito externo que às vezes acontece é pior do que nenhum: ninguém
  //    sabe em qual dos dois casos está.
  it("🔴 não há notificação externa nesta PR", () => {
    expect(CODIGO).not.toContain("notifyUser");
    expect(CODIGO).not.toContain("crm_visit_assigned");
  });

  it("🔴 nada de orçamentos — isso é a 103", () => {
    for (const proibido of ["crm_quotes", "crm_quote_items", "crm-orcamentos"]) {
      expect(CODIGO, `${proibido} não pertence a esta unidade`).not.toContain(proibido);
    }
  });

  it("os tipos trazem crm_visits e não os da 103", () => {
    const tipos = ler("src/types/database.ts");
    expect(tipos).toContain("crm_visits: {");
    expect(tipos).not.toContain("crm_quotes: {");
    expect(tipos).not.toContain("crm_quote_items: {");
  });
});

describe("CRM visitas — a navegação", () => {
  const CODIGO = semComentarios(ACTIONS);

  it("o CRM mostra Pipeline e Visitas", () => {
    expect(CRM_VIEWS.map((v) => v.href)).toEqual([
      "/dashboard/crm",
      "/dashboard/crm/visitas",
    ]);
  });

  it("🔴 Orçamentos ainda não aparece — crm_quotes não existe em produção", () => {
    expect(CRM_VIEWS.map((v) => v.href)).not.toContain("/dashboard/crm/orcamentos");
  });

  it("🔴 cada vista tem página no repositório", () => {
    for (const { href, label } of CRM_VIEWS) {
      const rota = href.replace(/^\/dashboard/, "src/app/(dashboard)/dashboard");
      let existe = true;
      try {
        ler(`${rota}/page.tsx`);
      } catch {
        existe = false;
      }
      expect(existe, `«${label}» aponta para ${href}, que não tem page.tsx`).toBe(true);
    }
  });

  it("o erro cru do Supabase nunca chega ao ecrã", () => {
    expect(CODIGO).not.toMatch(/error:\s*error\.message/);
    expect(CODIGO).toContain("internalFailure(");
  });

  it("a revalidação passa pelo helper central", () => {
    expect(CODIGO).not.toContain("revalidatePath(");
    expect(CODIGO).toContain("invalidateBusinessState(");
  });

  it("nunca select(\"*\")", () => {
    expect(CODIGO).not.toContain('select("*")');
  });
});
