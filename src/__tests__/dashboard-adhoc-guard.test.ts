// ============================================================================
// T15 — Guarda contra cálculos ad hoc no dashboard financeiro
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
//
// Terceira camada da mesma estratégia: a T11 congelou os cálculos de dinheiro,
// a T14 os das agregações de relatório, e a T15 os do dashboard.
//
//   • ficheiro NOVO com o padrão → falha;
//   • ficheiro conhecido a ganhar MAIS ocorrências → falha;
//   • ocorrências a desaparecer (que é o objectivo) → passa, com instrução para
//     actualizar o inventário.
//
// Como nas anteriores, a guarda NÃO tenta detectar "qualquer conta". Cada
// padrão está ligado a um defeito medido e documentado em
// `docs/T15-dashboard-financeiro-canonico.md`.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

/** Os módulos canónicos são os únicos sítios onde estas contas são legítimas. */
const CANONICAL_PREFIXES = [
  path.join("src", "domain", "billing"),
  path.join("src", "domain", "reports"),
  path.join("src", "domain", "dashboard"),
];

/**
 * Réplicas deliberadas das fórmulas antigas, fora do módulo canónico.
 * `legacy-dashboard.ts` é o irmão do `legacy-formulas.ts` (T11) e do
 * `legacy-reports.ts` (T14): existe para ser COMPARADO, nunca usado.
 */
const LEGACY_REPLICAS = new Set([
  path.join("src", "domain", "dashboard", "legacy-dashboard.ts"),
]);

interface Rule {
  id: string;
  why: string;
  pattern: RegExp;
  allow: Record<string, number>;
}

const RULES: Rule[] = [
  {
    id: "MATH_MAX_1_COUNT",
    why:
      "usa `Math.max(1, count)` como denominador da avença. Quando não há ocorrências, "
      + "cola o valor mensal INTEIRO numa linha só — receita inventada, não "
      + "arredondamento. O modelo canónico devolve UNALLOCATED_NO_OCCURRENCES e deixa "
      + "o montante visível sem o atribuir a ninguém. "
      + "Usar allocateMonthlyAmount de src/domain/billing/monthly-allocation.ts.",
    pattern: /Math\.max\(1,\s*count/g,
    allow: {
      "src/app/actions/daily-billing.ts": 1,
      "src/app/actions/financial-dashboard.ts": 1,
    },
  },
  {
    id: "ZERO_PCT_MASK",
    why:
      "devolve 0% quando o denominador é zero. Um mês com 0 € de receita e 3000 € de "
      + "custos mostra '0%' ao lado de '−3000,00 €' — o 0% não é a percentagem, é a "
      + "ausência dela disfarçada de valor. "
      + "Usar percentOf de src/domain/dashboard/comparison.ts, que devolve "
      + "NOT_COMPARABLE.",
    pattern: />\s*0\s*\?\s*Math\.round\(\([^)]*\/\s*\w*(?:revenue|total|receita)\w*\)\s*\*\s*100\)\s*:\s*0/gi,
    allow: {
      "src/app/actions/financial-dashboard.ts": 1,
    },
  },
  {
    id: "MARGIN_CLAMP",
    why:
      "achata a margem negativa em zero antes de a desenhar. O mês em que a empresa "
      + "perdeu dinheiro fica com o mesmo aspecto do mês em que ficou empatada. "
      + "A margem negativa tem de continuar negativa no DTO; como se desenha é decisão "
      + "de apresentação, não de dados.",
    pattern: /Math\.max\(\w+\.margin,\s*0\)/g,
    // Vazio desde a UI final do Financeiro V2. O padrão vivia na linha de
    // margem do gráfico antigo, que achatava meses negativos em zero; esse
    // gráfico foi substituído e o novo desenha Faturado e Despesas a partir
    // dos valores como estão. Deixar o teto a 1 tornaria a guarda incapaz de
    // acusar o regresso do padrão.
    allow: {},
  },
];

/**
 * `new Date()` a decidir o mês/ano corrente.
 *
 * O processo corre em UTC na Vercel (sem `TZ`). Na primeira hora do dia 1 em
 * hora de verão, o "mês atual" é o mês anterior. `getOperationalSummary`, no
 * MESMO ficheiro, já usa `todayInLisbon()` — as duas metades da página
 * discordam sobre que mês é hoje.
 *
 * Teto por ficheiro sobre a superfície financeira. Medido em 2026-08-08.
 */
const CLOCK_FOR_PERIOD = /new Date\(\)\.getMonth\(\)|now\.getMonth\(\)|now\.getFullYear\(\)/g;

// Financeiro V2 (PR A): as **páginas** deixaram de decidir o período pelo
// relógio. O período vem da URL (`?mes=YYYY-MM`), resolvido por
// `parseFinancePeriod`, e o mês por omissão vem de `todayInLisbon()` num único
// sítio — `src/lib/finance-period.ts`.
//
// Estes tectos desceram a zero por isso, e ficam a zero: se voltar a aparecer
// um `new Date().getMonth()` numa página financeira, esta guarda falha.
//
// `financial-dashboard.ts` continua em 4: é a **fonte legada**, que o PR B
// substitui pela fronteira canónica. Este PR não lhe tocou.
const CLOCK_CEILING: Record<string, number> = {
  "src/app/(dashboard)/dashboard/cobrancas/page.tsx": 0,
  // Baixou de 1 para 0 na UI final: o `new Date()` que decidia o mês vivia
  // no cabeçalho do gráfico antigo, que já não existe.
  "src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx": 0,
  "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/page.tsx": 0,
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx": 0,
  "src/app/(dashboard)/dashboard/financeiro/page.tsx": 0,
  "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx": 0,
  "src/app/actions/financial-dashboard.ts": 4,
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
    if (LEGACY_REPLICAS.has(rel)) continue;
    const content = fs.readFileSync(file, "utf8");
    const matches = content.match(new RegExp(pattern.source, pattern.flags));
    if (matches && matches.length > 0) {
      found.set(rel.split(path.sep).join("/"), matches.length);
    }
  }
  return found;
}

