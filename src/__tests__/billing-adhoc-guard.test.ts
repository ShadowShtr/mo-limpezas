// ============================================================================
// T11 — Guarda contra novos cálculos financeiros ad hoc
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
//
// O problema da T11 não foi um cálculo errado. Foi um cálculo CERTO, copiado
// para cinco sítios, e depois corrigido em três. Esta guarda impede que a lista
// cresça: os pontos que hoje fazem a conta à mão estão inventariados abaixo,
// congelados, com o número exacto de ocorrências.
//
//   • um ficheiro NOVO com um destes padrões → o teste falha;
//   • um ficheiro conhecido que ganhe MAIS ocorrências → o teste falha;
//   • remover ocorrências (que é o objectivo do Financeiro V2) → passa, e a
//     mensagem diz para actualizar o inventário.
//
// A guarda NÃO tenta detectar "qualquer conta com dinheiro". Uma expressão
// regular assim daria falsos positivos em tudo (percentagens de progresso,
// larguras de barra, durações) e seria desligada na primeira semana. Cobre três
// padrões concretos, cada um ligado a um defeito medido.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

/** O módulo canónico é o único sítio onde estas contas são legítimas. */
const CANONICAL_PREFIX = path.join("src", "domain", "billing");

/**
 * Réplicas deliberadas das fórmulas antigas, fora do módulo canónico.
 *
 * `src/domain/billing/legacy-formulas.ts` (T11) já está coberto pelo prefixo
 * acima. `src/domain/reports/legacy-reports.ts` (T14) é o seu gémeo para as
 * agregações de relatório e tem exactamente o mesmo papel: existe para ser
 * COMPARADO, nunca usado. Um teste próprio em `reports-adhoc-guard.test.ts`
 * garante que nenhum código de aplicação o importa.
 *
 * A isenção é por ficheiro, e não por pasta: o resto de `src/domain/reports`
 * continua a ser varrido por esta guarda.
 */
const LEGACY_REPLICAS = new Set([
  path.join("src", "domain", "reports", "legacy-reports.ts"),
]);

interface Rule {
  id: string;
  /** O defeito que o padrão representa. Aparece na mensagem de falha. */
  why: string;
  pattern: RegExp;
  /** ficheiro (posix, relativo à raiz) → nº de ocorrências congelado. */
  allow: Record<string, number>;
}

const RULES: Rule[] = [
  {
    id: "AVENCA_SPLIT",
    why:
      "divide o valor mensal do contrato pelo nº de ocorrências à mão. Perde cêntimos "
      + "(100,00 € ÷ 3 = 99,99 €) e cada consumidor usa um denominador diferente. "
      + "Usar allocateMonthlyAmount de src/domain/billing/monthly-allocation.ts.",
    pattern: /fixed_?[Pp]rice[^;\n]*\/\s*(?:Math\.max\(1,\s*)?count/g,
    allow: {
      "src/app/actions/daily-billing.ts": 2,
      "src/app/actions/financial-dashboard.ts": 1,
      "src/app/actions/reports.ts": 1,
    },
  },
  {
    id: "VAT_INLINE_FACTOR",
    why:
      "aplica IVA com `* (1 + taxa/100)` em vez do helper canónico. Devolve só o total, "
      + "nunca o imposto, e arredonda em momentos diferentes conforme o ecrã. "
      + "Usar applyVat de src/domain/billing/vat.ts, que devolve net/vat/gross.",
    // `vat[A-Za-z]*` cobre vatRate, vatRatePct e qualquer variante futura — a
    // primeira versão desta regra só apanhava `vatRate` e deixava passar o
    // `vatRatePct` do próprio withVat. A guarda encontrou o buraco sozinha.
    pattern: /1\s*\+\s*(?:vat[A-Za-z]*\s*\/\s*100|vatFactor)/g,
    allow: {
      "src/app/(dashboard)/dashboard/calendario/_components/service-create-sheet.tsx": 1,
      "src/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client.tsx": 3,
      "src/app/(dashboard)/dashboard/relatorios/_components/reports-tabs.tsx": 4,
      "src/app/actions/financial-dashboard.ts": 2,
      "src/lib/service-value.ts": 1,
    },
  },
  {
    id: "VAT_RATE_DIVISION",
    why:
      "converte a taxa de IVA em fator localmente. Cada sítio que o faz passa a ter a "
      + "sua própria ordem de arredondamento. A conversão pertence ao módulo de IVA.",
    pattern: /vat(?:Rate|RatePct)\s*\/\s*100/g,
    allow: {
      "src/app/(dashboard)/dashboard/calendario/_components/service-create-sheet.tsx": 2,
      "src/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client.tsx": 3,
      "src/app/(dashboard)/dashboard/contratos/_components/sheet.tsx": 1,
      "src/app/(dashboard)/dashboard/relatorios/_components/reports-tabs.tsx": 2,
      "src/app/actions/financial-dashboard.ts": 1,
      "src/app/actions/invoices.ts": 1,
      "src/app/actions/reports.ts": 1,
      "src/lib/service-value.ts": 1,
    },
  },
];

/** Hardcode literal da taxa portuguesa em código de domínio. */
const HARDCODED_VAT = /\*\s*1\.23\b/g;

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
    if (rel.startsWith(CANONICAL_PREFIX)) continue;
    if (LEGACY_REPLICAS.has(rel)) continue;
    const content = fs.readFileSync(file, "utf8");
    const matches = content.match(new RegExp(pattern.source, "g"));
    if (matches && matches.length > 0) {
      found.set(rel.split(path.sep).join("/"), matches.length);
    }
  }
  return found;
}

