#!/usr/bin/env node
/**
 * Verificação REAL das guardas de `profiles` (migrations 069 e 070).
 *
 * Task T04 do plano mestre. Existe porque os testes estáticos de
 * `src/__tests__/` provam que o SQL contém as cláusulas certas — não provam
 * que a base recusa a escrita. Só uma ligação a Postgres prova isso.
 *
 * ---------------------------------------------------------------------------
 * SEGURANÇA
 * ---------------------------------------------------------------------------
 * Este script ESCREVE. Por isso:
 *
 *   1. Nunca lê `SUPABASE_DB_URL` do ambiente. A URL tem de ser passada
 *      explicitamente em `--database-url`, para não haver forma de apontar
 *      para produção por descuido de configuração.
 *   2. Recusa-se a correr se o project ref da URL for o mesmo de
 *      `NEXT_PUBLIC_SUPABASE_URL` — isto é, o projeto configurado no ambiente.
 *   3. Exige `--i-know-this-database-is-disposable`.
 *   4. Tudo corre dentro de uma transação terminada em ROLLBACK. Mesmo numa
 *      base descartável, não fica nada.
 *
 * Ver AGENTS.md, REGRA ZERO.
 *
 * ---------------------------------------------------------------------------
 * USO
 * ---------------------------------------------------------------------------
 *   node scripts/verify-profile-guards.mjs \
 *     --database-url postgresql://... \
 *     --i-know-this-database-is-disposable
 *
 *   node scripts/verify-profile-guards.mjs \
 *     --database-url postgresql://... \
 *     --i-know-this-database-is-disposable \
 *     --rehearse-rollback
 *
 * A base tem de ser um projeto Supabase descartável com as migrations
 * aplicadas (precisa do schema `auth` para `auth.uid()` / `auth.role()`).
 *
 * ---------------------------------------------------------------------------
 * MODO --rehearse-rollback
 * ---------------------------------------------------------------------------
 * Prova que a 070 se desliga e se volta a ligar sem deixar resíduo. Corre, na
 * MESMA transação:
 *
 *   1. os cenários com a guarda ativa                      → esperado 12/12
 *   2. DROP do trigger e da função da 070 (o rollback)
 *   3. os cenários outra vez — os bloqueios da 070 têm de DESAPARECER, e os
 *      da 069 têm de PERMANECER (prova que o rollback é cirúrgico)
 *   4. reaplicação do SQL lido de supabase/migrations/070_*.sql
 *   5. os cenários uma última vez                          → esperado 12/12
 *   6. ROLLBACK
 *
 * ⚠️ Este modo ALTERA temporariamente objetos da base: larga e recria um
 * trigger e uma função. Tudo acontece dentro da transação e é revertido pelo
 * ROLLBACK final, mas enquanto a transação está aberta a guarda está mesmo
 * ausente para esta ligação. Nunca contra uma base que não seja descartável.
 *
 * O SQL da 070 é LIDO DO FICHEIRO, nunca reescrito aqui: duas cópias do mesmo
 * SQL seriam duas fontes de verdade, e o ensaio deixaria de provar o que a
 * migration realmente faz.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  FUNCAO_070,
  TRIGGER_070,
  validarMigration070,
} from "./lib/migration-070-integrity.mjs";

const args = process.argv.slice(2);

function readArgument(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

const DATABASE_URL = readArgument("--database-url");
const DISPOSABLE = args.includes("--i-know-this-database-is-disposable");
const REHEARSE_ROLLBACK = args.includes("--rehearse-rollback");

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

if (!DATABASE_URL) {
  fail(
    "--database-url é obrigatório. Este script nunca lê SUPABASE_DB_URL do ambiente, de propósito.",
  );
}

if (!DISPOSABLE) {
  fail(
    "--i-know-this-database-is-disposable é obrigatório: este script escreve na base.",
  );
}

/** Mesmo formato usado por scripts/lib/migration-runner-guards.mjs. */
function extractDbProjectRef(dbUrl) {
  const parsed = new URL(dbUrl);
  const host = parsed.hostname;
  const username = decodeURIComponent(parsed.username);

  const direct = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (direct) return direct[1];

  if (/^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(host)) {
    const pooler = username.match(/^postgres\.([a-z0-9]+)$/i);
    if (pooler) return pooler[1];
  }

  return null;
}

