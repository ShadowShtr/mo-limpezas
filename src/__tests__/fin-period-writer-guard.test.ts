// ============================================================================
// FIN-PERIOD-WRITER-INVENTORY — o guard permanente contra a regressão
// ============================================================================
//
// As migrations 090..097 puseram a decisão de período dentro da transação, e o
// R1 fez o runtime deixar de a tomar cá fora. Este ficheiro existe para que
// isso não se desfaça em silêncio.
//
// A regressão que ele apanha não é teórica. O padrão que saiu do runtime —
// ler, decidir em TypeScript, e só depois escrever — é o que sai naturalmente
// da cabeça de quem escreve a próxima funcionalidade. Reaparece sozinho. Sem
// um guard, reaparece sem ninguém dar por isso, e a única prova de que voltou
// é um mês fechado que muda de valor.
//
// Duas metades:
//
//   1. cada writer financeiro CHAMA as RPCs da sua migration;
//   2. nenhum deles ESCREVE directamente nas tabelas sensíveis ao período.
//
// A segunda é a que interessa. A primeira sozinha passaria com um ficheiro que
// chama a RPC num caminho e escreve à mão noutro — que é exactamente a forma
// que a regressão costuma ter.
//
// As excepções estão listadas, uma a uma, com dono e razão. Uma excepção NOVA
// faz este teste falhar: é essa a diferença entre uma lista de excepções e uma
// desculpa.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ler = (ficheiro: string) => fs.readFileSync(path.join(process.cwd(), ficheiro), "utf8");

/**
 * Tabelas cujo conteúdo pertence a um mês: ou têm competência declarada
 * (`period_year`/`period_month`), ou uma data que decide o mês, ou são o
 * próprio registo do fecho.
 */
const TABELAS_SENSIVEIS = [
  "fixed_variable_payments",
  "cash_flow_entries",
  "invoices",
  "invoice_items",
  "bank_reconciliation_matches",
  "bank_transactions",
  "bank_statement_imports",
  "payroll_records",
  "financial_periods",
] as const;

/** Cada writer convertido, e as RPCs que a sua migration lhe deu. */
const WRITERS: Record<string, string[]> = {
  "src/app/actions/payments.ts": [
    "create_payment_atomic",
    "update_payment_atomic",
    "set_payment_status_atomic",
    "delete_payment_atomic",
  ],
  "src/app/actions/cash-flow.ts": [
    "create_cashflow_entry_atomic",
    "update_cashflow_entry_atomic",
    "delete_cashflow_entry_atomic",
  ],
  "src/app/actions/invoices.ts": ["set_invoice_status_atomic", "delete_invoice_atomic"],
  "src/app/actions/bank-reconciliation.ts": [
    "confirm_bank_match_atomic",
    "reject_bank_match_atomic",
    "manual_bank_match_atomic",
    "set_bank_transaction_ignored_atomic",
    "create_cashflow_from_bank_transaction_atomic",
    "delete_bank_import_atomic",
  ],
  "src/app/actions/daily-billing.ts": ["set_service_payment_atomic"],
  "src/app/actions/financial-periods.ts": [
    "close_financial_period_atomic",
    "reopen_financial_period_atomic",
  ],
  "src/app/actions/payroll.ts": [
    "upsert_payroll_records_atomic",
    "adjust_payroll_record_atomic",
    "approve_payroll_records_atomic",
    "mark_payroll_paid_atomic",
  ],
};

/**
 * O que ainda escreve à mão numa tabela sensível, porque quê, e de quem é.
 *
 * Nenhuma destas é dívida do protocolo: são escritas que não decidem nada sobre
 * o mês. A dívida a sério — a folha — saiu daqui quando passou pelas RPCs da
 * 096, e foi este ficheiro que obrigou a que saísse: o teste
 * «cada excepção inventariada continua a existir» falhou no instante em que o
 * INSERT directo desapareceu do código.
 */
const EXCECOES: Array<{ ficheiro: string; tabela: string; dono: string; razao: string }> = [
  {
    ficheiro: "src/app/actions/colaboradores.ts",
    tabela: "invoices",
    dono: "—",
    razao:
      "Anonimização de `created_by` ao remover uma pessoa. Não toca em valor, " +
      "data nem estado: nada aqui muda o que um mês vale.",
  },
  {
    ficheiro: "src/app/actions/colaboradores.ts",
    tabela: "payroll_records",
    dono: "—",
    razao: "Anonimização de `approved_by`, pela mesma razão.",
  },
  {
    ficheiro: "src/lib/payments-month-materialization.ts",
    tabela: "fixed_variable_payments",
    dono: "—",
    razao:
      "Módulo em quarentena, sem nenhum caminho da aplicação a chegar-lhe. " +
      "`payments-no-implicit-materialization.test.ts` falha se alguém o importar.",
  },
];

