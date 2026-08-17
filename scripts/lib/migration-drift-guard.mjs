// ============================================================================
// DRIFT GUARD — o ledger diz "pendente", o schema diz "já cá está"
// ============================================================================
//
// Origem (2026-08-17, verificação read-only contra a base real de produção):
// as migrations 071, 072 e 073 foram aplicadas pelo SQL Editor do Supabase.
// O SQL Editor não escreve em `public._migrations`, por isso o ledger ficou
// parado na 069. Estado provado:
//
//   SCHEMA:  071 presente   072 presente   073 presente   070 NÃO VERIFICADO
//   LEDGER:  071 ausente    072 ausente    073 ausente    070 ausente
//
// Para o runner, "ausente do ledger" significa "pendente". Um `--apply` hoje
// tentaria re-executar as três. São escritas com `IF NOT EXISTS` e
// `CREATE OR REPLACE`, portanto *provavelmente* passariam sem estragar nada —
// mas "provavelmente" não é uma garantia que se dê a uma base com dados
// financeiros reais lá dentro. E a 071 tem um `INSERT` de catálogo inicial que
// não é, por si, idempotente do mesmo modo que o DDL é.
//
// Por isso este módulo faz uma coisa só: **detecta a divergência e manda
// parar**. Não corrige.
//
// ---------------------------------------------------------------------------
// O que este módulo NUNCA faz
// ---------------------------------------------------------------------------
// 1. **Não escreve no ledger.** Nem `INSERT`, nem `UPDATE`, nem "já existe,
//    então registo automaticamente". A reconciliação é uma operação separada,
//    com autorização explícita — ver `docs/LEDGER-RECONCILIATION-PENDING.md`.
//    Um runner que se auto-reconcilia é um runner que apaga a prova de que
//    algo correu fora dele.
//
// 2. **Não inventa checksums.** Para uma migration aplicada por fora, o
//    checksum do ficheiro é o que o ficheiro tem hoje — não prova nada sobre
//    o que foi executado no SQL Editor naquele dia. Mostra-se como
//    `EXPECTED_FILE_CHECKSUM`, para quem reconciliar poder comparar, e fica
//    nisso.
//
// 3. **Não transforma ausência de prova em prova de ausência.** A 070 cria uma
//    função de guarda e um trigger sobre `profiles`. A função dá curto-circuito
//    para `service_role`, que é o único contexto disponível às ferramentas
//    automáticas — provar que está aplicada exigiria uma escrita em `profiles`
//    de produção sob uma identidade não-admin. Isso não se faz para satisfazer
//    um fingerprint. A 070 fica `UNKNOWN`, e `UNKNOWN` nunca autoriza um apply
//    nem o bloqueia por si só.
//
// ---------------------------------------------------------------------------
// Porque é que os fingerprints são só de objectos, e não de HTTP
// ---------------------------------------------------------------------------
// A primeira tentativa de verificação usou o PostgREST e concluiu, errado, que
// as funções da 072/073 não existiam: uma chamada RPC sem argumentos devolve
// `PGRST202` porque o PostgREST resolve funções por assinatura, não por nome.
// Funções que *sabemos* estar aplicadas (a 064 está no ledger) davam o mesmo
// 404. O falso negativo só apareceu porque havia um caso de controlo.
//
// Aqui a detecção é feita contra o catálogo do Postgres (`to_regclass`,
// `information_schema.columns`, `pg_proc`) — não contra códigos de estado HTTP.
// É a diferença entre perguntar à base o que ela tem e perguntar a um proxy
// se acha que consegue encaminhar uma chamada.
// ============================================================================

import { columnExists, tableExists } from "./migration-runner-core.mjs";

/**
 * Fingerprints — **só objectos verificados em produção a 2026-08-17**.
 *
 * Cada entrada é o conjunto de objectos que, se existirem todos, provam que
 * aquela migration correu. Deliberadamente não inclui tudo o que a migration
 * cria: índices e políticas RLS são mais frágeis de introspeccionar e não
 * acrescentam certeza a uma prova que as tabelas e funções já dão.
 *
 * A 070 **não tem entrada**, e a ausência é intencional — ver o ponto 3 no
 * cabeçalho. Não adicionar uma sem uma forma de prova que não passe por
 * escrever em `profiles` de produção.
 */