describe("guarda contra cálculos financeiros ad hoc", () => {
  for (const rule of RULES) {
    describe(rule.id, () => {
      const found = scan(rule.pattern);

      it("não aparece em nenhum ficheiro novo", () => {
        const novos = [...found.keys()].filter((f) => !(f in rule.allow));
        expect(
          novos,
          `${rule.id}: ficheiro novo a fazer a conta à mão.\n${rule.why}\n`
          + `Ficheiros: ${novos.join(", ")}`,
        ).toEqual([]);
      });

      it("não cresce nos ficheiros conhecidos", () => {
        const cresceram = [...found.entries()]
          .filter(([file, count]) => file in rule.allow && count > rule.allow[file])
          .map(([file, count]) => `${file}: ${rule.allow[file]} → ${count}`);
        expect(
          cresceram,
          `${rule.id}: aumentou o nº de contas à mão.\n${rule.why}\n`
          + cresceram.join("\n"),
        ).toEqual([]);
      });

      it("o inventário continua a corresponder à realidade", () => {
        // Se uma entrada do inventário desapareceu, o Financeiro V2 avançou —
        // e o inventário tem de encolher com ele, senão deixa de ser prova.
        const desaparecidos = Object.keys(rule.allow).filter((f) => !found.has(f));
        expect(
          desaparecidos,
          `${rule.id}: estes ficheiros já não fazem a conta à mão. Removê-los do `
          + `inventário desta guarda:\n${desaparecidos.join("\n")}`,
        ).toEqual([]);
      });
    });
  }

  it("a taxa de IVA nunca está fixa em código", () => {
    const offenders = [...scan(HARDCODED_VAT).keys()];
    expect(
      offenders,
      "A taxa vem de company_settings.vat_rate. Um `* 1.23` fixo em código deixa de "
      + `refletir a configuração:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("o módulo canónico não importa as fórmulas antigas para produção", () => {
    // legacy-formulas.ts existe para ser COMPARADO, não usado. Só o comparador
    // e os testes lhe podem tocar.
    const consumidores = FILES.map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => {
        if (rel === "src/domain/billing/legacy-formulas.ts") return false;
        if (rel === "src/domain/billing/billing-compat.ts") return false;
        const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
        return /from\s+["'][^"']*legacy-formulas["']/.test(content);
      });
    expect(
      consumidores,
      `legacy-formulas.ts só pode ser importado pelo comparador e pelos testes:\n`
      + consumidores.join("\n"),
    ).toEqual([]);
  });
});
