// ============================================================================
// RECONCILIAÇÃO DE EVENTOS REALTIME (Task T10)
// ============================================================================
// Sintoma que este bloco ataca: "uma pessoa altera e a outra continua a ver
// estado antigo — ou pior, estado diferente".
//
// O princípio que os testes fixam: UM EVENTO REALTIME É UM GATILHO, NÃO UMA
// FONTE DE VERDADE. O payload serve para decidir se vale a pena voltar a
// perguntar ao servidor; nunca para construir estado. Fundir `payload.new` no
// estado local produz um objeto que o servidor nunca devolveu — com as colunas
// da tabela, mas sem as juntas, valores calculados e permissões que a página
// realmente lê.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  EventLedger,
  decideEvent,
  eventCompanyId,
  eventRowId,
  eventVersion,
  processEvent,
  shouldRefetch,
  type RealtimeEvent,
} from "@/domain/realtime/event-reconciler";

const EMPRESA = "empresa-1";
const OUTRA = "empresa-2";
const TABELAS = ["services", "contracts"];

function evento(over: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    table: "services",
    type: "UPDATE",
    new: {
      id: "servico-1",
      company_id: EMPRESA,
      updated_at: "2026-08-07T10:00:00.000Z",
    },
    ...over,
  };
}

function decidir(event: RealtimeEvent, ledger?: EventLedger) {
  return decideEvent({ event, companyId: EMPRESA, watchedTables: TABELAS, ledger });
}

// ─── leitura do payload ─────────────────────────────────────────────────────

describe("leitura defensiva do payload", () => {
  it("lê id, empresa e versão do INSERT/UPDATE", () => {
    const e = evento();
    expect(eventRowId(e)).toBe("servico-1");
    expect(eventCompanyId(e)).toBe(EMPRESA);
    expect(eventVersion(e)).toBe("2026-08-07T10:00:00.000Z");
  });

  it("no DELETE lê a linha antiga", () => {
    const e = evento({ type: "DELETE", new: null, old: { id: "servico-9", company_id: EMPRESA } });
    expect(eventRowId(e)).toBe("servico-9");
    expect(eventCompanyId(e)).toBe(EMPRESA);
  });

  it("payload incompleto não rebenta nem inventa", () => {
    const e = evento({ new: {} });
    expect(eventRowId(e)).toBeNull();
    expect(eventCompanyId(e)).toBeNull();
    expect(eventVersion(e)).toBeNull();
  });

  it("valores de tipo errado são ignorados", () => {
    const e = evento({ new: { id: 42, company_id: null, updated_at: {} } });
    expect(eventRowId(e)).toBeNull();
    expect(eventCompanyId(e)).toBeNull();
    expect(eventVersion(e)).toBeNull();
  });

  it("usa created_at quando não há updated_at", () => {
    const e = evento({ new: { id: "x", created_at: "2026-08-07T09:00:00.000Z" } });
    expect(eventVersion(e)).toBe("2026-08-07T09:00:00.000Z");
  });
});

// ─── isolamento por empresa ─────────────────────────────────────────────────

describe("isolamento por empresa", () => {
  it("🔴 evento de outra empresa é descartado", () => {
    // Segunda linha de defesa: metade das subscrições atuais não declara
    // filtro e depende inteiramente da RLS.
    const e = evento({ new: { id: "s1", company_id: OUTRA, updated_at: "2026-08-07T10:00:00.000Z" } });
    expect(decidir(e).decision).toBe("IGNORE_FOREIGN_TENANT");
  });

  it("evento da própria empresa passa", () => {
    expect(decidir(evento()).decision).toBe("REFETCH");
  });

  it("sem company_id no payload, deixa passar para o servidor decidir", () => {
    // A consulta seguinte é feita no servidor e já está limitada à empresa da
    // sessão — descartar aqui perderia mudanças legítimas.
    const e = evento({ new: { id: "s1", updated_at: "2026-08-07T10:00:00.000Z" } });
    expect(decidir(e).decision).toBe("REFETCH");
  });

  it("um evento de outra empresa nunca é registado no ledger", () => {
    const ledger = new EventLedger();
    processEvent({
      event: evento({ new: { id: "s1", company_id: OUTRA, updated_at: "2026-08-07T10:00:00.000Z" } }),
      companyId: EMPRESA, watchedTables: TABELAS, ledger,
    });
    expect(ledger.size).toBe(0);
  });
});

// ─── tabelas observadas ─────────────────────────────────────────────────────

