// ============================================================================
// REPARAÇÃO DA COMPETÊNCIA — o executor, exercitado contra um cliente falso
// ============================================================================
//
// Nenhum teste aqui liga a uma base. Um cliente falso responde às consultas e
// grava tudo o que recebeu, para se poder afirmar — por captura, não por
// leitura do código — que o dry-run não escreve e que um lote com uma linha
// desatualizada não escreve nada.
//
// O que está em jogo: 29 pagamentos reais, dois deles já pagos, quatro com
// anexo, um com movimento de caixa. Um lote parcial seria pior do que o
// defeito, e por isso a única saída em caso de divergência é ROLLBACK total.
// ============================================================================
import { describe, it, expect } from "vitest";
import {
  parseArgs, runBackfill, competenceFromDueDate, validarManifesto,
  compararComManifesto, periodosFechadosEnvolvidos, sanitizar,
  UPDATE_FIELD_WHITELIST, verificarHashManifesto,
} from "../../scripts/repairs/lib/competence-backfill-core.mjs";

// ─── Cliente falso ───────────────────────────────────────────────────────────

interface Linha {
  id: string; company_id: string; due_date: string | null; amount: number | string | null;
  status: string; paid_at: string | null; period_year: number; period_month: number;
  attachment_url: string | null; attachment_name: string | null;
  attachment_size: number | null; attachment_mime: string | null; updated_at: string;
}

const MUTANTES = ["UPDATE", "INSERT", "DELETE", "TRUNCATE", "ALTER", "DROP"];

class ClienteFalso {
  queries: { sql: string; params?: unknown[] }[] = [];
  linhas: Map<string, Linha>;
  caixa: { id: string; reference_id: string; date: string; amount: number }[];
  periodos: Record<string, unknown>[];
  falharNoUpdateDe: string | null = null;
  mexerNaCaixaDepois = false;

  constructor(linhas: Linha[], opts: {
    caixa?: { id: string; reference_id: string; date: string; amount: number }[];
    periodos?: Record<string, unknown>[];
  } = {}) {
    this.linhas = new Map(linhas.map((l) => [l.id, { ...l }]));
    this.caixa = opts.caixa ?? [];
    this.periodos = opts.periodos ?? [];
  }

  get mutacoes() {
    return this.queries.filter((q) => MUTANTES.some((p) => q.sql.trim().toUpperCase().startsWith(p)));
  }
  get comitou() { return this.queries.some((q) => q.sql.trim().toUpperCase() === "COMMIT"); }
  get reverteu() { return this.queries.some((q) => q.sql.trim().toUpperCase() === "ROLLBACK"); }