describe("guarda contra cálculos ad hoc no dashboard", () => {
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
          `${rule.id}: estes ficheiros já não têm o padrão. Removê-los do inventário:\n`
          + desaparecidos.join("\n"),
        ).toEqual([]);
      });
    });
  }

  describe("CLOCK_FOR_PERIOD", () => {
    const found = scan(CLOCK_FOR_PERIOD);

    it("a superfície financeira não ganha novas decisões de período pelo relógio", () => {
      const acima = [...found.entries()]
        .filter(([file, count]) => file in CLOCK_CEILING && count > CLOCK_CEILING[file])
        .map(([file, count]) => `${file}: teto ${CLOCK_CEILING[file]} → ${count}`);
      expect(
        acima,
        "O processo corre em UTC na Vercel. Decidir 'este mês' com new Date() mostra o "
        + "mês errado na primeira hora do dia 1 em hora de verão. Usar todayInLisbon() "
        + "na fronteira e buildDashboardPeriods no domínio.\n" + acima.join("\n"),
      ).toEqual([]);
    });

    it("o teto acompanha a realidade — se baixou, actualizar", () => {
      const baixaram = Object.entries(CLOCK_CEILING)
        .filter(([file, ceiling]) => (found.get(file) ?? 0) < ceiling)
        .map(([file, ceiling]) => `${file}: teto ${ceiling} → ${found.get(file) ?? 0}`);
      expect(
        baixaram,
        "O Financeiro V2 avançou. Baixar o teto para que a guarda continue a ser prova:\n"
        + baixaram.join("\n"),
      ).toEqual([]);
    });
  });

  it("o domínio do dashboard não conhece o Supabase", () => {
    const dir = path.join(SRC, "domain", "dashboard");
    const offenders: string[] = [];
    for (const file of sourceFiles(dir)) {
      const content = fs.readFileSync(file, "utf8");
      if (/supabase|createAdminClient|createClient|process\.env|"use server"/.test(content)) {
        offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
    expect(
      offenders,
      "src/domain/dashboard é puro: sem cliente, sem env, sem 'use server'.\n"
      + offenders.join("\n"),
    ).toEqual([]);
  });

  it("o domínio do dashboard não lê o relógio", () => {
    // `todayCivilDate`, `asOf` e `generatedAt` vêm sempre de fora. É esta regra
    // que impede o dashboard de voltar a discordar de si próprio sobre que mês
    // é hoje.
    const dir = path.join(SRC, "domain", "dashboard");
    const offenders: string[] = [];
    for (const file of sourceFiles(dir)) {
      const content = fs.readFileSync(file, "utf8");
      if (/new Date\(\)|Date\.now\(\)/.test(content)) {
        offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
    expect(
      offenders,
      "O domínio recebe todayCivilDate de fora. Ler o relógio traria de volta o "
      + "defeito do mês em UTC.\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("o domínio do dashboard não faz aritmética de dinheiro própria", () => {
    // A T15 compõe; a T11 calcula. Importar money/vat/monthly-allocation para
    // fazer contas aqui seria criar um segundo modelo financeiro.
    const dir = path.join(SRC, "domain", "dashboard");
    const offenders: string[] = [];
    for (const file of sourceFiles(dir)) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      // O comparador constrói fixtures e a projeção soma cêntimos: ambos usam
      // os helpers canónicos da T11, que é precisamente o que se quer.
      if (rel.endsWith("dashboard-compat.ts") || rel.endsWith("projection.ts")) continue;
      const content = fs.readFileSync(file, "utf8");
      if (/from\s+["'][^"']*billing\/(?:vat|monthly-allocation)["']/.test(content)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "O dashboard compõe, não calcula. IVA e distribuição de avença pertencem à T11 "
      + "e chegam já resolvidos no read model da T14.\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("as fórmulas antigas não são importadas por código de aplicação", () => {
    const consumidores = FILES.map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => {
        if (rel === "src/domain/dashboard/legacy-dashboard.ts") return false;
        if (rel === "src/domain/dashboard/dashboard-compat.ts") return false;
        const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
        return /from\s+["'][^"']*legacy-dashboard["']/.test(content);
      });
    expect(
      consumidores,
      "legacy-dashboard.ts só pode ser importado pelo comparador e pelos testes:\n"
      + consumidores.join("\n"),
    ).toEqual([]);
  });

  it("o comparador da T15 não tem modo de escrita", () => {
    const script = fs.readFileSync(
      path.join(ROOT, "scripts", "compare-dashboard-compat.ts"), "utf8",
    );
    expect(script).toContain("assertNoWriteFlags");
    expect(script).not.toMatch(/createClient|createAdminClient|SUPABASE|process\.env/);
  });

  it("a UI do dashboard não foi tocada por esta task", () => {
    // A T15 é offline: nenhum componente, layout ou estilo muda. A prova é que
    // o cliente do dashboard continua a não importar nada do domínio novo.
    const client = fs.readFileSync(
      path.join(
        ROOT, "src", "app", "(dashboard)", "dashboard", "financeiro",
        "_components", "financial-dashboard-client.tsx",
      ),
      "utf8",
    );
    expect(client).not.toMatch(/domain\/dashboard/);
    expect(client).not.toMatch(/domain\/reports/);
  });
});
