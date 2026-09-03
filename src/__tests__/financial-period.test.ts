// ============================================================================
// FECHAMENTO MENSAL — regras puras e guarda central
// ============================================================================
//
// Nada aqui liga a uma base. As regras de domínio são funções puras; a guarda
// recebe um cliente falso que responde de forma determinística e grava o que
// recebeu, para se poder afirmar por captura — não por leitura do código — que
// a leitura é só leitura.
//
// O caso que mais importa é `erro de leitura ≠ aberto`. Se essa asserção
// deixar de passar, uma falha de infraestrutura passa a autorizar escritas num
// mês fechado, e isso não dá erro em sítio nenhum: passa a acontecer em
// silêncio.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  ERRO_PERIODO_FECHADO,
  MIN_CARACTERES_MOTIVO,
  agregarChecklist,
  descreverBloqueadores,
  interpretarLinhaPeriodo,
  interpretarResultadoFecho,
  itemContagem,
  itemFalhaDeLeitura,
  mensagemPeriodoFechado,
  mesmoPeriodo,
  nomePeriodo,
  periodoDeDataCivil,
  validarMotivoReabertura,
  validarPeriodo,
} from "@/domain/finance-v2/financial-period";
import {
  ERRO_ESTADO_INDETERMINADO,
  assertFinancialPeriodOpen,
  assertPeriodosAbertosParaMudancaDeData,
  criarContextoPeriodo,
  lerEstadoPeriodo,
  type ClientePeriodo,
} from "@/lib/finance-period-guard";

const EMPRESA = "00000000-0000-0000-0000-000000000001";
const OUTRA_EMPRESA = "00000000-0000-0000-0000-000000000002";

/**
 * Cliente falso. `linhas` é indexado por `company:year:month` — sem isso não se
 * conseguia testar isolamento entre empresas, que é o teste que apanha uma
 * chave de cache mal construída.
 */
function fakeCliente({
  linhas = {} as Record<string, Record<string, unknown> | null>,
  erro = null as { message: string } | null,
}) {
  const chamadas: { company: string; year: number; month: number }[] = [];
  const cliente: ClientePeriodo = {
    from() {
      return {
        select() {
          let company = "";
          let year = 0;
          let month = 0;
          const eq = (coluna: string, valor: unknown) => {
            if (coluna === "company_id") company = String(valor);
            if (coluna === "year") year = Number(valor);
            if (coluna === "month") month = Number(valor);
            return {
              eq,
              maybeSingle: async () => {
                chamadas.push({ company, year, month });
                if (erro) return { data: null, error: erro };
                return { data: linhas[`${company}:${year}:${month}`] ?? null, error: null };
              },
            };
          };
          return { eq } as never;
        },
      };
    },
  };
  return { cliente, chamadas };
}

const fechado = { status: "closed", closed_at: "2026-09-01T10:00:00Z", closed_by: "u1" };

// ─── Data civil ──────────────────────────────────────────────────────────────

describe("período a partir da data civil", () => {
  it("lê ano e mês dos caracteres", () => {
    const r = periodoDeDataCivil("2026-08-17");
    expect(r).toEqual({ ok: true, periodo: { year: 2026, month: 8 } });
  });

  it("🔴 31 de Agosto é Agosto — não Setembro por UTC", () => {
    // O bug de Julho: `new Date("2026-08-31").getMonth()` num processo UTC+1
    // podia dar o mês errado. Aqui não há `Date`.
    const r = periodoDeDataCivil("2026-08-31");
    expect(r.ok && r.periodo).toEqual({ year: 2026, month: 8 });
  });

  it("🔴 1 de Agosto é Agosto — não Julho", () => {
    const r = periodoDeDataCivil("2026-08-01");
    expect(r.ok && r.periodo).toEqual({ year: 2026, month: 8 });
  });

  it("31 de Dezembro não escorrega para o ano seguinte", () => {
    const r = periodoDeDataCivil("2026-12-31");
    expect(r.ok && r.periodo).toEqual({ year: 2026, month: 12 });
  });

  it("1 de Janeiro não escorrega para o ano anterior", () => {
    const r = periodoDeDataCivil("2026-01-01");
    expect(r.ok && r.periodo).toEqual({ year: 2026, month: 1 });
  });

  it("rejeita a corrupção de data de Julho", () => {
    // `"72026-01-01"` — o valor real que rebentou a ficha do cliente.
    expect(periodoDeDataCivil("72026-01-01").ok).toBe(false);
    expect(periodoDeDataCivil("").ok).toBe(false);
    expect(periodoDeDataCivil("2026-13-01").ok).toBe(false);
    expect(periodoDeDataCivil("não é data").ok).toBe(false);
  });
});

