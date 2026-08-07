// ============================================================================
// IDENTIDADE DE OCORRÊNCIA E IDEMPOTÊNCIA (Task T08)
// ============================================================================
// O defeito concreto que motivou este bloco:
//
//   1. contrato semanal à quarta-feira gera o serviço de 08/07;
//   2. a gestora arrasta essa visita para sexta, 10/07 (is_exception = true);
//   3. o cron mensal corre outra vez;
//   4. a verificação de duplicado procura "serviço deste contrato no dia
//      08/07" — e já não existe nenhum, porque o serviço foi movido;
//   5. o cron cria um serviço NOVO a 08/07.
//
// A mesma ocorrência lógica passa a existir duas vezes. A causa é a chave
// usada para a identidade: `scheduled_start` é estado mutável.
//
// Todos os identificadores destes testes são sintéticos.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  classifyService,
  decideEnsure,
  createsService,
  identityOf,
  occurrenceKey,
  sameOccurrence,
  type ServiceRecord,
  type OccurrenceIdentity,
} from "@/domain/scheduling/occurrence-identity";

const EMPRESA = "empresa-1";
const CONTRATO = "contrato-1";

function servico(over: Partial<ServiceRecord> & { id: string }): ServiceRecord {
  return {
    companyId: EMPRESA,
    contractId: CONTRATO,
    occurrenceDate: null,
    scheduledDate: "2026-07-08",
    status: "agendado",
    isException: false,
    originalDate: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...over,
  };
}

const identidade = (date: string): OccurrenceIdentity => ({
  companyId: EMPRESA,
  contractId: CONTRATO,
  occurrenceDate: date,
});

// ─── a identidade em si ─────────────────────────────────────────────────────

describe("identidade", () => {
  it("é (empresa, contrato, data canónica)", () => {
    expect(occurrenceKey(identidade("2026-07-08"))).toBe("empresa-1|contrato-1|2026-07-08");
  });

  it("distingue empresas diferentes com o mesmo contrato e data", () => {
    const a = identidade("2026-07-08");
    const b = { ...a, companyId: "empresa-2" };
    expect(sameOccurrence(a, b)).toBe(false);
  });

  it("distingue contratos diferentes na mesma data", () => {
    expect(sameOccurrence(identidade("2026-07-08"), {
      ...identidade("2026-07-08"), contractId: "contrato-2",
    })).toBe(false);
  });

  it("serviço avulso não tem identidade de ocorrência", () => {
    expect(identityOf(servico({ id: "s1", contractId: null, occurrenceDate: "2026-07-08" }))).toBeNull();
  });

  it("serviço por preencher (backfill pendente) não tem identidade", () => {
    expect(identityOf(servico({ id: "s1", occurrenceDate: null }))).toBeNull();
  });

  it("data de identidade corrompida não conta como identidade", () => {
    expect(identityOf(servico({ id: "s1", occurrenceDate: "72026-01-01" }))).toBeNull();
    expect(identityOf(servico({ id: "s2", occurrenceDate: "2026-02-30" }))).toBeNull();
  });
});

// ─── a identidade sobrevive às mudanças de estado ───────────────────────────

describe("a identidade não muda quando o serviço muda", () => {
  const casos: Array<[string, Partial<ServiceRecord>]> = [
    ["reagendado para outro dia", { scheduledDate: "2026-07-10", isException: true }],
    ["horário alterado no mesmo dia", { isException: true }],
    ["equipa alterada", { isException: true }],
    ["marcado como falta", { status: "falta" }],
    ["concluído", { status: "concluido" }],
    ["em curso", { status: "em_curso" }],
    ["sem cobertura", { status: "sem_cobertura" }],
  ];

  it.each(casos)("%s mantém a identidade", (_nome, mudanca) => {
    const antes = servico({ id: "s1", occurrenceDate: "2026-07-08" });
    const depois = servico({ id: "s1", occurrenceDate: "2026-07-08", ...mudanca });
    expect(identityOf(depois)).toEqual(identityOf(antes));
  });
});

// ─── decisão de idempotência ────────────────────────────────────────────────

