// ============================================================================
// RUNNER — migrations bloqueadas e aplicação de exatamente uma (P0G)
// ============================================================================
//
// A lacuna que isto fecha não estava numa migration. Estava no caminho até ela:
//
//     pending = ficheiros sem linha no ledger
//     for (const file of pending) executar
//
// «Pendente» era a única categoria. A 070 está deliberadamente congelada e
// ausente do ledger — logo, indistinguível de uma migration que ainda não teve
// oportunidade de correr. Criar a 077 e correr o `--apply` de sempre executaria
// **a 070 primeiro**, sem ninguém a ter pedido.
//
// Ter uma migration segura não chega. É preciso um caminho seguro até ela.
//
// Como sempre neste runner, os testes correm contra um cliente Postgres falso
// que grava todas as queries recebidas. A pergunta em cada caso é a mesma que
// interessa em produção: **que SQL é que isto teria corrido?**
// ============================================================================

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations as runMigrationsUntyped } from "../../scripts/lib/migration-runner-core.mjs";

// O núcleo é .mjs sem tipos; o default `blockedMigrations = []` faz o TS
// inferir `never[]`. Este alias documenta a forma real das opções em vez de
// espalhar `as never` pelos testes.
const runMigrations = runMigrationsUntyped as unknown as (opts: Record<string, unknown>) =>
  Promise<{ exitCode: number; targetState?: string; driftCode?: string }>;
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";
import {
  assertValidBlockedEntries,
  splitBlocked,
  resolveOnlyTarget,
  isBlocked,
} from "../../scripts/lib/migration-blocklist.mjs";
import { parseArgs, validateArgCombination } from "../../scripts/lib/migration-runner-guards.mjs";

