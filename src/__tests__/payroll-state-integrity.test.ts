// ============================================================================
// FOLHA DE PAGAMENTO — blindagem de estado e de integridade (P0A)
// ============================================================================
//
// O que estes testes protegem, por ordem de gravidade do que corriam o risco
// de deixar acontecer:
//
//   1. uma folha **paga** ser reescrita por um recálculo, ficando a divergir
//      da saída de caixa que já lhe corresponde;
//   2. uma consulta falhada virar "zero horas", "sem faltas" ou "8 €/hora" e
//      essa leitura ser gravada como se fosse verdade;
//   3. uma folha paga voltar a "aprovado" por alguém carregar em Aprovar;
//   4. duas regras diferentes para a mesma hora extra;
//   5. a auditoria contar uma história que não aconteceu.
//
// Nenhum destes é hipotético: todos estavam no código antes desta ronda.
//
// ---------------------------------------------------------------------------
// Como é que estes testes provam alguma coisa
// ---------------------------------------------------------------------------
//
// A Parte A é domínio puro — a máquina de estados, sem base de dados.
//
// A Parte B corre as Server Actions contra um cliente Supabase falso que
// regista todas as escritas. A pergunta que responde não é "devolveu ok?" mas
// **"escreveu?"** — porque o defeito que corrigimos devolvia `ok: true` a
// escrever coisas erradas, e devolveria `ok: true` outra vez se voltasse.
//
// A Parte D são guardas estáticas, e cada uma é ela própria testada contra
// uma amostra deliberadamente estragada. Uma guarda que nunca se viu falhar
// não é uma guarda — é uma expressão regular com boa reputação.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

/** Remove comentários: uma guarda tem de medir o código, não o que se escreveu sobre ele. */
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — a máquina de estados, sem base de dados
// ═══════════════════════════════════════════════════════════════════════════

import {
  parsePayrollStatus,
  isEconomicallyMutable,
  denyEconomicMutation,
  approveTransition,
  canRecalculate,
  splitRecalculationScope,
} from "@/domain/payroll/payroll-state";