describe("validarPeriodo", () => {
  it("aceita um par válido", () => {
    expect(validarPeriodo({ year: 2026, month: 8 })).toEqual({ ok: true, periodo: { year: 2026, month: 8 } });
  });

  it("rejeita lixo", () => {
    for (const e of [
      { year: 2026, month: 0 },
      { year: 2026, month: 13 },
      { year: 1999, month: 5 },
      { year: 2101, month: 5 },
      { year: NaN, month: 8 },
      { year: 2026.5, month: 8 },
      { year: "2026", month: 8 },
      { year: null, month: 8 },
    ]) {
      expect(validarPeriodo(e as never).ok, JSON.stringify(e)).toBe(false);
    }
  });
});

describe("nomes e mensagens", () => {
  it("nomeia o período em português", () => {
    expect(nomePeriodo({ year: 2026, month: 8 })).toBe("Agosto de 2026");
    expect(nomePeriodo({ year: 2026, month: 3 })).toBe("Março de 2026");
  });

  it("a mensagem de recusa nomeia o mês", () => {
    expect(mensagemPeriodoFechado({ year: 2026, month: 8 })).toBe(
      "Agosto de 2026 está fechado para alterações financeiras.",
    );
  });

  it("mesmoPeriodo compara ano e mês", () => {
    expect(mesmoPeriodo({ year: 2026, month: 8 }, { year: 2026, month: 8 })).toBe(true);
    expect(mesmoPeriodo({ year: 2026, month: 8 }, { year: 2026, month: 9 })).toBe(false);
    expect(mesmoPeriodo({ year: 2026, month: 8 }, { year: 2025, month: 8 })).toBe(false);
  });
});

// ─── Semântica: ausência = aberto ────────────────────────────────────────────

describe("interpretarLinhaPeriodo — a semântica da 073", () => {
  it("sem linha → aberto, não explícito", () => {
    const e = interpretarLinhaPeriodo(null);
    expect(e.status).toBe("open");
    expect(e.explicit).toBe(false);
  });

  it("linha 'open' → aberto, explícito", () => {
    const e = interpretarLinhaPeriodo({ status: "open" });
    expect(e.status).toBe("open");
    expect(e.explicit).toBe(true);
  });

  it("linha 'closed' → fechado", () => {
    const e = interpretarLinhaPeriodo(fechado);
    expect(e.status).toBe("closed");
    expect(e.closedAt).toBe("2026-09-01T10:00:00Z");
    expect(e.closedBy).toBe("u1");
  });

  it("🔴 status inesperado não fecha o mês por acidente", () => {
    // Só 'closed' fecha — igual à 073. Fechar é sempre acto explícito.
    for (const s of ["CLOSED", "fechado", "", null, undefined, 1]) {
      expect(interpretarLinhaPeriodo({ status: s }).status, String(s)).toBe("open");
    }
  });
});

// ─── Motivo de reabertura ────────────────────────────────────────────────────

describe("validarMotivoReabertura", () => {
  it("aceita um motivo com conteúdo e apara espaços", () => {
    expect(validarMotivoReabertura("  Correcção da fatura 12  ")).toEqual({
      ok: true,
      motivo: "Correcção da fatura 12",
    });
  });

  it("🔴 recusa vazio e só-espaços", () => {
    for (const m of ["", "   ", "\t\n  ", null, undefined, 42]) {
      expect(validarMotivoReabertura(m as never).ok, JSON.stringify(m)).toBe(false);
    }
  });

  it(`recusa abaixo de ${MIN_CARACTERES_MOTIVO} caracteres úteis`, () => {
    expect(validarMotivoReabertura("ab").ok).toBe(false);
    expect(validarMotivoReabertura("  a  ").ok).toBe(false);
    expect(validarMotivoReabertura("abc").ok).toBe(true);
  });
});

// ─── Checklist ───────────────────────────────────────────────────────────────

