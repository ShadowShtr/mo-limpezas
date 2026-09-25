#!/usr/bin/env node
// ============================================================================
// Inventário da superfície de autorização — quem decide sem olhar ao estado
// ============================================================================
//
// Antes de fazer `profiles.status` participar da autorização na base, é
// preciso saber TUDO o que hoje decide acesso sem o consultar. Uma policy
// corrigida ao lado de quarenta que continuam a resolver identidade por
// `auth.uid()` não fecha nada — dá a sensação de ter fechado, que é pior.
//
// Este script lê o catálogo de produção dentro de `BEGIN READ ONLY` e produz:
//
//   · todas as policies de `public`, e quais mencionam cada helper;
//   · o corpo das funções de autorização, e se filtram por estado;
//   · todas as SECURITY DEFINER do schema, que são as que podem contornar
//     qualquer regra nova;
//   · a distribuição real de `profiles.status`.
//
// Não escreve nada. `--project-ref` é obrigatório e tem de bater com a
// `SUPABASE_DB_URL`, para não inventariar a base errada.
//
//   node scripts/audit-status-authorization-surface.mjs --project-ref <ref>
//   node scripts/audit-status-authorization-surface.mjs --project-ref <ref> --json <ficheiro>
// ============================================================================

import { writeFileSync } from "node:fs";
import pg from "pg";

// O leitor comum — nunca um parser próprio de `.env.local` (ver
// `admin-script-guard.test.ts`).
import { loadEnvFile } from "./lib/admin-db.mjs";

/** As funções cuja decisão de autorização nos interessa auditar. */
const HELPERS = [
  "get_my_profile_id",
  "get_my_company_id",
  "get_my_role",
  "can_access_service",
];

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const igual = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return igual ? igual.slice(nome.length + 3) : null;
}

const POLICIES = `
  SELECT schemaname, tablename, policyname, cmd, roles::text AS roles,
         COALESCE(qual, '')       AS qual,
         COALESCE(with_check, '') AS with_check
  FROM pg_policies
  WHERE schemaname = 'public'
  ORDER BY tablename, policyname;
`;

const FUNCOES = `
  SELECT p.proname                                   AS nome,
         pg_get_function_identity_arguments(p.oid)   AS args,
         p.prosecdef                                 AS security_definer,
         COALESCE(p.proconfig::text, '')             AS config,
         COALESCE(p.proacl::text, '')                AS acl,
         pg_get_functiondef(p.oid)                   AS corpo
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
  ORDER BY p.proname;
`;

const ESTADOS = `
  SELECT COALESCE(status, '<NULL>') AS status, count(*)::int AS n
  FROM public.profiles GROUP BY 1 ORDER BY 2 DESC;
`;

const CHECK_STATUS = `
  SELECT pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.profiles'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';
`;

/** Uma expressão que decide acesso sem olhar ao estado da pessoa. */
const mencionaEstado = (txt) => /\bstatus\b/i.test(txt);