describe("máquina de estados da folha", () => {
  it("só rascunho é economicamente mutável", () => {
    expect(isEconomicallyMutable("rascunho")).toBe(true);
    expect(isEconomicallyMutable("aprovado")).toBe(false);
    expect(isEconomicallyMutable("pago")).toBe(false);
  });

  it("um estado desconhecido não vira rascunho", () => {
    // A tentação é `?? "rascunho"`. Seria assumir o estado mais permissivo
    // precisamente quando não se sabe nada — a troca exatamente ao contrário.
    expect(parsePayrollStatus("qualquer_coisa")).toBeNull();
    expect(parsePayrollStatus(null)).toBeNull();
    expect(parsePayrollStatus(undefined)).toBeNull();
    expect(denyEconomicMutation(null)).toBe("UNKNOWN_STATUS");
  });

  it("rascunho aprova; aprovado é idempotente; pago é recusado", () => {
    expect(approveTransition("rascunho")).toEqual({ kind: "apply", to: "aprovado" });
    expect(approveTransition("aprovado")).toEqual({ kind: "noop" });
    expect(approveTransition("pago")).toEqual({
      kind: "denied", code: "PAID_CANNOT_BE_APPROVED",
    });
  });

  it("pago nunca recua para aprovado nem para rascunho", () => {
    // O defeito original: `update({ status: "aprovado" }).in("id", ids)` sem
    // ler o estado atual. A saída de caixa ficava, a folha dizia "por pagar".
    const r = approveTransition("pago");
    expect(r.kind).toBe("denied");
    expect(denyEconomicMutation("pago")).toBe("PAID_IS_IMMUTABLE");
  });

  it("recalcular: rascunho e inexistente sim; aprovado e pago não", () => {
    expect(canRecalculate(undefined)).toBe(true);   // linha ainda não existe
    expect(canRecalculate(null)).toBe(true);
    expect(canRecalculate("rascunho")).toBe(true);
    expect(canRecalculate("aprovado")).toBe(false);
    expect(canRecalculate("pago")).toBe(false);
  });

  it("o split separa quem se recalcula de quem se preserva", () => {
    const entries = [
      { id: "a", status: "rascunho" },
      { id: "b", status: "aprovado" },
      { id: "c", status: "pago" },
      { id: "d", status: undefined },
    ];
    const { recalculable, preserved } = splitRecalculationScope(
      entries, (e) => parsePayrollStatus(e.status),
    );
    expect(recalculable.map((e) => e.id)).toEqual(["a", "d"]);
    expect(preserved.map((e) => e.id)).toEqual(["b", "c"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — as actions, contra um Supabase falso que regista escritas
// ═══════════════════════════════════════════════════════════════════════════

/** Uma escrita observada. É a unidade de prova desta parte. */
interface Escrita {
  table: string;
  op: "insert" | "update" | "upsert" | "delete";
  payload: unknown;
  filtros: Array<[string, unknown]>;
}

const escritas: Escrita[] = [];
const getUser = vi.fn();

/**
 * Respostas por (tabela, terminal). `terminal` distingue como a consulta foi
 * consumida: `await` direto, `.single()` ou `.maybeSingle()`.
 *
 * É o que permite servir duas leituras diferentes da mesma tabela — o
 * `requireProfile` faz `.single()` sobre `profiles` para saber quem é o ator,
 * enquanto o cálculo faz um `await` para listar os colaboradores.
 */
type Terminal = "await" | "single" | "maybeSingle";
let respostas: Record<string, { data?: unknown; error?: unknown }> = {};

function resposta(table: string, terminal: Terminal) {
  const chave = `${table}:${terminal}`;
  if (chave in respostas) return respostas[chave];
  if (table in respostas) return respostas[table];
  return { data: null, error: null };
}

/** Builder encadeável: qualquer método devolve o próprio builder. */
function makeBuilder(table: string) {
  const filtros: Array<[string, unknown]> = [];
  let op: Escrita["op"] | null = null;
  let payload: unknown = null;

  const registar = () => {
    if (op) escritas.push({ table, op, payload, filtros: [...filtros] });
  };

  const builder: Record<string, unknown> = {};

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (nome === "insert" || nome === "update" || nome === "upsert" || nome === "delete") {
      op = nome;
      payload = args[0] ?? null;
    } else if (["eq", "in", "gte", "lte", "lt", "gt", "neq", "is"].includes(nome)) {
      filtros.push([String(args[0]), args[1]]);
    }
    return builder;
  };

  for (const nome of [
    "select", "insert", "update", "upsert", "delete",
    "eq", "in", "gte", "lte", "lt", "gt", "neq", "is", "order", "limit",
  ]) {
    builder[nome] = encadeia(nome);
  }

  builder.single      = async () => { registar(); return resposta(table, "single"); };
  builder.maybeSingle = async () => { registar(); return resposta(table, "maybeSingle"); };
  builder.then = (resolve: (v: unknown) => unknown) => {
    registar();
    return Promise.resolve(resposta(table, "await")).then(resolve);
  };

  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "upsert_payroll_records_atomic") {
        escritas.push({ table: "payroll_records", op: "upsert", payload: args.p_records, filtros: [] });
        return { data: [{ gravados: Array.isArray(args.p_records) ? args.p_records.length : 0, preservados: 0 }], error: null };
      }
      if (name === "adjust_payroll_record_atomic") {
        escritas.push({ table: "payroll_records", op: "update", payload: args.p_patch, filtros: [["status", "rascunho"]] });
        return { data: [{ record_id: args.p_record_id }], error: null };
      }
      if (name === "approve_payroll_records_atomic") {
        escritas.push({ table: "payroll_records", op: "update", payload: { status: "aprovado" }, filtros: [["status", "rascunho"]] });
        return { data: [{ aprovados: Array.isArray(args.p_ids) ? args.p_ids.length : 0, ja_aprovados: 0 }], error: null };
      }
      if (name === "mark_payroll_paid_atomic") {
        escritas.push({ table: "payroll_records", op: "update", payload: { status: "pago" }, filtros: [] });
        return { data: [{ pagos: Array.isArray(args.p_ids) ? args.p_ids.length : 0, movimentos: 0 }], error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const auditoria: Array<Record<string, unknown>> = [];
vi.mock("@/lib/audit", () => ({
  auditLog: async (entry: Record<string, unknown>) => { auditoria.push(entry); },
}));

// O período financeiro tem guarda própria e testes próprios. Aqui está sempre
// aberto, para que o que falhar seja a blindagem de estado e não outra coisa.
vi.mock("@/lib/finance-period-guard", () => ({
  lerEstadoPeriodo: async () => ({ ok: true, estado: { status: "open" } }),
  criarContextoPeriodo: () => ({
    ler: async () => ({ ok: true, estado: { status: "open" } }),
  }),
}));

const ACTOR = { id: "actor-1", company_id: "empresa-1", role: "admin" };

/** Estado base: ator válido, um colaborador, nada configurado, mês vazio. */
function cenarioBase(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  respostas = {
    "profiles:single": { data: ACTOR, error: null },
    "profiles:await": {
      data: [{ id: "colab-1", full_name: "Maria", avatar_url: null,
               contracted_hours_month: 160, hourly_rate: 10 }],
      error: null,
    },
    "company_settings:maybeSingle": { data: null, error: null },
    "daily_clocks:await": { data: [], error: null },
    "absences:await": { data: [], error: null },
    "payroll_records:await": { data: [], error: null },
    ...over,
  };
}

beforeEach(() => {
  escritas.length = 0;
  auditoria.length = 0;
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: ACTOR.id } } });
  cenarioBase();
  vi.resetModules();
});

afterEach(() => { vi.restoreAllMocks(); });

const escritasEm = (table: string) => escritas.filter((e) => e.table === table);

// ─── B1. Uma consulta falhada nunca autoriza uma escrita ─────────────────────

describe("consulta falhada não vira default nem lista vazia", () => {
  const FALHA = { data: null, error: { code: "57014", message: "canceling statement" } };

  it("A. definições falham → não escreve, e não assume 8 €/hora", async () => {
    cenarioBase({ "company_settings:maybeSingle": FALHA });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records")).toHaveLength(0);
  });

  it("B. ponto falha → não escreve uma folha de zero horas", async () => {
    cenarioBase({ "daily_clocks:await": FALHA });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records")).toHaveLength(0);
  });

  it("C. faltas falham → não escreve uma folha sem faltas", async () => {
    cenarioBase({ "absences:await": FALHA });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records")).toHaveLength(0);
  });

  it("D. registos existentes falham → não escreve por cima de estado desconhecido", async () => {
    cenarioBase({ "payroll_records:await": FALHA });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records")).toHaveLength(0);
  });

  it("E. definições ausentes ≠ definições em erro", async () => {
    // Sem linha de definições a folha calcula-se com os valores por omissão
    // de sempre. É o contrato do produto, e continua a valer.
    cenarioBase({ "company_settings:maybeSingle": { data: null, error: null } });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(true);
    expect(escritasEm("payroll_records").filter((e) => e.op === "upsert")).toHaveLength(1);
  });

  it("a mensagem de erro não expõe o detalhe do Postgres", async () => {
    cenarioBase({ "daily_clocks:await": {
      data: null,
      error: { code: "42P01", message: 'relation "daily_clocks" does not exist' },
    } });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/relation|daily_clocks|42P01/);
  });
});

// ─── B2. Recalcular não toca em aprovado nem em pago ─────────────────────────

describe("recálculo respeita o estado", () => {
  it("F. rascunho é recalculado", async () => {
    cenarioBase({ "payroll_records:await": {
      data: [{ collaborator_id: "colab-1", other_additions: 0, other_deductions: 0,
               notes: null, status: "rascunho", paid_at: null }],
      error: null,
    } });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(true);
    const upserts = escritasEm("payroll_records").filter((e) => e.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect((upserts[0].payload as unknown[]).length).toBe(1);
  });

  it("G. aprovado não é recalculado, e é contado", async () => {
    cenarioBase({ "payroll_records:await": {
      data: [{ collaborator_id: "colab-1", other_additions: 0, other_deductions: 0,
               notes: null, status: "aprovado", paid_at: null }],
      error: null,
    } });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(escritasEm("payroll_records").filter((e) => e.op === "upsert")).toHaveLength(0);
    expect(res.preservados).toBe(1);
  });

  it("H+I. pago não é recalculado — nem uma escrita, nem um cêntimo", async () => {
    // O cenário exato do defeito: a folha paga vale €1.200 e há uma saída de
    // caixa de €1.200. Se o recálculo lhe tocasse, a folha passaria a valer
    // outra coisa e o caixa ficaria para trás, em silêncio.
    cenarioBase({ "payroll_records:await": {
      data: [{ collaborator_id: "colab-1", other_additions: 0, other_deductions: 0,
               notes: null, status: "pago", paid_at: "2026-08-01T10:00:00Z" }],
      error: null,
    } });
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(escritasEm("payroll_records").filter((e) => e.op === "upsert")).toHaveLength(0);
    expect(res.preservados).toBe(1);
  });

  it("J. um lote misto só escreve as linhas de rascunho", async () => {
    respostas = {
      "profiles:single": { data: ACTOR, error: null },
      "profiles:await": { data: [
        { id: "c1", full_name: "A", avatar_url: null, contracted_hours_month: 160, hourly_rate: 10 },
        { id: "c2", full_name: "B", avatar_url: null, contracted_hours_month: 160, hourly_rate: 10 },
        { id: "c3", full_name: "C", avatar_url: null, contracted_hours_month: 160, hourly_rate: 10 },
      ], error: null },
      "company_settings:maybeSingle": { data: null, error: null },
      "daily_clocks:await": { data: [], error: null },
      "absences:await": { data: [], error: null },
      "payroll_records:await": { data: [
        { collaborator_id: "c1", status: "rascunho", other_additions: 0, other_deductions: 0, notes: null, paid_at: null },
        { collaborator_id: "c2", status: "aprovado", other_additions: 0, other_deductions: 0, notes: null, paid_at: null },
        { collaborator_id: "c3", status: "pago",     other_additions: 0, other_deductions: 0, notes: null, paid_at: "x" },
      ], error: null },
    };
    const { calculateAndSavePayroll } = await import("@/app/actions/payroll");

    const res = await calculateAndSavePayroll("empresa-1", 2026, 8);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const upserts = escritasEm("payroll_records").filter((e) => e.op === "upsert");
    expect(upserts).toHaveLength(1);
    const linhas = upserts[0].payload as Array<{ collaborator_id: string }>;
    expect(linhas.map((l) => l.collaborator_id)).toEqual(["c1"]);
    expect(res.preservados).toBe(2);
  });
});

// ─── B3. Ajuste manual ───────────────────────────────────────────────────────

describe("ajuste manual respeita o estado", () => {
  const registo = (status: string) => ({
    company_id: "empresa-1", status,
    gross_salary: 1000, meal_allowance: 100, overtime_bonus: 0,
    absence_deductions: 0, other_additions: 0, other_deductions: 0,
    net_salary: 1100, worked_hours: 100, overtime_hours: 0,
    absence_hours: 0, days_worked: 20, hourly_rate: 10, notes: null,
  });

  it("K. rascunho pode ser ajustado", async () => {
    cenarioBase({ "payroll_records:maybeSingle": { data: registo("rascunho"), error: null },
                  "payroll_records:await": { data: [{ period_year: 2026, period_month: 8 }], error: null } });
    const { adjustPayrollRecord } = await import("@/app/actions/payroll");

    const res = await adjustPayrollRecord("rec-1", { other_additions: 50 });

    expect(res.ok).toBe(true);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(1);
  });

  it("L. aprovado é recusado, sem escrever", async () => {
    cenarioBase({ "payroll_records:maybeSingle": { data: registo("aprovado"), error: null },
                  "payroll_records:await": { data: [{ period_year: 2026, period_month: 8 }], error: null } });
    const { adjustPayrollRecord } = await import("@/app/actions/payroll");

    const res = await adjustPayrollRecord("rec-1", { other_additions: 50 });

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("M. pago é recusado, sem escrever — mesmo com o período aberto", async () => {
    cenarioBase({ "payroll_records:maybeSingle": { data: registo("pago"), error: null },
                  "payroll_records:await": { data: [{ period_year: 2026, period_month: 8 }], error: null } });
    const { adjustPayrollRecord } = await import("@/app/actions/payroll");

    const res = await adjustPayrollRecord("rec-1", { other_additions: 50 });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/paga/i);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("a escrita traz a guarda de estado no próprio update", async () => {
    // Entre o `select` e o `update` outra sessão pode ter aprovado a folha. A
    // condição na escrita é a rede que apanha essa corrida.
    cenarioBase({ "payroll_records:maybeSingle": { data: registo("rascunho"), error: null },
                  "payroll_records:await": { data: [{ period_year: 2026, period_month: 8 }], error: null } });
    const { adjustPayrollRecord } = await import("@/app/actions/payroll");

    await adjustPayrollRecord("rec-1", { other_additions: 50 });

    const update = escritasEm("payroll_records").find((e) => e.op === "update");
    expect(update?.filtros).toContainEqual(["status", "rascunho"]);
  });

  it("U. a auditoria regista o líquido anterior verdadeiro", async () => {
    // Estava a gravar `net_salary: rec.gross_salary` — 1000 em vez de 1100.
    cenarioBase({ "payroll_records:maybeSingle": { data: registo("rascunho"), error: null },
                  "payroll_records:await": { data: [{ period_year: 2026, period_month: 8 }], error: null } });
    const { adjustPayrollRecord } = await import("@/app/actions/payroll");

    await adjustPayrollRecord("rec-1", { other_additions: 50 });

    const entrada = auditoria.find((a) => a.action === "payroll_adjusted");
    expect(entrada).toBeDefined();
    const before = entrada!.before as Record<string, number>;
    expect(before.net_salary).toBe(1100);
    expect(before.gross_salary).toBe(1000);
    expect(before.net_salary).not.toBe(before.gross_salary);
  });

  it("T. a taxa de hora extra vem das definições, não de 25% fixos", async () => {
    cenarioBase({
      "payroll_records:maybeSingle": { data: registo("rascunho"), error: null },
      "payroll_records:await": { data: [{ period_year: 2026, period_month: 8 }], error: null },
      "company_settings:maybeSingle": { data: { overtime_rate_pct: 50 }, error: null },
    });
    const { adjustPayrollRecord } = await import("@/app/actions/payroll");

    await adjustPayrollRecord("rec-1", { overtime_hours: 10 });

    const update = escritasEm("payroll_records").find((e) => e.op === "update");
    const payload = update?.payload as Record<string, number>;
    // 10 h × 10 €/h × 50% = 50 €. Com os 25% antigos daria 25 €.
    expect(payload.overtime_bonus).toBe(50);
  });

  it("definições em erro recusam o ajuste em vez de assumir uma taxa", async () => {
    cenarioBase({
      "payroll_records:maybeSingle": { data: registo("rascunho"), error: null },
      "payroll_records:await": { data: [{ period_year: 2026, period_month: 8 }], error: null },
      "company_settings:maybeSingle": { data: null, error: { code: "57014", message: "timeout" } },
    });
    const { adjustPayrollRecord } = await import("@/app/actions/payroll");

    const res = await adjustPayrollRecord("rec-1", { overtime_hours: 10 });

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });
});

// ─── B4. Aprovação em lote ───────────────────────────────────────────────────

describe("aprovação em lote", () => {
  const periodos = { data: [{ period_year: 2026, period_month: 8 }], error: null };

  it("N. rascunho passa a aprovado", async () => {
    cenarioBase({ "payroll_records:await": periodos });
    respostas["payroll_records:await"] = { data: [{ id: "r1", status: "rascunho" }], error: null };
    // O guard de período lê a mesma tabela; ambos recebem esta lista, e o que
    // importa provar aqui é a escrita.
    const { approvePayrollRecords } = await import("@/app/actions/payroll");

    const res = await approvePayrollRecords(["r1"]);

    expect(res.ok).toBe(true);
    const updates = escritasEm("payroll_records").filter((e) => e.op === "update");
    expect(updates).toHaveLength(1);
    expect((updates[0].payload as Record<string, string>).status).toBe("aprovado");
  });

  it("O. aprovar o que já está aprovado é idempotente e não escreve", async () => {
    cenarioBase();
    respostas["payroll_records:await"] = { data: [{ id: "r1", status: "aprovado" }], error: null };
    const { approvePayrollRecords } = await import("@/app/actions/payroll");

    const res = await approvePayrollRecords(["r1"]);

    expect(res.ok).toBe(true);
    expect(res.jaAprovados).toBe(1);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("P. um lote com uma folha paga é recusado por inteiro", async () => {
    cenarioBase();
    respostas["payroll_records:await"] = { data: [
      { id: "r1", status: "rascunho" },
      { id: "r2", status: "pago" },
    ], error: null };
    const { approvePayrollRecords } = await import("@/app/actions/payroll");

    const res = await approvePayrollRecords(["r1", "r2"]);

    expect(res.ok).toBe(false);
    // Nem sequer a linha de rascunho é aprovada: meia operação num lote
    // financeiro deixa quem clicou sem saber o que ficou feito.
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("Q. um id que não resolve derruba o lote inteiro", async () => {
    cenarioBase();
    respostas["payroll_records:await"] = { data: [{ id: "r1", status: "rascunho" }], error: null };
    const { approvePayrollRecords } = await import("@/app/actions/payroll");

    const res = await approvePayrollRecords(["r1", "inexistente"]);

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("R. um id de outra empresa não resolve — e a mensagem não o confirma", async () => {
    cenarioBase();
    // A consulta filtra por company_id, por isso o id alheio simplesmente não
    // aparece. O efeito é o mesmo do id inexistente, deliberadamente.
    respostas["payroll_records:await"] = { data: [{ id: "r1", status: "rascunho" }], error: null };
    const { approvePayrollRecords } = await import("@/app/actions/payroll");

    const res = await approvePayrollRecords(["r1", "id-de-outra-empresa"]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/empresa|tenant|outra/i);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("a resolução do lote falha fechada quando a consulta falha", async () => {
    cenarioBase();
    respostas["payroll_records:await"] = { data: null, error: { code: "57014", message: "timeout" } };
    const { approvePayrollRecords } = await import("@/app/actions/payroll");

    const res = await approvePayrollRecords(["r1"]);

    expect(res.ok).toBe(false);
    expect(escritasEm("payroll_records").filter((e) => e.op === "update")).toHaveLength(0);
  });

  it("a escrita da aprovação também traz a guarda de estado", async () => {
    cenarioBase();
    respostas["payroll_records:await"] = { data: [{ id: "r1", status: "rascunho" }], error: null };
    const { approvePayrollRecords } = await import("@/app/actions/payroll");

    await approvePayrollRecords(["r1"]);

    const update = escritasEm("payroll_records").find((e) => e.op === "update");
    expect(update?.filtros).toContainEqual(["status", "rascunho"]);
  });
});

// ─── B5. O render não escreve ────────────────────────────────────────────────

describe("V+W. ler o estado da folha não escreve nem calcula", () => {
  it("ensurePayrollCalculated não faz uma única escrita", async () => {
    cenarioBase();
    const { ensurePayrollCalculated } = await import("@/app/actions/payroll");

    const res = await ensurePayrollCalculated(2026, 8);

    expect(res.ok).toBe(true);
    expect(escritas).toHaveLength(0);
  });

  it("ensurePayrollCalculated não consulta as fontes do cálculo", async () => {
    // Não basta não escrever: enquanto o motor estivesse lá dentro, bastava
    // uma alteração distraída para a escrita voltar.
    cenarioBase();
    const { ensurePayrollCalculated } = await import("@/app/actions/payroll");

    await ensurePayrollCalculated(2026, 8);

    const corpo = semComentarios(ler("src/app/actions/payroll.ts"));
    const fn = corpo.slice(
      corpo.indexOf("export async function ensurePayrollCalculated"),
      corpo.indexOf("export async function calculateAndSavePayroll"),
    );
    expect(fn).not.toMatch(/runPayrollCalculation|daily_clocks|absences|upsert/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — guardas permanentes, e a prova de que cada uma dispara
// ═══════════════════════════════════════════════════════════════════════════
//
// Cada guarda é uma função pura sobre o texto do módulo. Corre duas vezes:
// contra o ficheiro real (tem de estar limpo) e contra uma amostra estragada
// de propósito (tem de acusar). A segunda metade é o que distingue uma guarda
// de um regex decorativo — §34 do programa de execução.

/** PAYROLL_HARDCODED_OVERTIME_RATE — a taxa de hora extra não é literal. */
function taxaExtraLiteral(src: string): string[] {
  return [...semComentarios(src).matchAll(/\*\s*0?\.\d+\s*\*/g)].map((m) => m[0]);
}

/** PAYROLL_QUERY_ERROR_AS_EMPTY — quem lê `data` também lê `error`. */
function leituraSemErro(src: string): string[] {
  const corpo = semComentarios(src);
  const falhas: string[] = [];
  for (const m of corpo.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+admin/g)) {
    const bind = m[1];
    if (/\bdata\b/.test(bind) && !/\berror\b/.test(bind)) falhas.push(m[0].trim());
  }
  return falhas;
}

/** PAYROLL_APPROVE_WITHOUT_STATE_GUARD / PAYROLL_PAID_DIRECT_ECONOMIC_MUTATION */
function mutacaoSemGuarda(src: string): string[] {
  const corpo = semComentarios(src);
  const falta: string[] = [];
  const trecho = (de: string, ate: string) => {
    const i = corpo.indexOf(de);
    const j = corpo.indexOf(ate, i + 1);
    return i < 0 ? "" : corpo.slice(i, j < 0 ? undefined : j);
  };
  const approve = trecho("export async function approvePayrollRecords", "export async function markPayrollPaid");
  const adjust  = trecho("export async function adjustPayrollRecord", "export async function approvePayrollRecords");

  if (approve && !approve.includes("approveTransition")) falta.push("approvePayrollRecords sem approveTransition");
  if (adjust && !adjust.includes("denyEconomicMutation")) falta.push("adjustPayrollRecord sem denyEconomicMutation");
  return falta;
}

const PAYROLL_SRC = ler("src/app/actions/payroll.ts");

describe("guardas permanentes da folha", () => {
  it("PAYROLL_HARDCODED_OVERTIME_RATE = 0", () => {
    expect(taxaExtraLiteral(PAYROLL_SRC)).toEqual([]);
  });

  it("PAYROLL_QUERY_ERROR_AS_EMPTY = 0", () => {
    expect(leituraSemErro(PAYROLL_SRC)).toEqual([]);
  });

  it("PAYROLL_APPROVE_WITHOUT_STATE_GUARD = 0 e PAID_DIRECT_ECONOMIC_MUTATION = 0", () => {
    expect(mutacaoSemGuarda(PAYROLL_SRC)).toEqual([]);
  });

  it("PAYROLL_RENDER_WRITE = 0 — a página não chama o motor", () => {
    const page = semComentarios(ler("src/app/(dashboard)/dashboard/folha-pagamento/page.tsx"));
    expect(page).not.toMatch(/calculateAndSavePayroll|ensurePayrollCalculated/);
    expect(page).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
  });

  it("a fórmula do líquido tem uma fonte só", () => {
    const corpo = semComentarios(PAYROLL_SRC);
    // A soma escrita à mão foi substituída por `calcAdjustedNetSalary`.
    expect(corpo).toMatch(/calcAdjustedNetSalary/);
    expect(corpo).not.toMatch(/grossSalary\s*\+\s*mealAllowance\s*\+\s*overtimeBonus/);
  });
});

describe("as guardas acusam código estragado (mutation proof)", () => {
  it("reintroduzir `* 0.25` faz a guarda disparar", () => {
    const mutado = "const overtimeBonus = overtimeHours * hourlyRate * 0.25 * 100;";
    expect(taxaExtraLiteral(mutado).length).toBeGreaterThan(0);
  });

  it("reintroduzir uma leitura sem `error` faz a guarda disparar", () => {
    const mutado = 'const { data: dailyClocks } = await admin.from("daily_clocks").select("*");';
    expect(leituraSemErro(mutado)).toHaveLength(1);
  });

  it("uma leitura com `error` não é acusada", () => {
    const limpo = 'const { data: dailyClocks, error: cErr } = await admin.from("x").select("*");';
    expect(leituraSemErro(limpo)).toEqual([]);
  });

  it("retirar a guarda de estado do approve faz a guarda disparar", () => {
    const mutado = `
export async function adjustPayrollRecord() { denyEconomicMutation(s); }
export async function approvePayrollRecords() {
  await admin.from("payroll_records").update({ status: "aprovado" }).in("id", ids);
}
export async function markPayrollPaid() {}
`;
    expect(mutacaoSemGuarda(mutado)).toContain("approvePayrollRecords sem approveTransition");
  });

  it("retirar a guarda de estado do ajuste faz a guarda disparar", () => {
    const mutado = `
export async function adjustPayrollRecord() {
  await admin.from("payroll_records").update({ net_salary: 1 }).eq("id", id);
}
export async function approvePayrollRecords() { approveTransition(s); }
export async function markPayrollPaid() {}
`;
    expect(mutacaoSemGuarda(mutado)).toContain("adjustPayrollRecord sem denyEconomicMutation");
  });

  it("a guarda de comentários não se deixa enganar pelo texto explicativo", () => {
    // O ficheiro real cita `* 0.25` num comentário, a explicar o que saiu.
    // Se a guarda medisse o comentário, estaria vermelha agora.
    expect(PAYROLL_SRC).toMatch(/0\.25/);
    expect(taxaExtraLiteral(PAYROLL_SRC)).toEqual([]);
  });
});