export const FINGERPRINTS = Object.freeze({
  "071_finance_periods_and_expense_categories.sql": Object.freeze({
    tables: Object.freeze(["public.expense_categories", "public.financial_periods"]),
    columns: Object.freeze([
      { schema: "public", table: "cash_flow_entries", column: "expense_category_id" },
      { schema: "public", table: "fixed_variable_payments", column: "expense_category_id" },
    ]),
    functions: Object.freeze([]),
  }),
  "072_invoice_atomic_creation.sql": Object.freeze({
    tables: Object.freeze([]),
    columns: Object.freeze([]),
    functions: Object.freeze(["create_invoice_with_items"]),
  }),
  "073_payment_to_cashflow.sql": Object.freeze({
    tables: Object.freeze([]),
    columns: Object.freeze([]),
    functions: Object.freeze(["mark_payment_paid", "unmark_payment_paid", "is_financial_period_open"]),
  }),
});

/** Migrations sem fingerprint seguro. Estado permanente: UNKNOWN. */
export const SEM_FINGERPRINT = Object.freeze({
  "070_guard_profile_managed_fields.sql":
    "A guarda da 070 é uma função + trigger sobre profiles que dá curto-circuito " +
    "para service_role. Provar presença exigiria escrever em profiles de produção " +
    "sob uma identidade não-admin — não se faz por um fingerprint.",
});

export const CODIGO_DRIFT = "MIGRATION_LEDGER_SCHEMA_DRIFT";
export const CODIGO_PARCIAL = "MIGRATION_PARTIALLY_MATERIALIZED";

/** SELECT puro contra `pg_proc`. Nunca executa a função — só pergunta se existe. */
export async function functionExists(client, schema, name) {
  const { rows } = await client.query(
    `SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2
      LIMIT 1`,
    [schema, name],
  );
  return rows.length > 0;
}

/**
 * Estado de materialização de UMA migration, por introspecção.
 *
 * `presentes`/`ausentes` são listas de nomes de objectos — nunca valores de
 * dados, nunca credenciais. O que sai daqui vai para stdout de CI.
 *
 * Devolve:
 *   · `PRESENT`  — todos os objectos do fingerprint existem;
 *   · `ABSENT`   — nenhum existe;
 *   · `PARTIAL`  — uns sim, outros não (o caso perigoso);
 *   · `UNKNOWN`  — sem fingerprint para decidir.
 */
export async function inspecionarSchema(client, migration) {
  if (SEM_FINGERPRINT[migration]) {
    return { estado: "UNKNOWN", presentes: [], ausentes: [], motivo: SEM_FINGERPRINT[migration] };
  }

  const fp = FINGERPRINTS[migration];
  if (!fp) return { estado: "UNKNOWN", presentes: [], ausentes: [], motivo: "Sem fingerprint definido." };

  const presentes = [];
  const ausentes = [];

  for (const t of fp.tables) {
    ((await tableExists(client, t)) ? presentes : ausentes).push(t);
  }
  for (const c of fp.columns) {
    const rotulo = `${c.schema}.${c.table}.${c.column}`;
    ((await columnExists(client, c.schema, c.table, c.column)) ? presentes : ausentes).push(rotulo);
  }
  for (const f of fp.functions) {
    const rotulo = `public.${f}()`;
    ((await functionExists(client, "public", f)) ? presentes : ausentes).push(rotulo);
  }

  const total = presentes.length + ausentes.length;
  if (total === 0) return { estado: "UNKNOWN", presentes, ausentes, motivo: "Fingerprint vazio." };

  let estado;
  if (ausentes.length === 0) estado = "PRESENT";
  else if (presentes.length === 0) estado = "ABSENT";
  else estado = "PARTIAL";

  return { estado, presentes, ausentes, motivo: null };
}

