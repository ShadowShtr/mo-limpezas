#!/usr/bin/env node
// ============================================================================
// R0 — inspecção de reconciliação do ledger
// ============================================================================
//
//   node scripts/reconcile-migrations.mjs                 # relatório humano
//   node scripts/reconcile-migrations.mjs --json <ficheiro>
//
// 🔴 SÓ LEITURA. Não existe caminho de escrita neste ficheiro. `--apply` é
//    reconhecido apenas para **recusar** com `RECONCILIATION_WRITE_NOT_ENABLED`
//    — reconhecido, e não ignorado, porque um argumento silenciosamente
//    descartado deixa quem o escreveu convencido de que algo aconteceu.
//
// A escrita no ledger é a ronda **R1**, separada, e depende de revisão humana
// do manifesto que isto produz.
//
// ---------------------------------------------------------------------------
// Ligação
// ---------------------------------------------------------------------------
// Precisa de `SUPABASE_DB_URL`/`DATABASE_URL` (ligação Postgres directa, não
// PostgREST — o catálogo não é acessível por REST).
//
// Antes de correr, imprime **host, base de dados e utilizador** e exige
// confirmação por `--confirm-target <host>`. Nunca imprime a password nem a URL
// completa: um manifesto de infraestrutura acaba em logs de CI e em capturas de
// ecrã.
//
// A sessão é aberta em `BEGIN READ ONLY` e fechada com `ROLLBACK`. Mesmo que
// uma query mutável passasse por todas as barreiras de código, o Postgres
// recusava-a.
// ============================================================================

import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  construirManifesto,
  formatarManifesto,
} from "./lib/migration-reconciliation.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");
const MIGRATIONS_DIR = join(RAIZ, "supabase", "migrations");

const argv = process.argv.slice(2);
const temFlag = (f) => argv.includes(f);
const valorDe = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ─── A recusa ────────────────────────────────────────────────────────────────

if (temFlag("--apply") || temFlag("--reconcile") || temFlag("--fix")) {
  console.error("❌ RECONCILIATION_WRITE_NOT_ENABLED");
  console.error("");
  console.error("   Esta ferramenta é de inspecção. Não escreve no ledger, e não");
  console.error("   tem caminho de código que o faça.");
  console.error("");
  console.error("   Escrever em public._migrations é a ronda R1: exige este manifesto");
  console.error("   revisto por uma pessoa e autorização explícita.");
  console.error("   Ver docs/LEDGER-RECONCILIATION-R0.md.");
  process.exit(2);
}

// ─── Ligação, com confirmação de alvo ────────────────────────────────────────

function partesDaUrl(url) {
  // `URL` aceita postgres:// e faz o parsing sem que seja preciso mexer em
  // strings à mão. A password nunca sai daqui.
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || "5432",
    database: u.pathname.replace(/^\//, "") || "(omissão)",
    user: decodeURIComponent(u.username || "(omissão)"),
  };
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌ Falta SUPABASE_DB_URL (ou DATABASE_URL).");
    console.error("");
    console.error("   É preciso uma ligação Postgres directa: o catálogo");
    console.error("   (pg_proc, pg_trigger, information_schema) não é acessível");
    console.error("   por PostgREST.");
    console.error("");
    console.error("   Não colar a URL em chat nem versioná-la.");
    process.exit(1);
  }

  let alvo;
  try {
    alvo = partesDaUrl(dbUrl);
  } catch {
    console.error("❌ SUPABASE_DB_URL não é uma URL válida.");
    process.exit(1);
  }

  console.log("Alvo da inspecção:");
  console.log(`   host     : ${alvo.host}:${alvo.port}`);
  console.log(`   database : ${alvo.database}`);
  console.log(`   user     : ${alvo.user}`);
  console.log("");

  const confirmado = valorDe("--confirm-target");
  if (confirmado !== alvo.host) {
    console.error("❌ Alvo não confirmado.");
    console.error("");
    console.error(`   Para correr contra este host, repete-o explicitamente:`);
    console.error(`      node scripts/reconcile-migrations.mjs --confirm-target ${alvo.host}`);
    console.error("");
    console.error("   A confirmação existe para que ninguém aponte isto a uma base");
    console.error("   por engano — mesmo sendo só leitura.");
    process.exit(1);
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    // 🔴 Rede de segurança do lado do servidor. Se algo tentasse escrever, o
    //    Postgres recusa — não é preciso confiar só no código.
    await client.query("BEGIN READ ONLY");

    const manifesto = await construirManifesto({
      client,
      migrationsDir: MIGRATIONS_DIR,
      lerLedger: async () => {
        const { rows } = await client.query("SELECT name, checksum FROM public._migrations");
        return new Map(rows.map((r) => [r.name, { checksum: r.checksum }]));
      },
    });

    for (const linha of formatarManifesto(manifesto)) console.log(linha);

    const destino = valorDe("--json");
    if (destino) {
      const { writeFileSync, mkdirSync } = await import("fs");
      mkdirSync(dirname(destino), { recursive: true });
      writeFileSync(destino, JSON.stringify(manifesto, null, 2) + "\n", "utf8");
      console.log(`Manifesto JSON: ${destino}`);
      console.log("(não versionar: envelhece com a base)");
    }

    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
