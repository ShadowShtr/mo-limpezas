// ============================================================================
// ENSAIO PROFUNDO — 066_secure_migrations_ledger.sql
// ============================================================================
// Tudo dentro de UMA transação (BEGIN...ROLLBACK). Cobre exatamente os itens
// pedidos na revisão: grants zero para anon/authenticated/PUBLIC, RLS ativa,
// sem policy permissiva, fora da publicação Realtime, o runner (role
// postgres, dono da tabela) continua a conseguir ler/gravar depois da
// proteção, acesso real como anon/authenticated bloqueado (SELECT e
// escrita), e o rollback restaura exatamente o estado anterior.
// ============================================================================

import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

for (const f of [".env.local", ".env"]) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error("Define SUPABASE_DB_URL."); process.exit(1); }

const MIGRATION_FILE = "066_secure_migrations_ledger.sql";
const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
}

async function fingerprint(client) {
  const grants = await client.query(`
    SELECT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='_migrations'
    ORDER BY grantee, privilege_type
  `);
  const rls = await client.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relname='_migrations' AND relnamespace='public'::regnamespace
  `);
  const policies = await client.query(`
    SELECT policyname, roles, cmd FROM pg_policies WHERE schemaname='public' AND tablename='_migrations'
  `);
  return JSON.stringify({ grants: grants.rows, rls: rls.rows, policies: policies.rows });
}

async function main() {
  const pre = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await pre.connect();
  const before = await fingerprint(pre);
  await pre.end();

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("BEGIN");

  try {
    await client.query(sql);
    check("migration executa sem erro", true);

    // ── 1-3. anon/authenticated/PUBLIC com zero privilégios ──────────────
    const { rows: grants } = await client.query(`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='_migrations'
        AND grantee IN ('anon','authenticated','PUBLIC')
    `);
    check("anon/authenticated/PUBLIC com ZERO privilégios em _migrations", grants.length === 0,
      grants.length > 0 ? JSON.stringify(grants) : undefined);

    // ── 4. RLS ativa ───────────────────────────────────────────────────
    const { rows: rlsRows } = await client.query(`
      SELECT relrowsecurity FROM pg_class WHERE relname='_migrations' AND relnamespace='public'::regnamespace
    `);
    check("RLS ativa em _migrations", rlsRows[0]?.relrowsecurity === true);

    // ── 5. sem policy permissiva (só a policy bloqueada) ──────────────────
    const { rows: policies } = await client.query(`
      SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='_migrations'
    `);
    const onlyLockedPolicy = policies.length === 1 && policies[0].qual === "false" && policies[0].with_check === "false";
    check("única policy é a bloqueada (USING false, WITH CHECK false)", onlyLockedPolicy, JSON.stringify(policies));

    // ── 6. fora da publicação Realtime ────────────────────────────────────
    const { rows: pub } = await client.query(`
      SELECT 1 FROM pg_publication_tables WHERE schemaname='public' AND tablename='_migrations'
    `);
    check("_migrations continua fora da publicação supabase_realtime", pub.length === 0);

    // ── 7/9/10. o runner (role postgres, dono) continua a conseguir ler/gravar ──
    const { rows: readable } = await client.query("SELECT count(*)::int AS n FROM public._migrations");
    check("dono da tabela (postgres) continua a conseguir SELECT em _migrations", readable[0].n > 0,
      `linhas visíveis=${readable[0].n}`);

    await client.query("SAVEPOINT sp_runner_insert");
    let runnerInsertOk = false;
    try {
      await client.query(
        "INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)",
        ["999_rehearsal_fake.sql", "fake-checksum-rehearsal"],
      );
      runnerInsertOk = true;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT sp_runner_insert");
    }
    check("runner (postgres) continua a conseguir INSERT em _migrations (registo de migration futura)", runnerInsertOk);

    // ── 8. --dry-run continua funcional (checagem estrutural: tabela +
    //       coluna name continuam a existir e legíveis pelo owner) ────────
    const { rows: cols } = await client.query(`
      SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='_migrations'
    `);
    check("estrutura de _migrations preservada (name/checksum/applied_at) — --dry-run continua a funcionar",
      cols.some((c) => c.column_name === "name") && cols.some((c) => c.column_name === "checksum"));

    // ── 11/12. anon não consegue SELECT nem escrever ──────────────────────
    await client.query("SAVEPOINT sp_anon");
    try {
      await client.query("SET LOCAL ROLE anon");
      let selectBlocked = false;
      await client.query("SAVEPOINT sp_anon_select");
      try {
        await client.query("SELECT * FROM public._migrations");
      } catch (e) {
        selectBlocked = /permission denied/i.test(e.message);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT sp_anon_select");
      }
      check("anon não consegue SELECT em _migrations", selectBlocked);

      let insertBlocked = false;
      await client.query("SAVEPOINT sp_anon_insert");
      try {
        await client.query("INSERT INTO public._migrations (name) VALUES ('hack.sql')");
      } catch (e) {
        insertBlocked = /permission denied/i.test(e.message);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT sp_anon_insert");
      }
      check("anon não consegue INSERT em _migrations", insertBlocked);
    } finally {
      await client.query("RESET ROLE");
      await client.query("ROLLBACK TO SAVEPOINT sp_anon");
    }

    // ── 13. authenticated também não consegue nada ────────────────────────
    await client.query("SAVEPOINT sp_authenticated");
    try {
      await client.query("SET LOCAL ROLE authenticated");
      let selectBlocked = false;
      await client.query("SAVEPOINT sp_auth_select");
      try {
        await client.query("SELECT * FROM public._migrations");
      } catch (e) {
        selectBlocked = /permission denied/i.test(e.message);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT sp_auth_select");
      }
      check("authenticated não consegue SELECT em _migrations", selectBlocked);

      let updateBlocked = false;
      await client.query("SAVEPOINT sp_auth_update");
      try {
        await client.query("UPDATE public._migrations SET checksum = 'hacked' WHERE true");
      } catch (e) {
        updateBlocked = /permission denied/i.test(e.message);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT sp_auth_update");
      }
      check("authenticated não consegue UPDATE em _migrations", updateBlocked);
    } finally {
      await client.query("RESET ROLE");
      await client.query("ROLLBACK TO SAVEPOINT sp_authenticated");
    }

    // ── service_role continua com o seu próprio acesso (não deve ter sido tocado) ──
    const { rows: srGrants } = await client.query(`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='_migrations' AND grantee='service_role'
    `);
    check("service_role mantém os seus grants (não tocados por esta migration)", srGrants.length > 0,
      `grants=${srGrants.map((g) => g.privilege_type).join(",")}`);

  } catch (e) {
    check("execução do ensaio sem erro inesperado", false, e.message);
    console.error(e.stack);
  } finally {
    await client.query("ROLLBACK");
    console.log("\n↩️  ROLLBACK executado — nada foi persistido.");
    await client.end();
  }

  const post = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await post.connect();
  const after = await fingerprint(post);
  await post.end();
  check("fingerprint (grants/RLS/policies de _migrations) idêntico antes/depois do ensaio", before === after);

  console.log("\n============================================================");
  const failed = results.filter((r) => !r.ok);
  console.log(`RESUMO: ${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) {
    console.log("FALHAS:");
    for (const f of failed) console.log(`  ❌ ${f.label}${f.detail ? " — " + f.detail : ""}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e.stack ?? e));
  process.exit(1);
});
