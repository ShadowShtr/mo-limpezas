// ============================================================================
// NÚCLEO DO RUNNER DE MIGRAÇÕES — testável com um cliente Postgres falso
// ============================================================================
// Toda a lógica que decide QUE queries correm contra a base vive aqui,
// isolada do parsing de CLI e da criação do cliente `pg` real
// (scripts/run-migrations.mjs é só o wrapper fino que liga tudo). Isto
// permite testar o fluxo inteiro — incluindo "que queries o runner tentaria
// correr" — com um cliente falso que só grava o que recebe, nunca ligando a
// uma base real. Ver src/__tests__/migration-runner-core.test.ts.
//
// Origem (2026-08-05, revisão pós-incidente da PR #32): a versão anterior
// chamava incondicionalmente `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE...
// ADD COLUMN` (ensureTracking) e podia fazer `UPDATE` de backfill de
// checksum, tudo ANTES de qualquer verificação de `--dry-run` — ou seja, o
// "dry-run" escrevia. Aqui, cada operação que MUTA a base está gated
// explicitamente por `apply`, não por uma flag de leitura calculada fora
// deste módulo — defesa em profundidade: mesmo que quem chama se engane
// nos argumentos, este núcleo nunca escreve sem `apply === true`.
// ============================================================================

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  historicalChecksumMatches,
  checksumForNewMigration,
  assertNoDuplicateExceptions,
  findKnownException,
  knownExceptionMatches,
} from "./migration-checksum.mjs";

/** SELECT puro — nunca CREATE. */
export async function tableExists(client, schemaDotTable) {
  const { rows } = await client.query("SELECT to_regclass($1) AS reg", [schemaDotTable]);
  return rows[0].reg !== null;
}

/** SELECT puro — nunca ALTER. */
export async function columnExists(client, schema, table, column) {
  const { rows } = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
    [schema, table, column],
  );
  return rows.length > 0;
}

/** CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN — só chamar quando apply === true. */
export async function ensureTracking(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query("ALTER TABLE public._migrations ADD COLUMN IF NOT EXISTS checksum text");
}

/** SELECT puro. Se a tabela/coluna ainda não existem, devolve o que der para ler sem inventar nada. */
export async function readAppliedMap(client, hasTable, hasChecksumCol) {
  if (!hasTable) return new Map();
  if (hasChecksumCol) {
    const { rows } = await client.query("SELECT name, checksum FROM public._migrations");
    return new Map(rows.map((r) => [r.name, r.checksum]));
  }
  const { rows } = await client.query("SELECT name FROM public._migrations");
  return new Map(rows.map((r) => [r.name, null]));
}

/** SELECT puro, com fallback seguro se a tabela nem existir. */
export async function dbHasData(client) {
  try {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM public.companies");
    return rows[0].n > 0;
  } catch {
    return false;
  }
}

/**
 * Uma migração já aplicada NUNCA pode mudar de conteúdo — ver o mesmo
 * comentário histórico em scripts/run-migrations.mjs sobre checksums
 * RAW/LF/CRLF e a exceção nomeada da 022
 * (docs/atomicidade-audit/migration-checksum-map-2026-08-05.md). Só
 * inspeciona ficheiros locais — nenhuma query.
 */
export function verifyChecksums(applied, files, migrationsDir, knownChecksumExceptions) {
  const divergent = [];
  const accepted = [];
  for (const file of files) {
    const stored = applied.get(file);
    if (stored == null) continue;
    const current = readFileSync(join(migrationsDir, file), "utf8");
    if (historicalChecksumMatches(stored, current)) continue;

    const exception = findKnownException(knownChecksumExceptions, file);
    if (knownExceptionMatches(exception, stored, current)) {
      accepted.push({ file, reason: exception.reason });
      continue;
    }
    divergent.push(file);
  }
  return { divergent, accepted };
}

/**
 * Orquestra o runner inteiro contra um `client` injetado (real ou falso).
 * Nunca chama `process.exit` — devolve `{ exitCode }` para quem chamar
 * decidir o que fazer (o wrapper CLI sai com esse código; os testes só
 * inspecionam o valor e as queries capturadas pelo cliente falso).
 *
 * `log`/`logWarn`/`logError` são injetáveis para os testes conseguirem
 * capturar mensagens sem depender de stdout real.
 */
