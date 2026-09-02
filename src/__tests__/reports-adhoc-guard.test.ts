// ============================================================================
// T14 — Guarda contra cálculos ad hoc em relatórios e exportações
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
//
// Estende a estratégia da T11 (`billing-adhoc-guard.test.ts`) para os defeitos
// que a T14 mediu. Mesmo princípio: inventário congelado com contagem exacta.
//
//   • ficheiro NOVO com o padrão → falha;
//   • ficheiro conhecido a ganhar MAIS ocorrências → falha;
//   • ocorrências a desaparecer (que é o objectivo) → passa, com instrução para
//     actualizar o inventário.
//
// Como na T11, a guarda NÃO tenta detectar "qualquer conta". Cobre padrões
// concretos, cada um ligado a um defeito medido e documentado em
// `docs/T14-relatorios-read-model.md`.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

/** Os módulos canónicos são os únicos sítios onde estas contas são legítimas. */
const CANONICAL_PREFIXES = [
  path.join("src", "domain", "billing"),
  path.join("src", "domain", "reports"),
];

interface Rule {
  id: string;
  why: string;
  pattern: RegExp;
  /** ficheiro (posix, relativo à raiz) → nº de ocorrências congelado. */
  allow: Record<string, number>;
}

const RULES: Rule[] = [
  {
    id: "ABSENCE_FULL_DURATION",
    why:
      "conta a duração INTEIRA de uma ausência em vez da parte que cai no período. "
      + "Uma baixa de 61 dias aparece com 61 dias tanto em agosto (que tem 31) como em "
      + "setembro — 122 dias para uma ausência de 61. "
      + "Usar absenceDaysWithinPeriod de src/domain/reports/absence-metrics.ts.",
    // A subtracção DIRECTA de `ends_on` por `starts_on`.
    //
    // A regra é estreita de propósito. `src/lib/payroll-calc.ts` tem uma conta
    // com a mesma forma mas faz `Math.max`/`Math.min` contra os limites do
    // período ANTES de subtrair — ou seja, já calcula a interseção, e está
    // certa. Uma regra mais larga apanhá-la-ia como defeito e a guarda seria
    // desligada na primeira semana.
    pattern: /new Date\(\w+\.ends_on\)\.getTime\(\)\s*-\s*new Date\(\w+\.starts_on\)/g,
    allow: {
      "src/app/actions/reports.ts": 1,
    },
  },
  {
    id: "STATUS_ELSE_BUCKET",
    why:
      "agrupa os estados restantes num balde com `else`. `em_curso` e `sem_cobertura` "
      + "ficam indistinguíveis de `agendado`, e qualquer estado novo do schema entra lá "
      + "sem aviso. Usar countServices de src/domain/reports/operational-metrics.ts, "
      + "que tem um contador por estado e assinala UNKNOWN_STATUS.",
    pattern: /status\s*===\s*["']falta["']\)[^;]*;\s*\n?\s*else\s+(?!if)/g,
    allow: {
      "src/app/actions/reports.ts": 1,
    },
  },
  {
    id: "VAT_DEFAULT_23",
    why:
      "assume 23% quando a leitura de company_settings falha. O relatório passa a "
      + "apresentar a taxa portuguesa corrente como se fosse configuração da empresa, e "
      + "uma consulta falhada fica indistinguível de uma taxa realmente configurada. "
      + "O read model da T14 devolve VAT_RATE_UNAVAILABLE e não assume nada.",
    pattern: /vat_rate\s*\?\?\s*23\b/g,
    allow: {
      "src/app/(dashboard)/dashboard/clientes/[id]/page.tsx": 1,
      "src/app/(dashboard)/dashboard/contratos/page.tsx": 1,
      "src/app/actions/daily-billing.ts": 2,
      "src/app/actions/financial-dashboard.ts": 1,
      "src/app/actions/invoices.ts": 1,
      "src/app/actions/reports.ts": 1,
    },
  },
];

/**
 * Consulta cujo `error` é ignorado à entrada — `const { data: x } = await …`
 * sem `error` na desestruturação.
 *
 * É o defeito central da T14: `data` vem `null`, o `?? []` a seguir dá lista
 * vazia, e o relatório apresenta 0 € com o mesmo aspecto de um mês sem receita.
 *
 * Cobre as duas formas usadas no repositório: a directa (`= await admin…`) e a
 * condicional (`= ids.length > 0 ? await admin… : { data: [] }`), que é a que o
 * Dashboard Financeiro usa e que uma regra ingénua deixaria passar.
 */
const IGNORED_ERROR =
  /const\s*\{\s*data:\s*\w+\s*\}\s*=\s*(?:(?:await\s+)?(?:admin|supabase)\b|[^;=]{0,60}\?\s*\n?\s*await\s+(?:admin|supabase)\b)/g;

/**
 * Tetos medidos em 2026-08-08, só para a superfície de relatório/financeiro.
 *
 * O padrão existe em ~250 sítios no repositório inteiro. Baixá-lo em toda a
 * parte é uma frente própria; a T14 congela apenas onde ele produz NÚMEROS
 * FINANCEIROS, que é onde um erro silenciado vira 0 € com ar de número certo.
 */
const IGNORED_ERROR_CEILING: Record<string, number> = {
  "src/app/(dashboard)/dashboard/financeiro/page.tsx": 1,
  "src/app/(dashboard)/dashboard/relatorios/page.tsx": 1,
  "src/app/actions/cash-flow.ts": 3,
  "src/app/actions/daily-billing.ts": 0,
  "src/app/actions/financial-dashboard.ts": 2,
  // 13 → 6. Sete erros de consulta deixaram de ser ignorados em
  // `generateInvoices`: avenças, contratos ativos, locais de preço fixo,
  // locais, clientes, faturas existentes e as definições de IVA.
  //
  // O que estava em jogo não era um número errado: se a consulta das avenças
  // falhasse, a função devolvia **sucesso com zero faturas** e ninguém era
  // faturado nesse mês, com o ecrã a dizer que correu bem.
  "src/app/actions/invoices.ts": 6,
  // 9 → 0 (P0A). A folha deixou de ter uma única leitura cujo erro se
  // confunda com ausência de dados. As quatro do cálculo — definições, ponto,
  // faltas e registos existentes — abortavam para valores por omissão, zero
  // horas, zero faltas e "não há ajustes"; as de `markPayrollPaid` davam
  // sucesso sem pagar nada.
  //
  // O teto a zero é agora uma afirmação forte: qualquer leitura nova nesta
  // action tem de tratar o `error`, ou esta guarda fica vermelha.
  "src/app/actions/payroll.ts": 0,
  "src/app/actions/reports.ts": 10,
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = sourceFiles(SRC);

function scan(pattern: RegExp): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of FILES) {
    const rel = path.relative(ROOT, file);
    if (CANONICAL_PREFIXES.some((p) => rel.startsWith(p))) continue;
    const content = fs.readFileSync(file, "utf8");
    const matches = content.match(new RegExp(pattern.source, pattern.flags));
    if (matches && matches.length > 0) {
      found.set(rel.split(path.sep).join("/"), matches.length);
    }
  }
  return found;
}