describe("checklist — só falha de leitura bloqueia", () => {
  it("contagem zero é ok", () => {
    expect(itemContagem("k", "R", 0, "det").gravidade).toBe("ok");
  });

  it("contagem acima de zero é aviso, não bloqueio", () => {
    // Deliberado: ninguém aprovou "não podes fechar com despesas sem
    // categoria" como política de empresa.
    expect(itemContagem("k", "R", 3, "det").gravidade).toBe("warning");
  });

  it("falha de leitura é bloqueio", () => {
    expect(itemFalhaDeLeitura("k", "R", "timeout").gravidade).toBe("blocker");
  });

  it("só avisos → pode fechar", () => {
    const r = agregarChecklist([
      itemContagem("a", "A", 3, "d"),
      itemContagem("b", "B", 5, "d"),
      itemContagem("c", "C", 0, "d"),
    ]);
    expect(r.podeFechar).toBe(true);
    expect(r.avisos).toHaveLength(2);
    expect(r.bloqueadores).toHaveLength(0);
  });

  it("um bloqueio → não pode fechar", () => {
    const r = agregarChecklist([itemContagem("a", "A", 0, "d"), itemFalhaDeLeitura("b", "B", "erro")]);
    expect(r.podeFechar).toBe(false);
    expect(r.bloqueadores).toHaveLength(1);
  });
});

// ─── Leitura ─────────────────────────────────────────────────────────────────

describe("lerEstadoPeriodo", () => {
  it("sem linha → aberto", async () => {
    const { cliente } = fakeCliente({});
    const r = await lerEstadoPeriodo(cliente, EMPRESA, { year: 2026, month: 8 });
    expect(r.ok && r.estado.status).toBe("open");
  });

  it("linha fechada → fechado", async () => {
    const { cliente } = fakeCliente({ linhas: { [`${EMPRESA}:2026:8`]: fechado } });
    const r = await lerEstadoPeriodo(cliente, EMPRESA, { year: 2026, month: 8 });
    expect(r.ok && r.estado.status).toBe("closed");
  });

  it("🔴 erro de leitura devolve !ok — nunca 'aberto'", async () => {
    const { cliente } = fakeCliente({ erro: { message: "timeout" } });
    const r = await lerEstadoPeriodo(cliente, EMPRESA, { year: 2026, month: 8 });
    expect(r.ok).toBe(false);
  });
});

// ─── A guarda ────────────────────────────────────────────────────────────────

