// ============================================================================
// DISPONIBILIDADE — falhar fechado (P0D)
// ============================================================================
//
// O defeito, em concreto: a consulta de faltas falha, o conjunto de ausentes
// vem vazio, e **quem está de férias aparece como substituta disponível** para
// cobrir quem faltou. O ecrã dizia "3 colaboradores disponíveis" com a mesma
// confiança de sempre.
//
// O que estes testes provam não é que a lista está certa. É que quando o
// sistema não consegue confirmar, **não produz uma lista**. A pergunta em cada
// caso é: alguém saiu daqui rotulado como disponível sem que isso tenha sido
// provado?
//
// A Parte C são guardas permanentes, e cada uma corre também contra uma
// amostra estragada de propósito. Uma guarda que nunca se viu falhar não é
// uma guarda.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — o domínio: quatro estados, e "não sei" não é "disponível"
// ═══════════════════════════════════════════════════════════════════════════

import {
  resolveAvailability,
  isSuggestable,
  isCriticalSource,
  AVAILABILITY_LABEL,
} from "@/domain/workforce/availability";

describe("resolução de disponibilidade", () => {
  it("tudo conhecido e livre → available", () => {
    expect(resolveAvailability({ isActive: true, isAbsent: false, conflictCount: 0 }))
      .toBe("available");
  });

  it("livre mas com serviços marcados → conflict", () => {
    expect(resolveAvailability({ isActive: true, isAbsent: false, conflictCount: 2 }))
      .toBe("conflict");
  });

  it("ausente → unavailable, mesmo sem conflitos", () => {
    expect(resolveAvailability({ isActive: true, isAbsent: true, conflictCount: 0 }))
      .toBe("unavailable");
  });

  it("inativa → unavailable", () => {
    expect(resolveAvailability({ isActive: false, isAbsent: false, conflictCount: 0 }))
      .toBe("unavailable");
  });

  it("🔴 faltas por confirmar → unknown, nunca available", () => {
    // Este é o caso exato do defeito: tudo o resto favorável, e a única coisa
    // que não se sabe é precisamente a que interessa.
    const estado = resolveAvailability({ isActive: true, isAbsent: null, conflictCount: 0 });
    expect(estado).toBe("unknown");
    expect(estado).not.toBe("available");
  });

  it("🔴 conflitos por confirmar → unknown, nunca available", () => {
    expect(resolveAvailability({ isActive: true, isAbsent: false, conflictCount: null }))
      .toBe("unknown");
  });

  it("estado por confirmar → unknown", () => {
    expect(resolveAvailability({ isActive: null, isAbsent: false, conflictCount: 0 }))
      .toBe("unknown");
  });

  it("unknown é avaliado antes de tudo o resto", () => {
    // Mesmo com factos desfavoráveis conhecidos, não se conclui a partir de
    // um conjunto incompleto.
    expect(resolveAvailability({ isActive: true, isAbsent: true, conflictCount: null }))
      .toBe("unknown");
  });

  it("só available e conflict entram numa lista de sugestões", () => {
    expect(isSuggestable("available")).toBe(true);
    expect(isSuggestable("conflict")).toBe(true);
    expect(isSuggestable("unavailable")).toBe(false);
    // Aparecer numa lista de sugestões é, em si, uma afirmação de
    // disponibilidade. Uma candidata por confirmar não a pode fazer.
    expect(isSuggestable("unknown")).toBe(false);
  });

  it("o texto de unknown não diz «disponível»", () => {
    expect(AVAILABILITY_LABEL.unknown).not.toMatch(/^Disponível/);
    expect(AVAILABILITY_LABEL.unknown).toMatch(/não foi possível confirmar/i);
  });

  it("uma fonte é crítica quando a sua falha faz alguém parecer mais livre", () => {
    expect(isCriticalSource("absences")).toBe(true);
    expect(isCriticalSource("services")).toBe(true);
    expect(isCriticalSource("team_members")).toBe(true);
    expect(isCriticalSource("profiles")).toBe(true);
    // Perder competências piora a ordenação; não faz ninguém parecer livre.
    expect(isCriticalSource("skills")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — o motor, contra um Supabase falso
// ═══════════════════════════════════════════════════════════════════════════

interface Escrita { table: string; op: string }
const escritas: Escrita[] = [];
const getUser = vi.fn();

type Terminal = "await" | "single" | "maybeSingle";
let respostas: Record<string, { data?: unknown; error?: unknown }> = {};

function resposta(table: string, terminal: Terminal) {
  const chave = `${table}:${terminal}`;
  if (chave in respostas) return respostas[chave];
  if (table in respostas) return respostas[table];
  return { data: null, error: null };
}

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  let op: string | null = null;

  const encadeia = (nome: string) => (...args: unknown[]) => {
    void args;
    if (["insert", "update", "upsert", "delete", "rpc"].includes(nome)) op = nome;
    return builder;
  };
  for (const nome of [
    "select", "insert", "update", "upsert", "delete", "rpc",
    "eq", "in", "gte", "lte", "lt", "gt", "neq", "is", "order", "limit",
  ]) builder[nome] = encadeia(nome);

  const registar = () => { if (op) escritas.push({ table, op }); };

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
  createAdminClient: () => ({ from: (table: string) => makeBuilder(table) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ACTOR = { id: "actor-1", company_id: "empresa-1", role: "admin" };
const FALHA = { data: null, error: { code: "57014", message: "canceling statement" } };

const CANDIDATOS = [
  { id: "c1", full_name: "Maria", skills: ["limpeza"], status: "ativo" },
  { id: "c2", full_name: "Joana", skills: ["limpeza"], status: "ativo" },
];

function cenario(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  respostas = {
    "profiles:single":      { data: ACTOR, error: null },
    "profiles:maybeSingle": { data: { skills: ["limpeza"] }, error: null },
    "profiles:await":       { data: CANDIDATOS, error: null },
    "team_members:await":   { data: [{ collaborator_id: "c1", team_id: "t1" }], error: null },
    "absences:await":       { data: [], error: null },
    "services:await":       { data: [], error: null },
    ...over,
  };
}

beforeEach(() => {
  escritas.length = 0;
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: ACTOR.id } } });
  cenario();
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const pedir = async () => {
  const { getSubstituteSuggestions } = await import("@/app/actions/absences");
  return getSubstituteSuggestions("ausente-1", "2026-09-01", "2026-09-03");
};

describe("motor de substituição — fontes críticas falham fechado", () => {
  it("1. sem ausências, os candidatos aparecem normalmente", async () => {
    const res = await pedir();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(res.data.every((s) => s.availability === "available")).toBe(true);
  });

  it("2. um candidato ausente é excluído", async () => {
    cenario({ "absences:await": { data: [{ collaborator_id: "c1" }], error: null } });
    const res = await pedir();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((s) => s.id)).toEqual(["c2"]);
  });

  it("3. 🔴 faltas em erro → ninguém sai rotulado como disponível", async () => {
    // O defeito original vivia exatamente aqui.
    cenario({ "absences:await": FALHA });
    const res = await pedir();

    expect(res.ok).toBe(false);
    if (res.ok) {
      // Se algum dia voltar a devolver ok, pelo menos que não minta.
      expect((res as { data: unknown[] }).data).toHaveLength(0);
    }
  });

  it("4. 🔴 serviços em erro → ninguém sai rotulado como «sem conflitos»", async () => {
    cenario({ "services:await": FALHA });
    const res = await pedir();
    expect(res.ok).toBe(false);
  });

  it("5. candidatos em erro → falha fechada", async () => {
    cenario({ "profiles:await": FALHA });
    const res = await pedir();
    expect(res.ok).toBe(false);
  });

  it("6. equipas em erro → falha fechada (são o caminho até aos serviços)", async () => {
    cenario({ "team_members:await": FALHA });
    const res = await pedir();
    expect(res.ok).toBe(false);
  });

  it("a mensagem de falha não se confunde com «não há ninguém»", async () => {
    cenario({ "absences:await": FALHA });
    const res = await pedir();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/não foi possível confirmar/i);
    expect(res.error).not.toMatch(/nenhum|ninguém|vazio/i);
  });

  it("a mensagem não expõe o detalhe do Postgres", async () => {
    cenario({ "absences:await": {
      data: null, error: { code: "42P01", message: 'relation "absences" does not exist' },
    } });
    const res = await pedir();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/relation|absences|42P01/);
  });

  it("7. sem sessão não devolve candidato nenhum", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await pedir();
    expect(res.ok).toBe(false);
  });

  it("7b. um papel sem permissão não recebe a lista de colaboradores", async () => {
    cenario({ "profiles:single": { data: { ...ACTOR, role: "colaborador" }, error: null } });
    const res = await pedir();
    expect(res.ok).toBe(false);
  });

  it("8. erro não vira lista vazia — são conclusões diferentes", async () => {
    cenario({ "absences:await": { data: [], error: null } });
    const semFaltas = await pedir();

    cenario({ "absences:await": FALHA });
    const comErro = await pedir();

    expect(semFaltas.ok).toBe(true);
    expect(comErro.ok).toBe(false);
  });

  it("9. erro de serviços não vira conflictCount = 0", async () => {
    cenario({ "services:await": { data: [{ team_id: "t1" }], error: null } });
    const comServico = await pedir();
    expect(comServico.ok).toBe(true);
    if (!comServico.ok) return;
    const c1 = comServico.data.find((s) => s.id === "c1");
    expect(c1?.conflicting_services).toBe(1);
    expect(c1?.availability).toBe("conflict");

    cenario({ "services:await": FALHA });
    expect((await pedir()).ok).toBe(false);
  });

  it("11. depois de um erro, uma leitura boa recupera", async () => {
    cenario({ "absences:await": FALHA });
    expect((await pedir()).ok).toBe(false);

    cenario();
    const res = await pedir();
    expect(res.ok).toBe(true);
  });

  it("12. a ordenação é determinística com fontes válidas", async () => {
    const a = await pedir();
    const b = await pedir();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.map((s) => s.id)).toEqual(b.data.map((s) => s.id));
  });

  it("13. uma ausência efetiva no período bloqueia a sugestão", async () => {
    cenario({ "absences:await": { data: [
      { collaborator_id: "c1" }, { collaborator_id: "c2" },
    ], error: null } });
    const res = await pedir();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(0);
  });

  it("15. pedir sugestões não escreve nada", async () => {
    await pedir();
    expect(escritas).toHaveLength(0);
  });

  it("competências em erro degradam a ordem, não a lista", async () => {
    cenario({ "profiles:maybeSingle": FALHA });
    const res = await pedir();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Ninguém desapareceu: perder competências não muda quem pode ir.
    expect(res.data).toHaveLength(2);
    expect(res.rankingDegraded).toBe(true);
  });

  it("sem candidatos, a resposta é uma lista vazia honesta", async () => {
    cenario({ "profiles:await": { data: [], error: null } });
    const res = await pedir();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
    expect(res.rankingDegraded).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — guardas permanentes, e a prova de que disparam
// ═══════════════════════════════════════════════════════════════════════════

const MOTOR = (() => {
  const src = semComentarios(ler("src/app/actions/absences.ts"));
  const i = src.indexOf("export async function getSubstituteSuggestions");
  const j = src.indexOf("export async function updateAbsenceSubstitute", i + 1);
  return i < 0 ? "" : src.slice(i, j < 0 ? undefined : j);
})();

/**
 * AVAILABILITY_ABSENCE_ERROR_AS_EMPTY / SERVICE_ERROR_AS_ZERO_CONFLICT
 *
 * A guarda não procura nomes de variáveis. Esses mudam a cada refactor, e uma
 * guarda presa a `absencesRes.error` cai sozinha na primeira renomeação — o
 * pior modo de falhar, porque fica verde sem estar a verificar nada.
 *
 * Ancora-se no que tem de existir para a falha ser tratada: um ponto de
 * tratamento identificado pela fonte (`getSubstituteSuggestions:<fonte>`) que
 * leve a uma saída fechada.
 *
 *   `return queryFailure("...:fonte", e)`  → já é a saída fechada;
 *   `logQueryFailure("...:fonte", e)`      → só conta se um `return ok:false`
 *                                            o seguir de perto.
 *
 * A segunda distinção é o ponto todo: registar e continuar foi exatamente o
 * defeito dos serviços.
 */
function fonteCriticaSemAborto(motor: string): string[] {
  const falhas: string[] = [];

  for (const fonte of ["absences", "team_members", "services", "profiles"]) {
    const i = motor.indexOf(`getSubstituteSuggestions:${fonte}`);
    if (i < 0) { falhas.push(`${fonte}: erro nunca tratado`); continue; }

    const abortaJa = /return\s+queryFailure\s*\(\s*["'`]$/.test(motor.slice(Math.max(0, i - 40), i));
    const abortaLogo = /return\s*\{\s*ok:\s*false/.test(motor.slice(i, i + 260));

    if (!abortaJa && !abortaLogo) falhas.push(`${fonte}: falha registada mas não aborta`);
  }

  return falhas;
}

/** AVAILABILITY_QUERY_ERROR_AS_AVAILABLE — a elegibilidade passa pelo domínio. */
function elegibilidadeSemDominio(motor: string): string[] {
  const falhas: string[] = [];
  if (!motor.includes("resolveAvailability")) falhas.push("não usa resolveAvailability");
  if (!motor.includes("isSuggestable")) falhas.push("não usa isSuggestable");
  return falhas;
}

describe("guardas permanentes da disponibilidade", () => {
  it("AVAILABILITY_ABSENCE_ERROR_AS_EMPTY = 0", () => {
    expect(fonteCriticaSemAborto(MOTOR)).toEqual([]);
  });

  it("AVAILABILITY_SERVICE_ERROR_AS_ZERO_CONFLICT = 0", () => {
    // A falha dos serviços tem de sair pela porta do erro, não pelo log.
    expect(MOTOR).toMatch(/servicesError[\s\S]{0,200}return\s*\{\s*ok:\s*false/);
  });

  it("AVAILABILITY_QUERY_ERROR_AS_AVAILABLE = 0", () => {
    expect(elegibilidadeSemDominio(MOTOR)).toEqual([]);
  });

  it("o motor não escreve — é uma leitura", () => {
    expect(MOTOR).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
  });

  it("a empresa é resolvida no servidor, e o papel é verificado", () => {
    expect(MOTOR).toMatch(/requireProfile\(\s*\{\s*roles:/);
    expect(MOTOR).toMatch(/guard\.profile\.company_id/);
  });

  it("unknown nunca é convertido em available no domínio", () => {
    const dominio = semComentarios(ler("src/domain/workforce/availability.ts"));
    expect(dominio).not.toMatch(/unknown["']?\s*[:=]>?\s*["']available/);
    expect(dominio).not.toMatch(/\?\?\s*["']available["']/);
  });
});

describe("as guardas acusam código estragado (mutation proof)", () => {
  it("A. reintroduzir `(absencesRes.data ?? [])` sem verificar o erro dispara", () => {
    const mutado = `
export async function getSubstituteSuggestions() {
  const absentSet = new Set((absencesRes.data ?? []).map((a) => a.collaborator_id));
  return { ok: true, data: [] };
}
`;
    expect(fonteCriticaSemAborto(mutado).length).toBeGreaterThan(0);
  });

  it("B. voltar a só registar o erro dos serviços e continuar dispara", () => {
    const mutado = `
  logQueryFailure("x:services", servicesError);
  for (const s of services ?? []) { count += 1; }
`;
    expect(mutado).not.toMatch(/servicesError[\s\S]{0,200}return\s*\{\s*ok:\s*false/);
  });

  it("C. converter unknown em available dispara", () => {
    const mutado = 'const estado = resolve(x) ?? "available";';
    expect(mutado).toMatch(/\?\?\s*["']available["']/);
  });

  it("D. tirar a elegibilidade do domínio dispara", () => {
    const mutado = `
export async function getSubstituteSuggestions() {
  for (const c of all) { if (absentSet.has(c.id)) continue; suggestions.push(c); }
}
`;
    expect(elegibilidadeSemDominio(mutado)).toContain("não usa resolveAvailability");
    expect(elegibilidadeSemDominio(mutado)).toContain("não usa isSuggestable");
  });

  it("as guardas não se deixam enganar pelos comentários que as explicam", () => {
    // O ficheiro real cita `(absencesRes.data ?? [])` no comentário que explica
    // o defeito. Se a guarda medisse comentários, estaria vermelha.
    expect(ler("src/app/actions/absences.ts")).toMatch(/absencesRes\.data \?\? \[\]/);
    expect(fonteCriticaSemAborto(MOTOR)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — o consumidor não pode mostrar uma lista velha depois de um erro
// ═══════════════════════════════════════════════════════════════════════════

describe("10. o painel de substituição", () => {
  const painel = semComentarios(
    ler("src/app/(dashboard)/dashboard/faltas/_components/substitution-panel.tsx"),
  );

  it("limpa as sugestões quando a leitura falha", () => {
    const ramoErro = painel.slice(painel.indexOf("} else {"), painel.indexOf("setLoading(false)"));
    expect(ramoErro).toMatch(/setSuggestions\(\[\]\)/);
    expect(ramoErro).toMatch(/setError/);
  });

  it("mostra o erro em vez da lista", () => {
    expect(painel).toMatch(/error\s*\?/);
  });

  it("distingue lista degradada de lista errada", () => {
    expect(painel).toMatch(/rankingDegraded/);
  });
});
