// Ensaio da cadeia 077 → 078 → 079 sobre o estado PARCIAL real de produção.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";

const REPO = process.cwd();
const C = "chain-" + process.pid;
const PORT = 55713;
const d = (a) => spawnSync("docker", a, { encoding: "utf8" });
const res = [];
const v = (n, ok, det = "") => { res.push({ n, ok: !!ok }); console.log(`  ${ok ? "✔" : "✘"} ${n}${det ? "  — " + det : ""}`); };
const git = (ref) => spawnSync("git", ["show", ref], { cwd: REPO, encoding: "utf8", maxBuffer: 20e6 }).stdout;

const estado = JSON.parse(fs.readFileSync(REPO + "/src/__tests__/fixtures/production-078-partial-shape.json", "utf8"));
const SQL077 = git("origin/fix/secure-migrations-ledger:supabase/migrations/077_secure_migrations_ledger.sql");
const SQL078 = fs.readFileSync(REPO + "/supabase/migrations/078_domain_mutation_change_event_foundation.sql", "utf8");
const SQL079 = git("origin/fix/reuse-pending-cashflow-on-payment:supabase/migrations/079_reuse_pending_cashflow_on_payment.sql");
const SQL073 = git("origin/master:supabase/migrations/073_payment_to_cashflow.sql");

const tipo = (c) => c.udt_name.startsWith("_") ? c.udt_name.slice(1) + "[]" : c.udt_name;