export async function runMigrations({
  client,
  migrationsDir,
  rootDir,
  apply,
  baseline = false,
  seed = false,
  knownChecksumExceptions = [],
  log = console.log,
  logWarn = console.warn,
  logError = console.error,
}) {
  assertNoDuplicateExceptions(knownChecksumExceptions);

  // ── Leitura de estado — sempre SELECT, em qualquer modo. ──────────────
  const hasTable = await tableExists(client, "public._migrations");
  const hasChecksumCol = hasTable ? await columnExists(client, "public", "_migrations", "checksum") : false;

  // ── Única secção que pode CREATE/ALTER — gated por apply, não por uma
  //    flag "dry-run" calculada fora deste módulo. ──────────────────────
  if (apply) {
    await ensureTracking(client);
  } else if (!hasTable) {
    log("(dry-run) tabela public._migrations não existe — seria criada por --apply");
  } else if (!hasChecksumCol) {
    log("(dry-run) coluna checksum não existe em public._migrations — seria adicionada por --apply");
  }

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  // Depois de `apply`, a tabela/coluna passaram a existir (ensureTracking);
  // em dry-run, lê exatamente o que já lá está.
  const effectiveHasTable = apply || hasTable;
  const effectiveHasChecksumCol = apply || hasChecksumCol;
  const applied = await readAppliedMap(client, effectiveHasTable, effectiveHasChecksumCol);

  // ── Backfill de checksum — só UPDATE quando apply === true. ────────────
  const toBackfill = [...applied.entries()].filter(([name, sum]) => sum == null && files.includes(name));
  if (apply) {
    for (const [name] of toBackfill) {
      const cs = checksumForNewMigration(readFileSync(join(migrationsDir, name), "utf8"));
      await client.query("UPDATE public._migrations SET checksum = $1 WHERE name = $2 AND checksum IS NULL", [cs, name]);
      applied.set(name, cs);
      log(`🔏 checksum backfill: ${name}`);
    }
  } else if (toBackfill.length > 0) {
    log(`(would-backfill) ${toBackfill.length} registo(s) sem checksum: ${toBackfill.map(([n]) => n).join(", ")}`);
  }

  // Migração já aplicada cujo ficheiro mudou → parar SEMPRE (nada de silêncio).
  const { divergent, accepted } = verifyChecksums(applied, files, migrationsDir, knownChecksumExceptions);
  for (const { file, reason } of accepted) {
    logWarn("⚠ CHECKSUM EXCEPTION ACEITE:");
    logWarn(`   ${file}`);
    logWarn(`   Motivo: ${reason}`);
  }
  if (divergent.length > 0) {
    logError("❌ CHECKSUM DIVERGENTE — estes ficheiros de migração foram ALTERADOS depois de aplicados:");
    for (const f of divergent) logError(`   - ${f}`);
    logError("   A base pode não corresponder ao que o repo diz. Reverte a alteração ao ficheiro,");
    logError("   ou cria uma migração NOVA com a correção (nunca editar migrações históricas).");
    return { exitCode: 1 };
  }

  // Guarda: base com schema mas sem histórico de migrações → exigir baseline.
  // dbHasData() é sempre SELECT — seguro correr em qualquer modo.
  if (!baseline && applied.size === 0 && (await dbHasData(client))) {
    logError("❌ Esta base já tem dados mas a tabela _migrations está vazia.");
    logError("   Corre primeiro:  node scripts/run-migrations.mjs --baseline --apply --confirm-production <project-ref>");
    logError("   (marca as migrações existentes como aplicadas SEM as re-executar — evita re-aplicar UPDATEs/DELETEs sobre dados reais)");
    return { exitCode: 1 };
  }

  if (baseline) {
    const toBaseline = files.filter((f) => !applied.has(f));
    if (apply) {
      log(`📋 ${toBaseline.length} migração(ões) a marcar como aplicada(s) (baseline, sem executar): ${toBaseline.join(", ") || "(nenhuma)"}`);
      for (const f of files) {
        if (!applied.has(f)) {
          const sum = checksumForNewMigration(readFileSync(join(migrationsDir, f), "utf8"));
          await client.query(
            "INSERT INTO public._migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum",
            [f, sum],
          );
          log(`📌 baseline: ${f}`);
        }
      }
      log("✅ Baseline concluído — nada foi executado, tudo marcado como aplicado (com checksum).");
    } else {
      // Defesa em profundidade: mesmo que --baseline chegasse aqui sem
      // --apply (a CLI já bloqueia isto antes, ver migration-runner-guards.mjs),
      // este núcleo nunca escreve fora de apply === true.
      log(`(dry-run) --baseline marcaria ${toBaseline.length} migração(ões) como aplicada(s), sem executar: ${toBaseline.join(", ") || "(nenhuma)"}`);
    }
    return { exitCode: 0 };
  }

  const pending = files.filter((f) => !applied.has(f));
  log(`📋 ${pending.length} migração(ões) pendente(s)${pending.length > 0 ? ": " + pending.join(", ") : ""}`);
  if (pending.length === 0) log("✅ Nenhuma migração pendente.");
  for (const file of pending) {
    if (!apply) { log(`(dry-run) aplicaria: ${file}`); continue; }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    log(`📦 ${file}...`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)", [file, checksumForNewMigration(sql)]);
      await client.query("COMMIT");
      log("   ✅ OK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logError(`   ❌ ERRO em ${file}: ${err.message}`);
      logError("   Migração revertida (transação). Corrige o .sql e volta a correr — nada ficou a meio.");
      return { exitCode: 1 };
    }
  }

  if (seed) {
    if (await dbHasData(client)) {
      logError("❌ --seed recusado: a base já tem dados (companies > 0). O seed é APENAS para bases de desenvolvimento vazias.");
      return { exitCode: 1 };
    }
    if (apply) {
      log("🌱 seed.sql (base vazia confirmada)...");
      await client.query(readFileSync(join(rootDir, "supabase", "seed.sql"), "utf8"));
      log("✅ Seed aplicado.");
    } else {
      log("(dry-run) seed.sql seria aplicado (base vazia confirmada)");
    }
  }

  log("🎉 Concluído.");
  return { exitCode: 0 };
}