function resolveConfiguredRef() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  const match = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match ? match[1] : null;
}

const targetRef = extractDbProjectRef(DATABASE_URL);
const configuredRef = resolveConfiguredRef();

if (configuredRef && targetRef && configuredRef === targetRef) {
  fail(
    `A --database-url aponta para o projeto configurado no ambiente (${configuredRef}). ` +
      "Este script só corre contra uma base descartável.",
  );
}

// ---------------------------------------------------------------------------
// SQL da migration 070 — fonte única
// ---------------------------------------------------------------------------

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIGRATION_070 = path.join(
  ROOT,
  "supabase",
  "migrations",
  "070_guard_profile_managed_fields.sql",
);

/**
 * Lê o SQL da 070 do ficheiro e recusa-se a executá-lo se não for o que se
 * espera. O ensaio só vale se aplicar exatamente a migration real: por isso
 * nada de reescrever o SQL aqui, e nada de executar às cegas um ficheiro que
 * possa ter mudado de natureza. A decisão vive em
 * `scripts/lib/migration-070-integrity.mjs`, para poder ser testada.
 */
function lerMigration070() {
  const rel = path.relative(ROOT, MIGRATION_070);

  const sql = fs.existsSync(MIGRATION_070)
    ? fs.readFileSync(MIGRATION_070, "utf8")
    : null;

  const veredito = validarMigration070(sql);

  if (!veredito.ok) fail(`${rel}: ${veredito.error}`);

  return sql;
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

const EMPRESA_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const EMPRESA_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const COLABORADOR_A = "11111111-0000-4000-8000-000000000001";
const ADMIN_A = "22222222-0000-4000-8000-000000000002";
const COLABORADOR_B = "33333333-0000-4000-8000-000000000003";

/**
 * Cada cenário descreve: quem age, o que tenta escrever, e o que deve
 * acontecer. `expect` é `"ok"` ou o prefixo estável do erro esperado.
 */
const CENARIOS = [
  {
    nome: "colaborador não altera o próprio valor/hora",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET hourly_rate = 999 WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "PROFILE_MANAGED_FIELD_BLOCKED",
  },
  {
    nome: "colaborador não altera o próprio saldo de férias",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET vacation_balance = 365 WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "PROFILE_MANAGED_FIELD_BLOCKED",
  },
  {
    nome: "colaborador não altera as próprias horas contratadas",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET contracted_hours_month = 1 WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "PROFILE_MANAGED_FIELD_BLOCKED",
  },
  {
    nome: "colaborador não altera o próprio estado",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET status = 'suspenso' WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "PROFILE_MANAGED_FIELD_BLOCKED",
  },
  {
    nome: "colaborador não altera as próprias datas contratuais",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET contract_end = '2030-01-01' WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "PROFILE_MANAGED_FIELD_BLOCKED",
  },
  {
    nome: "colaborador não altera as próprias competências",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET skills = ARRAY['tudo'] WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "PROFILE_MANAGED_FIELD_BLOCKED",
  },
  {
    nome: "colaborador ALTERA o próprio nome (campo pessoal continua livre)",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET full_name = 'Nome Novo' WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "ok",
  },
  {
    nome: "colaborador ALTERA o próprio telefone (campo pessoal continua livre)",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET phone = '910000000' WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "ok",
  },
  {
    nome: "colaborador não escala o próprio role (guarda da 069)",
    ator: COLABORADOR_A,
    sql: `UPDATE public.profiles SET role = 'admin' WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "PROFILE_ROLE_ESCALATION_BLOCKED",
  },
  {
    nome: "admin gere o valor/hora de um colega da mesma empresa",
    ator: ADMIN_A,
    sql: `UPDATE public.profiles SET hourly_rate = 9.5 WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "ok",
  },
  {
    nome: "admin gere o saldo de férias de um colega da mesma empresa",
    ator: ADMIN_A,
    sql: `UPDATE public.profiles SET vacation_balance = 25 WHERE id = $1`,
    alvo: COLABORADOR_A,
    expect: "ok",
  },
  {
    nome: "admin da empresa A NÃO altera campos laborais de alguém da empresa B",
    ator: ADMIN_A,
    sql: `UPDATE public.profiles SET hourly_rate = 1 WHERE id = $1`,
    alvo: COLABORADOR_B,
    expect: "isolado",
  },
];

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const client = new pg.Client({ connectionString: DATABASE_URL });

async function comoAtor(ator, fn) {
  await client.query("SAVEPOINT ator");
  try {
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: ator, role: "authenticated" })],
    );
    return await fn();
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT ator");
    await client.query(`SET LOCAL ROLE NONE`);
  }
}

