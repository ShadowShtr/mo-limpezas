// ============================================================================
// 077 — fechar o acesso público a public._migrations (P0H)
// ============================================================================
//
// Corre a migration REAL, lida do ficheiro versionado, contra PGlite — Postgres
// a sério, em memória. Nunca toca na base de produção.
//
// A pergunta mais importante deste ficheiro **não** é «anon fica bloqueado?».
// É a inversa: **o runner continua a conseguir registar a própria migration?**
//
// Uma migration de segurança que protege a tabela e impede o sistema de
// migrations de escrever nela deixaria a base protegida e o ledger a mentir —
// pior do que o problema que veio resolver. Por isso o teste central reproduz
// a transação exata do runner:
//
//     BEGIN → executar 077 → INSERT INTO _migrations → COMMIT
//
// PGlite implementa roles, GRANT/REVOKE, RLS, policies restritivas e `SET ROLE`
// com fidelidade real — está verificado abaixo, não assumido:
//
//     sem privilégio de tabela  → "permission denied"
//     com privilégio + RLS      → a query passa e devolve ZERO linhas
//
// PRIVILEGE_SEMANTICS_PGLITE = FULL para o que esta migration faz. Não foi
// preciso um Postgres descartável à parte.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();
const FICHEIRO = "077_secure_migrations_ledger.sql";
const SQL_077 = fs.readFileSync(path.join(RAIZ, "supabase", "migrations", FICHEIRO), "utf8");

/**
 * Reproduz o estado de produção medido a 2026-08-24:
 * owner postgres, RLS desligada, anon/authenticated com privilégios amplos,
 * uma policy anterior, e o ledger com linhas já registadas.
 */
async function producaoAntesDa077(linhas = 77) {
  const db = new PGlite();

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;

    CREATE TABLE public._migrations (
      name       text PRIMARY KEY,
      checksum   text,
      applied_at timestamptz NOT NULL DEFAULT now()
    );

    GRANT ALL ON TABLE public._migrations TO anon, authenticated, service_role;
  `);

  // A policy anterior que a auditoria encontrou (POLICIES_TOTAL = 1). A
  // semântica real não foi caracterizada; o que importa aqui é que exista uma
  // policy permissiva e que a 077 não a destrua.
  await db.exec(`
    CREATE POLICY "policy_anterior_nao_caracterizada"
    ON public._migrations
    FOR SELECT
    TO anon, authenticated
    USING (true);
  `);

  for (let i = 1; i <= linhas; i++) {
    const nome = `${String(i).padStart(3, "0")}_historica.sql`;
    await db.query(
      "INSERT INTO public._migrations (name, checksum, applied_at) VALUES ($1, $2, $3)",
      [nome, `checksum-${i}`, new Date(2026, 0, i % 28 + 1).toISOString()],
    );
  }

  return db;
}

/** Aplica a 077 como o runner faria: numa transação, com o registo no ledger. */
async function aplicarComoRunner(db: PGlite, { falharNoLedger = false } = {}) {
  try {
    await db.exec("BEGIN");
    await db.exec(SQL_077);
    if (falharNoLedger) {
      // Um INSERT que viola a chave primária — o modo mais fiel de simular
      // "a migration correu e o registo no ledger falhou".
      await db.query(
        "INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)",
        ["001_historica.sql", "duplicado"],
      );
    } else {
      await db.query(
        "INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)",
        [FICHEIRO, "checksum-077"],
      );
    }
    await db.exec("COMMIT");
    return { ok: true as const };
  } catch (e) {
    await db.exec("ROLLBACK").catch(() => {});
    return { ok: false as const, erro: (e as Error).message };
  }
}

const privilegios = async (db: PGlite, role: string) => {
  const r = await db.query<{ privilege_type: string }>(
    `SELECT privilege_type FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='_migrations' AND grantee=$1
     ORDER BY privilege_type`, [role],
  );
  return r.rows.map((x) => x.privilege_type);
};

const estadoRls = async (db: PGlite) => {
  const r = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='_migrations'`,
  );
  return r.rows[0];
};