describe("decideEnsure", () => {
  it("cria quando não existe nada", () => {
    const d = decideEnsure({ identity: identidade("2026-07-08"), existing: [] });
    expect(d.action).toBe("CREATE");
    expect(createsService(d.action)).toBe(true);
  });

  it("não duplica quando já existe", () => {
    const d = decideEnsure({
      identity: identidade("2026-07-08"),
      existing: [servico({ id: "s1", occurrenceDate: "2026-07-08" })],
    });
    expect(d.action).toBe("SKIP_EXISTS");
    expect(createsService(d.action)).toBe(false);
  });

  it("🔴 REGRESSÃO: um serviço REAGENDADO impede a recriação na data canónica", () => {
    // Este é o defeito que a T08 fecha. Com a identidade, o serviço movido
    // para 10/07 continua a ocupar a ocorrência de 08/07.
    const movido = servico({
      id: "s1", occurrenceDate: "2026-07-08", scheduledDate: "2026-07-10", isException: true,
    });
    const d = decideEnsure({ identity: identidade("2026-07-08"), existing: [movido] });
    expect(d.action).toBe("SKIP_EXCEPTION");
    expect(createsService(d.action)).toBe(false);
  });

  it("uma ocorrência cancelada não é recriada", () => {
    const d = decideEnsure({
      identity: identidade("2026-07-08"),
      existing: [servico({ id: "s1", occurrenceDate: "2026-07-08", status: "cancelado" })],
    });
    expect(d.action).toBe("SKIP_CANCELLED");
  });

  it("uma data excluída à mão não é recriada, mesmo sem serviço nenhum", () => {
    const d = decideEnsure({
      identity: identidade("2026-07-08"),
      existing: [],
      excludedDates: ["2026-07-08"],
    });
    expect(d.action).toBe("SKIP_EXCLUDED");
  });

  it("a exclusão vence sobre tudo o resto", () => {
    const d = decideEnsure({
      identity: identidade("2026-07-08"),
      existing: [servico({ id: "s1", occurrenceDate: "2026-07-08" })],
      excludedDates: ["2026-07-08"],
    });
    expect(d.action).toBe("SKIP_EXCLUDED");
  });

  it("dois serviços com a mesma identidade exigem decisão humana", () => {
    const d = decideEnsure({
      identity: identidade("2026-07-08"),
      existing: [
        servico({ id: "s1", occurrenceDate: "2026-07-08" }),
        servico({ id: "s2", occurrenceDate: "2026-07-08" }),
      ],
    });
    expect(d.action).toBe("CONFLICT_MANUAL");
    expect(d.matches).toHaveLength(2);
  });

  it("serviços de outras datas do mesmo contrato não interferem", () => {
    const d = decideEnsure({
      identity: identidade("2026-07-15"),
      existing: [
        servico({ id: "s1", occurrenceDate: "2026-07-08" }),
        servico({ id: "s2", occurrenceDate: "2026-07-22" }),
      ],
    });
    expect(d.action).toBe("CREATE");
  });

  it("serviços por preencher não bloqueiam a criação", () => {
    // Antes do backfill, `occurrence_date` é NULL e não reclama identidade.
    const d = decideEnsure({
      identity: identidade("2026-07-08"),
      existing: [servico({ id: "s1", occurrenceDate: null, scheduledDate: "2026-07-08" })],
    });
    expect(d.action).toBe("CREATE");
  });

  it("nunca decide apagar", () => {
    const acoes = new Set<string>();
    for (const existing of [
      [],
      [servico({ id: "s1", occurrenceDate: "2026-07-08" })],
      [servico({ id: "s1", occurrenceDate: "2026-07-08", status: "cancelado" })],
      [servico({ id: "s1", occurrenceDate: "2026-07-08", isException: true })],
    ]) {
      acoes.add(decideEnsure({ identity: identidade("2026-07-08"), existing }).action);
    }
    for (const acao of acoes) {
      expect(acao).not.toMatch(/DELETE|REMOVE/);
    }
  });
});

// ─── concorrência ───────────────────────────────────────────────────────────

/**
 * Base simulada com o índice único parcial da T08. Reproduz a garantia real:
 * o segundo INSERT com a mesma identidade colide, mesmo que os dois processos
 * tenham lido "não existe" antes.
 */
class BaseSimulada {
  private readonly linhas = new Map<string, ServiceRecord>();
  public conflitos = 0;

