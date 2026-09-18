#!/usr/bin/env node
// ============================================================================
// Confrontar o inventário de FKs com o catálogo VIVO — só leitura
// ============================================================================
//
// O inventário em `src/domain/collaborators/profile-fk-inventory.ts` foi
// gerado do fixture que representa a forma de produção, mais as migrations
// 101/101a. Isso prova que o ficheiro descreve o schema que o repositório
// conhece. Não prova que descreve o schema que está a correr.
//
// Este script fecha essa distância. Faz UMA pergunta ao `pg_constraint`,
// dentro de uma transação `READ ONLY`, e compara com o ficheiro. Não escreve,
// não cria, não altera — e o `READ ONLY` não é uma promessa no comentário: é
// a base a recusar qualquer escrita que este processo tentasse.
//
// ----------------------------------------------------------------------------
// Como correr
// ----------------------------------------------------------------------------
//
//   node scripts/verify-profile-fk-inventory-live.mjs --project-ref <ref>
//
// `--project-ref` é obrigatório e tem de coincidir com o `ref` que está na
// `SUPABASE_DB_URL` de `.env.local`. É de propósito: sem ele, correr isto na
// máquina errada consulta a base errada e devolve um verde que não vale nada.
// Quem corre tem de dizer contra QUE base está a comparar, e o script recusa
// se não for a mesma.
//
// Saídas:
//   0  o catálogo vivo e o inventário coincidem
//   1  divergem — a lista das diferenças é impressa
//   2  não correu (ligação, argumentos, ficheiro)
// ============================================================================

import { readFileSync } from "node:fs";
import pg from "pg";

// 🔴 O leitor de `.env.local` é o comum, e não um parser próprio.
//
//    `admin-script-guard.test.ts` recusa scripts com o seu próprio parser, e
//    a razão é histórica: eram sete, cada um com regras ligeiramente
//    diferentes, e nenhum a dizer para onde apontava. Este script existe
//    exactamente para apontar a produção — ser ele a reinventar a leitura
//    seria o pior sítio possível para o fazer.
import { loadEnvFile } from "./lib/admin-db.mjs";

const PERGUNTA = `
  SELECT
    con.conname AS restricao,
    src.relname AS tabela,
    (SELECT a.attname
       FROM unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord)
       JOIN unnest(con.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = f.attnum
       JOIN pg_attribute a  ON a.attrelid  = con.conrelid  AND a.attnum  = k.attnum
      WHERE pa.attname = 'id') AS coluna,
    CASE con.confdeltype
      WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'  WHEN 'd' THEN 'SET DEFAULT'
    END AS on_delete,
    cardinality(con.conkey) > 1 AS composta
  FROM pg_constraint con
  JOIN pg_class     src    ON src.oid    = con.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_class     tgt    ON tgt.oid    = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
  WHERE con.contype = 'f'
    AND tgt_ns.nspname = 'public' AND tgt.relname = 'profiles'
    AND src_ns.nspname = 'public'
  ORDER BY src.relname, con.conname;
`;

function lerArgumento(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const igual = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return igual ? igual.slice(nome.length + 3) : null;
}

/** As assinaturas que o ficheiro entregue declara. */
function inventarioDoFicheiro() {
  const src = readFileSync("src/domain/collaborators/profile-fk-inventory.ts", "utf8");
  const linhas = [...src.matchAll(
    /\{\s*tabela:\s*"([^"]+)",\s*coluna:\s*"([^"]+)",\s*restricao:\s*"([^"]+)",\s*onDelete:\s*"([^"]+)",\s*composta:\s*(true|false)/g,
  )];
  if (linhas.length === 0) throw new Error("não consegui ler o inventário do ficheiro.");
  return linhas
    .map(([, tabela, coluna, restricao, onDelete, composta]) =>
      `${tabela}.${coluna} [${restricao}] ${onDelete}${composta === "true" ? " composta" : ""}`)
    .sort();
}

async function main() {
  const refEsperado = lerArgumento("project-ref");
  if (!refEsperado) {
    console.error(
      "Falta --project-ref <ref>.\n"
      + "É obrigatório para o script poder recusar se a ligação apontar a outra base.",
    );
    process.exit(2);
  }

  const url = loadEnvFile().SUPABASE_DB_URL;
  if (!url) {
    console.error("SUPABASE_DB_URL não está em .env.local.");
    process.exit(2);
  }

  // O `ref` do projeto aparece no utilizador do pooler (`postgres.<ref>`) ou
  // no anfitrião. Comparar é o que impede consultar a base errada.
  if (!url.includes(refEsperado)) {
    console.error(
      `A SUPABASE_DB_URL de .env.local não menciona "${refEsperado}".\n`
      + "Ou o --project-ref está errado, ou o .env.local aponta a outra base.\n"
      + "Não vou adivinhar qual — corrige um dos dois e repete.",
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let vivas;
  try {
    // 🔴 `READ ONLY` a sério: qualquer escrita neste processo é recusada pela
    //    base, não pela boa vontade de quem leu o código.
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(PERGUNTA);
    vivas = rows
      .map((r) => `${r.tabela}.${r.coluna} [${r.restricao}] ${r.on_delete}${r.composta ? " composta" : ""}`)
      .sort();
    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }

  const doFicheiro = inventarioDoFicheiro();
  const soNaBase = vivas.filter((v) => !doFicheiro.includes(v));
  const soNoFicheiro = doFicheiro.filter((f) => !vivas.includes(f));

  console.log(`catálogo vivo: ${vivas.length} referências a public.profiles`);
  console.log(`inventário:    ${doFicheiro.length}`);

  if (soNaBase.length === 0 && soNoFicheiro.length === 0) {
    console.log("\n✔ coincidem, referência a referência.");
    return;
  }

  if (soNaBase.length > 0) {
    console.error("\n✖ na base e NÃO no inventário — o guard não as sonda:");
    for (const s of soNaBase) console.error(`   ${s}`);
  }
  if (soNoFicheiro.length > 0) {
    console.error("\n✖ no inventário e NÃO na base — o guard sonda colunas que não existem:");
    for (const s of soNoFicheiro) console.error(`   ${s}`);
  }
  console.error("\nRegenerar com: npx tsx scripts/generate-profile-fk-inventory.ts");
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(2);
});
