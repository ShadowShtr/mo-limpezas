#!/usr/bin/env node
// ============================================================================
// Preflight da 101b — o que ela FARIA se corresse agora
// ============================================================================
//
// A 101b é condicional: cada passo pergunta ao catálogo antes de agir. Este
// script faz as MESMAS perguntas, em leitura, e diz quantas instruções a
// migration executaria.
//
// 🔴 A resposta esperada, contra produção, é ZERO em tudo.
//
//    Se aparecer um número diferente de zero, alguma coisa mudou desde a
//    última medição — e isso é uma decisão para tomar antes de aplicar, não
//    uma surpresa para descobrir a meio.
//
// Não escreve nada, e corre dentro de `BEGIN READ ONLY`. `--project-ref` é
// obrigatório e tem de bater com a `SUPABASE_DB_URL`.
//
//   node scripts/preflight-101b.mjs --project-ref <ref>
//
// Saídas:
//   0  a migration seria um no-op operacional
//   1  a migration executaria alguma coisa (a lista é impressa)
//   2  não correu
// ============================================================================

import pg from "pg";

import { loadEnvFile } from "./lib/admin-db.mjs";

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const igual = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return igual ? igual.slice(nome.length + 3) : null;
}

/** Cada pergunta que a 101b faz antes de agir, e o que ela faria se a resposta fosse «falta». */
const PERGUNTAS = [
  {
    nome: "coluna profiles.auth_user_id",
    acao: "ALTER TABLE ADD COLUMN",
    sql: `SELECT count(*)::int = 0 AS faria FROM information_schema.columns
           WHERE table_schema='public' AND table_name='profiles' AND column_name='auth_user_id'`,
  },
  {
    nome: "coluna profiles.must_change_password",
    acao: "ALTER TABLE ADD COLUMN",
    sql: `SELECT count(*)::int = 0 AS faria FROM information_schema.columns
           WHERE table_schema='public' AND table_name='profiles' AND column_name='must_change_password'`,
  },
  {
    nome: "FK profiles_auth_user_id_fkey",
    acao: "ALTER TABLE ADD CONSTRAINT",
    sql: `SELECT count(*)::int = 0 AS faria FROM pg_constraint WHERE conname='profiles_auth_user_id_fkey'`,
  },
  {
    nome: "FK profiles_id_fkey (a remover)",
    acao: "ALTER TABLE DROP CONSTRAINT",
    sql: `SELECT count(*)::int > 0 AS faria FROM pg_constraint WHERE conname='profiles_id_fkey'`,
  },
  {
    nome: "índice uq_profiles_auth_user_id",
    acao: "CREATE UNIQUE INDEX",
    sql: `SELECT count(*)::int = 0 AS faria FROM pg_indexes
           WHERE schemaname='public' AND indexname='uq_profiles_auth_user_id'`,
  },
  {
    nome: "índice idx_profiles_company_auth",
    acao: "CREATE INDEX",
    sql: `SELECT count(*)::int = 0 AS faria FROM pg_indexes
           WHERE schemaname='public' AND indexname='idx_profiles_company_auth'`,
  },
  {
    nome: "get_my_profile_id()",
    acao: "CREATE FUNCTION + REVOKE/GRANT + COMMENT",
    sql: `SELECT count(*)::int = 0 AS faria FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='get_my_profile_id' AND p.pronargs=0`,
  },
  {
    nome: "get_my_company_id() delega",
    acao: "CREATE OR REPLACE FUNCTION",
    sql: `SELECT NOT EXISTS (
             SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='get_my_company_id' AND p.pronargs=0
                AND position('get_my_profile_id' in pg_get_functiondef(p.oid)) > 0
           ) AS faria`,
  },
  {
    nome: "get_my_role() delega",
    acao: "CREATE OR REPLACE FUNCTION",
    sql: `SELECT NOT EXISTS (
             SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='get_my_role' AND p.pronargs=0
                AND position('get_my_profile_id' in pg_get_functiondef(p.oid)) > 0
           ) AS faria`,
  },
];