const policies = async (db: PGlite) => {
  const r = await db.query<{ polname: string; polpermissive: boolean }>(
    `SELECT p.polname, p.polpermissive FROM pg_policy p
     JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname='_migrations'
     ORDER BY p.polname`,
  );
  return r.rows;
};

/**
 * Corre uma operação sob a identidade de um role e classifica o resultado.
 *
 * 🔴 Grants e RLS protegem de maneiras **diferentes**, e confundi-las leva a
 *    conclusões erradas nos dois sentidos:
 *
 *      sem privilégio de tabela  → a query rebenta: "permission denied"
 *      com privilégio + RLS      → a query passa e devolve ZERO linhas
 *
 *    A segunda não é uma falha da proteção — é RLS a fazer exatamente o que
 *    faz: filtra linhas, não levanta erros. Um teste que só procurasse
 *    "permission denied" daria a RLS por partida quando ela está a funcionar;
 *    um que só contasse linhas não distinguiria "protegido" de "tabela vazia".
 *
 *    Por isso esta função devolve a categoria, e cada teste diz qual espera.
 */
async function comoRole(
  db: PGlite, role: string, sql: string,
): Promise<"sem-privilegio" | "sem-linhas" | "bloqueado-por-rls" | "permitido" | string> {
  await db.exec(`SET ROLE ${role};`);
  try {
    const r = await db.query<Record<string, unknown>>(sql);
    if (/^\s*select/i.test(sql)) {
      // Numa contagem, a RLS a filtrar tudo aparece como 0.
      const primeiro = r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
      const zero = r.rows.length === 0 || Number(primeiro) === 0;
      return zero ? "sem-linhas" : "permitido";
    }
    return "permitido";
  } catch (e) {
    const m = (e as Error).message;
    if (m.includes("permission denied")) return "sem-privilegio";
    if (/row-level security/i.test(m)) return "bloqueado-por-rls";
    return `erro: ${m.slice(0, 60)}`;
  } finally {
    await db.exec("RESET ROLE;");
  }
}

let db: PGlite;
beforeEach(async () => { db = await producaoAntesDa077(); });

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — o ponto de partida é mesmo o de produção
// ═══════════════════════════════════════════════════════════════════════════