  snapshot(): ServiceRecord[] {
    return [...this.linhas.values()];
  }

  /** Devolve `false` quando o índice único rejeita — não é erro, é idempotência. */
  inserir(service: ServiceRecord): boolean {
    const identity = identityOf(service);
    if (identity === null) {
      this.linhas.set(service.id, service);
      return true;
    }
    const chave = occurrenceKey(identity);
    if ([...this.linhas.values()].some((s) => {
      const outra = identityOf(s);
      return outra !== null && occurrenceKey(outra) === chave;
    })) {
      this.conflitos++;
      return false; // ON CONFLICT ... DO NOTHING
    }
    this.linhas.set(service.id, service);
    return true;
  }
}

/** Um gerador: lê o estado, decide, tenta inserir. */
function gerar(base: BaseSimulada, date: string, id: string, excluded: string[] = []): void {
  const decisao = decideEnsure({
    identity: identidade(date),
    existing: base.snapshot(),
    excludedDates: excluded,
  });
  if (!createsService(decisao.action)) return;
  base.inserir(servico({ id, occurrenceDate: date, scheduledDate: date }));
}

describe("concorrência", () => {
  it("dois geradores em simultâneo não duplicam", () => {
    const base = new BaseSimulada();
    // Os dois leem o estado ANTES de qualquer escrita — a janela de corrida.
    const estadoInicial = base.snapshot();
    const a = decideEnsure({ identity: identidade("2026-07-08"), existing: estadoInicial });
    const b = decideEnsure({ identity: identidade("2026-07-08"), existing: estadoInicial });
    expect(a.action).toBe("CREATE");
    expect(b.action).toBe("CREATE"); // ambos julgam que têm de criar

    // A base é que decide.
    expect(base.inserir(servico({ id: "s1", occurrenceDate: "2026-07-08" }))).toBe(true);
    expect(base.inserir(servico({ id: "s2", occurrenceDate: "2026-07-08" }))).toBe(false);

    expect(base.snapshot()).toHaveLength(1);
    expect(base.conflitos).toBe(1);
  });

  it("o cron a correr duas vezes é inofensivo", () => {
    const base = new BaseSimulada();
    for (const volta of [1, 2]) gerar(base, "2026-07-08", `cron-${volta}`);
    expect(base.snapshot()).toHaveLength(1);
  });

  it("cron + updateContrato ao mesmo tempo não duplicam", () => {
    const base = new BaseSimulada();
    gerar(base, "2026-07-08", "cron");
    gerar(base, "2026-07-08", "action");
    expect(base.snapshot()).toHaveLength(1);
  });

  it("repetir depois de um timeout (resposta desconhecida) não duplica", () => {
    const base = new BaseSimulada();
    // A primeira tentativa gravou, mas o cliente não chegou a saber.
    base.inserir(servico({ id: "s1", occurrenceDate: "2026-07-08" }));
    // O retry usa outro id porque não sabe o que aconteceu.
    expect(base.inserir(servico({ id: "s2", occurrenceDate: "2026-07-08" }))).toBe(false);
    expect(base.snapshot()).toHaveLength(1);
  });

  it("dez tentativas concorrentes produzem exatamente uma linha", () => {
    const base = new BaseSimulada();
    for (let i = 0; i < 10; i++) {
      base.inserir(servico({ id: `s${i}`, occurrenceDate: "2026-07-08" }));
    }
    expect(base.snapshot()).toHaveLength(1);
    expect(base.conflitos).toBe(9);
  });

  it("serviços avulsos continuam a poder repetir-se no mesmo dia", () => {
    const base = new BaseSimulada();
    base.inserir(servico({ id: "m1", contractId: null, occurrenceDate: null }));
    base.inserir(servico({ id: "m2", contractId: null, occurrenceDate: null }));
    expect(base.snapshot()).toHaveLength(2);
  });

  it("ocorrências diferentes do mesmo contrato coexistem", () => {
    const base = new BaseSimulada();
    for (const d of ["2026-07-08", "2026-07-15", "2026-07-22"]) gerar(base, d, `s-${d}`);
    expect(base.snapshot()).toHaveLength(3);
  });

  it("a geração é retry-safe: repetir o lote todo não muda nada", () => {
    const base = new BaseSimulada();
    const datas = ["2026-07-08", "2026-07-15", "2026-07-22"];
    for (const d of datas) gerar(base, d, `a-${d}`);
    const primeiro = base.snapshot().map((s) => s.occurrenceDate).sort();
    for (const d of datas) gerar(base, d, `b-${d}`);
    expect(base.snapshot().map((s) => s.occurrenceDate).sort()).toEqual(primeiro);
  });
});