function estadoParcial() {
  const L = [`
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $u$ SELECT NULL::uuid $u$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $r$ SELECT 'authenticated'::text $r$;
DO $p$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $p$;
CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), role text NOT NULL DEFAULT 'colaborador', auth_user_id uuid);
CREATE FUNCTION public.get_my_company_id() RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE AS $f$ SELECT company_id FROM public.profiles LIMIT 1 $f$;
CREATE FUNCTION public.get_my_role() RETURNS text LANGUAGE sql SECURITY DEFINER STABLE AS $f$ SELECT role FROM public.profiles LIMIT 1 $f$;
CREATE FUNCTION public.get_my_profile_id() RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE AS $f$ SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $f$;
CREATE TABLE public._migrations (name text PRIMARY KEY, checksum text, applied_at timestamptz DEFAULT now());
GRANT SELECT ON public._migrations TO anon, authenticated;`];

  for (const t of ["company_change_events", "domain_mutations"]) {
    const e = estado[t];
    const defs = e.cols.map((c) => {
      let s = `  ${c.column_name} ${tipo(c)}`;
      if (c.is_nullable === "NO") s += " NOT NULL";
      if (c.column_default) s += ` DEFAULT ${c.column_default}`;
      return s;
    });
    L.push(`CREATE TABLE public.${t} (\n${defs.join(",\n")}\n);`);
    for (const c of e.cons) L.push(`ALTER TABLE public.${t} ADD CONSTRAINT ${c.conname} ${c.def};`);
    for (const i of e.idx) {
      if (/_pkey$/.test(i.indexname)) continue;
      if (e.cons.some((c) => c.conname === i.indexname)) continue;
      L.push(`${i.indexdef};`);
    }
    if (e.rls?.relrowsecurity) L.push(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    for (const p of e.pol) {
      let s = `CREATE POLICY "${p.policyname}" ON public.${t} FOR ${p.cmd} TO ${p.roles.replace(/[{}]/g, "")}`;
      if (p.qual) s += ` USING (${p.qual})`;
      if (p.with_check) s += ` WITH CHECK (${p.with_check})`;
      L.push(s + ";");
    }
  }
  if (estado.fn_record) L.push(estado.fn_record + ";");
  return L.join("\n");
}

d(["rm", "-f", C]);
if (d(["run", "-d", "--name", C, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=r", "-p", `${PORT}:5432`, "postgres:16-alpine"]).status !== 0) {
  console.error("contentor falhou"); process.exit(1);
}
const lig = () => new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "r" });
let c = null;
const lim = Date.now() + 90000;
while (Date.now() < lim) {
  if (d(["exec", C, "pg_isready", "-U", "postgres", "-d", "r"]).status === 0) {
    const s = lig();
    try { await s.connect(); await s.query("select 1"); await s.end(); c = lig(); await c.connect(); break; }
    catch { try { await s.end(); } catch { /* nada */ } }
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!c) { console.error("pg nao subiu"); d(["rm", "-f", C]); process.exit(1); }

try {
  console.log("\n── 1. O estado PARCIAL que produção tem hoje");
  await c.query(estadoParcial());
  const p = await c.query(`select
    (select count(*)::int from pg_constraint where conrelid='public.company_change_events'::regclass) cons,
    to_regclass('public.company_sync_state') is null falta_css,
    to_regproc('public.next_company_sequence') is null falta_fn,
    (select count(*)::int from pg_policies where tablename='_migrations') pol_ledger`);
  v("company_change_events e domain_mutations existem", p.rows[0].cons > 0, `${p.rows[0].cons} constraints`);
  v("company_sync_state e as 4 funções em falta — como em produção", p.rows[0].falta_css && p.rows[0].falta_fn);
  v("o ledger está sem RLS — como em produção", p.rows[0].pol_ledger === 0);

  console.log("\n── 1b. 🔴 A função legada NÃO consegue inserir — está partida");
  await c.query("INSERT INTO public.companies(id,name) VALUES('11111111-1111-4111-8111-111111111111','A')");
  let erroLegado = "";
  try {
    await c.query(`SELECT public.record_company_change_event(
      '11111111-1111-4111-8111-111111111111'::uuid, gen_random_uuid(),
      'financeiro','teste','{}'::uuid[],'{}'::text[], NULL::tstzrange, '{}'::jsonb)`);
  } catch (e) { erroLegado = e.message; }
  v("🔴 chamar a legada falha por falta de `sequence`", /sequence/.test(erroLegado),
    erroLegado.split("\n")[0].slice(0, 80));
  const seqDef = await c.query(`select column_default is null sem_default,
      (select count(*)::int from pg_trigger where tgrelid='public.company_change_events'::regclass and not tgisinternal) trg
    from information_schema.columns
   where table_schema='public' and table_name='company_change_events' and column_name='sequence'`);
  v("  `sequence` é NOT NULL sem default, e a tabela não tem triggers",
    seqDef.rows[0].sem_default && seqDef.rows[0].trg === 0);

  console.log("\n── 2. 🔴 A ordem não é escolha: a 078 recusa sem a 077");
  let msg = "";
  try { await c.query(SQL078); } catch (e) { msg = e.message; }
  v("a 078 recusa, e diz porquê", /REQUIRED_MIGRATION_077_NOT_APPLIED/.test(msg),
    msg.split("\n")[0].slice(0, 90));

  console.log("\n── 3. 077 — fecha o ledger ao público");
  await c.query(SQL077);
  const r77 = await c.query(`select c.relrowsecurity r,
    (select count(*)::int from pg_policies where tablename='_migrations') n
    from pg_class c where c.oid='public._migrations'::regclass`);
  v("RLS activa em _migrations", r77.rows[0].r === true);
  v("e com política", r77.rows[0].n > 0, `${r77.rows[0].n}`);

  console.log("\n── 4. 🔴 A 078 exige a LINHA DE LEDGER, não só o efeito");
  let msg2 = "";
  try { await c.query(SQL078); } catch (e) { msg2 = e.message; }
  v("mesmo com a 077 aplicada, a 078 recusa sem a linha registada",
    /REQUIRED_MIGRATION_077_NOT_APPLIED/.test(msg2), msg2.split("\n")[0].slice(0, 90));

  // É o runner que escreve esta linha. Aqui simula-se o que ele faria.
  if (process.env.MUTACAO_LEDGER === "1") {
    console.log("  (MUTAÇÃO: a linha de ledger da 077 NÃO é escrita)");
  } else {
    await c.query(`INSERT INTO public._migrations(name, checksum) VALUES('077_secure_migrations_ledger.sql','ensaio')`);
  }

  console.log("\n── 5. 078 sobre o estado parcial");
  await c.query(SQL078);
  v("🔴 a 078 aplica sobre o parcial, sem erro", true);
  const objs = await c.query(`
    select 'company_sync_state' o, to_regclass('public.company_sync_state') is not null e
    union all select 'complete_domain_mutation', to_regproc('public.complete_domain_mutation') is not null
    union all select 'find_or_conflict_domain_mutation', to_regproc('public.find_or_conflict_domain_mutation') is not null
    union all select 'lock_domain_mutation', to_regproc('public.lock_domain_mutation') is not null
    union all select 'next_company_sequence', to_regproc('public.next_company_sequence') is not null`);
  for (const r of objs.rows) v(`  ${r.o} passa a existir`, r.e);

  const dup = await c.query(`
    select string_agg(conname,' + ') nomes from pg_constraint
     where conrelid='public.company_change_events'::regclass and contype='u'
     group by pg_get_constraintdef(oid) having count(*)>1`);
  v("🔴 nenhuma restrição única duplicada nas mesmas colunas", dup.rows.length === 0,
    dup.rows.map((r) => r.nomes).join(" | "));

  console.log("\n── 6. 079 no fim da cadeia");
  await c.query(`
    CREATE TABLE public.expense_categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, name text);
    CREATE TABLE public.financial_periods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, year smallint NOT NULL, month smallint NOT NULL, status text NOT NULL DEFAULT 'open');
    CREATE TABLE public.cash_flow_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, type text NOT NULL, amount numeric(10,2) NOT NULL, description text NOT NULL, category text, date date NOT NULL, reference_id uuid, reference_type text, status text NOT NULL DEFAULT 'confirmado', notes text, created_by uuid, created_at timestamptz DEFAULT now(), expense_category_id uuid);
    CREATE TABLE public.fixed_variable_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, kind text NOT NULL, description text NOT NULL, amount numeric(10,2), due_date date, status text NOT NULL DEFAULT 'pendente', recurring boolean NOT NULL DEFAULT false, period_year integer NOT NULL, period_month integer NOT NULL, paid_at timestamptz, expense_category_id uuid);
    CREATE UNIQUE INDEX cash_flow_entries_reference_unique ON public.cash_flow_entries (company_id, reference_type, reference_id) WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year int, p_month int) RETURNS boolean LANGUAGE sql STABLE AS $x$ SELECT true $x$;`);
  await c.query(SQL073);
  await c.query(SQL079);
  // O F14-A extraiu a validação para uma função própria — é lá que vivem os
  // códigos de erro, e é ela que `mark_payment_paid` chama.
  const t79 = await c.query(`select
      to_regproc('public.assert_payment_cashflow_link') is not null tem_guarda,
      (select position('assert_payment_cashflow_link' in pg_get_functiondef(p.oid))>0
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='mark_payment_paid') chama,
      (select position('CASHFLOW_LINK_AMOUNT_MISMATCH' in pg_get_functiondef(oid))>0
         from pg_proc where oid=to_regproc('public.assert_payment_cashflow_link')) valida`);
  v("🔴 a 079 aplica depois da 077 e da 078", t79.rows[0].tem_guarda);
  v("  e o mark_payment_paid chama a guarda do F14-A", t79.rows[0].chama);
  v("  que revalida o valor depois do conflito", t79.rows[0].valida);

  console.log("\n── 7. Segunda passagem — o contrato é do runner, não da migration");
  // A 078 e de uma so passagem, e de proposito: a impressao digital exige o
  // esquema legado, que ela propria transforma. Correr o SQL cru outra vez da
  // LEGACY_SCHEMA_UNEXPECTED — o que esta certo. Quem garante que nao corre
  // duas vezes e o runner, pelo ledger.
  let msg3 = "";
  try { await c.query(SQL078); } catch (e) { msg3 = e.message; }
  v("🔴 repetir a 078 recusa em vez de corromper", /LEGACY_SCHEMA_UNEXPECTED/.test(msg3),
    msg3.split("\n")[0].slice(0, 80));
  await c.query(SQL079);
  const rep = await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public' and p.proname in ('mark_payment_paid','assert_payment_cashflow_link')`);
  v("a 079 e CREATE OR REPLACE puro — repetir nao duplica", rep.rows[0].n === 2, `${rep.rows[0].n}`);
} catch (e) {
  v("o ensaio correu até ao fim", false, String(e.message).slice(0, 200));
} finally {
  try { await c.end(); } catch { /* já fechada */ }
  d(["rm", "-f", C]);
}
const f = res.filter((r) => !r.ok);
console.log(`\n═══ ${res.length - f.length}/${res.length} ═══`);
if (f.length) for (const x of f) console.log(`  ✘ ${x.n}`);
process.exit(f.length ? 1 : 0);