const CONTAGENS = [
  {
    nome: "políticas a migrar (auth.uid() → get_my_profile_id())",
    sql: `SELECT count(*)::int AS n FROM pg_policies
           WHERE schemaname='public'
             AND (COALESCE(qual,'') || ' ' || COALESCE(with_check,'')) ~ 'auth\\.uid\\(\\)'`,
  },
  {
    nome: "linhas que o backfill guardado tocaria",
    sql: `SELECT count(*)::int AS n FROM public.profiles p
           WHERE p.auth_user_id IS NULL
             AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)`,
  },
];

/** O que tem de ser verdade DEPOIS, e já é verdade agora. */
const POSCONDICOES = [
  {
    nome: "nenhuma política resolve por auth.uid()",
    sql: `SELECT count(*)::int = 0 AS ok FROM pg_policies
           WHERE schemaname='public'
             AND (COALESCE(qual,'') || ' ' || COALESCE(with_check,'')) ~ 'auth\\.uid\\(\\)'`,
  },
  {
    nome: "nenhum perfil ligado a conta inexistente",
    sql: `SELECT count(*)::int = 0 AS ok FROM public.profiles p
           WHERE p.auth_user_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.auth_user_id)`,
  },
];

async function main() {
  const ref = arg("project-ref");
  if (!ref) { console.error("Falta --project-ref <ref>."); process.exit(2); }

  const url = loadEnvFile().SUPABASE_DB_URL;
  if (!url) { console.error("SUPABASE_DB_URL não está em .env.local."); process.exit(2); }
  if (!url.includes(ref)) {
    console.error(`A SUPABASE_DB_URL não menciona "${ref}". Não vou adivinhar.`);
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const faria = [];
  let politicas = 0;
  let backfill = 0;
  const falhas = [];
  let noLedger = false;

  try {
    await client.query("BEGIN READ ONLY");

    for (const p of PERGUNTAS) {
      const { rows } = await client.query(p.sql);
      if (rows[0].faria) faria.push(`${p.acao.padEnd(34)} ${p.nome}`);
    }

    politicas = (await client.query(CONTAGENS[0].sql)).rows[0].n;
    backfill = (await client.query(CONTAGENS[1].sql)).rows[0].n;

    for (const c of POSCONDICOES) {
      const { rows } = await client.query(c.sql);
      if (!rows[0].ok) falhas.push(c.nome);
    }

    noLedger = (await client.query(
      "SELECT count(*)::int > 0 AS n FROM public._migrations WHERE name LIKE '101b%'",
    )).rows[0].n;

    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }

  console.log(`ledger: 101b ${noLedger ? "PRESENTE ⚠️" : "ABSENT"}`);
  console.log("");
  console.log(`instruções de DDL que a 101b executaria ... ${faria.length}`);
  for (const f of faria) console.log(`   ${f}`);
  console.log(`políticas que reescreveria ................ ${politicas}`);
  console.log(`linhas que o backfill tocaria ............. ${backfill}`);
  console.log("");
  console.log("pós-condições (já verdadeiras agora):");
  for (const c of POSCONDICOES) {
    console.log(`   ${falhas.includes(c.nome) ? "✖" : "✔"} ${c.nome}`);
  }

  const total = faria.length + politicas + backfill;
  console.log("");
  if (noLedger) {
    console.log("⚠️  já há linha de 101b no ledger — rever antes de qualquer coisa.");
    process.exit(1);
  }
  if (total === 0 && falhas.length === 0) {
    console.log("✔ a 101b seria um NO-OP operacional: zero DDL, zero linhas.");
    return;
  }
  console.log(`✖ a 101b executaria ${total} operação(ões). Decidir antes de aplicar.`);
  process.exit(1);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(2); });