// ─── classificação para o backfill ──────────────────────────────────────────

describe("classifyService", () => {
  const canonicas = ["2026-07-01", "2026-07-08", "2026-07-15"];

  it("agendado na data canónica é NORMAL e propõe a data", () => {
    const c = classifyService({
      service: servico({ id: "s1", scheduledDate: "2026-07-08" }),
      contractExists: true, canonicalDates: canonicas, siblings: [],
    });
    expect(c.class).toBe("NORMAL");
    expect(c.proposedOccurrenceDate).toBe("2026-07-08");
  });

  it("exceção que ficou na data canónica continua inequívoca", () => {
    const c = classifyService({
      service: servico({ id: "s1", scheduledDate: "2026-07-08", isException: true }),
      contractExists: true, canonicalDates: canonicas, siblings: [],
    });
    expect(c.class).toBe("NORMAL");
    expect(c.proposedOccurrenceDate).toBe("2026-07-08");
  });

  it("🔴 exceção movida para fora da data canónica NÃO é adivinhada", () => {
    // `original_date` seria a evidência, mas nenhum código a escreve.
    const c = classifyService({
      service: servico({ id: "s1", scheduledDate: "2026-07-10", isException: true }),
      contractExists: true, canonicalDates: canonicas, siblings: [],
    });
    expect(c.class).toBe("RESCHEDULED");
    expect(c.proposedOccurrenceDate).toBeNull();
  });

  it("data fora do padrão sem ser exceção é inconsistente", () => {
    const c = classifyService({
      service: servico({ id: "s1", scheduledDate: "2026-07-09" }),
      contractExists: true, canonicalDates: canonicas, siblings: [],
    });
    expect(c.class).toBe("DATE_INCONSISTENT");
    expect(c.proposedOccurrenceDate).toBeNull();
  });

  it("dois serviços no mesmo dia são candidatos a duplicado", () => {
    const a = servico({ id: "s1", scheduledDate: "2026-07-08" });
    const b = servico({ id: "s2", scheduledDate: "2026-07-08" });
    const c = classifyService({
      service: a, contractExists: true, canonicalDates: canonicas, siblings: [a, b],
    });
    expect(c.class).toBe("DUPLICATE_CANDIDATE");
  });

  it("cancelado na data canónica preserva a identidade", () => {
    const c = classifyService({
      service: servico({ id: "s1", scheduledDate: "2026-07-08", status: "cancelado" }),
      contractExists: true, canonicalDates: canonicas, siblings: [],
    });
    expect(c.class).toBe("CANCELLED");
    expect(c.proposedOccurrenceDate).toBe("2026-07-08");
  });

  it("cancelado fora da data canónica fica indeterminado", () => {
    const c = classifyService({
      service: servico({ id: "s1", scheduledDate: "2026-07-09", status: "cancelado" }),
      contractExists: true, canonicalDates: canonicas, siblings: [],
    });
    expect(c.proposedOccurrenceDate).toBeNull();
  });

  it("serviço avulso fica fora do âmbito", () => {
    const c = classifyService({
      service: servico({ id: "s1", contractId: null }),
      contractExists: false, canonicalDates: [], siblings: [],
    });
    expect(c.class).toBe("STANDALONE");
    expect(c.proposedOccurrenceDate).toBeNull();
  });

  it("contrato inexistente é sinalizado, não inventado", () => {
    const c = classifyService({
      service: servico({ id: "s1" }),
      contractExists: false, canonicalDates: [], siblings: [],
    });
    expect(c.class).toBe("MISSING_CONTRACT");
    expect(c.proposedOccurrenceDate).toBeNull();
  });

  it("é determinística", () => {
    const entrada = {
      service: servico({ id: "s1", scheduledDate: "2026-07-08" }),
      contractExists: true, canonicalDates: canonicas, siblings: [],
    };
    expect(classifyService(entrada)).toEqual(classifyService(entrada));
  });
});