describe("tabelas", () => {
  it("tabela não observada é ignorada", () => {
    expect(decidir(evento({ table: "profiles" })).decision).toBe("IGNORE_UNKNOWN_TABLE");
  });

  it("cada consumidor observa só o seu domínio", () => {
    const e = evento({ table: "invoices" });
    expect(decideEvent({ event: e, companyId: EMPRESA, watchedTables: ["invoices"] }).decision)
      .toBe("REFETCH");
    expect(decideEvent({ event: e, companyId: EMPRESA, watchedTables: ["services"] }).decision)
      .toBe("IGNORE_UNKNOWN_TABLE");
  });
});

// ─── duplicados ─────────────────────────────────────────────────────────────

describe("eventos duplicados", () => {
  it("🔴 o mesmo evento duas vezes só provoca um refetch", () => {
    const ledger = new EventLedger();
    const e = evento();
    expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("REFETCH");
    expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("IGNORE_DUPLICATE");
  });

  it("dez entregas do mesmo evento dão um refetch", () => {
    const ledger = new EventLedger();
    const e = evento();
    const decisoes = Array.from({ length: 10 }, () =>
      processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision);
    expect(decisoes.filter((d) => d === "REFETCH")).toHaveLength(1);
  });

  it("DELETE duplicado também é filtrado", () => {
    const ledger = new EventLedger();
    const e = evento({ type: "DELETE", new: null, old: { id: "s1", company_id: EMPRESA } });
    expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("REFETCH");
    expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("IGNORE_DUPLICATE");
  });

  it("linhas diferentes não se confundem", () => {
    const ledger = new EventLedger();
    for (const id of ["s1", "s2", "s3"]) {
      const e = evento({ new: { id, company_id: EMPRESA, updated_at: "2026-08-07T10:00:00.000Z" } });
      expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
        .toBe("REFETCH");
    }
  });

  it("tabelas diferentes com o mesmo id não se confundem", () => {
    const ledger = new EventLedger();
    for (const table of ["services", "contracts"]) {
      const e = evento({ table, new: { id: "mesmo-id", company_id: EMPRESA, updated_at: "2026-08-07T10:00:00.000Z" } });
      expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
        .toBe("REFETCH");
    }
  });
});

// ─── ordem ──────────────────────────────────────────────────────────────────

