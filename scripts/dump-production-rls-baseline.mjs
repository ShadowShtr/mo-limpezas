#!/usr/bin/env node
// ============================================================================
// GERA O BASELINE FIEL PARA OS ENSAIOS DE RLS
// ============================================================================
//
// 🔴 SÓ LEITURA. Uma consulta aos catálogos, mais nada. Não escreve na base,
//    não lê uma única linha de dados de negócio, e não imprime credenciais.
//
// Produz `src/__tests__/fixtures/production-schema-shape.sql` — a **forma** do
// schema de produção: tabelas, colunas, chaves, RLS e políticas. Sem dados.
//
// ---------------------------------------------------------------------------
// Porque é que isto passou a existir
// ---------------------------------------------------------------------------
//
// Seis ensaios em Postgres real escreviam o baseline à mão, com 3 a 13 tabelas.
// Produção tem 47 e 93 políticas. O ensaio do resolver conhecia 3 das 6
// políticas de `profiles`. As provas eram verdadeiras — sobre outro mundo.
//
// Foi um preflight read-only que mostrou a diferença: **71 das 93 políticas**
// resolvem a identidade por `auth.uid()`, e a migration tratava 10.
//
// Um baseline escrito à mão tende ao subconjunto que quem o escreveu tinha em
// mente. Este é gerado, e por isso não tem opinião.
//
//   node scripts/dump-production-rls-baseline.mjs
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const DESTINO = path.join(ROOT, "src", "__tests__", "fixtures", "production-schema-shape.sql");

/** 🔴 Só linhas com `KEY=`. Uma linha sem chave já expôs uma password. */
function lerEnvLocal() {
  const p = path.join(ROOT, ".env.local");
  if (!fs.existsSync(p)) return {};
  const env = {};
  for (const linha of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const i = linha.indexOf("=");
    if (i < 1) continue;
    const chave = linha.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) continue;
    env[chave] = linha.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = lerEnvLocal();
const url = env.SUPABASE_DB_URL;
if (!url) {
  console.error("Falta SUPABASE_DB_URL no .env.local.");
  process.exit(1);
}

const cliente = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await cliente.connect();

const { rows: cols } = await cliente.query(`
  SELECT table_name, column_name, udt_name, is_nullable, column_default,
         character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
   ORDER BY table_name, ordinal_position`);

const { rows: pks } = await cliente.query(`
  SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
   WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
   ORDER BY tc.table_name, kcu.ordinal_position`);

const { rows: rls } = await cliente.query(`
  SELECT c.relname, c.relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`);

const { rows: pol } = await cliente.query(`
  SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`);

const { rows: fks } = await cliente.query(`
  SELECT conrelid::regclass::text AS tabela, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace
   ORDER BY 1, 2`);

await cliente.end();

/** O tipo tal como o catálogo o dá — sem interpretação. */
function tipo(c) {
  const u = c.udt_name;
  if (u.startsWith("_")) return `${u.slice(1)}[]`;
  if (u === "varchar") return c.character_maximum_length ? `varchar(${c.character_maximum_length})` : "text";
  if (u === "numeric" && c.numeric_precision) return `numeric(${c.numeric_precision},${c.numeric_scale ?? 0})`;
  if (u === "bpchar") return "text";
  return u;
}

const porTabela = {};
for (const c of cols) (porTabela[c.table_name] ??= []).push(c);
const pkPor = {};
for (const p of pks) (pkPor[p.table_name] ??= []).push(p.column_name);

const L = [
  "-- GERADO por scripts/dump-production-rls-baseline.mjs — NÃO EDITAR À MÃO.",
  "-- Forma do schema de produção: tabelas, chaves, RLS e políticas. Sem dados.",
  "-- É a fidelidade que faltava: o baseline escrito à mão conhecia 3 das 6",
  "-- políticas de `profiles` e 2 das 8 de `timesheets`.",
  "",
];

for (const t of Object.keys(porTabela).sort()) {
  const defs = porTabela[t].map((c) => {
    let d = `  ${c.column_name} ${tipo(c)}`;
    if (c.is_nullable === "NO") d += " NOT NULL";
    // `nextval` referenciaria uma sequência que não existe num Postgres limpo.
    if (c.column_default && !/nextval\(/.test(c.column_default)) d += ` DEFAULT ${c.column_default}`;
    return d;
  });
  if (pkPor[t]?.length) defs.push(`  PRIMARY KEY (${pkPor[t].join(", ")})`);
  L.push(`CREATE TABLE public.${t} (`, defs.join(",\n"), `);`);
}

L.push("");
for (const f of fks) L.push(`ALTER TABLE ${f.tabela} ADD CONSTRAINT ${f.conname} ${f.def};`);
L.push("");
for (const r of rls) if (r.relrowsecurity) L.push(`ALTER TABLE public.${r.relname} ENABLE ROW LEVEL SECURITY;`);
L.push("");
for (const p of pol) {
  const roles = p.roles.replace(/[{}]/g, "");
  let c = `CREATE POLICY "${p.policyname}" ON public.${p.tablename} AS ${p.permissive} FOR ${p.cmd} TO ${roles}`;
  if (p.qual) c += `\n  USING (${p.qual})`;
  if (p.with_check) c += `\n  WITH CHECK (${p.with_check})`;
  L.push(`${c};`);
}

fs.writeFileSync(DESTINO, `${L.join("\n")}\n`);

const comIdentidadeLegada = pol.filter(
  (p) => /auth\.uid\(\)/.test(`${p.qual ?? ""} ${p.with_check ?? ""}`),
).length;

console.log(`tabelas   = ${Object.keys(porTabela).length}`);
console.log(`colunas   = ${cols.length}`);
console.log(`políticas = ${pol.length}   com auth.uid() = ${comIdentidadeLegada}`);
console.log(`chaves    = ${fks.length}`);
console.log(`escrito em ${path.relative(ROOT, DESTINO)}`);
