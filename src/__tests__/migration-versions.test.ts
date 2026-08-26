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
    //
    // 077 e 078 são o mesmo caso, por outra razão: não estão perdidas, estão
    // **ocupadas**. Vivem em branches que ainda existem no remoto —
    // `fix/secure-migrations-ledger` (077, PR #73) e
    // `feat/domain-mutation-change-event-foundation` (078, PR #74) — e é por
    // isso que a 079 saltou por cima delas em vez de reutilizar um número.
    // Duas migrations diferentes com o mesmo número é uma colisão que só se
    // descobre no dia do merge, com o ledger a dizer que já aplicou aquilo.
    const AUSENTES_CONHECIDAS = [66, 67, 77, 78];

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

  it("🔴 não recria o índice de origem — esse já vem da 024", () => {
    // Correcção a um erro meu: a 071 criava `uq_cash_flow_origin`, e o
    // relatório M0 afirmava que o índice não existia. A auditoria consultou o
    // esquema vivo via REST — que não expõe índices — e nunca olhou para os
    // ficheiros de migration. A 024 já o cria, e está aplicada.
    //
    // Dois índices equivalentes com nomes diferentes não acrescentam
    // protecção: custam escrita em cada insert, para sempre, e deixam o
    // próximo a mexer sem saber qual é o verdadeiro.
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*uq_cash_flow_origin/);
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

  it("🔴 a protecção de idempotência existe no baseline, vinda da 024", () => {
    // É isto que o `markPaymentPaid` vai precisar. Provar que existe é tão
    // importante como não a duplicar — sem ela, um duplo clique cria duas
    // saídas de caixa para o mesmo pagamento.
    const m024 = fs.readFileSync(
      path.join(DIR, "024_cash_flow_reference_integrity.sql"),
      "utf8",
    ).replace(/^\s*--.*$/gm, "");

    expect(m024).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS cash_flow_entries_reference_unique/);
    expect(m024).toMatch(/\(company_id, reference_type, reference_id\)/);
    // Parcial: 439 das 444 linhas têm `reference_type` nulo, e um índice total
    // rejeitaria a segunda despesa manual sem origem.
    expect(m024).toMatch(/WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL/);
  });

  it("não toca em due_date nem em source_id", () => {
    expect(sql).not.toMatch(/due_date|source_id/);
  });
});

describe("migration 073 — pagamento → caixa, preparada e não aplicada", () => {
  const bruto = fs.readFileSync(path.join(DIR, "073_payment_to_cashflow.sql"), "utf8");
  const sql = bruto.replace(/^\s*--.*$/gm, "");

  it("🔴 o ON CONFLICT repete o predicado do índice parcial", () => {
    // Defeito real, apanhado pelo ensaio: sem o `WHERE`, o Postgres não infere
    // um índice **parcial** e recusa com «there is no unique or exclusion
    // constraint matching the ON CONFLICT specification». A função aplicava-se
    // sem erro; só rebentava na primeira vez que alguém pagasse.
    const idx = sql.indexOf("ON CONFLICT (company_id, reference_type, reference_id)");
    expect(idx, "ON CONFLICT pela identidade de origem").toBeGreaterThan(-1);
    expect(sql.slice(idx, idx + 220)).toMatch(
      /WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL/,
    );
  });

  it("🔴 a reversão apaga pela origem, nunca por valor e data", () => {
    // Apagar por `(amount, date)` levaria à frente a despesa manual que alguém
    // lançou no mesmo dia pelo mesmo montante — e essa não volta.
    const del = sql.slice(sql.indexOf("DELETE FROM public.cash_flow_entries"));
    expect(del).toMatch(/reference_type = 'fixed_variable_payment'/);
    expect(del).toMatch(/reference_id = p_payment_id/);
    expect(del.slice(0, del.indexOf(";"))).not.toMatch(/amount|c\.date|AND date/);
  });

  it("não faz backfill dos pagamentos já marcados como pagos", () => {
    // Criar movimentos de caixa para pagamentos antigos seria inventar
    // histórico de dinheiro a partir de um estado que ninguém verificou.
    // O único INSERT em cash_flow_entries é por VALUES, com um pagamento de
    // cada vez. Um `INSERT ... SELECT ... FROM fixed_variable_payments` varria
    // a tabela toda e criava movimentos em massa.
    //
    // A primeira versão desta asserção varria o ficheiro inteiro e casava o
    // INSERT de uma função com o SELECT da outra — mede-se dentro do comando,
    // até ao `;`.
    const inserts = sql.match(/INSERT INTO public\.cash_flow_entries[\s\S]*?;/gi) ?? [];
    expect(inserts.length, "um só INSERT em cash_flow_entries").toBe(1);
    expect(inserts[0]).toMatch(/VALUES/);
    expect(inserts[0]).not.toMatch(/FROM public\.fixed_variable_payments/i);
  });

  it("a ausência de linha em financial_periods significa aberto", () => {
    expect(sql).toMatch(/SELECT NOT EXISTS/);
    expect(sql).toMatch(/fp\.status = 'closed'/);
  });

  it("tranca a linha do pagamento antes de decidir", () => {
    expect(sql).toMatch(/FROM public\.fixed_variable_payments[\s\S]{0,200}FOR UPDATE/);
  });

  it("um pagamento de outra empresa não é alcançável", () => {
    expect(sql).toMatch(/company_id = p_company_id/);
  });
});