async function executar(cenario) {
  return comoAtor(cenario.ator, async () => {
    try {
      const r = await client.query(cenario.sql, [cenario.alvo]);
      return { tipo: "ok", linhas: r.rowCount };
    } catch (erro) {
      return { tipo: "erro", mensagem: String(erro.message) };
    }
  });
}

function avaliar(esperado, resultado) {
  if (esperado === "ok") {
    return resultado.tipo === "ok" && resultado.linhas > 0;
  }

  if (esperado === "isolado") {
    // RLS não deixa sequer ver a linha da outra empresa: ou 0 linhas
    // afetadas, ou erro da guarda. As duas coisas são isolamento.
    return (
      (resultado.tipo === "ok" && resultado.linhas === 0) ||
      (resultado.tipo === "erro" &&
        resultado.mensagem.includes("PROFILE_MANAGED_FIELD_BLOCKED"))
    );
  }

  return (
    resultado.tipo === "erro" && resultado.mensagem.includes(esperado)
  );
}

/**
 * Expectativa de cada cenário quando a guarda da 070 está AUSENTE.
 *
 * É aqui que o ensaio ganha valor: os bloqueios da 070 têm de desaparecer
 * (prova que era ela a bloquear, e que o rollback funciona), enquanto os da
 * 069 têm de permanecer (prova que o rollback é cirúrgico e não derruba a
 * proteção vizinha).
 */
function esperadoSemGuarda(cenario) {
  if (cenario.expect === "PROFILE_MANAGED_FIELD_BLOCKED") return "ok";
  return cenario.expect;
}

async function correrFase(titulo, esperadoDe) {
  console.log(`\n── ${titulo}`);

  const resultados = [];

  for (const cenario of CENARIOS) {
    const esperado = esperadoDe(cenario);
    const resultado = await executar(cenario);
    const passou = avaliar(esperado, resultado);

    resultados.push({ cenario: cenario.nome, passou, esperado, resultado });

    console.log(
      `${passou ? "✔" : "✘"} ${cenario.nome}` +
        (passou
          ? ""
          : `\n    esperado: ${esperado}\n    obtido:   ${JSON.stringify(resultado)}`),
    );
  }

  const passaram = resultados.filter((r) => r.passou).length;
  console.log(`   ${passaram}/${resultados.length}`);

  return resultados;
}

async function prepararDados() {
  await client.query(
    `INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa A'), ($2, 'Empresa B')
     ON CONFLICT (id) DO NOTHING`,
    [EMPRESA_A, EMPRESA_B],
  );

  await client.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status, hourly_rate, vacation_balance, contracted_hours_month)
     VALUES
       ($1, $4, 'Colaboradora A', 'colaborador', 'ativo', 8.00, 22, 168),
       ($2, $4, 'Admin A',        'admin',       'ativo', 8.00, 22, 168),
       ($3, $5, 'Colaboradora B', 'colaborador', 'ativo', 8.00, 22, 168)
     ON CONFLICT (id) DO NOTHING`,
    [COLABORADOR_A, ADMIN_A, COLABORADOR_B, EMPRESA_A, EMPRESA_B],
  );
}

async function guardasPresentes() {
  const { rows } = await client.query(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal`,
  );

  return rows.map((r) => r.tgname);
}

