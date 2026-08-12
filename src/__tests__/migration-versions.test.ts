// ============================================================================
// MIGRATION_VERSION_UNIQUE
// ============================================================================
//
// Duas migrations com a mesma versão só se descobrem a meio de uma aplicação,
// com metade do esquema já alterado e a outra metade por decidir qual corre
// primeiro. Aconteceu: `070_guard_profile_managed_fields.sql` e
// `070_finance_periods_and_expense_categories.sql` coexistiram neste ramo.
//
// ---------------------------------------------------------------------------
// Porque só a sequência numérica
// ---------------------------------------------------------------------------
// Há dois esquemas de nomes no repositório:
//
//   NNN_nome.sql        sequência do projecto — a ordem é a versão
//   YYYYMMDD_nome.sql   data — três no mesmo dia é normal e esperado
//
// Exigir unicidade às datadas obrigaria a renomear migrations **já aplicadas
// em produção**, o que é bem pior do que o problema: a ordem delas está
// registada na base, e o ficheiro é só o rasto.
//
// A ordem entre datas iguais resolve-se alfabeticamente, de forma estável, e
// nenhuma das três de 2026-06-09 toca nas mesmas tabelas.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "supabase", "migrations");

function ficheiros(): string[] {
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
}

/** `071_x.sql` → `071`. Devolve `null` para as datadas e para o resto. */
function versaoSequencial(nome: string): string | null {
  const m = /^(\d{3})_/.exec(nome);
  return m ? m[1] : null;
}

describe("migrations — a versão identifica uma só migration", () => {
  it("há migrations para verificar", () => {
    // Se o directório mudasse de sítio, tudo o resto passaria por vacuidade.
    expect(ficheiros().length).toBeGreaterThan(50);
  });

  it("🔴 nenhuma versão sequencial se repete", () => {
    const porVersao = new Map<string, string[]>();
    for (const f of ficheiros()) {
      const v = versaoSequencial(f);
      if (!v) continue;
      porVersao.set(v, [...(porVersao.get(v) ?? []), f]);
    }

    const colisoes = [...porVersao.entries()]
      .filter(([, fs_]) => fs_.length > 1)
      .map(([v, fs_]) => `${v}: ${fs_.join(" + ")}`);

    expect(
      colisoes,
      "duas migrations com a mesma versão — renumerar a mais recente",
    ).toEqual([]);
  });

  it("as datadas podem repetir-se no mesmo dia, e isso é aceite", () => {
    // Documenta a excepção de propósito: se alguém a estreitar sem pensar,
    // este teste falha e obriga a ler o porquê acima.
    const datadas = ficheiros().filter((f) => /^\d{8}_/.test(f));
    const dias = new Set(datadas.map((f) => f.slice(0, 8)));
    expect(datadas.length).toBeGreaterThanOrEqual(dias.size);
  });

  it("todos os nomes seguem um dos dois esquemas conhecidos", () => {
    const estranhos = ficheiros().filter((f) => !/^(\d{3}|\d{8})_/.test(f));
    expect(estranhos, "nome de migration fora dos dois padrões").toEqual([]);
  });

  it("a sequência só tem os saltos que estão documentados", () => {
    // Um salto costuma significar uma migration perdida num rebase — mas 066 e
    // 067 estão em falta por decisão, não por acidente: vivem na branch
    // `fix/atomic-contract-calendar-sync`, congelada depois do incidente de
    // produção de 2026-08-05, e serão extraídas em PRs isolados.
    //
    // O teste continua a existir para apanhar o **próximo** salto.
    const AUSENTES_CONHECIDAS = [66, 67];

    const nums = ficheiros()
      .map(versaoSequencial)
      .filter((v): v is string => v !== null)
      .map(Number)
      .sort((a, b) => a - b);

    const faltam: number[] = [];
    for (let n = nums[0]; n < nums[nums.length - 1]; n++) {
      if (!nums.includes(n) && !AUSENTES_CONHECIDAS.includes(n)) faltam.push(n);
    }
    expect(faltam, "versões em falta na sequência").toEqual([]);
  });
});

describe("migration 071 — preparada, não aplicada", () => {
  const bruto = fs.readFileSync(
    path.join(DIR, "071_finance_periods_and_expense_categories.sql"),
    "utf8",
  );

  // 🔴 Só o SQL, sem comentários.
  //
  // A primeira versão destes testes varria o ficheiro inteiro e falhava nos
  // **próprios comentários** — o cabeçalho explica que não se infere "Galp" →
  // combustível, e a asserção "não menciona combustível" apanhava essa frase.
  // É a armadilha "mencionar ≠ usar", que este projecto já apanhou várias
  // vezes: procurar por texto encontra sempre a documentação do problema.
  const sql = bruto.replace(/^\s*--.*$/gm, "");

  it("🔴 não semeia categorias nenhumas", () => {
    // As catorze categorias foram uma sugestão nossa, não uma lista aprovada
    // pela gestão. Um seed transformaria proposta em dado contabilístico
    // permanente — e categorias que ninguém pediu são categorias que ninguém
    // apaga.
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.expense_categories/i);
    expect(sql).not.toMatch(/Combust[íi]vel|Subcontrata/i);
  });

  it("não classifica o histórico nem faz backfill", () => {
    expect(sql).not.toMatch(/UPDATE\s+public\.cash_flow_entries\s+SET/i);
    expect(sql).not.toMatch(/ILIKE|~\*|regexp/i);
  });

  it("a categoria fica nullable — não se inventa para as linhas antigas", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS expense_category_id uuid/);
    expect(sql).not.toMatch(/expense_category_id uuid NOT NULL/);
  });

  it("🔴 o índice de origem é único e parcial", () => {
    // Único, porque é ele que torna «marcar como pago» idempotente na base —
    // uma verificação em JavaScript perde a corrida contra dois pedidos
    // concorrentes. Parcial, porque 439 das 444 linhas têm `reference_type`
    // nulo e um índice total rejeitaria a segunda despesa manual.
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_flow_origin/);
    expect(sql).toMatch(/WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL/);
  });

  it("reabrir um período exige motivo", () => {
    expect(sql).toMatch(/financial_periods_reopen_needs_reason/);
    expect(sql).toMatch(/length\(trim\(reopen_reason\)\)\s*>\s*0/);
  });

  it("as duas tabelas novas têm RLS por empresa", () => {
    for (const t of ["expense_categories", "financial_periods"]) {
      expect(sql, `${t} sem RLS`).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
    }
  });

  it("não toca em due_date nem em source_id", () => {
    expect(sql).not.toMatch(/due_date|source_id/);
  });
});
