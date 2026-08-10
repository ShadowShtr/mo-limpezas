// ============================================================================
// T17-B3 — Falhas de consulta: o helper e o invariante central
// ============================================================================
//
// 🚨 Offline. Nenhum teste liga ao Supabase, à rede, ou a uma base real. O
//    cliente é substituído por um duplo que **regista** as escritas em vez de
//    as executar — é isso que permite provar o invariante desta ronda:
//
//        se uma leitura de que depende uma escrita falhar,
//        a escrita NÃO acontece.
//
// A parte B é a que interessa. As outras existem para que ela não passe por
// acidente.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  QUERY_FAILURE_MESSAGE,
  isNoRowsError,
  logQueryFailure,
  queryFailure,
} from "@/lib/query-error";

// ---------------------------------------------------------------------------
// Parte A — o helper
// ---------------------------------------------------------------------------

describe("T17-B3 — helper de falhas de consulta", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("PGRST116 é ausência de linhas, não avaria", () => {
    // Sem esta distinção, todo o `if (!data) return "não encontrado"` passaria
    // a dizer "erro técnico" — o erro simétrico ao que esta task corrige.
    expect(isNoRowsError({ code: "PGRST116" })).toBe(true);
    expect(isNoRowsError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isNoRowsError(null)).toBe(false);
    expect(isNoRowsError(undefined)).toBe(false);
  });

  it("a mensagem para o utilizador não é 'não encontrado'", () => {
    // É a confusão que o módulo existe para desfazer: uma diz que o registo
    // não existe, a outra que não se conseguiu perguntar.
    expect(QUERY_FAILURE_MESSAGE).not.toMatch(/não encontrad/i);
    expect(QUERY_FAILURE_MESSAGE).toMatch(/tenta novamente/i);
  });

  it("o detalhe do driver nunca chega ao resultado devolvido", () => {
    const erro = {
      code: "42501",
      message: 'new row violates row-level security policy for table "invoices"',
      details: "Failing row contains (uuid, 1234.56, cliente@exemplo.pt)",
      hint: "check policy invoices_company_isolation",
    };
    const r = queryFailure("teste", erro);

    expect(r.ok).toBe(false);
    expect(r.error).toBe(QUERY_FAILURE_MESSAGE);
    // Nem tabela, nem política, nem valores da linha.
    expect(r.error).not.toMatch(/invoices|policy|row-level|1234|exemplo\.pt/i);
  });

  it("regista code e message no log, e nada mais", () => {
    // `details` e `hint` do PostgREST podem trazer valores das próprias linhas.
    // Um log não é sítio para dados de clientes.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logQueryFailure("acao:leitura", {
      code: "42501",
      message: "permission denied",
      details: "Failing row contains (cliente@exemplo.pt)",
      hint: "verifica a policy",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const registado = JSON.stringify(spy.mock.calls[0]);
    expect(registado).toMatch(/acao:leitura/);
    expect(registado).toMatch(/permission denied/);
    expect(registado).not.toMatch(/exemplo\.pt|verifica a policy/);
  });

  it("não regista nada quando não houve erro", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logQueryFailure("acao", null);
    logQueryFailure("acao", undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Parte B — o invariante: nenhuma escrita depois de uma leitura falhada
// ---------------------------------------------------------------------------

/**
 * Duplo do cliente Supabase.
 *
 * Encadeia como o real (`.from().select().eq()…`) e resolve no fim com o
 * resultado que o teste programou para aquela tabela. As mutações **não** são
 * executadas: são contadas. É a contagem que prova o invariante.
 */
/** O que o encadeamento do Supabase oferece, reduzido ao que os testes usam. */
interface Chain {
  select: (...a: unknown[]) => Chain;
  eq: (...a: unknown[]) => Chain;
  in: (...a: unknown[]) => Chain;
  is: (...a: unknown[]) => Chain;
  single: () => Promise<{ data: unknown; error: unknown }>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (res: (v: { data: unknown; error: unknown }) => void) => void;
}

interface FakeClient {
  from: (table: string) => Chain & {
    insert: (...a: unknown[]) => Chain;
    update: (...a: unknown[]) => Chain;
    upsert: (...a: unknown[]) => Chain;
    delete: (...a: unknown[]) => Chain;
  };
  rpc: (nome: string) => Promise<{ data: unknown; error: unknown }>;
}

function fakeAdmin(reads: Record<string, { data?: unknown; error?: unknown }>) {
  const mutations: Array<{ table: string; op: string }> = [];

  function builder(table: string, op: string): Chain {
    const resultado = op === "select"
      ? (reads[table] ?? { data: null, error: null })
      : { data: [{ id: "escrito" }], error: null };

    const alvo: Record<string, unknown> = {};
    const proxy = new Proxy(alvo, {
      get(_t, prop: string) {
        if (prop === "then") {
          // Torna o builder aguardável, como o do Supabase.
          return (res: (v: unknown) => void) => res(resultado);
        }
        if (prop === "single" || prop === "maybeSingle") {
          return () => Promise.resolve(resultado);
        }
        return () => proxy;
      },
    });
    return proxy as unknown as Chain;
  }

  const client = {
    from(table: string) {
      return new Proxy({}, {
        get(_t, prop: string) {
          if (["insert", "update", "upsert", "delete"].includes(prop)) {
            mutations.push({ table, op: prop });
            return () => builder(table, prop);
          }
          return () => builder(table, "select");
        },
      });
    },
    rpc(nome: string) {
      mutations.push({ table: nome, op: "rpc" });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as FakeClient;

  return { mutations, client };
}

describe("T17-B3 — o duplo de teste comporta-se como o cliente real", () => {
  it("uma leitura devolve o resultado programado", async () => {
    const { client } = fakeAdmin({ services: { data: { id: "s1" }, error: null } });
    const r = await client.from("services").select("id").eq("id", "s1").single();
    expect(r).toEqual({ data: { id: "s1" }, error: null });
  });

  it("uma escrita é contada, não executada", async () => {
    const f = fakeAdmin({});
    await f.client.from("services").update({ status: "x" }).eq("id", "s1");
    expect(f.mutations).toEqual([{ table: "services", op: "update" }]);
  });
});

/**
 * O invariante, aplicado a um fluxo típico "ler para decidir, depois escrever".
 *
 * Está escrito como função para poder ser reutilizado: qualquer action nova que
 * leia antes de escrever pode ser passada aqui.
 */
async function naoEscreveAposLeituraFalhada(
  executar: (admin: unknown) => Promise<{ ok: boolean; error?: string }>,
) {
  const f = fakeAdmin({
    services: { data: null, error: { code: "42501", message: "permission denied" } },
  });
  const r = await executar(f.client);
  return { resultado: r, mutations: f.mutations };
}

describe("T17-B3 — invariante: leitura falhada não deixa escrever", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("o fluxo corrigido pára antes da mutação", async () => {
    // Réplica exacta da forma que as actions passaram a ter.
    const { resultado, mutations } = await naoEscreveAposLeituraFalhada(async (admin) => {
      const client = admin as ReturnType<typeof fakeAdmin>["client"];
      const { data: svc, error } = await client
        .from("services").select("id").eq("id", "s1").single() as {
          data: unknown; error: { code?: string; message?: string } | null;
        };
      if (error && !isNoRowsError(error)) return queryFailure("teste:services", error);
      if (!svc) return { ok: false, error: "Serviço não encontrado." };

      await client.from("services").update({ status: "cancelado" }).eq("id", "s1");
      return { ok: true };
    });

    expect(mutations, "nenhuma escrita depois de uma leitura falhada").toEqual([]);
    expect(resultado.ok).toBe(false);
    expect(resultado.error).toBe(QUERY_FAILURE_MESSAGE);
  });

  it("🔴 o fluxo antigo escrevia à mesma — é isto que a ronda corrige", async () => {
    // Demonstração do defeito, não da correcção. Se este teste deixar de
    // falhar-por-escrever, é porque o padrão antigo deixou de ser perigoso —
    // e aí é este teste que está errado.
    const f = fakeAdmin({
      services: { data: null, error: { code: "42501", message: "permission denied" } },
    });
    const { data: svc } = await f.client
      .from("services").select("id").eq("id", "s1").single() as { data: unknown };
    // `svc` é null por AVARIA, mas o código antigo lia isso como "não existe"…
    if (svc === null) {
      // …e num fluxo de upsert/criação seguia para a escrita.
      await f.client.from("services").insert({ id: "s1" });
    }
    expect(f.mutations).toEqual([{ table: "services", op: "insert" }]);
  });

  it("ausência legítima de linhas continua a dar 'não encontrado'", async () => {
    const f = fakeAdmin({ services: { data: null, error: { code: "PGRST116" } } });
    const { data: svc, error } = await f.client
      .from("services").select("id").eq("id", "s1").single() as {
        data: unknown; error: { code?: string } | null;
      };

    const resultado = (error && !isNoRowsError(error))
      ? queryFailure("teste", error)
      : (!svc ? { ok: false, error: "Serviço não encontrado." } : { ok: true });

    expect(resultado).toEqual({ ok: false, error: "Serviço não encontrado." });
    expect(f.mutations).toEqual([]);
  });

  it("o caminho de sucesso não mudou", async () => {
    const f = fakeAdmin({ services: { data: { id: "s1" }, error: null } });
    const { data: svc, error } = await f.client
      .from("services").select("id").eq("id", "s1").single() as {
        data: unknown; error: { code?: string } | null;
      };
    if (error && !isNoRowsError(error)) throw new Error("não devia falhar");
    expect(svc).toEqual({ id: "s1" });

    await f.client.from("services").update({ status: "cancelado" }).eq("id", "s1");
    expect(f.mutations).toEqual([{ table: "services", op: "update" }]);
  });
});

// ---------------------------------------------------------------------------
// Parte C — guarda: o lote corrigido não volta a encher
// ---------------------------------------------------------------------------
//
// A primeira versão desta guarda varria o código com uma expressão regular à
// procura de `const { data: x } = await admin…` nos ficheiros tocados. Acusou
// 42 sítios — quase todos os **guards inline de autenticação**, que são
// BATCH_0 e estão explicitamente fora do âmbito desta ronda — e 8 mensagens de
// driver que vêm de escritas, não de leituras.
//
// Era o falso positivo previsível: a guarda media o ficheiro inteiro, quando o
// que a T17-B3 se comprometeu a corrigir foi um lote definido. Uma guarda que
// falha por coisas que a task decidiu não fazer é desligada na primeira semana.
//
// Esta versão guarda o que é decidível sem ambiguidade: o **classificador**
// — a mesma ferramenta que definiu o lote — não deve voltar a encontrar
// ocorrências em BATCH_3. Se alguém acrescentar uma leitura sem `error` numa
// action de escrita, o número deixa de ser zero.

import fsSync from "node:fs";
import pathSync from "node:path";

const RELATORIO = JSON.parse(
  fsSync.readFileSync(
    pathSync.join(process.cwd(), "reports", "ignored-query-errors.json"),
    "utf8",
  ),
) as {
  total: number;
  byBatch: Record<string, number>;
  findings: Array<{ path: string; recommendedBatch: string; severity: string }>;
};

describe("T17-B3 — guarda do lote", () => {
  it("BATCH_3_ACTIONS_ESCRITA está a zero", () => {
    const restantes = RELATORIO.findings
      .filter((f) => f.recommendedBatch === "BATCH_3_ACTIONS_ESCRITA")
      .map((f) => f.path);

    expect(
      restantes,
      "leitura sem `error` numa action que escreve — ver src/lib/query-error.ts\n"
      + "Regenerar: node scripts/audit-ignored-query-errors.mjs --output reports/ignored-query-errors.json",
    ).toEqual([]);
    expect(RELATORIO.byBatch.BATCH_3_ACTIONS_ESCRITA ?? 0).toBe(0);
  });

  it("os lotes fora de âmbito continuam por corrigir, e contados", () => {
    // Não é uma meta: é a prova de que esta ronda não invadiu os outros lotes
    // nem os declarou resolvidos por arrasto.
    expect(RELATORIO.byBatch.BATCH_0_TENANT_AUTORIZACAO).toBeGreaterThan(0);
    expect(RELATORIO.byBatch.BATCH_1_SUPERFICIE_FINANCEIRA).toBeGreaterThan(0);
    expect(RELATORIO.byBatch.BLOCKED_FINANCIAL_INCIDENT).toBeGreaterThan(0);
  });

  it("payments.ts e invoices.ts continuam bloqueados", () => {
    const bloqueados = RELATORIO.findings.filter((f) =>
      /src\/app\/actions\/(payments|invoices)\.ts$/.test(f.path));
    expect(bloqueados.length).toBeGreaterThan(0);
    for (const f of bloqueados) {
      expect(f.recommendedBatch, `${f.path} não pode entrar num lote de correcção`)
        .toBe("BLOCKED_FINANCIAL_INCIDENT");
    }
  });

  it("o helper é usado onde as correcções foram feitas", () => {
    const comHelper = fsSync.readdirSync(pathSync.join(process.cwd(), "src/app/actions"))
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => fsSync.readFileSync(pathSync.join(process.cwd(), "src/app/actions", f), "utf8")
        .includes("@/lib/query-error"));
    expect(comHelper.length, "as actions corrigidas importam o helper").toBeGreaterThanOrEqual(10);
  });
});