describe("guarda contra cálculos ad hoc em relatórios", () => {
  for (const rule of RULES) {
    describe(rule.id, () => {
      const found = scan(rule.pattern);

      it("não aparece em nenhum ficheiro novo", () => {
        const novos = [...found.keys()].filter((f) => !(f in rule.allow));
        expect(
          novos,
          `${rule.id}: ficheiro novo com o padrão.\n${rule.why}\n`
          + `Ficheiros: ${novos.join(", ")}`,
        ).toEqual([]);
      });

      it("não cresce nos ficheiros conhecidos", () => {
        const cresceram = [...found.entries()]
          .filter(([file, count]) => file in rule.allow && count > rule.allow[file])
          .map(([file, count]) => `${file}: ${rule.allow[file]} → ${count}`);
        expect(
          cresceram,
          `${rule.id}: aumentou o nº de ocorrências.\n${rule.why}\n` + cresceram.join("\n"),
        ).toEqual([]);
      });

      it("o inventário continua a corresponder à realidade", () => {
        const desaparecidos = Object.keys(rule.allow).filter((f) => !found.has(f));
        expect(
          desaparecidos,
          `${rule.id}: estes ficheiros já não têm o padrão. Removê-los do inventário `
          + `desta guarda:\n${desaparecidos.join("\n")}`,
        ).toEqual([]);
      });
    });
  }

  describe("IGNORED_QUERY_ERROR", () => {
    const found = scan(IGNORED_ERROR);

    it("os ficheiros de relatório não ganham consultas com erro ignorado", () => {
      const acima = [...found.entries()]
        .filter(([file, count]) => file in IGNORED_ERROR_CEILING && count > IGNORED_ERROR_CEILING[file])
        .map(([file, count]) => `${file}: teto ${IGNORED_ERROR_CEILING[file]} → ${count}`);
      expect(
        acima,
        "Uma consulta cujo `error` é ignorado transforma falha em 0 € com ar de número "
        + "certo. Devolver SourceResult (src/domain/reports/integrity.ts) e deixar o read "
        + "model marcar *_QUERY_FAILED.\n" + acima.join("\n"),
      ).toEqual([]);
    });

    it("o teto acompanha a realidade — se baixou, actualizar", () => {
      const baixaram = Object.entries(IGNORED_ERROR_CEILING)
        .filter(([file, ceiling]) => (found.get(file) ?? 0) < ceiling)
        .map(([file, ceiling]) => `${file}: teto ${ceiling} → ${found.get(file) ?? 0}`);
      expect(
        baixaram,
        "O Financeiro V2 avançou. Baixar o teto para que a guarda continue a ser prova:\n"
        + baixaram.join("\n"),
      ).toEqual([]);
    });
  });

  it("o domínio de relatórios não importa as fórmulas antigas para produção", () => {
    // legacy-reports.ts existe para ser COMPARADO, não usado.
    const consumidores = FILES.map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => {
        if (rel === "src/domain/reports/legacy-reports.ts") return false;
        if (rel === "src/domain/reports/reports-compat.ts") return false;
        const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
        return /from\s+["'][^"']*legacy-reports["']/.test(content);
      });
    expect(
      consumidores,
      "legacy-reports.ts só pode ser importado pelo comparador e pelos testes:\n"
      + consumidores.join("\n"),
    ).toEqual([]);
  });

  it("o domínio de relatórios não conhece o Supabase", () => {
    const dir = path.join(SRC, "domain", "reports");
    const offenders: string[] = [];
    for (const file of sourceFiles(dir)) {
      const content = fs.readFileSync(file, "utf8");
      if (/supabase|createAdminClient|createClient|process\.env|"use server"/.test(content)) {
        offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
    expect(
      offenders,
      "src/domain/reports é puro: sem cliente, sem env, sem 'use server'.\n"
      + offenders.join("\n"),
    ).toEqual([]);
  });

  it("o domínio de relatórios não lê o relógio", () => {
    // `generatedAt`/`asOf` vêm sempre de fora, para que um relatório de um mês
    // passado seja reproduzível tal como era.
    const dir = path.join(SRC, "domain", "reports");
    const offenders: string[] = [];
    for (const file of sourceFiles(dir)) {
      const content = fs.readFileSync(file, "utf8");
      if (/new Date\(\)|Date\.now\(\)/.test(content)) {
        offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
    expect(
      offenders,
      "O domínio recebe `asOf` e `generatedAt` de fora. Ler o relógio tornaria o "
      + "relatório irreproduzível.\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("o comparador da T14 não tem modo de escrita", () => {
    const script = fs.readFileSync(path.join(ROOT, "scripts", "compare-reports-compat.ts"), "utf8");
    expect(script).toContain("assertNoWriteFlags");
    expect(script).not.toMatch(/createClient|createAdminClient|SUPABASE|process\.env/);
  });
});
