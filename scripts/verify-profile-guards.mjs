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
 * A base tem de ser um projeto Supabase descartável com as migrations
 * aplicadas (precisa do schema `auth` para `auth.uid()` / `auth.role()`).
 */

import pg from "pg";

const args = process.argv.slice(2);

function readArgument(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

const DATABASE_URL = readArgument("--database-url");
const DISPOSABLE = args.includes("--i-know-this-database-is-disposable");

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

async function main() {
  await client.connect();

  console.log(`Base alvo: ${targetRef ?? "(fora do Supabase)"}`);
  console.log("Tudo corre numa transação terminada em ROLLBACK.\n");

  await client.query("BEGIN");

  const resultados = [];

  try {
    // Pré-condição: as guardas existem mesmo nesta base.
    const { rows: triggers } = await client.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal`,
    );

    const nomes = triggers.map((r) => r.tgname);

    for (const esperado of [
      "trg_guard_profile_tenant_role",
      "trg_guard_profile_managed_fields",
    ]) {
      if (!nomes.includes(esperado)) {
        throw new Error(
          `Trigger ${esperado} não existe nesta base. As migrations 069/070 estão aplicadas?`,
        );
      }
    }

    console.log("✔ Triggers 069 e 070 presentes.\n");

    // Dados mínimos, dentro da transação.
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

    for (const cenario of CENARIOS) {
      const resultado = await comoAtor(cenario.ator, async () => {
        try {
          const r = await client.query(cenario.sql, [cenario.alvo]);
          return { tipo: "ok", linhas: r.rowCount };
        } catch (erro) {
          return { tipo: "erro", mensagem: String(erro.message) };
        }
      });

      let passou;

      if (cenario.expect === "ok") {
        passou = resultado.tipo === "ok" && resultado.linhas > 0;
      } else if (cenario.expect === "isolado") {
        // RLS não deixa sequer ver a linha da outra empresa: ou 0 linhas
        // afetadas, ou erro da guarda. As duas coisas são isolamento.
        passou =
          (resultado.tipo === "ok" && resultado.linhas === 0) ||
          (resultado.tipo === "erro" &&
            resultado.mensagem.includes("PROFILE_MANAGED_FIELD_BLOCKED"));
      } else {
        passou =
          resultado.tipo === "erro" &&
          resultado.mensagem.includes(cenario.expect);
      }

      resultados.push({ cenario: cenario.nome, passou, resultado });

      console.log(
        `${passou ? "✔" : "✘"} ${cenario.nome}` +
          (passou
            ? ""
            : `\n    esperado: ${cenario.expect}\n    obtido:   ${JSON.stringify(resultado)}`),
      );
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  const falhas = resultados.filter((r) => !r.passou);

  console.log(
    `\n${resultados.length - falhas.length}/${resultados.length} cenários passaram. Transação revertida.`,
  );

  if (falhas.length > 0) process.exitCode = 1;
}

main().catch((erro) => {
  console.error(`❌ ${erro.message}`);
  process.exitCode = 1;
});