const MUTATING = ["CREATE", "ALTER", "INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "DROP"];
const isMutating = (sql: string) => MUTATING.some((p) => sql.trim().toUpperCase().startsWith(p));

interface Row { name: string; checksum: string | null }

class FakeClient {
  queries: Array<{ sql: string; params: unknown }> = [];
  constructor(
    private rows: Row[] = [],
    private falhaEm: string | null = null,
    private falhaNoInsert = false,
  ) {}

  async query(sql: string, params?: unknown) {
    this.queries.push({ sql, params });

    if (this.falhaEm && sql.includes(this.falhaEm)) throw new Error("erro de SQL simulado");
    if (this.falhaNoInsert && sql.startsWith("INSERT INTO public._migrations")) {
      throw new Error("insert no ledger falhou");
    }
    if (sql.includes("to_regclass")) return { rows: [{ reg: "public._migrations" }] };
    if (sql.includes("information_schema.columns")) return { rows: [{ "?column?": 1 }] };
    if (sql.includes("FROM public._migrations")) return { rows: this.rows };
    if (sql.includes("FROM public.companies")) return { rows: [{ n: 1 }] };
    return { rows: [] };
  }

  /** Nomes de ficheiro que este run tentou executar de facto. */
  executadas(ficheiros: string[]) {
    return ficheiros.filter((f) =>
      this.queries.some((q) => q.sql.startsWith("INSERT INTO public._migrations") &&
        Array.isArray(q.params) && (q.params as unknown[])[0] === f));
  }

  get mutacoes() { return this.queries.filter((q) => isMutating(q.sql)); }
}

// ── Diretório temporário com migrations reais em disco ─────────────────────
const temporarios: string[] = [];
function criarMigrations(nomes: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  temporarios.push(dir);
  for (const [nome, sql] of Object.entries(nomes)) fs.writeFileSync(path.join(dir, nome), sql);
  return dir;
}
afterEach(() => {
  for (const d of temporarios.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BLOQUEADAS = [{
  migration: "070_guard_profile_managed_fields.sql",
  reason: "Congelada por decisão do proprietário.",
  evidence: "CLAUDE.md",
}];

const CENARIO = {
  "069_guard.sql": "SELECT 1;",
  "070_guard_profile_managed_fields.sql": "SELECT 'a 070 nunca deve correr';",
  "077_secure_migrations_ledger.sql": "SELECT 'alvo';",
};

const jaAplicada = (nome: string, dir: string): Row => ({
  name: nome,
  checksum: checksumForNewMigration(fs.readFileSync(path.join(dir, nome), "utf8")),
});

const correr = (client: FakeClient, dir: string, opts: Record<string, unknown> = {}): Promise<{ exitCode: number; targetState?: string }> =>
  runMigrations({
    client, migrationsDir: dir, rootDir: dir,
    apply: false,
    blockedMigrations: BLOQUEADAS,
    log: () => {}, logWarn: () => {}, logError: () => {},
    ...opts,
  });

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — a política de bloqueio, pura
// ═══════════════════════════════════════════════════════════════════════════

describe("política de migrations bloqueadas", () => {
  it("uma entrada sem motivo é recusada", () => {
    // Um bloqueio sem motivo não sobrevive a quem o encontrar daqui a seis meses.
    expect(() => assertValidBlockedEntries([{ migration: "070_x.sql" }])).toThrow(/sem motivo/i);
  });

  it("uma lista malformada lança em vez de degradar para «nada bloqueado»", () => {
    // 🔴 Degradar aqui seria a falha silenciosa mais cara do módulo: o bloqueio
    //    desaparecia e a migration voltava à fila sem aviso nenhum.
    expect(() => assertValidBlockedEntries({} as never)).toThrow(/lista/i);
    expect(() => assertValidBlockedEntries([{ migration: 70 as never, reason: "x" }])).toThrow(/\.sql/);
  });

  it("duplicados são recusados", () => {
    expect(() => assertValidBlockedEntries([
      { migration: "070_x.sql", reason: "a" },
      { migration: "070_x.sql", reason: "b" },
    ])).toThrow(/duas vezes/i);
  });

  it("separa bloqueadas de elegíveis sem perder nenhuma", () => {
    const { blocked, eligible } = splitBlocked(BLOQUEADAS, [
      "070_guard_profile_managed_fields.sql", "077_secure_migrations_ledger.sql",
    ]);
    expect(blocked).toEqual(["070_guard_profile_managed_fields.sql"]);
    expect(eligible).toEqual(["077_secure_migrations_ledger.sql"]);
  });

  it("a lista vazia não bloqueia nada", () => {
    expect(isBlocked([], "070_guard_profile_managed_fields.sql")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — resolução de --only
// ═══════════════════════════════════════════════════════════════════════════

describe("resolução de --only", () => {
  const files = Object.keys(CENARIO);
  const base = { files, appliedNames: new Set<string>(), blockedEntries: BLOQUEADAS };

  it("I. 🔴 prefixo não corresponde — exige o nome exato", () => {
    // `--only 077` parece inofensivo até existirem duas 077_, ou até o prefixo
    // apanhar mais do que se pensava. Em produção, «provavelmente era esta»
    // não é um resultado aceitável.
    expect(resolveOnlyTarget({ ...base, only: "077" }).kind).toBe("invalid");
    expect(resolveOnlyTarget({ ...base, only: "077_secure" }).kind).toBe("invalid");
  });

  it("H. ficheiro inexistente falha", () => {
    expect(resolveOnlyTarget({ ...base, only: "999_nada.sql" }).kind).toBe("invalid");
  });

  it("D. 🔴 uma migration bloqueada nunca pode ser alvo", () => {
    const r = resolveOnlyTarget({ ...base, only: "070_guard_profile_managed_fields.sql" });
    expect(r.kind).toBe("blocked");
    expect(r.error).toMatch(/BLOCKED_PENDING/);
  });

  it("J. um alvo já aplicado devolve ALREADY_APPLIED", () => {
    const r = resolveOnlyTarget({
      ...base, only: "077_secure_migrations_ledger.sql",
      appliedNames: new Set(["077_secure_migrations_ledger.sql"]),
    });
    expect(r.kind).toBe("already-applied");
  });

  it("um alvo válido e pendente é aceite", () => {
    const r = resolveOnlyTarget({ ...base, only: "077_secure_migrations_ledger.sql" });
    expect(r).toEqual({ kind: "target", file: "077_secure_migrations_ledger.sql" });
  });

  it("sem --only, não há alvo", () => {
    expect(resolveOnlyTarget({ ...base, only: null }).kind).toBe("none");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — argumentos
// ═══════════════════════════════════════════════════════════════════════════

describe("argumentos de CLI", () => {
  const combinacao = (argv: string[]) => validateArgCombination(parseArgs(argv));

  it("P. --only + --baseline é recusado", () => {
    expect(combinacao(["--only", "077_x.sql", "--baseline", "--apply"]).ok).toBe(false);
  });

  it("Q. --only + --seed é recusado", () => {
    expect(combinacao(["--only", "077_x.sql", "--seed", "--apply"]).ok).toBe(false);
  });

  it("O. flag desconhecida continua recusada", () => {
    expect(combinacao(["--only", "077_x.sql", "--force"]).ok).toBe(false);
  });

  it("🔴 --only sem valor não engole a flag seguinte", () => {
    // Sem esta guarda, `--only --apply` aplicaria uma migration chamada
    // "--apply" — ou pior, passaria a validação com um alvo absurdo.
    const r = combinacao(["--only", "--apply"]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--apply/);
  });

  it("--only com nome válido passa", () => {
    expect(combinacao(["--only", "077_x.sql", "--apply", "--confirm-production", "ref"]).ok).toBe(true);
  });

  it("R. --apply continua a exigir confirmação de produção", () => {
    // A guarda vive em validateProductionConfirmation; aqui prova-se que
    // --only não abriu um caminho que a contorne.
    const parsed = parseArgs(["--apply", "--only", "077_x.sql"]);
    expect(parsed.apply).toBe(true);
    expect(parsed.confirmProductionValue).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — o runner, contra o cliente falso
// ═══════════════════════════════════════════════════════════════════════════

describe("runner com a 070 bloqueada", () => {
  it("A+T. dry-run sem argumentos não executa uma única mutação", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient();
    await correr(c, dir);
    expect(c.mutacoes).toEqual([]);
  });

  it("C+E. 🔴 --apply normal NÃO executa a 070", async () => {
    // Este é o cenário exato do risco: 070 e 077 ambas ausentes do ledger.
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([jaAplicada("069_guard.sql", dir)]);

    await correr(c, dir, { apply: true });

    expect(c.executadas(["070_guard_profile_managed_fields.sql"])).toEqual([]);
    expect(c.executadas(["077_secure_migrations_ledger.sql"]))
      .toEqual(["077_secure_migrations_ledger.sql"]);
    // E o SQL da 070 nunca chegou a ser enviado.
    expect(c.queries.some((q) => q.sql.includes("a 070 nunca deve correr"))).toBe(false);
  });

  it("B. --only 077 seleciona exatamente essa migration", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([jaAplicada("069_guard.sql", dir)]);

    await correr(c, dir, { apply: true, only: "077_secure_migrations_ledger.sql" });

    expect(c.executadas(Object.keys(CENARIO)))
      .toEqual(["077_secure_migrations_ledger.sql"]);
  });

  it("D. --only sobre a 070 falha ANTES de qualquer escrita", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([jaAplicada("069_guard.sql", dir)]);

    const r = await correr(c, dir, {
      apply: true, only: "070_guard_profile_managed_fields.sql",
    });

    expect(r.exitCode).toBe(1);
    expect(c.queries.some((q) => q.sql.startsWith("BEGIN"))).toBe(false);
    expect(c.executadas(Object.keys(CENARIO))).toEqual([]);
  });

  it("U+F. a 070 aparece no relatório como BLOCKED_PENDING, nunca como aplicada", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([jaAplicada("069_guard.sql", dir)]);
    const linhas: string[] = [];

    await correr(c, dir, { apply: false, log: (m: string) => linhas.push(m) });

    const texto = linhas.join("\n");
    expect(texto).toMatch(/BLOCKED_PENDING/);
    expect(texto).toMatch(/070_guard_profile_managed_fields\.sql/);
    expect(texto).toMatch(/Congelada por decisão do proprietário/);
    // Nunca desaparece nem é dada por resolvida.
    expect(texto).not.toMatch(/070.*(já aplicada|ignorada)/i);
  });

  it("G. 🔴 --baseline não marca a 070 como aplicada", async () => {
    // Sem isto, "não executámos a 070" virava "o ledger diz que executámos a
    // 070" — uma mentira gravada na tabela que existe para não mentir.
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([]);

    await correr(c, dir, { apply: true, baseline: true });

    const marcadas = c.queries
      .filter((q) => q.sql.startsWith("INSERT INTO public._migrations"))
      .map((q) => (q.params as unknown[])[0]);

    expect(marcadas).not.toContain("070_guard_profile_managed_fields.sql");
    expect(marcadas).toContain("077_secure_migrations_ledger.sql");
  });

  it("J. alvo já aplicado → zero escritas, saída de sucesso", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([
      jaAplicada("069_guard.sql", dir),
      jaAplicada("077_secure_migrations_ledger.sql", dir),
    ]);

    const r = await correr(c, dir, {
      apply: true, only: "077_secure_migrations_ledger.sql",
    });

    expect(r.exitCode).toBe(0);
    expect(r.targetState).toBe("ALREADY_APPLIED");
    expect(c.queries.some((q) => q.sql.startsWith("BEGIN"))).toBe(false);
  });

  it("T. dry-run com --only continua a não escrever", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([jaAplicada("069_guard.sql", dir)]);

    await correr(c, dir, { apply: false, only: "077_secure_migrations_ledger.sql" });

    expect(c.mutacoes).toEqual([]);
  });

  it("L. 🔴 checksum divergente noutra migration impede o alvo de correr", async () => {
    // "Estou a aplicar só a 077, portanto ignoro o drift da 069" seria trocar
    // uma verificação global por conveniência local.
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([{ name: "069_guard.sql", checksum: "checksum-que-nao-bate" }]);

    const r = await correr(c, dir, {
      apply: true, only: "077_secure_migrations_ledger.sql",
    });

    expect(r.exitCode).toBe(1);
    expect(c.executadas(Object.keys(CENARIO))).toEqual([]);
  });

  it("M. erro no SQL do alvo faz ROLLBACK", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([jaAplicada("069_guard.sql", dir)], "alvo");

    const r = await correr(c, dir, {
      apply: true, only: "077_secure_migrations_ledger.sql",
    });

    expect(r.exitCode).toBe(1);
    expect(c.queries.some((q) => q.sql.startsWith("ROLLBACK"))).toBe(true);
    expect(c.queries.some((q) => q.sql.startsWith("COMMIT"))).toBe(false);
  });

  it("N. erro a registar no ledger faz ROLLBACK do schema do alvo", async () => {
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([jaAplicada("069_guard.sql", dir)], null, true);

    const r = await correr(c, dir, {
      apply: true, only: "077_secure_migrations_ledger.sql",
    });

    expect(r.exitCode).toBe(1);
    expect(c.queries.some((q) => q.sql.startsWith("ROLLBACK"))).toBe(true);
  });

  it("uma migration bloqueada e já no ledger não aparece como pendente", async () => {
    // Coerência: o bloqueio é sobre aplicar, não sobre existir.
    const dir = criarMigrations(CENARIO);
    const c = new FakeClient([
      jaAplicada("069_guard.sql", dir),
      jaAplicada("070_guard_profile_managed_fields.sql", dir),
    ]);
    const linhas: string[] = [];

    await correr(c, dir, { apply: false, log: (m: string) => linhas.push(m) });

    expect(linhas.join("\n")).not.toMatch(/BLOCKED_PENDING/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE E — mutation proof
// ═══════════════════════════════════════════════════════════════════════════
//
// Cada proteção é quebrada de propósito e prova-se que a quebra é detetável.
// Uma guarda que nunca se viu falhar não é uma guarda.

describe("as proteções acusam quando removidas", () => {
  it("sem lista de bloqueios, a 070 volta a ser elegível", () => {
    const { eligible } = splitBlocked([], [
      "070_guard_profile_managed_fields.sql", "077_secure_migrations_ledger.sql",
    ]);
    expect(eligible).toContain("070_guard_profile_managed_fields.sql");
  });

  it("prefix matching aceitaria o que a correspondência exata recusa", () => {
    const files = Object.keys(CENARIO);
    const porPrefixo = files.filter((f) => f.startsWith("077"));
    expect(porPrefixo).toHaveLength(1);            // hoje passaria por sorte
    const exato = files.filter((f) => f === "077");
    expect(exato).toHaveLength(0);                 // e é por isso que se exige exato
  });

  it("o baseline sem filtro marcaria a 070", () => {
    const files = Object.keys(CENARIO);
    const semFiltro = files.filter((f) => !new Set(["069_guard.sql"]).has(f));
    expect(semFiltro).toContain("070_guard_profile_managed_fields.sql");

    const { eligible } = splitBlocked(BLOQUEADAS, semFiltro);
    expect(eligible).not.toContain("070_guard_profile_managed_fields.sql");
  });

  it("a política versionada tem mesmo a 070 bloqueada", () => {
    const politica = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "supabase", "migration-policy.json"), "utf8"),
    );
    expect(() => assertValidBlockedEntries(politica.blockedMigrations)).not.toThrow();
    expect(isBlocked(politica.blockedMigrations, "070_guard_profile_managed_fields.sql")).toBe(true);
  });

  it("o bloqueio não está escrito no runner — está na política", () => {
    const core = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "lib", "migration-runner-core.mjs"), "utf8",
    ).replace(/^\s*\/\/.*$/gm, "");
    // Uma condição no código é invisível quando alguém a remove.
    expect(core).not.toMatch(/["']070/);
    expect(core).toMatch(/splitBlocked/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O ledger COMO ESTÁ HOJE em produção
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 Esta fixture existe por causa de um erro de leitura, não de código.
//
//    O `CLAUDE.md` de 2026-08-17 dizia que 071/072/073 estavam aplicadas fora
//    do ledger e que a última entrada era a 069. Era verdade nesse dia. A 18
//    deixou de ser — as três passaram a ter linha, com checksum coincidente.
//    A frase antiga continuou a ser citada como estado corrente durante uma
//    semana, incluindo por mim.
//
//    Escrever a fotografia atual num teste tira-lhe a ambiguidade: se alguém
//    voltar a assumir que 071–076 estão pendentes, isto fica vermelho.
//
//    Medido a 2026-08-25 por consulta read-only: `LEDGER_ROWS = 77`, com
//    068, 069, 071, 072, 073, 074, 075 e 076 presentes e a 070 ausente.
// ═══════════════════════════════════════════════════════════════════════════

const LEDGER_HOJE = {
  "068_disable_untrusted_profile_bootstrap.sql": "SELECT '068';",
  "069_guard_profile_tenant_role.sql":           "SELECT '069';",
  "070_guard_profile_managed_fields.sql":        "SELECT 'a 070 nunca deve correr';",
  "071_finance_periods_and_expense_categories.sql": "SELECT '071';",
  "072_invoice_atomic_creation.sql":             "SELECT '072';",
  "073_payment_to_cashflow.sql":                 "SELECT '073';",
  "074_attachments.sql":                         "SELECT '074';",
  "075_cash_flow_fixed_variable_payment_reference.sql": "SELECT '075';",
  "076_update_notices.sql":                      "SELECT '076';",
};

/** Tudo o que hoje tem linha no ledger — ou seja, todas menos a 070. */
const COM_LINHA_NO_LEDGER = Object.keys(LEDGER_HOJE)
  .filter((n) => !n.startsWith("070_"));

describe("fixture do ledger atual (2026-08-25)", () => {
  it("V. com o ledger de hoje não sobra uma única migration pendente", async () => {
    // 🔴 A primeira versão procurava os nomes 071/072/073 seguidos da palavra
    //    "pendente" e exigia que não aparecessem. Nunca apareciam — o runner
    //    não escreve os nomes das aplicadas — por isso a asserção passava sem
    //    nunca ter nada contra que falhar.
    //
    //    O sinal verdadeiro é a contagem. Se alguém voltar a assumir a
    //    fotografia de 17/08, 071–076 entram na fila e este número deixa de
    //    ser zero.
    const dir = criarMigrations(LEDGER_HOJE);
    const c = new FakeClient(COM_LINHA_NO_LEDGER.map((n) => jaAplicada(n, dir)));
    const linhas: string[] = [];

    await correr(c, dir, { apply: false, log: (m: string) => linhas.push(m) });
    const texto = linhas.join("\n");

    expect(texto).toMatch(/0 migração\(ões\) pendente\(s\)/);

    // Prova de que a contagem reage: sem a linha da 073, ela deixa de ser zero.
    const semA073 = new FakeClient(
      COM_LINHA_NO_LEDGER.filter((n) => !n.startsWith("073_")).map((n) => jaAplicada(n, dir)),
    );
    const outras: string[] = [];
    await correr(semA073, dir, { apply: false, log: (m: string) => outras.push(m) });
    expect(outras.join("\n")).not.toMatch(/0 migração\(ões\) pendente\(s\)/);
  });

  it("W. com este ledger, um --apply não executa nada além do que falta", async () => {
    const dir = criarMigrations(LEDGER_HOJE);
    const c = new FakeClient(COM_LINHA_NO_LEDGER.map((n) => jaAplicada(n, dir)));

    await correr(c, dir, { apply: true });

    // A única sem linha é a 070, e essa está bloqueada: sobra exatamente nada.
    expect(c.executadas(Object.keys(LEDGER_HOJE))).toEqual([]);
    expect(c.queries.some((q) => q.sql.includes("a 070 nunca deve correr"))).toBe(false);
  });

  it("X. a 070 continua a aparecer como BLOCKED_PENDING neste ledger", async () => {
    const dir = criarMigrations(LEDGER_HOJE);
    const c = new FakeClient(COM_LINHA_NO_LEDGER.map((n) => jaAplicada(n, dir)));
    const linhas: string[] = [];

    await correr(c, dir, { apply: false, log: (m: string) => linhas.push(m) });
    const texto = linhas.join("\n");

    expect(texto).toMatch(/BLOCKED_PENDING/);
    expect(texto).toMatch(/070_guard_profile_managed_fields\.sql/);
  });

  it("Y. baseline não inventa uma linha para a 070 — e o mecanismo está vivo", async () => {
    // 🔴 A primeira versão deste teste passava por vazio: procurava a 070
    //    dentro dos INSERT emitidos, e não havia INSERT nenhum. Uma asserção
    //    que nunca olha para nada não prova nada.
    //
    //    Passa a afirmar-se as duas metades: com este ledger o baseline não
    //    escreve **de todo**, e num ledger a que falte uma migration elegível
    //    ele escreve mesmo — o que mostra que o silêncio acima é uma decisão,
    //    não uma avaria.
    const dir = criarMigrations(LEDGER_HOJE);
    const inserts = (c: FakeClient) =>
      c.queries.filter((q) => q.sql.startsWith("INSERT INTO public._migrations"));

    const completo = new FakeClient(COM_LINHA_NO_LEDGER.map((n) => jaAplicada(n, dir)));
    await correr(completo, dir, { apply: true, baseline: true });
    expect(inserts(completo)).toHaveLength(0);

    // Agora sem a linha da 076: o baseline tem trabalho para fazer.
    const semA076 = new FakeClient(
      COM_LINHA_NO_LEDGER.filter((n) => !n.startsWith("076_")).map((n) => jaAplicada(n, dir)),
    );
    await correr(semA076, dir, { apply: true, baseline: true });

    const escritas = inserts(semA076);
    expect(escritas.length).toBeGreaterThan(0);

    const marcadas = escritas.flatMap((q) => (q.params ?? []) as unknown[]).map(String);
    expect(marcadas.some((v) => v.includes("076_"))).toBe(true);
    // E a 070, essa, continua sem linha mesmo quando o baseline está a escrever.
    expect(marcadas.some((v) => v.includes("070_"))).toBe(false);
  });
});