describe("assertFinancialPeriodOpen", () => {
  it("mês aberto → passa", async () => {
    const { cliente } = fakeCliente({});
    const r = await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-08-17" });
    expect(r.ok).toBe(true);
  });

  it("mês fechado → recusa com o código e a mensagem certos", async () => {
    const { cliente } = fakeCliente({ linhas: { [`${EMPRESA}:2026:8`]: fechado } });
    const r = await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-08-17" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(ERRO_PERIODO_FECHADO);
    expect(!r.ok && r.error).toContain("Agosto de 2026");
  });

  it("🔴 erro de leitura → RECUSA (fail closed), não passa", async () => {
    const { cliente } = fakeCliente({ erro: { message: "connection reset" } });
    const r = await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-08-17" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(ERRO_ESTADO_INDETERMINADO);
  });

  it("sem cliente nem contexto → recusa (erro de programação, mas fechado)", async () => {
    const r = await assertFinancialPeriodOpen({ companyId: EMPRESA, data: "2026-08-17" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(ERRO_ESTADO_INDETERMINADO);
  });

  it("data inválida → recusa", async () => {
    const { cliente } = fakeCliente({});
    const r = await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "72026-01-01" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("INVALID_DATE");
  });

  it("🔴 Agosto fechado não bloqueia Setembro — lock é por período", async () => {
    const { cliente } = fakeCliente({ linhas: { [`${EMPRESA}:2026:8`]: fechado } });
    expect((await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-08-31" })).ok).toBe(false);
    expect((await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-09-01" })).ok).toBe(true);
    expect((await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-07-31" })).ok).toBe(true);
  });

  it("🔴 Agosto fechado na empresa A não fecha Agosto na empresa B", async () => {
    const { cliente } = fakeCliente({ linhas: { [`${EMPRESA}:2026:8`]: fechado } });
    expect((await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-08-10" })).ok).toBe(false);
    expect((await assertFinancialPeriodOpen({ cliente, companyId: OUTRA_EMPRESA, data: "2026-08-10" })).ok).toBe(true);
  });
});

// ─── Contexto por pedido ─────────────────────────────────────────────────────

describe("contexto por pedido", () => {
  it("não repete a leitura do mesmo período", async () => {
    const { cliente, chamadas } = fakeCliente({});
    const ctx = criarContextoPeriodo(cliente);
    for (const d of ["2026-08-01", "2026-08-15", "2026-08-31"]) {
      await assertFinancialPeriodOpen({ contexto: ctx, companyId: EMPRESA, data: d });
    }
    expect(chamadas).toHaveLength(1);
  });

  it("lê uma vez por período distinto", async () => {
    const { cliente, chamadas } = fakeCliente({});
    const ctx = criarContextoPeriodo(cliente);
    await assertFinancialPeriodOpen({ contexto: ctx, companyId: EMPRESA, data: "2026-07-15" });
    await assertFinancialPeriodOpen({ contexto: ctx, companyId: EMPRESA, data: "2026-08-15" });
    expect(chamadas).toHaveLength(2);
  });

  it("🔴 a chave inclui a empresa — não vaza estado entre tenants", async () => {
    const { cliente, chamadas } = fakeCliente({ linhas: { [`${EMPRESA}:2026:8`]: fechado } });
    const ctx = criarContextoPeriodo(cliente);

    const a = await assertFinancialPeriodOpen({ contexto: ctx, companyId: EMPRESA, data: "2026-08-10" });
    const b = await assertFinancialPeriodOpen({ contexto: ctx, companyId: OUTRA_EMPRESA, data: "2026-08-10" });

    expect(a.ok).toBe(false); // fechado
    expect(b.ok).toBe(true); // outra empresa, aberto
    expect(chamadas).toHaveLength(2); // duas leituras: a chave distingue
  });
});

// ─── Mudança de data entre períodos ──────────────────────────────────────────

describe("mudança de data entre períodos", () => {
  const casos: [string, string, string, boolean][] = [
    ["ambos abertos", "2026-07-15", "2026-09-15", true],
    ["origem fechada", "2026-08-15", "2026-09-15", false],
    ["destino fechado", "2026-07-15", "2026-08-15", false],
    ["ambos fechados", "2026-08-10", "2026-08-20", false],
  ];

  for (const [nome, antiga, nova, esperado] of casos) {
    it(`${nome} → ${esperado ? "passa" : "recusa"}`, async () => {
      const { cliente } = fakeCliente({ linhas: { [`${EMPRESA}:2026:8`]: fechado } });
      const r = await assertPeriodosAbertosParaMudancaDeData({
        cliente,
        companyId: EMPRESA,
        dataAntiga: antiga,
        dataNova: nova,
      });
      expect(r.ok).toBe(esperado);
    });
  }

  it("🔴 não se pode retirar de um mês fechado, mesmo indo para um aberto", async () => {
    // O caso que uma validação só do destino deixaria passar.
    const { cliente } = fakeCliente({ linhas: { [`${EMPRESA}:2026:8`]: fechado } });
    const r = await assertPeriodosAbertosParaMudancaDeData({
      cliente,
      companyId: EMPRESA,
      dataAntiga: "2026-08-15",
      dataNova: "2026-09-15",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(ERRO_PERIODO_FECHADO);
  });

  it("dentro do mesmo período faz uma leitura só", async () => {
    const { cliente, chamadas } = fakeCliente({});
    const ctx = criarContextoPeriodo(cliente);
    const r = await assertPeriodosAbertosParaMudancaDeData({
      contexto: ctx,
      companyId: EMPRESA,
      dataAntiga: "2026-07-01",
      dataNova: "2026-07-28",
    });
    expect(r.ok).toBe(true);
    expect(chamadas).toHaveLength(1);
  });
});

// ─── Read-only ───────────────────────────────────────────────────────────────

describe("🔴 a guarda é READ-ONLY", () => {
  it("só faz SELECT em financial_periods", async () => {
    const tabelas: string[] = [];
    const cliente = {
      from(t: string) {
        tabelas.push(t);
        const eq = () => ({ eq, maybeSingle: async () => ({ data: null, error: null }) });
        return { select: () => ({ eq }) } as never;
      },
    } as ClientePeriodo;

    await assertFinancialPeriodOpen({ cliente, companyId: EMPRESA, data: "2026-08-17" });
    expect(tabelas).toEqual(["financial_periods"]);
  });

  it("o módulo da guarda não contém insert/update/delete/upsert", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(
      path.join(__dirname, "..", "lib", "finance-period-guard.ts"),
      "utf8",
    );
    expect(fonte).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });
});

// ============================================================================
// A resposta do fecho atómico (090) — lógica pura
// ============================================================================
//
// `closeFinancialPeriod` deixou de ler-calcular-escrever em três viagens e
// passou a chamar `close_financial_period_atomic`. O que sobra do lado do
// TypeScript é interpretar a resposta — e é isso que se testa aqui, sem base
// de dados nenhuma.
//
// 🔴 O ponto destes testes é a resposta INESPERADA. Um `data` com outra forma
//    não pode acabar como «fechado com sucesso»: é isso que transformaria uma
//    falha silenciosa da base num mês dado por encerrado.
describe("interpretarResultadoFecho", () => {
  it("fechou: a linha diz fechado = true", () => {
    const r = interpretarResultadoFecho([{ fechado: true, bloqueadores: {} }]);
    expect(r).toEqual({ ok: true, fechado: true });
  });

  it("já estava fechado: no-op, não erro", () => {
    const r = interpretarResultadoFecho([{ fechado: false, bloqueadores: { ja_fechado: true } }]);
    expect(r).toEqual({ ok: true, fechado: false, jaFechado: true });
  });

  it("bloqueadores: devolve as contagens", () => {
    const r = interpretarResultadoFecho([
      { fechado: false, bloqueadores: { faturas_rascunho: 2, pagamentos_pendentes: 1 } },
    ]);
    expect(r).toEqual({
      ok: true,
      fechado: false,
      jaFechado: false,
      bloqueadores: { faturas_rascunho: 2, pagamentos_pendentes: 1 },
    });
  });

  it("aceita a linha fora do array — o PostgREST devolve as duas formas", () => {
    expect(interpretarResultadoFecho({ fechado: true, bloqueadores: {} })).toEqual({ ok: true, fechado: true });
  });

  it("contagens a zero não entram na lista", () => {
    const r = interpretarResultadoFecho([{ fechado: false, bloqueadores: { faturas_rascunho: 0 } }]);
    expect(r).toEqual({ ok: true, fechado: false, jaFechado: false, bloqueadores: {} });
  });

  it("🔴 resposta inesperada NUNCA vira sucesso", () => {
    for (const mau of [
      null,
      undefined,
      [],
      "fechado",
      42,
      [{}],
      [{ fechado: "sim" }],
      [{ fechado: false }],
      [{ fechado: false, bloqueadores: null }],
      [{ fechado: false, bloqueadores: "nenhum" }],
    ]) {
      expect(interpretarResultadoFecho(mau), JSON.stringify(mau) ?? "undefined").toEqual({ ok: false });
    }
  });

  it("valores não numéricos nos bloqueadores são ignorados, não somados", () => {
    const r = interpretarResultadoFecho([
      { fechado: false, bloqueadores: { faturas_rascunho: 1, lixo: "muito", outro: null } },
    ]);
    expect(r).toEqual({ ok: true, fechado: false, jaFechado: false, bloqueadores: { faturas_rascunho: 1 } });
  });
});

describe("descreverBloqueadores", () => {
  it("traduz as chaves da RPC para a frase da gestora", () => {
    expect(descreverBloqueadores({ faturas_rascunho: 2 })).toBe("2 faturas em rascunho");
    expect(descreverBloqueadores({ saidas_sem_categoria: 1 })).toBe("1 despesas sem categoria");
    expect(descreverBloqueadores({ movimentos_bancarios_pendentes: 3 })).toBe(
      "3 movimentos bancários por conciliar",
    );
    expect(descreverBloqueadores({ pagamentos_pendentes: 5 })).toBe("5 pagamentos pendentes");
  });

  it("junta vários com ponto e vírgula", () => {
    const frase = descreverBloqueadores({ faturas_rascunho: 2, pagamentos_pendentes: 1 });
    expect(frase).toContain("2 faturas em rascunho");
    expect(frase).toContain("1 pagamentos pendentes");
    expect(frase).toContain("; ");
  });

  it("uma chave sem rótulo aparece pelo nome técnico, e não desaparece", () => {
    // Feio, mas honesto: um bloqueador novo na base que ninguém traduziu ainda
    // tem de aparecer na frase. Desaparecer daria uma recusa sem explicação.
    expect(descreverBloqueadores({ chave_nova_da_base: 4 })).toBe("4 chave_nova_da_base");
  });

  it("sem bloqueadores dá uma frase genérica em vez de vazio", () => {
    expect(descreverBloqueadores({})).toBe("há pendências por resolver");
  });
});
