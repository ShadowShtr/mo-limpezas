// ============================================================================
// Manifest de drift — o que produção tem e o repositório não explica
// ============================================================================
//
// 🔴 A pergunta que isto responde, e porque é que tinha de ser feita.
//
//    O catálogo de produção tem `profiles.auth_user_id`, um
//    `get_my_profile_id()` que a usa, e políticas reescritas à volta disso. O
//    ledger tem 103 linhas e a última é a `101a`. Nenhuma migration aplicada
//    deste repositório cria nada disso: os efeitos vêm de três ficheiros em
//    `supabase/migrations/draft/`, que dizem de si próprios
//    `NÃO APLICADA PELO RUNNER` e `MIGRATION_NUMBER_FINAL = UNASSIGNED`.
//
//    SCHEMA_EFFECT != MIGRATION_PROVENANCE.
//
//    Antes de escrever uma migration que DEPENDE desse estado, é preciso saber
//    exactamente o que dele está lá e o que não está. Assumir que «o draft foi
//    aplicado» porque vários efeitos aparecem é o erro que este ficheiro
//    existe para impedir: pode ter sido aplicado em parte, ou editado à mão.
//
// Compara dois lados:
//
//   CANONICAL  — o que o repositório sabe construir: a forma de produção
//                versionada (`production-schema-shape.sql`, anterior ao drift)
//                + os helpers legados + 101 + 101a. Nada de fixtures que
//                fabriquem o drift.
//   PRODUCTION — o catálogo vivo, lido em `BEGIN READ ONLY`.
//
// E classifica cada objecto: CANONICAL_AND_LIVE, LIVE_ONLY, CANONICAL_ONLY,
// DIVERGENT.
//
//   npx tsx scripts/audit-identity-drift-manifest.ts --project-ref <ref>
//        [--json reports/identity-drift-manifest.json]
//
// Não escreve em produção. O contentor é descartável.
// ============================================================================

import { writeFileSync } from "node:fs";
import pg from "pg";

import { loadEnvFile } from "./lib/admin-db.mjs";
import { startPostgresContainer } from "../src/__tests__/helpers/pg-container";
import { baselineCompleto } from "../src/__tests__/helpers/production-baseline";
import { migrationCrm, MIGRATIONS_CRM } from "../src/__tests__/helpers/crm-pg-harness";

type Classificacao =
  | "CANONICAL_AND_LIVE"
  | "LIVE_ONLY"
  | "CANONICAL_ONLY"
  | "DIVERGENT";

interface Objecto {
  tipo: string;
  nome: string;
  /** Assinatura comparável. `null` = não existe deste lado. */
  assinatura: string | null;
}

function arg(nome: string): string | null {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const igual = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return igual ? igual.slice(nome.length + 3) : null;
}

/** Espaços e maiúsculas não são diferenças de schema. */
const normalizar = (s: string) => s.replace(/\s+/g, " ").trim();

const COLUNAS_PROFILES = `
  SELECT 'coluna' AS tipo, column_name AS nome,
         data_type || ' null=' || is_nullable || ' def=' || COALESCE(column_default,'-') AS assinatura
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='profiles'
`;

const RESTRICOES_PROFILES = `
  SELECT 'restricao' AS tipo, conname AS nome, pg_get_constraintdef(oid) AS assinatura
  FROM pg_constraint WHERE conrelid='public.profiles'::regclass
`;

const INDICES_PROFILES = `
  SELECT 'indice' AS tipo, indexname AS nome, indexdef AS assinatura
  FROM pg_indexes WHERE schemaname='public' AND tablename='profiles'
`;

const FUNCOES_AUTZ = `
  SELECT 'funcao' AS tipo, p.proname AS nome,
         pg_get_functiondef(p.oid)
           || ' | secdef=' || p.prosecdef
           || ' | config=' || COALESCE(p.proconfig::text,'-')
           || ' | acl='    || COALESCE(p.proacl::text,'-') AS assinatura
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('get_my_profile_id','get_my_company_id','get_my_role','can_access_service')
`;

const POLITICAS = `
  SELECT 'policy' AS tipo, tablename || '.' || policyname AS nome,
         cmd || ' | ' || COALESCE(qual,'-') || ' | ' || COALESCE(with_check,'-') AS assinatura
  FROM pg_policies WHERE schemaname='public'
`;

const SECDEF = `
  SELECT 'secdef' AS tipo, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS nome,
         'config=' || COALESCE(p.proconfig::text,'-') AS assinatura
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
`;

const CONSULTAS = [COLUNAS_PROFILES, RESTRICOES_PROFILES, INDICES_PROFILES, FUNCOES_AUTZ, POLITICAS, SECDEF];

async function inventariar(db: pg.Client): Promise<Objecto[]> {
  const saida: Objecto[] = [];
  for (const q of CONSULTAS) {
    const { rows } = await db.query(q);
    for (const r of rows) {
      saida.push({ tipo: r.tipo, nome: r.nome, assinatura: normalizar(r.assinatura ?? "") });
    }
  }
  return saida;
}

/**
 * Os três rascunhos que se suspeita terem produzido o drift.
 *
 * 🔴 Aplicados aqui só para PROVAR a proveniência, e não para a assumir. Se o
 *    lado canónico + estes três der exactamente o que produção tem, então o
 *    drift É estes ficheiros — e a reconciliação pode partir deles com
 *    fundamento. Se não der, alguém mexeu à mão, e isso muda tudo.
 */