describe("eventos fora de ordem", () => {
  it("🔴 receber B e depois A não volta atrás no tempo", () => {
    const ledger = new EventLedger();
    const b = evento({ new: { id: "s1", company_id: EMPRESA, updated_at: "2026-08-07T10:05:00.000Z" } });
    const a = evento({ new: { id: "s1", company_id: EMPRESA, updated_at: "2026-08-07T10:00:00.000Z" } });

    expect(processEvent({ event: b, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("REFETCH");
    expect(processEvent({ event: a, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("IGNORE_STALE");
  });

  it("a ordem correta processa os dois", () => {
    const ledger = new EventLedger();
    for (const t of ["2026-08-07T10:00:00.000Z", "2026-08-07T10:05:00.000Z"]) {
      const e = evento({ new: { id: "s1", company_id: EMPRESA, updated_at: t } });
      expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
        .toBe("REFETCH");
    }
  });

  it("sem versão no payload não se presume antiguidade", () => {
    const ledger = new EventLedger();
    const e = evento({ new: { id: "s1", company_id: EMPRESA } });
    processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger });
    // Sem `updated_at` não há como ordenar: mais vale um refetch a mais.
    expect(ledger.isStale(e)).toBe(false);
  });

  it("um DELETE nunca é descartado por antiguidade", () => {
    const ledger = new EventLedger();
    const update = evento({ new: { id: "s1", company_id: EMPRESA, updated_at: "2026-08-07T10:05:00.000Z" } });
    processEvent({ event: update, companyId: EMPRESA, watchedTables: TABELAS, ledger });

    const del = evento({ type: "DELETE", new: null, old: { id: "s1", company_id: EMPRESA } });
    expect(processEvent({ event: del, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("REFETCH");
  });
});

// ─── reconexão ──────────────────────────────────────────────────────────────

describe("reconexão", () => {
  it("🔴 depois de reconectar, o ledger é limpo e nada é presumido", () => {
    // Durante a desconexão houve escritas que nunca chegaram: o que está em
    // memória deixa de servir para decidir o que é antigo.
    const ledger = new EventLedger();
    const e = evento({ new: { id: "s1", company_id: EMPRESA, updated_at: "2026-08-07T10:05:00.000Z" } });
    processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger });
    expect(ledger.size).toBe(1);

    ledger.reset();
    expect(ledger.size).toBe(0);
    // O mesmo evento volta a valer um refetch — o resync é obrigatório.
    expect(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }).decision)
      .toBe("REFETCH");
  });

  it("um evento anterior à desconexão deixa de ser considerado antigo", () => {
    const ledger = new EventLedger();
    const recente = evento({ new: { id: "s1", company_id: EMPRESA, updated_at: "2026-08-07T10:05:00.000Z" } });
    processEvent({ event: recente, companyId: EMPRESA, watchedTables: TABELAS, ledger });
    ledger.reset();
    const antigo = evento({ new: { id: "s1", company_id: EMPRESA, updated_at: "2026-08-07T10:00:00.000Z" } });
    expect(ledger.isStale(antigo)).toBe(false);
  });
});

// ─── limites de memória ─────────────────────────────────────────────────────

describe("memória", () => {
  it("o ledger não cresce sem fim numa sessão longa", () => {
    const ledger = new EventLedger(50);
    for (let i = 0; i < 500; i++) {
      processEvent({
        event: evento({ new: { id: `s${i}`, company_id: EMPRESA, updated_at: "2026-08-07T10:00:00.000Z" } }),
        companyId: EMPRESA, watchedTables: TABELAS, ledger,
      });
    }
    expect(ledger.size).toBeLessThanOrEqual(50);
  });
});

// ─── invariantes ────────────────────────────────────────────────────────────

describe("invariantes", () => {
  it("só REFETCH leva o consumidor a agir", () => {
    const decisoes = [
      decidir(evento({ table: "profiles" })),
      decidir(evento({ new: { id: "s1", company_id: OUTRA, updated_at: "2026-08-07T10:00:00.000Z" } })),
      decidir(evento()),
    ];
    expect(decisoes.map(shouldRefetch)).toEqual([false, false, true]);
  });

  it("nenhuma decisão devolve dados do payload", () => {
    // O veredicto é só decisão e razão: não há por onde o payload escapar
    // para o estado da aplicação.
    const veredicto = decidir(evento());
    expect(Object.keys(veredicto).sort()).toEqual(["decision", "reason"]);
  });

  it("é determinístico", () => {
    expect(decidir(evento())).toEqual(decidir(evento()));
  });

  it("decideEvent não altera o ledger — só processEvent regista", () => {
    const ledger = new EventLedger();
    decideEvent({ event: evento(), companyId: EMPRESA, watchedTables: TABELAS, ledger });
    expect(ledger.size).toBe(0);
  });

  it("não altera o evento recebido", () => {
    const e = evento();
    const congelado = JSON.stringify(e);
    processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger: new EventLedger() });
    expect(JSON.stringify(e)).toBe(congelado);
  });
});

// ─── cenário multiutilizador ────────────────────────────────────────────────

describe("cenário: duas gestoras no calendário", () => {
  it("A escreve, B converge, e o eco da própria escrita de B não duplica", () => {
    const ledgerB = new EventLedger();
    let refetchesB = 0;

    // A move uma visita. B recebe o evento.
    const eventoA = evento({ new: { id: "servico-1", company_id: EMPRESA, updated_at: "2026-08-07T10:00:00.000Z" } });
    if (shouldRefetch(processEvent({ event: eventoA, companyId: EMPRESA, watchedTables: TABELAS, ledger: ledgerB }))) {
      refetchesB++;
    }

    // O mesmo evento chega repetido (reentrega do canal).
    if (shouldRefetch(processEvent({ event: eventoA, companyId: EMPRESA, watchedTables: TABELAS, ledger: ledgerB }))) {
      refetchesB++;
    }

    // Chega ainda um evento atrasado, anterior ao que B já viu.
    const atrasado = evento({ new: { id: "servico-1", company_id: EMPRESA, updated_at: "2026-08-07T09:59:00.000Z" } });
    if (shouldRefetch(processEvent({ event: atrasado, companyId: EMPRESA, watchedTables: TABELAS, ledger: ledgerB }))) {
      refetchesB++;
    }

    expect(refetchesB).toBe(1);
  });

  it("uma empresa vizinha a trabalhar não provoca refetch nenhum", () => {
    const ledger = new EventLedger();
    let refetches = 0;
    for (let i = 0; i < 20; i++) {
      const e = evento({ new: { id: `s${i}`, company_id: OUTRA, updated_at: "2026-08-07T10:00:00.000Z" } });
      if (shouldRefetch(processEvent({ event: e, companyId: EMPRESA, watchedTables: TABELAS, ledger }))) {
        refetches++;
      }
    }
    expect(refetches).toBe(0);
  });
});
