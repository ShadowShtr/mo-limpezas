// ============================================================================
// ENSAIO PROFUNDO — 066_outbox_foundation.sql
// ============================================================================
// Tudo dentro de UMA transação (BEGIN...ROLLBACK), incluindo:
//   - aplicar a migration;
//   - verificação estrutural (tabelas, colunas, constraints, grants,
//     policies, publicação);
//   - teste EMPÍRICO de isolamento por empresa: cria 2 empresas sintéticas,
//     2 utilizadores sintéticos, grava um evento por empresa, e confirma —
//     como a role `authenticated` realmente veria, via RLS — que uma nunca
//     vê o evento da outra, e que `anon` não vê nada;
//   - teste de idempotência (replay do mesmo mutation_id) e de conflito
//     (mesmo mutation_id, request_hash diferente);
//   - teste dos CHECK constraints (operation, affected_from/to).
// NUNCA faz COMMIT. Ao fim, confirma numa ligação separada que o fingerprint
// (grants) voltou exatamente ao estado anterior.
// ============================================================================

import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

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

const MIGRATION_FILE = "066_outbox_foundation.sql";
const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
}

async function tableGrantSnapshot(client) {
  const { rows } = await client.query(`
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('domain_mutations', 'company_change_events', 'company_sync_state')
      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    ORDER BY table_name, grantee, privilege_type
  `);
  return JSON.stringify(rows);
}