  async query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params });
    const s = sql.trim().toUpperCase();

    if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes("financial_periods")) return { rows: this.periodos, rowCount: this.periodos.length };

    if (sql.includes("cash_flow_entries")) {
      const ids = (params?.[0] as string[]) ?? [];
      const rows = this.caixa.filter((c) => ids.includes(c.reference_id));
      // Simula alguém a mexer no caixa entre o antes e o depois.
      if (this.mexerNaCaixaDepois && this.queries.filter((q) => q.sql.includes("cash_flow_entries")).length > 1) {
        return { rows: rows.map((c) => ({ ...c, date: "1999-01-01" })), rowCount: rows.length };
      }
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith("SELECT") && sql.includes("fixed_variable_payments")) {
      const ids = (params?.[0] as string[]) ?? [];
      const rows = ids.map((i) => this.linhas.get(i)).filter(Boolean);
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith("UPDATE") && sql.includes("fixed_variable_payments")) {
      const [ano, mes, id] = params as [number, number, string];
      if (this.falharNoUpdateDe === id) return { rows: [], rowCount: 0 };
      const l = this.linhas.get(id);
      if (!l) return { rows: [], rowCount: 0 };
      l.period_year = ano; l.period_month = mes;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const linha = (over: Partial<Linha> = {}): Linha => ({
  id: "p-1", company_id: "empresa-1", due_date: "2026-08-03", amount: 9.13,
  status: "pendente", paid_at: null, period_year: 2026, period_month: 7,
  attachment_url: null, attachment_name: null, attachment_size: null, attachment_mime: null,
  updated_at: "2026-08-01T10:00:00.000Z", ...over,
});

const doManifesto = (l: Linha) => ({
  payment_id: l.id, company_id: l.company_id, due_date: l.due_date,
  before_period_year: l.period_year, before_period_month: l.period_month,
  after_period_year: competenceFromDueDate(l.due_date)!.year,
  after_period_month: competenceFromDueDate(l.due_date)!.month,
  status: l.status, paid_at: l.paid_at, amount: l.amount, updated_at: l.updated_at,
  attachment: { url: l.attachment_url, name: l.attachment_name, size: l.attachment_size, mime: l.attachment_mime },
  cashflow: null, reason: "DUE_DATE_MONTH_MISMATCH",
});

const LOTE = [
  linha({ id: "p-1", due_date: "2026-08-03", period_month: 7 }),
  linha({ id: "p-2", due_date: "2026-09-03", period_month: 8, status: "pago", paid_at: "2026-08-24T00:00:00.000Z" }),
  linha({ id: "p-3", due_date: "2026-11-09", period_month: 6, attachment_url: "co/pa/f.pdf", attachment_name: "f.pdf" }),
];
const MANIFESTO = LOTE.map(doManifesto);

const correr = (c: ClienteFalso, extra: Record<string, unknown> = {}) =>
  runBackfill({ client: c, manifesto: MANIFESTO, log: () => {}, logErro: () => {}, ...extra });

// ═══════════════════════════════════════════════════════════════════════════
// A–C — nada escreve sem as quatro flags
// ═══════════════════════════════════════════════════════════════════════════

describe("portões antes de escrever", () => {
  it("A. dry-run não escreve nem abre transação", async () => {
    const c = new ClienteFalso(LOTE);
    const r = await correr(c);
    expect(r.writes).toBe(0);
    expect(c.mutacoes).toEqual([]);
    expect(c.queries.some((q) => q.sql.trim().toUpperCase() === "BEGIN")).toBe(false);
  });

  it("B. --apply sozinho é recusado", () => {
    const r = parseArgs(["--apply"]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--manifest/);
  });

  it("B2. --apply sem confirmação de produção não escreve", async () => {
    const c = new ClienteFalso(LOTE);
    const r = await correr(c, { apply: true, projectRefEsperado: "abc123", confirmProduction: null });
    expect(r.writes).toBe(0);
    expect(c.mutacoes).toEqual([]);
  });

  it("B3. confirmação com o projeto errado não escreve", async () => {
    const c = new ClienteFalso(LOTE);
    const r = await correr(c, { apply: true, projectRefEsperado: "abc123", confirmProduction: "outro" });
    expect(r.exitCode).toBe(1);
    expect(c.mutacoes).toEqual([]);
  });

  it("C1. 🔴 hash do manifesto diferente → recusa antes de qualquer escrita", () => {
    const sha = (o: unknown) => JSON.stringify(o).length.toString(16); // hash de teste
    const bom = sha(MANIFESTO);

    expect(verificarHashManifesto(MANIFESTO, bom, sha).ok).toBe(true);

    // O ficheiro tem o nome certo mas o conteúdo trocado.
    const adulterado = [...MANIFESTO, MANIFESTO[0]];
    const r = verificarHashManifesto(adulterado, bom, sha);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/MANIFEST_SHA_MISMATCH/);
  });

  it("C2. 🔴 sem --manifest-sha, escrever é recusado", () => {
    const sha = (o: unknown) => JSON.stringify(o).length.toString(16);
    const r = verificarHashManifesto(MANIFESTO, null, sha);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/MANIFEST_SHA_REQUIRED/);
  });

  it("C. flag desconhecida é recusada", () => {
    expect(parseArgs(["--force"]).ok).toBe(false);
    expect(parseArgs(["--manifest"]).ok).toBe(false); // valor em falta
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D–F — o que escreve, e só isso
// ═══════════════════════════════════════════════════════════════════════════

describe("o lote válido", () => {
  it("D. 3 candidatas → exatamente 3 UPDATE e um COMMIT", async () => {
    const c = new ClienteFalso(LOTE);
    const r = await correr(c, { apply: true });
    expect(r.writes).toBe(3);
    expect(c.mutacoes).toHaveLength(3);
    expect(c.comitou).toBe(true);
    expect(c.reverteu).toBe(false);
  });

  it("E. 🔴 o UPDATE só toca em period_year e period_month", async () => {
    const c = new ClienteFalso(LOTE);
    await correr(c, { apply: true });

    for (const q of c.mutacoes) {
      expect(q.sql).toMatch(/SET period_year = \$1, period_month = \$2/);
      expect(q.params).toHaveLength(3); // ano, mês, id
      for (const proibido of [
        "amount", "due_date", "status", "paid_at", "company_id", "description",
        "attachment_url", "attachment_name", "attachment_size", "attachment_mime",
      ]) {
        expect(q.sql, proibido).not.toMatch(new RegExp(proibido + "\\s*="));
      }
    }
    expect(UPDATE_FIELD_WHITELIST).toEqual(["period_year", "period_month"]);
  });

  it("F. os campos protegidos ficam iguais depois", async () => {
    const c = new ClienteFalso(LOTE);
    await correr(c, { apply: true });
    for (const orig of LOTE) {
      const f = c.linhas.get(orig.id)!;
      expect(f.amount).toBe(orig.amount);
      expect(f.status).toBe(orig.status);
      expect(f.paid_at).toBe(orig.paid_at);
      expect(f.due_date).toBe(orig.due_date);
      expect(f.attachment_url).toBe(orig.attachment_url);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G–L — qualquer divergência reverte tudo
// ═══════════════════════════════════════════════════════════════════════════

describe("uma divergência reverte o lote inteiro", () => {
  const comMudanca = async (mudar: (l: Linha) => void) => {
    const linhas = LOTE.map((l) => ({ ...l }));
    mudar(linhas[1]);                       // mexe na do meio, de propósito
    const c = new ClienteFalso(linhas);
    const r = await correr(c, { apply: true });
    return { c, r };
  };

  it("G. due_date mudou → rollback total", async () => {
    const { c, r } = await comMudanca((l) => { l.due_date = "2026-10-03"; });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
    expect(c.comitou).toBe(false);
  });

  it("H. competência de partida mudou → rollback total", async () => {
    const { c, r } = await comMudanca((l) => { l.period_month = 3; });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });

  it("I. updated_at mudou → rollback total", async () => {
    const { c, r } = await comMudanca((l) => { l.updated_at = "2026-08-26T23:59:00.000Z"; });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });

  it("J. 🔴 o estado de uma paga mudou → rollback total", async () => {
    const { c, r } = await comMudanca((l) => { l.status = "pendente"; l.paid_at = null; });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });

  it("J2. o valor mudou → rollback total", async () => {
    const { c, r } = await comMudanca((l) => { l.amount = 99.99; });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });

  it("K. um UPDATE não afeta nenhuma linha → rollback total", async () => {
    const c = new ClienteFalso(LOTE);
    c.falharNoUpdateDe = "p-2";
    const r = await correr(c, { apply: true });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
    expect(c.comitou).toBe(false);
  });

  it("L. uma linha desapareceu → rollback total", async () => {
    const c = new ClienteFalso(LOTE.slice(0, 2));
    const r = await correr(c, { apply: true });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M–N — caixa e anexos são intocáveis
// ═══════════════════════════════════════════════════════════════════════════

describe("caixa e anexos", () => {
  it("M. 🔴 o executor nunca escreve em cash_flow_entries", async () => {
    const c = new ClienteFalso(LOTE, {
      caixa: [{ id: "cf-1", reference_id: "p-2", date: "2026-08-24", amount: 9.46 }],
    });
    await correr(c, { apply: true });

    const escritasNaCaixa = c.queries.filter(
      (q) => q.sql.includes("cash_flow_entries") &&
             MUTANTES.some((p) => q.sql.trim().toUpperCase().startsWith(p)));
    expect(escritasNaCaixa).toEqual([]);
  });

  it("M2. se o caixa mudar entre o antes e o depois → rollback total", async () => {
    const c = new ClienteFalso(LOTE, {
      caixa: [{ id: "cf-1", reference_id: "p-2", date: "2026-08-24", amount: 9.46 }],
    });
    c.mexerNaCaixaDepois = true;
    const r = await correr(c, { apply: true });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });

  it("N. a referência do anexo mudou → rollback total", async () => {
    const linhas = LOTE.map((l) => ({ ...l }));
    linhas[2].attachment_url = "outro/caminho.pdf";
    const c = new ClienteFalso(linhas);
    const r = await correr(c, { apply: true });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O–R — períodos, datas e manifestos
// ═══════════════════════════════════════════════════════════════════════════

describe("períodos, datas e manifestos", () => {
  it("O. 🔴 período fechado no destino → zero escritas", async () => {
    const c = new ClienteFalso(LOTE, {
      periodos: [{ year: 2026, month: 9, status: "fechado" }],
    });
    const r = await correr(c, { apply: true });
    expect(r.writes).toBe(0);
    expect(c.mutacoes).toEqual([]);
    expect(r.closedPeriodCollisions).toBeGreaterThan(0);
  });

  it("O2. período fechado na origem também bloqueia", () => {
    const col = periodosFechadosEnvolvidos(MANIFESTO, [{ year: 2026, month: 7, closed_at: "2026-08-01" }]);
    expect(col.length).toBeGreaterThan(0);
    expect(col.some((x) => x.lado === "origem")).toBe(true);
  });

  it("P. 🔴 sem vencimento nunca é candidata", () => {
    expect(competenceFromDueDate(null)).toBeNull();
    const v = validarManifesto([{ ...MANIFESTO[0], due_date: null }]);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/nunca candidata/);
  });

  it("Q. 🔴 2026-08-01 é agosto, não julho", () => {
    // `new Date("2026-08-01")` lido em Lisboa no verão dá 31 de julho.
    expect(competenceFromDueDate("2026-08-01")).toEqual({ year: 2026, month: 8 });
    expect(competenceFromDueDate("2026-01-01")).toEqual({ year: 2026, month: 1 });
    for (const má of ["72026-01-01", "2026-13-01", "2026-08", "", "ontem"]) {
      expect(competenceFromDueDate(má), má).toBeNull();
    }
  });

  it("R. 🔴 um manifesto já aplicado é recusado", () => {
    // Segunda corrida com o manifesto antigo: o `before` já não corresponde.
    const jaCorrigida = { ...MANIFESTO[0], before_period_year: 2026, before_period_month: 8 };
    const v = validarManifesto([jaCorrigida]);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/já está no mês certo/);
  });

  it("R2. e em execução, um before desatualizado reverte tudo", async () => {
    const linhas = LOTE.map((l) => ({ ...l }));
    linhas[0].period_month = 8;             // alguém já a corrigiu
    const c = new ClienteFalso(linhas);
    const r = await correr(c, { apply: true });
    expect(r.writes).toBe(0);
    expect(c.reverteu).toBe(true);
  });

  it("manifesto com ids repetidos é recusado", () => {
    expect(validarManifesto([MANIFESTO[0], MANIFESTO[0]]).ok).toBe(false);
  });

  it("manifesto vazio é recusado", () => {
    expect(validarManifesto([]).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Segredos
// ═══════════════════════════════════════════════════════════════════════════

describe("o silêncio não é resposta", () => {
  it("🔴 as datas são lidas como texto, não como Date", async () => {
    // O node-postgres converte colunas `date` em objetos `Date`. A primeira
    // versão disto comparava esse `Date` com a string do manifesto e com o
    // parser civil, que só aceita string: resultado, zero candidatos, em
    // silêncio, como se não houvesse nada a corrigir. Só se apanhou porque
    // havia uma contagem independente para comparar.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const core = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "repairs", "lib", "competence-backfill-core.mjs"), "utf8");
    expect(core).toMatch(/due_date::text/);
    expect(core).toMatch(/paid_at::text/);
    expect(core).toMatch(/updated_at::text/);
  });

  it("🔴 um Date em vez de string nunca passa por candidata válida", () => {
    // Se um dia a leitura voltar a trazer objetos, isto acusa em vez de
    // devolver uma lista vazia.
    expect(competenceFromDueDate(new Date("2026-08-03") as unknown as string)).toBeNull();
    const v = validarManifesto([{ ...MANIFESTO[0], due_date: new Date("2026-08-03") }]);
    expect(v.ok).toBe(false);
  });

  it("o snapshot aborta se houver data presente mas ilegível", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cli = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "repairs", "payment-competence-backfill.mjs"), "utf8");
    // Ausente e ilegível são tratadas separadamente — a segunda aborta.
    expect(cli).toMatch(/ilegiveis/);
    expect(cli).toMatch(/snapshot abortado/);
  });
});

describe("nenhum segredo chega ao ecrã", () => {
  it("a connection string é removida das mensagens de erro", () => {
    const m = sanitizar('falhou: postgresql://postgres.abc:senha@host:5432/postgres timeout');
    expect(m).not.toMatch(/senha/);
    expect(m).not.toMatch(/postgresql:\/\//);
    expect(m).toMatch(/<URL OMITIDA>/);
  });

  it("o executor não imprime o ambiente", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "repairs", "payment-competence-backfill.mjs"), "utf8");
    expect(src).not.toMatch(/console\.(log|error)\([^)]*\burl\b/);
    expect(src).not.toMatch(/console\.(log|error)\([^)]*process\.env\b/);
    expect(src).toMatch(/sanitizar\(/);
  });

  it("compararComManifesto acusa exatamente o campo que mudou", () => {
    const difs = compararComManifesto({ ...LOTE[0], amount: 1 }, MANIFESTO[0]);
    expect(difs).toContain("amount");
    expect(difs).not.toContain("status");
  });
});
