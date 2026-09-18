#!/usr/bin/env node
// ============================================================================
// O ledger de produção, em leitura — para escolher um número de migration
// ============================================================================
//
// 🔴 Porque é que um número de migration não se escolhe pelo nome da branch.
//
//    A branch chama-se `hardening/102-...`, e isso não é prova de nada: diz
//    o que alguém pretendia, não o que a base já tem. Escolher por aí é como
//    numerar um cheque pela data que apetece.
//
//    A tabela canónica deste projeto é `public._migrations`.
//    `supabase_migrations.schema_migrations` existe e MENTE — tem um punhado
//    de linhas contra as dezenas reais, porque as migrations aplicadas pelo
//    SQL Editor nunca lá passaram. Este script lê a canónica, e imprime a
//    outra ao lado para a diferença ficar à vista em vez de ser folclore.
//
// Só leitura, dentro de `BEGIN READ ONLY`. `--project-ref` obrigatório.
//
//   node scripts/read-production-migration-ledger.mjs --project-ref <ref>
// ============================================================================

import pg from "pg";

import { loadEnvFile } from "./lib/admin-db.mjs";

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const igual = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return igual ? igual.slice(nome.length + 3) : null;
}

async function main() {
  const refEsperado = arg("project-ref");
  if (!refEsperado) {
    console.error("Falta --project-ref <ref>.");
    process.exit(2);
  }
  const url = loadEnvFile().SUPABASE_DB_URL;
  if (!url) { console.error("SUPABASE_DB_URL não está em .env.local."); process.exit(2); }
  if (!url.includes(refEsperado)) {
    console.error(`A SUPABASE_DB_URL não menciona "${refEsperado}". Não vou adivinhar.`);
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");

    const total = await client.query("SELECT count(*)::int AS n FROM public._migrations");
    const ultimas = await client.query(
      "SELECT name, applied_at FROM public._migrations ORDER BY applied_at DESC, name DESC LIMIT 12",
    );
    // O maior número já ocupado, lido do NOME e não da ordem de aplicação:
    // as migrations foram aplicadas fora de ordem mais do que uma vez.
    const maior = await client.query(`
      SELECT name,
             (regexp_match(name, '^([0-9]+)'))[1]::int AS numero
      FROM public._migrations
      WHERE name ~ '^[0-9]+'
      ORDER BY numero DESC, name DESC
      LIMIT 5
    `);

    let outra = null;
    try {
      outra = (await client.query(
        "SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations",
      )).rows[0].n;
    } catch { outra = "(inacessível)"; }

    await client.query("ROLLBACK");

    console.log(`public._migrations ............... ${total.rows[0].n} linhas`);
    console.log(`supabase_migrations.schema_migrations  ${outra} linhas  ← não é a canónica`);
    console.log("");
    console.log("maiores números já ocupados:");
    for (const r of maior.rows) console.log(`   ${String(r.numero).padStart(4)}  ${r.name}`);
    console.log("");
    console.log("últimas aplicadas:");
    for (const r of ultimas.rows) {
      console.log(`   ${new Date(r.applied_at).toISOString().slice(0, 10)}  ${r.name}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(2); });