const DRAFTS = [
  "supabase/migrations/draft/PROVISIONAL_collaborator_identity_expand.sql",
  "supabase/migrations/draft/PROVISIONAL_collaborator_identity_resolver_rls.sql",
  "supabase/migrations/draft/PROVISIONAL_collaborator_identity_resolver_rls_lote2.sql",
];

async function ladoCanonico(comDrafts = false): Promise<Objecto[]> {
  const contentor = await startPostgresContainer({
    name: `drift-canonical-${process.pid}`, database: "canonico", memory: "512m",
  });
  const db = new pg.Client({ ...contentor.connection });
  try {
    await db.connect();
    // 🔴 SEM `pre-102-authorization-helpers.sql`. É o ponto deste ficheiro: o
    //    lado canónico é o que as migrations do repositório constroem, e nada
    //    mais. Injectar a fixture que fabrica o drift responderia à pergunta
    //    errada — que foi exactamente o defeito da primeira prova.
    await db.query(baselineCompleto());
    await db.query("ALTER ROLE service_role BYPASSRLS;");
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS clients_id_company_unique
        ON public.clients (id, company_id);
      ALTER TABLE public.data_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
      CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS TRIGGER AS $upd$
        BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $upd$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION public.fn_capture_history() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $h$
        BEGIN RETURN COALESCE(NEW, OLD); END; $h$;
    `);
    await db.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    `);
    for (const m of MIGRATIONS_CRM) await db.query(migrationCrm(m));
    if (comDrafts) {
      const { readFileSync } = await import("node:fs");
      for (const d of DRAFTS) await db.query(readFileSync(d, "utf8"));
    }
    return await inventariar(db);
  } finally {
    await db.end().catch(() => { /* já fechada */ });
    contentor.stop();
  }
}

async function ladoProducao(ref: string): Promise<Objecto[]> {
  // `loadEnvFile` é `.mjs` com tipos de JSDoc: o TypeScript vê `{}`.
  const url = (loadEnvFile() as Record<string, string | undefined>).SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL não está em .env.local.");
  if (!url.includes(ref)) throw new Error(`A SUPABASE_DB_URL não menciona "${ref}".`);

  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query("BEGIN READ ONLY");
    const r = await inventariar(db);
    await db.query("ROLLBACK");
    return r;
  } finally {
    await db.end().catch(() => { /* já fechada */ });
  }
}

/** Os objectos que este manifesto existe para decidir. */
const DOMINIO_DE_IDENTIDADE = (o: Objecto) =>
  /auth_user_id|must_change_password|get_my_profile_id|get_my_company_id|get_my_role|can_access_service|profiles_id_fkey|idx_profiles_company_auth/.test(
    `${o.nome} ${o.assinatura ?? ""}`,
  );

async function main(): Promise<void> {
  const ref = arg("project-ref");
  if (!ref) { console.error("Falta --project-ref <ref>."); process.exit(2); }

  const comDrafts = process.argv.includes("--com-drafts");
  const [canonico, producao] = [await ladoCanonico(comDrafts), await ladoProducao(ref as string)];
  if (comDrafts) {
    console.log("🔴 lado canónico COM os três rascunhos aplicados — a medir proveniência.");
  }

  const chave = (o: Objecto) => `${o.tipo}::${o.nome}`;
  const mapaC = new Map(canonico.map((o) => [chave(o), o]));
  const mapaP = new Map(producao.map((o) => [chave(o), o]));

  const todas = new Set([...mapaC.keys(), ...mapaP.keys()]);
  const linhas: { chave: string; classificacao: Classificacao; canonico?: string; producao?: string }[] = [];

  for (const k of [...todas].sort()) {
    const c = mapaC.get(k);
    const p = mapaP.get(k);
    let classificacao: Classificacao;
    if (c && p) classificacao = c.assinatura === p.assinatura ? "CANONICAL_AND_LIVE" : "DIVERGENT";
    else if (p) classificacao = "LIVE_ONLY";
    else classificacao = "CANONICAL_ONLY";
    linhas.push({
      chave: k,
      classificacao,
      canonico: c?.assinatura ?? undefined,
      producao: p?.assinatura ?? undefined,
    });
  }

  const identidade = linhas.filter((l) => {
    const o = mapaP.get(l.chave) ?? mapaC.get(l.chave);
    return o ? DOMINIO_DE_IDENTIDADE(o) : false;
  });

  const contar = (ls: typeof linhas) => {
    const c: Record<string, number> = {};
    for (const l of ls) c[l.classificacao] = (c[l.classificacao] ?? 0) + 1;
    return c;
  };

  const relatorio = {
    geradoEm: new Date().toISOString(),
    projeto: ref,
    canonico: "production-schema-shape + HELPERS_LEGADOS + 101 + 101a (sem fixtures de drift)",
    totais: { objetos: linhas.length, ...contar(linhas) },
    dominioDeIdentidade: { objetos: identidade.length, ...contar(identidade) },
    identidade,
    tudo: linhas,
  };

  const destino = arg("json");
  if (destino) {
    writeFileSync(destino, `${JSON.stringify(relatorio, null, 2)}\n`, "utf8");
    console.log(`manifest em ${destino}`);
  }

  console.log("");
  console.log(`TOTAL ......... ${linhas.length} objectos`);
  for (const [k, v] of Object.entries(contar(linhas))) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log("");
  console.log(`DOMÍNIO DE IDENTIDADE ......... ${identidade.length}`);
  for (const l of identidade) {
    console.log(`  ${l.classificacao.padEnd(20)} ${l.chave}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