/** Todos os `.from("tabela")` seguidos de uma escrita, em todo o `src/` publicado. */
function escritasDirectas(): Array<{ ficheiro: string; tabela: string; linha: number }> {
  const encontradas: Array<{ ficheiro: string; tabela: string; linha: number }> = [];

  const percorrer = (dir: string) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "__tests__") continue;
        percorrer(completo);
        continue;
      }
      if (!/\.tsx?$/.test(entrada.name)) continue;

      const relativo = path.relative(process.cwd(), completo).replace(/\\/g, "/");
      const linhas = ler(relativo).split(/\r?\n/);
      linhas.forEach((linha, i) => {
        for (const tabela of TABELAS_SENSIVEIS) {
          // `.from("x")` e uma escrita na mesma linha — a forma que o
          // supabase-js encadeia na prática.
          const escreve = new RegExp(
            `\\.from\\("${tabela}"\\)[\\s\\S]*?\\.(insert|update|delete|upsert)\\b`,
          );
          if (escreve.test(linha)) {
            encontradas.push({ ficheiro: relativo, tabela, linha: i + 1 });
          }
        }
      });
    }
  };

  percorrer(path.join(process.cwd(), "src"));
  return encontradas;
}

describe("FIN-PERIOD-WRITER-INVENTORY", () => {
  it("cada writer financeiro chama as RPCs da sua migration", () => {
    const emFalta: string[] = [];

    for (const [ficheiro, rpcs] of Object.entries(WRITERS)) {
      const fonte = ler(ficheiro);
      for (const rpc of rpcs) {
        if (!fonte.includes(`rpc("${rpc}"`)) emFalta.push(`${ficheiro} → ${rpc}`);
      }
    }

    expect(
      emFalta,
      "um writer financeiro deixou de chamar a RPC atómica da sua migration — " +
        "a decisão de período voltou para fora da transação",
    ).toEqual([]);
  });

  it("nenhum writer convertido volta a escrever directamente numa tabela de período", () => {
    const convertidos = new Set(Object.keys(WRITERS));
    const reincidentes = escritasDirectas()
      .filter((e) => convertidos.has(e.ficheiro))
      .map((e) => `${e.ficheiro}:${e.linha} → ${e.tabela}`);

    expect(
      reincidentes,
      "um ficheiro já encaminhado voltou a escrever à mão: chamar a RPC num " +
        "caminho não protege o outro",
    ).toEqual([]);
  });

  it("não aparece nenhuma escrita directa que não esteja inventariada", () => {
    const conhecidas = new Set(EXCECOES.map((e) => `${e.ficheiro}::${e.tabela}`));
    const novas = escritasDirectas()
      .filter((e) => !Object.keys(WRITERS).includes(e.ficheiro))
      .filter((e) => !conhecidas.has(`${e.ficheiro}::${e.tabela}`))
      .map((e) => `${e.ficheiro}:${e.linha} → ${e.tabela}`);

    expect(
      novas,
      "escrita directa nova numa tabela sensível ao período. Ou passa pela RPC " +
        "atómica, ou entra em EXCECOES com dono e razão — não fica sem registo",
    ).toEqual([]);
  });

  it("cada excepção inventariada continua a existir, e diz de quem é", () => {
    const reais = new Set(escritasDirectas().map((e) => `${e.ficheiro}::${e.tabela}`));

    for (const excecao of EXCECOES) {
      const chave = `${excecao.ficheiro}::${excecao.tabela}`;
      expect(
        reais.has(chave),
        `a excepção ${chave} já não corresponde a nada no código — ` +
          "foi resolvida e deve sair da lista",
      ).toBe(true);
      expect(excecao.razao.length, `${chave} sem razão escrita`).toBeGreaterThan(40);
    }
  });

  it("PERIOD_SENSITIVE_RACY_WRITERS = 0", () => {
    // A afirmação inteira do protocolo, num sítio só: nenhuma escrita que
    // decida o valor de um mês acontece fora de uma RPC atómica.
    //
    // As excepções que restam não contam para isto, e o teste diz porquê em vez
    // de as ignorar em silêncio: duas anonimizam uma chave estrangeira, e a
    // terceira é um módulo que nenhum caminho da aplicação alcança.
    const racy = EXCECOES.filter(
      (e) =>
        e.ficheiro !== "src/app/actions/colaboradores.ts" &&
        e.ficheiro !== "src/lib/payments-month-materialization.ts",
    );

    expect(
      racy,
      "voltou a existir uma escrita que decide o mês fora da transação que o valida",
    ).toEqual([]);

    // A folha foi a última a entrar. Se algum dia sair, é aqui que se vê.
    expect(Object.keys(WRITERS)).toContain("src/app/actions/payroll.ts");
  });

  it("o arquivamento de clientes não destrói histórico financeiro", () => {
    const accao = ler("src/app/actions/clientes.ts");
    expect(accao).toContain("archive-only");
    const tabela = ler("src/app/(dashboard)/dashboard/clientes/_components/table.tsx");
    expect(tabela).toContain("archiveCliente");
    expect(tabela).not.toContain("deleteCliente");
  });
});