describe("estado antes da 077 (fixture fiel à auditoria)", () => {
  it("RLS desligada e anon com privilégios amplos", async () => {
    expect((await estadoRls(db)).relrowsecurity).toBe(false);
    const p = await privilegios(db, "anon");
    expect(p).toContain("SELECT");
    expect(p).toContain("DELETE");
    expect(p).toContain("TRUNCATE");
  });

  it("anon consegue ler o ledger — é o defeito a corrigir", async () => {
    // "permitido" aqui significa mesmo: devolveu linhas, não zero.
    expect(await comoRole(db, "anon", "SELECT count(*) FROM public._migrations")).toBe("permitido");
  });

  it("o ledger tem as 77 linhas históricas", async () => {
    const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public._migrations");
    expect(r.rows[0].n).toBe(77);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — o teste que decide: o runner continua a funcionar?
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 o runner sobrevive à própria migration", () => {
  it("RUNNER_CAN_INSERT_077_LEDGER_ROW — BEGIN → 077 → INSERT → COMMIT", async () => {
    const r = await aplicarComoRunner(db);
    expect(r.ok).toBe(true);

    const linhas = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public._migrations");
    expect(linhas.rows[0].n).toBe(78);

    const propria = await db.query<{ name: string }>(
      "SELECT name FROM public._migrations WHERE name = $1", [FICHEIRO],
    );
    expect(propria.rows).toHaveLength(1);
  });

  it("RUNNER_CAN_READ_LEDGER — a leitura continua a funcionar depois", async () => {
    await aplicarComoRunner(db);
    const r = await db.query("SELECT name, checksum FROM public._migrations LIMIT 5");
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("POST_FORCE_RLS = false — o dono não fica sujeito às policies", async () => {
    // Com FORCE, o próprio runner (owner) passaria a ser filtrado e o INSERT
    // do ledger deixaria de passar. É por isso que a 077 não o usa.
    await aplicarComoRunner(db);
    expect((await estadoRls(db)).relforcerowsecurity).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — o efeito pretendido
// ═══════════════════════════════════════════════════════════════════════════

describe("depois da 077", () => {
  beforeEach(async () => { await aplicarComoRunner(db); });

  it("POST_ANON_PRIVILEGES = NONE", async () => {
    expect(await privilegios(db, "anon")).toEqual([]);
  });

  it("POST_AUTH_PRIVILEGES = NONE", async () => {
    expect(await privilegios(db, "authenticated")).toEqual([]);
  });

  it("POST_RLS = true", async () => {
    expect((await estadoRls(db)).relrowsecurity).toBe(true);
  });

  it("anon é negado em leitura e em todas as escritas", async () => {
    // Com os grants revogados, a primeira camada já basta: nem chega à RLS.
    for (const sql of [
      "SELECT count(*) FROM public._migrations",
      "INSERT INTO public._migrations (name) VALUES ('x')",
      "UPDATE public._migrations SET checksum='x'",
      "DELETE FROM public._migrations",
      "TRUNCATE public._migrations",
    ]) {
      expect(await comoRole(db, "anon", sql), sql).toBe("sem-privilegio");
    }
  });

  it("authenticated é negado do mesmo modo", async () => {
    expect(await comoRole(db, "authenticated", "SELECT count(*) FROM public._migrations"))
      .toBe("sem-privilegio");
    expect(await comoRole(db, "authenticated", "DELETE FROM public._migrations"))
      .toBe("sem-privilegio");
  });

  it("SERVICE_ROLE_CHANGE = NO — os privilégios ficam como estavam", async () => {
    const p = await privilegios(db, "service_role");
    expect(p).toContain("SELECT");
    expect(p).toContain("INSERT");
  });

  it("EXISTING_POLICY_PRESERVED — a policy anterior não foi destruída", async () => {
    const nomes = (await policies(db)).map((p) => p.polname);
    expect(nomes).toContain("policy_anterior_nao_caracterizada");
    expect(nomes).toContain("_migrations_deny_public_roles");
  });

  it("RESTRICTIVE_DENY_POLICY — e é mesmo restritiva", async () => {
    const nova = (await policies(db)).find((p) => p.polname === "_migrations_deny_public_roles");
    // `polpermissive = false` é o que faz a diferença: permissivas combinam-se
    // por OR (uma nova reabriria), restritivas por AND (esta continua a negar).
    expect(nova?.polpermissive).toBe(false);
  });

  it("🔴 uma policy permissiva criada depois NÃO reabre o acesso", async () => {
    // A prova de que RESTRICTIVE era a escolha certa. Alguém volta a conceder
    // SELECT e cria uma policy permissiva a dizer `USING (true)` — as duas
    // camadas exteriores caem, e o ledger continua invisível.
    //
    // A negação muda de forma: já não é "permission denied" (o grant voltou),
    // é a RLS a filtrar todas as linhas. Nenhuma das 77 sai.
    await db.exec(`
      GRANT SELECT ON TABLE public._migrations TO anon;
      CREATE POLICY "reabre_por_engano" ON public._migrations
      FOR SELECT TO anon USING (true);
    `);

    expect(await comoRole(db, "anon", "SELECT count(*) FROM public._migrations"))
      .toBe("sem-linhas");

    // E não é a tabela que está vazia — o dono continua a ver as 78 linhas.
    const dono = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public._migrations");
    expect(dono.rows[0].n).toBe(78);
  });

  it("🔴 e uma escrita com os grants de volta é travada pela RLS", async () => {
    await db.exec("GRANT INSERT ON TABLE public._migrations TO anon;");
    expect(await comoRole(db, "anon", "INSERT INTO public._migrations (name) VALUES ('intruso')"))
      .toBe("bloqueado-por-rls");

    const linhas = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public._migrations");
    expect(linhas.rows[0].n).toBe(78);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — integridade dos dados e transação
// ═══════════════════════════════════════════════════════════════════════════

describe("as 77 linhas históricas", () => {
  it("ZERO_ALTERACAO — nome, checksum e applied_at intactos", async () => {
    const antes = await db.query(
      "SELECT name, checksum, applied_at FROM public._migrations ORDER BY name",
    );
    await aplicarComoRunner(db);
    const depois = await db.query(
      "SELECT name, checksum, applied_at FROM public._migrations WHERE name <> $1 ORDER BY name",
      [FICHEIRO],
    );
    expect(depois.rows).toEqual(antes.rows);
    expect(depois.rows).toHaveLength(77);
  });
});

describe("LEDGER_INSERT_FAILURE_ROLLS_BACK", () => {
  it("🔴 se o registo no ledger falhar, a proteção também é revertida", async () => {
    // O estado impossível a evitar: tabela protegida, ledger sem a linha. Na
    // execução seguinte o runner voltaria a tentar aplicar uma migration que
    // já tinha corrido.
    const r = await aplicarComoRunner(db, { falharNoLedger: true });
    expect(r.ok).toBe(false);

    expect((await estadoRls(db)).relrowsecurity).toBe(false);
    expect(await privilegios(db, "anon")).toContain("SELECT");
    const nomes = (await policies(db)).map((p) => p.polname);
    expect(nomes).not.toContain("_migrations_deny_public_roles");

    const linhas = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public._migrations");
    expect(linhas.rows[0].n).toBe(77);
  });
});

describe("reexecução", () => {
  it("aplicar a 077 duas vezes não parte nada", async () => {
    // O runner real não a reexecuta (ALREADY_APPLIED, testado na P0G), mas um
    // ambiente de ensaio pode. O `DROP POLICY IF EXISTS` existe para isto.
    await aplicarComoRunner(db);
    await db.exec("BEGIN");
    await db.exec(SQL_077);
    await db.exec("COMMIT");

    expect((await estadoRls(db)).relrowsecurity).toBe(true);
    expect(await privilegios(db, "anon")).toEqual([]);
    const nova = (await policies(db)).filter((p) => p.polname === "_migrations_deny_public_roles");
    expect(nova).toHaveLength(1);
  });
});

describe("ambiente sem os roles do Supabase", () => {
  it("a migration não rebenta se anon/authenticated não existirem", async () => {
    // Uma base descartável não tem os roles do Supabase. Revogar de um role
    // inexistente abortaria a transação inteira.
    const limpo = new PGlite();
    await limpo.exec(`
      CREATE TABLE public._migrations (
        name text PRIMARY KEY, checksum text,
        applied_at timestamptz NOT NULL DEFAULT now());
    `);
    await expect(limpo.exec(SQL_077)).resolves.not.toThrow();

    const r = await limpo.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname='_migrations'`,
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
  });

  it("sem a tabela, a migration recusa em vez de continuar às cegas", async () => {
    const vazio = new PGlite();
    await expect(vazio.exec(SQL_077)).rejects.toThrow(/não existe/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE E — guarda estática sobre o próprio SQL
// ═══════════════════════════════════════════════════════════════════════════

describe("a 077 não muta dados", () => {
  /** SQL executável, sem comentários — a guarda mede o código, não o texto. */
  const executavel = SQL_077
    .replace(/^\s*--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("nenhuma mutação de dados nem alteração destrutiva de schema", () => {
    for (const proibido of [
      /\bUPDATE\s+public\._migrations/i,
      /\bDELETE\s+FROM/i,
      /\bTRUNCATE\b/i,
      /\bINSERT\s+INTO/i,
      /\bDROP\s+TABLE\b/i,
      /\bALTER\s+TABLE\s+\S+\s+DROP\b/i,
      /\bALTER\s+COLUMN\b/i,
    ]) {
      expect(executavel, `SQL proibido: ${proibido}`).not.toMatch(proibido);
    }
  });

  it("só apaga a policy que ela própria cria", () => {
    const drops = [...executavel.matchAll(/DROP\s+POLICY[^;]*/gi)].map((m) => m[0]);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(/_migrations_deny_public_roles/);
    expect(drops[0]).toMatch(/IF\s+EXISTS/i);
  });

  it("não usa FORCE ROW LEVEL SECURITY", () => {
    expect(executavel).not.toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it("não revoga service_role", () => {
    expect(executavel).not.toMatch(/REVOKE[^;]*service_role/i);
  });

  it("revoga PUBLIC explicitamente", () => {
    // Um privilégio de PUBLIC aplica-se a todos os roles e não aparece na
    // lista de nenhum em particular.
    expect(executavel).toMatch(/REVOKE\s+ALL\s+ON\s+TABLE\s+public\._migrations\s+FROM\s+PUBLIC/i);
  });

  it("a guarda não se deixa enganar pelos comentários", () => {
    // O cabeçalho fala de DELETE e TRUNCATE ao descrever o problema.
    expect(SQL_077).toMatch(/TRUNCATE/);
    expect(executavel).not.toMatch(/\bTRUNCATE\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE F — o runner da P0G contra os ficheiros e a política REAIS
// ═══════════════════════════════════════════════════════════════════════════
//
// O ensaio acima prova o SQL. Este prova o **caminho**: que o runner desta
// árvore, com a política versionada desta árvore, escolhe a 077 e não toca na
// 070. É a junção das duas frentes — sem ele, cada metade estaria provada e o
// conjunto não.
//
// Cliente Postgres falso: nunca liga a nada, grava tudo o que receberia.

import { runMigrations as runMigrationsUntyped } from "../../scripts/lib/migration-runner-core.mjs";
import { checksumForNewMigration } from "../../scripts/lib/migration-checksum.mjs";

const runMigrations = runMigrationsUntyped as unknown as (opts: Record<string, unknown>) =>
  Promise<{ exitCode: number; targetState?: string }>;

const MIGRACOES_REAIS = path.join(RAIZ, "supabase", "migrations");
const POLITICA_REAL = JSON.parse(
  fs.readFileSync(path.join(RAIZ, "supabase", "migration-policy.json"), "utf8"),
);

const M070 = "070_guard_profile_managed_fields.sql";

class ClienteFalso {
  queries: Array<{ sql: string; params?: unknown }> = [];
  constructor(private aplicadas: Array<{ name: string; checksum: string }>) {}
  async query(sql: string, params?: unknown) {
    this.queries.push({ sql, params });
    if (sql.includes("to_regclass")) return { rows: [{ reg: "public._migrations" }] };
    if (sql.includes("information_schema.columns")) return { rows: [{ um: 1 }] };
    if (sql.includes("FROM public._migrations")) return { rows: this.aplicadas };
    if (sql.includes("FROM public.companies")) return { rows: [{ n: 1 }] };
    return { rows: [] };
  }
  /** SQL de migrations que este run enviaria para a base. */
  sqlEnviado(ficheiro: string) {
    const corpo = fs.readFileSync(path.join(MIGRACOES_REAIS, ficheiro), "utf8");
    return this.queries.filter((q) => q.sql === corpo).length;
  }
  get mutacoes() {
    return this.queries.filter((q) =>
      /^(CREATE|ALTER|INSERT|UPDATE|DELETE|BEGIN|COMMIT|DROP|REVOKE|GRANT)/i.test(q.sql.trim()));
  }
}

/** Ledger real: tudo aplicado menos a 070 e a 077 — o estado da produção. */
function ledgerRealista() {
  return fs.readdirSync(MIGRACOES_REAIS)
    .filter((f) => f.endsWith(".sql") && f !== M070 && f !== FICHEIRO)
    .map((f) => ({
      name: f,
      checksum: checksumForNewMigration(fs.readFileSync(path.join(MIGRACOES_REAIS, f), "utf8")),
    }));
}

const correrRunner = (cliente: ClienteFalso, opts: Record<string, unknown>) =>
  runMigrations({
    client: cliente,
    migrationsDir: MIGRACOES_REAIS,
    rootDir: RAIZ,
    apply: false,
    knownChecksumExceptions: POLITICA_REAL.knownChecksumExceptions ?? [],
    blockedMigrations: POLITICA_REAL.blockedMigrations ?? [],
    log: () => {}, logWarn: () => {}, logError: () => {},
    ...opts,
  });

describe("o caminho até à 077, com o runner e a política reais", () => {
  it("a política versionada tem mesmo a 070 bloqueada e a 077 livre", () => {
    const bloqueadas = (POLITICA_REAL.blockedMigrations ?? []).map((b: { migration: string }) => b.migration);
    expect(bloqueadas).toContain(M070);
    expect(bloqueadas).not.toContain(FICHEIRO);
  });

  it("dry-run com --only: 070 BLOCKED_PENDING, 077 alvo, ZERO escritas", async () => {
    const c = new ClienteFalso(ledgerRealista());
    const linhas: string[] = [];

    const r = await correrRunner(c, {
      apply: false, only: FICHEIRO, log: (m: string) => linhas.push(m),
    });

    expect(r.exitCode).toBe(0);
    const texto = linhas.join("\n");
    expect(texto).toMatch(/BLOCKED_PENDING/);
    expect(texto).toContain(M070);
    expect(texto).toMatch(new RegExp(`aplicaria: ${FICHEIRO}`));
    expect(c.mutacoes).toEqual([]);
  });

  it("🔴 --apply --only 077: a 070 nunca é enviada", async () => {
    const c = new ClienteFalso(ledgerRealista());

    const r = await correrRunner(c, { apply: true, only: FICHEIRO });

    expect(r.exitCode).toBe(0);
    expect(c.sqlEnviado(FICHEIRO)).toBe(1);
    expect(c.sqlEnviado(M070)).toBe(0);
  });

  it("🔴 até um --apply normal deixa a 070 de fora", async () => {
    // As duas estão ausentes do ledger; sem a P0G, a 070 corria primeiro.
    const c = new ClienteFalso(ledgerRealista());

    await correrRunner(c, { apply: true });

    expect(c.sqlEnviado(FICHEIRO)).toBe(1);
    expect(c.sqlEnviado(M070)).toBe(0);
  });

  it("SECOND_RUN_IDEMPOTENT — a segunda execução não escreve nada", async () => {
    const ledger = ledgerRealista();
    ledger.push({
      name: FICHEIRO,
      checksum: checksumForNewMigration(SQL_077),
    });
    const c = new ClienteFalso(ledger);

    const r = await correrRunner(c, { apply: true, only: FICHEIRO });

    expect(r.targetState).toBe("ALREADY_APPLIED");
    expect(c.queries.some((q) => q.sql.startsWith("BEGIN"))).toBe(false);
    expect(c.sqlEnviado(FICHEIRO)).toBe(0);
  });

  it("--only sobre a 070 é recusado antes de qualquer escrita", async () => {
    const c = new ClienteFalso(ledgerRealista());

    const r = await correrRunner(c, { apply: true, only: M070 });

    expect(r.exitCode).toBe(1);
    expect(c.queries.some((q) => q.sql.startsWith("BEGIN"))).toBe(false);
  });
});