async function main() {
  // Falha antes de ligar à base se a migration não for o que se espera.
  const sqlMigration070 = REHEARSE_ROLLBACK ? lerMigration070() : null;

  await client.connect();

  console.log(`Base alvo: ${targetRef ?? "(fora do Supabase)"}`);
  console.log(
    `Modo: ${REHEARSE_ROLLBACK ? "ensaio de rollback" : "verificação"}`,
  );
  console.log("Tudo corre numa transação terminada em ROLLBACK.\n");

  if (REHEARSE_ROLLBACK) {
    console.log(
      "⚠️  Este modo larga e recria temporariamente o trigger e a função da 070.\n" +
        "   Reversível pelo ROLLBACK final, mas nunca contra uma base não descartável.\n",
    );
  }

  await client.query("BEGIN");

  let todas = [];

  try {
    const presentes = await guardasPresentes();

    for (const esperado of ["trg_guard_profile_tenant_role", TRIGGER_070]) {
      if (!presentes.includes(esperado)) {
        throw new Error(
          `Trigger ${esperado} não existe nesta base. As migrations 069/070 estão aplicadas?`,
        );
      }
    }

    console.log("✔ Triggers 069 e 070 presentes.");

    await prepararDados();

    if (!REHEARSE_ROLLBACK) {
      todas = await correrFase("Guarda ativa", (c) => c.expect);
    } else {
      // 1. Estado inicial.
      const antes = await correrFase("1/3 · guarda ativa", (c) => c.expect);

      // 2. Rollback da 070 — exatamente as instruções documentadas na migration.
      await client.query(
        `DROP TRIGGER IF EXISTS ${TRIGGER_070} ON public.profiles`,
      );
      await client.query(`DROP FUNCTION IF EXISTS public.${FUNCAO_070}()`);

      const depoisDoDrop = await guardasPresentes();

      if (depoisDoDrop.includes(TRIGGER_070)) {
        throw new Error(`O rollback não removeu o trigger ${TRIGGER_070}.`);
      }

      if (!depoisDoDrop.includes("trg_guard_profile_tenant_role")) {
        throw new Error(
          "O rollback da 070 removeu também a guarda da 069 — não é cirúrgico.",
        );
      }

      console.log("\n✔ Rollback aplicado: trigger e função da 070 removidos, 069 intacta.");

      // 3. Sem guarda, os bloqueios da 070 têm de desaparecer.
      const semGuarda = await correrFase(
        "2/3 · guarda removida (os bloqueios da 070 devem desaparecer)",
        esperadoSemGuarda,
      );

      // 4. Reaplicar a migration, tal e qual está no ficheiro.
      await client.query(sqlMigration070);

      const depoisDeReaplicar = await guardasPresentes();

      if (!depoisDeReaplicar.includes(TRIGGER_070)) {
        throw new Error("A reaplicação da 070 não recriou o trigger.");
      }

      console.log("\n✔ Migration 070 reaplicada a partir do ficheiro.");

      // 5. Estado final tem de ser igual ao inicial.
      const depois = await correrFase("3/3 · guarda reaplicada", (c) => c.expect);

      todas = [...antes, ...semGuarda, ...depois];
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  const falhas = todas.filter((r) => !r.passou);

  console.log(
    `\n${todas.length - falhas.length}/${todas.length} verificações passaram. Transação revertida.`,
  );

  if (falhas.length > 0) process.exitCode = 1;
}

main().catch((erro) => {
  console.error(`❌ ${erro.message}`);
  process.exitCode = 1;
});