async function main() {
  const pre = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await pre.connect();
  const before = await tableGrantSnapshot(pre);
  await pre.end();

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("BEGIN");

  const companyA = randomUUID();
  const companyB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const mutationA1 = randomUUID();
  const mutationB1 = randomUUID();

  try {
    // ── aplicar a migration ──────────────────────────────────────────────
    await client.query(sql);
    check("migration executa sem erro", true);

    // ── 1. RLS ativa em company_change_events ────────────────────────────
    {
      const { rows } = await client.query(`
        SELECT relrowsecurity FROM pg_class
        WHERE relname = 'company_change_events' AND relnamespace = 'public'::regnamespace
      `);
      check("company_change_events tem RLS ativa", rows[0]?.relrowsecurity === true);
    }

    // ── 2. anon sem nenhum privilégio ─────────────────────────────────────
    {
      const { rows } = await client.query(`
        SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='public' AND grantee='anon'
          AND table_name IN ('domain_mutations','company_change_events','company_sync_state')
      `);
      check("anon sem SELECT/INSERT/UPDATE/DELETE/TRUNCATE nas 3 tabelas", rows.length === 0,
        rows.length > 0 ? JSON.stringify(rows) : undefined);
    }

    // ── 3. authenticated só com o estritamente necessário ─────────────────
    {
      const { rows } = await client.query(`
        SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='public' AND grantee='authenticated'
          AND table_name IN ('domain_mutations','company_change_events','company_sync_state')
        ORDER BY table_name, privilege_type
      `);
      const onlySelectOnEvents = rows.length === 1 && rows[0].table_name === "company_change_events" && rows[0].privilege_type === "SELECT";
      check("authenticated tem exatamente SELECT em company_change_events e nada mais", onlySelectOnEvents,
        JSON.stringify(rows));
    }

    // ── 4/5. next_company_sequence: unicidade + correção sequencial ──────
    {
      const companyC = randomUUID();
      await client.query("INSERT INTO public.companies (id, name, slug) VALUES ($1, 'Teste C', $2)", [companyC, "teste-c-" + companyC.slice(0, 8)]);
      const s1 = await client.query("SELECT public.next_company_sequence($1) AS s", [companyC]);
      const s2 = await client.query("SELECT public.next_company_sequence($1) AS s", [companyC]);
      const s3 = await client.query("SELECT public.next_company_sequence($1) AS s", [companyC]);
      const seqs = [s1.rows[0].s, s2.rows[0].s, s3.rows[0].s].map(String);
      check("next_company_sequence devolve 1,2,3 em chamadas sucessivas (sem saltos/repetição)",
        seqs.join(",") === "1,2,3", seqs.join(","));

      const { rows: fnDef } = await client.query(`
        SELECT prosrc FROM pg_proc WHERE proname = 'next_company_sequence' AND pronamespace = 'public'::regnamespace
      `);
      const usesForUpdate = /FOR UPDATE/i.test(fnDef[0]?.prosrc ?? "");
      check("next_company_sequence usa SELECT ... FOR UPDATE (lock de linha — serializa concorrência na mesma empresa sem bloquear empresas diferentes)",
        usesForUpdate);
    }

    // ── 6. UNIQUE (company_id, sequence) existe ───────────────────────────
    {
      const { rows } = await client.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.company_change_events'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE '%company_id, sequence%'
      `);
      check("UNIQUE (company_id, sequence) existe em company_change_events", rows.length === 1);
    }

    // ── setup para testes de isolamento: 2 empresas + 2 utilizadores ──────
    await client.query("INSERT INTO public.companies (id, name, slug) VALUES ($1,'Teste A',$2),($3,'Teste B',$4)",
      [companyA, "teste-a-" + companyA.slice(0, 8), companyB, "teste-b-" + companyB.slice(0, 8)]);
    await client.query(`
      INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, aud, role, raw_app_meta_data, raw_user_meta_data)
      VALUES
        ($1, 'rehearsal-a@example.invalid', 'x', now(), now(), now(), 'authenticated', 'authenticated', '{}', '{}'),
        ($2, 'rehearsal-b@example.invalid', 'x', now(), now(), now(), 'authenticated', 'authenticated', '{}', '{}')
    `, [userA, userB]);
    await client.query(`
      INSERT INTO public.profiles (id, company_id, full_name, role)
      VALUES ($1, $2, 'Rehearsal A', 'gestor'), ($3, $4, 'Rehearsal B', 'gestor')
    `, [userA, companyA, userB, companyB]);

    // ── 6b. record_company_change_event adquire o lock ANTES do SELECT ────
    // (corrida encontrada em revisão: sem isto, duas chamadas concorrentes
    // com o mesmo mutation_id podiam ambas passar o SELECT sem encontrar
    // nada e uma delas falhar com violação de unicidade em vez de devolver
    // o evento idempotente).
    {
      const { rows: fnDef } = await client.query(`
        SELECT prosrc FROM pg_proc WHERE proname = 'record_company_change_event' AND pronamespace = 'public'::regnamespace
      `);
      const src = fnDef[0]?.prosrc ?? "";
      const lockPos = src.indexOf("lock_domain_mutation");
      const selectPos = src.search(/SELECT \* INTO v_event/i);
      check("record_company_change_event chama lock_domain_mutation ANTES do SELECT que verifica idempotência",
        lockPos >= 0 && selectPos >= 0 && lockPos < selectPos,
        `lockPos=${lockPos} selectPos=${selectPos}`);
    }

    // ── 7. record_company_change_event é append-only ──────────────────────
    const ev1 = await client.query(
      `SELECT public.record_company_change_event($1,$2,'test','rehearsal_event',ARRAY[]::uuid[],ARRAY['teste']::text[],NULL,NULL,'{"n":1}'::jsonb) AS r`,
      [companyA, mutationA1],
    );
    const replay = await client.query(
      `SELECT public.record_company_change_event($1,$2,'test','rehearsal_event',ARRAY[]::uuid[],ARRAY['teste']::text[],NULL,NULL,'{"n":999}'::jsonb) AS r`,
      [companyA, mutationA1],
    );
    const originalPayload = ev1.rows[0].r.payload;
    const replayPayload = replay.rows[0].r.payload;
    check("replay do mesmo mutation_id devolve o evento ORIGINAL sem alterar payload (append-only, nunca UPDATE)",
      JSON.stringify(originalPayload) === '{"n":1}' && JSON.stringify(replayPayload) === '{"n":1}',
      `original=${JSON.stringify(originalPayload)} replay=${JSON.stringify(replayPayload)}`);

    const { rows: countA1 } = await client.query(
      "SELECT count(*)::int AS n FROM public.company_change_events WHERE company_id=$1 AND mutation_id=$2",
      [companyA, mutationA1],
    );
    check("replay não cria segunda linha", countA1[0].n === 1, `linhas=${countA1[0].n}`);

    await client.query(
      `SELECT public.record_company_change_event($1,$2,'test','rehearsal_event',ARRAY[]::uuid[],ARRAY['teste']::text[],NULL,NULL,'{"n":1}'::jsonb) AS r`,
      [companyB, mutationB1],
    );

    // ── 8. domain_mutations: idempotência + conflito de reutilização ──────
    {
      const reqHash1 = "hash-1";
      const mutId = randomUUID();
      const first = await client.query("SELECT public.find_or_conflict_domain_mutation($1,$2,'rehearsal_op',$3) AS r", [companyA, mutId, reqHash1]);
      check("find_or_conflict_domain_mutation devolve NULL na 1ª vez (mutation nova)", first.rows[0].r === null);

      await client.query(
        "SELECT public.complete_domain_mutation($1,$2,'test','rehearsal_op',NULL,$3,'succeeded','{\"ok\":true}'::jsonb) AS r",
        [companyA, mutId, reqHash1],
      );
      const replayOk = await client.query("SELECT public.find_or_conflict_domain_mutation($1,$2,'rehearsal_op',$3) AS r", [companyA, mutId, reqHash1]);
      check("replay com mesmo request_hash devolve o resultado gravado (idempotente)",
        JSON.stringify(replayOk.rows[0].r) === '{"ok":true}');

      const conflict = await client.query("SELECT public.find_or_conflict_domain_mutation($1,$2,'rehearsal_op','hash-DIFERENTE') AS r", [companyA, mutId]);
      check("mesmo mutation_id com request_hash diferente devolve MUTATION_REUSE_CONFLICT",
        conflict.rows[0].r?.code === "MUTATION_REUSE_CONFLICT", JSON.stringify(conflict.rows[0].r));
    }

    // ── 9. operation limitado por CHECK ────────────────────────────────────
    {
      let rejected = false;
      try {
        await client.query("SAVEPOINT sp_bad_operation");
        await client.query(
          "SELECT public.complete_domain_mutation($1,$2,'test','Operação Inválida com Espaços',NULL,'h','succeeded','{}'::jsonb)",
          [companyA, randomUUID()],
        );
      } catch (e) {
        rejected = /operation_format_check/i.test(e.message) || e.code === "23514";
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT sp_bad_operation");
      }
      check("operation fora do formato snake_case é rejeitado pelo CHECK", rejected);
    }

    // ── 10. affected_from/affected_to coerentes ────────────────────────────
    {
      let rejected = false;
      try {
        await client.query("SAVEPOINT sp_bad_range");
        await client.query(
          `SELECT public.record_company_change_event($1,$2,'test','bad_range',ARRAY[]::uuid[],ARRAY[]::text[],'2026-01-10'::date,'2026-01-01'::date,'{}'::jsonb)`,
          [companyA, randomUUID()],
        );
      } catch (e) {
        rejected = /affected_range_check/i.test(e.message) || e.code === "23514";
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT sp_bad_range");
      }
      check("affected_from > affected_to é rejeitado pelo CHECK", rejected);
    }

    // ── 11. Publicação Realtime ─────────────────────────────────────────
    {
      const { rows } = await client.query(`
        SELECT 1 FROM pg_publication_tables
        WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='company_change_events'
      `);
      check("company_change_events está na publicação supabase_realtime", rows.length === 1);
    }

    // ── 12. ISOLAMENTO EMPÍRICO — o teste mais importante ─────────────────
    // Simula exatamente o que o PostgREST/Realtime fazem: assume a role
    // `authenticated`, define request.jwt.claim.sub = id do utilizador, e
    // corre a query como esse utilizador correria — RLS aplica-se a sério.
    await client.query("SAVEPOINT sp_isolation");
    try {
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);
      const asA = await client.query("SELECT company_id FROM public.company_change_events ORDER BY company_id");
      const onlyOwnCompanyVisibleToA = asA.rows.length === 1 && asA.rows[0].company_id === companyA;
      check("como utilizador A (authenticated): só vê o evento da SUA empresa (nunca o de B)",
        onlyOwnCompanyVisibleToA, `linhas visíveis=${asA.rows.length}, company_ids=${asA.rows.map(r => r.company_id).join(",")}`);

      await client.query("RESET ROLE");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userB]);
      const asB = await client.query("SELECT company_id FROM public.company_change_events ORDER BY company_id");
      const onlyOwnCompanyVisibleToB = asB.rows.length === 1 && asB.rows[0].company_id === companyB;
      check("como utilizador B (authenticated): só vê o evento da SUA empresa (nunca o de A)",
        onlyOwnCompanyVisibleToB, `linhas visíveis=${asB.rows.length}, company_ids=${asB.rows.map(r => r.company_id).join(",")}`);

      await client.query("RESET ROLE");
      await client.query("SET LOCAL ROLE anon");
      let anonBlocked = false;
      await client.query("SAVEPOINT sp_anon_select");
      try {
        await client.query("SELECT * FROM public.company_change_events");
      } catch (e) {
        anonBlocked = /permission denied/i.test(e.message);
      } finally {
        // Erro esperado deixa a (sub)transação "aborted" até isto correr —
        // sem isto, RESET ROLE a seguir também falharia.
        await client.query("ROLLBACK TO SAVEPOINT sp_anon_select");
      }
      check("anon (sem sessão nenhuma) não consegue sequer executar SELECT — permission denied", anonBlocked);
    } finally {
      await client.query("RESET ROLE");
      await client.query("ROLLBACK TO SAVEPOINT sp_isolation");
    }

    // ── 13. domain_mutations continua ilegível/inescrevível por authenticated ──
    await client.query("SAVEPOINT sp_dm_auth");
    try {
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);
      let blocked = false;
      await client.query("SAVEPOINT sp_dm_select");
      try {
        await client.query("SELECT * FROM public.domain_mutations");
      } catch (e) {
        blocked = /permission denied/i.test(e.message);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT sp_dm_select");
      }
      check("authenticated não consegue SELECT em domain_mutations (permission denied)", blocked);
    } finally {
      await client.query("RESET ROLE");
      await client.query("ROLLBACK TO SAVEPOINT sp_dm_auth");
    }

  } catch (e) {
    check("execução do ensaio sem erro inesperado", false, e.message);
    console.error(e.stack);
  } finally {
    await client.query("ROLLBACK");
    console.log("\n↩️  ROLLBACK executado — nada foi persistido (incluindo companies/profiles/auth.users sintéticos).");
    await client.end();
  }

  const post = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await post.connect();
  const after = await tableGrantSnapshot(post);
  await post.end();
  const fingerprintOk = before === after;
  check("fingerprint de grants depois do ensaio é idêntico ao de antes", fingerprintOk);

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