/**
 * Corre a detecção sobre as migrations que o ledger diz estarem pendentes.
 *
 * 🔴 Só introspecção. Zero INSERT/UPDATE/DELETE, zero RPC de escrita, zero
 *    DDL. Seguro em qualquer modo, incluindo antes de um `--apply`.
 *
 * Só olha para migrations **pendentes segundo o ledger**: uma que já está
 * registada não tem divergência a reportar, por definição.
 */
export async function detectarDrift({ client, pendentes }) {
  const achados = [];

  for (const migration of pendentes) {
    const temFingerprint = Boolean(FINGERPRINTS[migration]);
    const semProva = Boolean(SEM_FINGERPRINT[migration]);
    if (!temFingerprint && !semProva) continue; // migration nova, genuinamente pendente

    const r = await inspecionarSchema(client, migration);
    achados.push({
      migration,
      ledger: "ABSENT",
      schema: r.estado,
      presentes: r.presentes,
      ausentes: r.ausentes,
      motivo: r.motivo,
    });
  }

  // Só `PRESENT` e `PARTIAL` bloqueiam. `ABSENT` é uma migration realmente
  // pendente — é para isso que o runner existe. `UNKNOWN` não é prova de nada,
  // e portanto não é motivo para parar: bloquear por falta de prova travava o
  // runner para sempre por causa da 070.
  const bloqueiam = achados.filter((a) => a.schema === "PRESENT" || a.schema === "PARTIAL");
  const parciais = bloqueiam.filter((a) => a.schema === "PARTIAL");

  return {
    achados,
    bloqueiam,
    deveAbortar: bloqueiam.length > 0,
    codigo: parciais.length > 0 ? CODIGO_PARCIAL : bloqueiam.length > 0 ? CODIGO_DRIFT : null,
  };
}

/**
 * Relatório para stdout. Só nomes de objectos, estados e a acção necessária —
 * nunca chaves, URLs de ligação, valores financeiros ou dados pessoais.
 *
 * `checksumEsperado` é opcional e só informativo: serve para quem reconciliar
 * o ledger à mão poder comparar. Este módulo não o grava em sítio nenhum.
 */
export function formatarRelatorioDrift(resultado, { checksumEsperado = {} } = {}) {
  const linhas = [];

  for (const a of resultado.achados) {
    linhas.push(`  ${a.migration}`);
    linhas.push(`     ledger: ${a.ledger}   schema: ${a.schema}`);
    if (a.presentes.length > 0) linhas.push(`     presentes: ${a.presentes.join(", ")}`);
    if (a.ausentes.length > 0) linhas.push(`     ausentes:  ${a.ausentes.join(", ")}`);
    if (a.motivo) linhas.push(`     nota: ${a.motivo}`);
    const cs = checksumEsperado[a.migration];
    if (cs) linhas.push(`     EXPECTED_FILE_CHECKSUM: ${cs}`);
  }

  if (!resultado.deveAbortar) return linhas;

  linhas.push("");
  linhas.push(`❌ ${resultado.codigo}`);
  linhas.push("");
  linhas.push("   Estas migrations estão materializadas no schema mas ausentes de");
  linhas.push("   public._migrations. O runner considerá-las-ia pendentes e tentaria");
  linhas.push("   re-executá-las sobre uma base com dados reais.");
  linhas.push("");

  if (resultado.codigo === CODIGO_PARCIAL) {
    linhas.push("   🔴 Materialização PARCIAL: parte dos objectos existe e parte não.");
    linhas.push("      Re-executar às cegas pode falhar a meio ou duplicar dados de");
    linhas.push("      catálogo. Isto precisa de análise objecto a objecto, à mão.");
    linhas.push("");
  }

  linhas.push("   Acção necessária: reconciliar o ledger como operação separada e");
  linhas.push("   autorizada — ver docs/LEDGER-RECONCILIATION-PENDING.md.");
  linhas.push("   Este runner não reconcilia por iniciativa própria.");

  return linhas;
}