async function main() {
  const refEsperado = arg("project-ref");
  if (!refEsperado) {
    console.error("Falta --project-ref <ref>. É obrigatório para não inventariar a base errada.");
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
  let policies; let funcoes; let estados; let checkStatus; let colunasProfiles;
  try {
    await client.query("BEGIN READ ONLY");
    policies = (await client.query(POLICIES)).rows;
    funcoes = (await client.query(FUNCOES)).rows;
    estados = (await client.query(ESTADOS)).rows;
    checkStatus = (await client.query(CHECK_STATUS)).rows;
    colunasProfiles = (await client.query(`
      SELECT column_name, data_type, is_nullable, COALESCE(column_default,'') AS def
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='profiles'
      ORDER BY ordinal_position`)).rows;
    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }

  const expr = (p) => `${p.qual} ${p.with_check}`;

  const consumidores = {};
  for (const h of HELPERS) {
    const re = new RegExp(`\\b${h}\\s*\\(`);
    consumidores[h] = {
      policies: policies.filter((p) => re.test(expr(p))).map((p) => `${p.tablename}.${p.policyname}`),
      funcoes: funcoes.filter((f) => f.nome !== h && re.test(f.corpo)).map((f) => f.nome),
    };
  }

  const authUidDirecto = policies
    .filter((p) => /auth\.uid\s*\(\s*\)/.test(expr(p)))
    .map((p) => `${p.tablename}.${p.policyname}`);

  const securityDefiner = funcoes.filter((f) => f.security_definer);

  // O que decide identidade/empresa/papel sem consultar o estado.
  const decideSemEstado = securityDefiner
    .filter((f) => /auth\.uid\s*\(\s*\)/.test(f.corpo) && /\bprofiles\b/.test(f.corpo))
    .map((f) => ({ nome: f.nome, olhaAoEstado: mencionaEstado(f.corpo) }));

  const policiesComEstado = policies.filter((p) => mencionaEstado(expr(p)) && /profiles/i.test(expr(p)));

  const relatorio = {
    geradoEm: new Date().toISOString(),
    projeto: refEsperado,
    totais: {
      policies: policies.length,
      funcoes: funcoes.length,
      securityDefiner: securityDefiner.length,
      policiesComAuthUidDirecto: authUidDirecto.length,
      policiesQueConsultamProfilesStatus: policiesComEstado.length,
    },
    distribuicaoDeEstados: estados,
    checkDeStatus: checkStatus.map((r) => r.def),
    colunasProfiles,
    consumidores,
    authUidDirecto,
    helpersQueDecidemSemEstado: decideSemEstado,
    // Os corpos REAIS em produção. A migration que os vai substituir tem de
    // partir daqui, e não do que o repositório julga que eles são — 014 e 034
    // podem ter sido alterados fora do runner.
    corposDosHelpers: funcoes
      .filter((f) => HELPERS.includes(f.nome))
      .map((f) => ({ nome: f.nome, securityDefiner: f.security_definer, config: f.config, corpo: f.corpo })),
    securityDefiner: securityDefiner.map((f) => ({
      nome: f.nome, args: f.args, config: f.config, acl: f.acl,
      olhaAoEstado: mencionaEstado(f.corpo),
      // 🔴 O que faz destas um caminho de contorno: correm com os privilégios
      //    do dono, e uma que seja executável por `authenticated` sem NUNCA
      //    consultar a identidade de quem chama decide sozinha — a regra nova
      //    dos helpers não lhe chega.
      alcancavelPorAutenticado: /authenticated=/.test(f.acl) || f.acl === "",
      consultaIdentidade: /get_my_profile_id\s*\(|auth\.uid\s*\(/.test(f.corpo),
      semSearchPath: f.config === "",
    })),
  };

  const destino = arg("json");
  if (destino) {
    writeFileSync(destino, `${JSON.stringify(relatorio, null, 2)}\n`, "utf8");
    console.log(`relatório em ${destino}`);
  }

  console.log(`policies em public ............... ${relatorio.totais.policies}`);
  console.log(`funções em public ................ ${relatorio.totais.funcoes}`);
  console.log(`SECURITY DEFINER ................. ${relatorio.totais.securityDefiner}`);
  console.log(`policies com auth.uid() directo .. ${relatorio.totais.policiesComAuthUidDirecto}`);
  console.log(`policies que olham a profiles.status  ${relatorio.totais.policiesQueConsultamProfilesStatus}`);
  console.log("");
  for (const h of HELPERS) {
    const c = consumidores[h];
    console.log(`${h}: ${c.policies.length} policies, ${c.funcoes.length} funções`);
  }
  console.log("");
  console.log("helpers que resolvem identidade sem olhar ao estado:");
  for (const d of decideSemEstado) {
    console.log(`   ${d.olhaAoEstado ? "ok " : "🔴 "} ${d.nome}`);
  }
  console.log("");
  console.log("distribuição de profiles.status:");
  for (const e of estados) console.log(`   ${e.status.padEnd(12)} ${e.n}`);
  console.log(`CHECK: ${relatorio.checkDeStatus.join(" | ") || "(nenhum)"}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(2); });
