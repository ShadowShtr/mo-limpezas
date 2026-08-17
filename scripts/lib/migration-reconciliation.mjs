// ============================================================================
// R0 — MANIFESTO DE RECONCILIAÇÃO DO LEDGER (só leitura)
// ============================================================================
//
// Responde, por migration, a sete perguntas:
//
//   1. o que o ficheiro versionado diz;
//   2. o que o ledger (`public._migrations`) diz;
//   3. o que o schema real contém;
//   4. onde divergem;
//   5. que evidência existe;
//   6. que evidência **não** existe;
//   7. se é candidata a reconciliação futura.
//
// 🔴 Não escreve. Não corrige. Não reconcilia. Produz um manifesto para uma
//    pessoa ler e decidir. A escrita no ledger é a ronda R1, separada, e não
//    existe aqui — nem sequer como comando desligado.
//
// ---------------------------------------------------------------------------
// Os três níveis de evidência, que não se confundem
// ---------------------------------------------------------------------------
//   1. **O objecto está materializado na base.** Provável por introspecção do
//      catálogo. É o que este módulo faz.
//
//   2. **O ficheiro versionado tem checksum X.** Trivial de calcular.
//
//   3. **Esse ficheiro é byte-a-byte o SQL que foi executado.** NÃO PROVÁVEL
//      quando a migration correu pelo SQL Editor: nada em lado nenhum regista
//      o texto executado. Não há hash guardado para comparar — é precisamente
//      por isso que o ledger está vazio para estas migrations.
//
// O nível 3 é o que separa "reconciliação" de "adopção administrativa do
// estado actual". O manifesto diz qual dos dois está a acontecer, em vez de
// deixar a distinção implícita.
//
// Por isso `CURRENT_FILE_CHECKSUM` chama-se assim e nunca `APPLIED_CHECKSUM`:
// é o checksum que o runner *passaria a considerar canónico* se
// reconciliássemos hoje. Não é o checksum do que correu.
//
// ---------------------------------------------------------------------------
// Porque é que a prova é o catálogo, e não uma mensagem de erro
// ---------------------------------------------------------------------------
// Durante a descoberta (2026-08-17), a prova de que a 072/073 estavam
// aplicadas veio de as funções responderem com as mensagens de negócio
// escritas nelas próprias. Foi evidência forte e serviu para desfazer um falso
// negativo do PostgREST — mas é um método mau para uma ferramenta: exige
// **provocar erros de negócio** contra uma base real para saber o que lá está.
//
// Aqui a introspecção é `pg_proc`, `pg_trigger`, `information_schema`. Perguntar
// à base o que ela tem, em vez de lhe pedir que falhe de uma maneira
// reconhecível.
// ============================================================================

import { readFileSync } from "fs";
import { join } from "path";

// 🔴 Reutilizado, nunca reimplementado. Um segundo algoritmo de checksum que
//    divergisse um bit do runner produzia um manifesto que recomendava gravar
//    um valor que o runner depois rejeitava.
import {
  checksumForNewMigration,
  historicalChecksumMatches,
} from "./migration-checksum.mjs";

// ─── Vocabulário ─────────────────────────────────────────────────────────────

export const LEDGER = Object.freeze({
  PRESENT: "PRESENT",
  ABSENT: "ABSENT",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  ERROR: "ERROR",
});

export const SCHEMA = Object.freeze({
  PRESENT: "PRESENT",
  ABSENT: "ABSENT",
  PARTIAL: "PARTIAL",
  UNKNOWN: "UNKNOWN",
  ERROR: "ERROR",
});

/** O nível 3 da evidência. Ver o cabeçalho. */
export const CORRESPONDENCE = Object.freeze({
  PROVEN: "PROVEN",
  UNPROVABLE: "UNPROVABLE",
  CONTRADICTED: "CONTRADICTED",
});

export const RECOMMENDATION = Object.freeze({
  NOT_CANDIDATE: "NOT_CANDIDATE",
  CANDIDATE_WITH_ASSUMPTION: "CANDIDATE_WITH_ASSUMPTION",
  BLOCKED: "BLOCKED",
  ALREADY_RECONCILED: "ALREADY_RECONCILED",
});

// ─── Introspecção (só SELECT) ────────────────────────────────────────────────

/**
 * Todas as queries deste módulo passam por aqui, e todas são `SELECT`.
 *
 * O teste de firewall (`migration-reconciliation.test.ts`) captura o SQL
 * **executado** e recusa qualquer verbo de escrita. Nota deliberada: o texto
 * *devolvido* por `pg_get_functiondef` contém `CREATE OR REPLACE FUNCTION` —
 * isso é um resultado, não uma instrução, e o detector analisa o que se envia,
 * nunca o que se recebe.
 */
async function selectRows(client, sql, params = []) {
  const r = await client.query(sql, params);
  return r?.rows ?? [];
}

export async function tabelaExiste(client, schema, tabela) {
  const rows = await selectRows(
    client,
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
    [schema, tabela],
  );
  return rows.length > 0;
}

/**
 * Colunas de uma tabela, com tipo e nulabilidade — não só o nome.
 *
 * 🔴 «A tabela existe» não é suficiente. O SQL Editor não é transaccional por
 *    omissão: uma execução interrompida a meio deixa a tabela criada e a coluna
 *    seguinte por criar. Só um diff coluna a coluna distingue isso de uma
 *    migration inteira.
 */
export async function colunasDe(client, schema, tabela) {
  const rows = await selectRows(
    client,
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [schema, tabela],
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(String(r.column_name), {
      type: String(r.data_type),
      nullable: String(r.is_nullable).toUpperCase() === "YES",
    });
  }
  return mapa;
}

/**
 * Funções por nome, **com assinatura**.
 *
 * §37: uma função com o nome certo e a assinatura errada não é a função que a
 * migration declara. Comparar só o nome daria `PRESENT` a um schema onde a
 * chamada real falharia.
 */
export async function funcoesDe(client, schema, nome) {
  const rows = await selectRows(
    client,
    `SELECT p.proname,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid)             AS returns
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2`,
    [schema, nome],
  );
  return rows.map((r) => ({
    name: String(r.proname),
    args: String(r.args ?? ""),
    returns: String(r.returns ?? ""),
  }));
}

/**
 * Triggers de uma tabela, com a função alvo e o estado de activação.
 *
 * É isto que permite verificar a 070 **sem escrever em `profiles`**. A guarda
 * dá curto-circuito para `service_role`, por isso provocá-la exigiria uma
 * escrita real sob identidade não-admin — mas `pg_trigger` diz que ela lá está
 * sem tocar em nenhuma linha de dados.
 *
 * `tgenabled`: 'O' = origin (activo), 'D' = disabled, 'R'/'A' = replica/always.
 * Um trigger desactivado existe e não corre — e isso tem de aparecer.
 */
export async function triggersDe(client, schema, tabela) {
  const rows = await selectRows(
    client,
    `SELECT t.tgname,
            t.tgenabled,
            fn.proname AS function_name,
            fns.nspname AS function_schema
       FROM pg_trigger t
       JOIN pg_class c   ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc fn   ON fn.oid = t.tgfoid
       JOIN pg_namespace fns ON fns.oid = fn.pronamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal`,
    [schema, tabela],
  );
  return rows.map((r) => ({
    name: String(r.tgname),
    enabled: String(r.tgenabled ?? "") === "O",
    enabledRaw: String(r.tgenabled ?? ""),
    functionName: String(r.function_name),
    functionSchema: String(r.function_schema),
  }));
}

/** Índices de uma tabela, por nome. Para o `uq_invoices_number_per_company`. */
export async function indicesDe(client, schema, tabela) {
  const rows = await selectRows(
    client,
    `SELECT i.relname AS index_name
       FROM pg_class t
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_index ix ON ix.indrelid = t.oid
       JOIN pg_class i  ON i.oid = ix.indexrelid
      WHERE n.nspname = $1 AND t.relname = $2`,
    [schema, tabela],
  );
  return new Set(rows.map((r) => String(r.index_name)));
}

// ─── Fingerprints esperados ──────────────────────────────────────────────────
//
// O que cada migration declara, ao nível a que dá para verificar. Só migrations
// com fingerprint entram no manifesto — uma migration nova e genuinamente
// pendente não é assunto desta ferramenta.

export const FINGERPRINTS = Object.freeze({
  "070_guard_profile_managed_fields.sql": Object.freeze({
    functions: Object.freeze([{ schema: "public", name: "fn_guard_profile_managed_fields" }]),
    triggers: Object.freeze([
      {
        schema: "public",
        table: "profiles",
        name: "trg_guard_profile_managed_fields",
        functionName: "fn_guard_profile_managed_fields",
      },
    ]),
    tables: Object.freeze([]),
    columns: Object.freeze([]),
    indexes: Object.freeze([]),
  }),

  "071_finance_periods_and_expense_categories.sql": Object.freeze({
    functions: Object.freeze([]),
    triggers: Object.freeze([]),
    tables: Object.freeze([
      {
        schema: "public",
        name: "expense_categories",
        columns: Object.freeze([
          { name: "id", type: "uuid", nullable: false },
          { name: "company_id", type: "uuid", nullable: false },
          { name: "name", type: "text", nullable: false },
          { name: "normalized_name", type: "text", nullable: false },
          { name: "color_token", type: "text", nullable: true },
          { name: "icon", type: "text", nullable: true },
          { name: "active", type: "boolean", nullable: false },
          { name: "sort_order", type: "integer", nullable: false },
        ]),
      },
      {
        schema: "public",
        name: "financial_periods",
        columns: Object.freeze([
          { name: "id", type: "uuid", nullable: false },
          { name: "company_id", type: "uuid", nullable: false },
          { name: "year", type: "smallint", nullable: false },
          { name: "month", type: "smallint", nullable: false },
          { name: "status", type: "text", nullable: false },
          { name: "closed_at", type: "timestamp with time zone", nullable: true },
          { name: "closed_by", type: "uuid", nullable: true },
          { name: "reopened_at", type: "timestamp with time zone", nullable: true },
          { name: "reopened_by", type: "uuid", nullable: true },
          { name: "reopen_reason", type: "text", nullable: true },
        ]),
      },
    ]),
    columns: Object.freeze([
      { schema: "public", table: "cash_flow_entries", name: "expense_category_id", type: "uuid", nullable: true },
      { schema: "public", table: "fixed_variable_payments", name: "expense_category_id", type: "uuid", nullable: true },
    ]),
    indexes: Object.freeze([]),
  }),

  "072_invoice_atomic_creation.sql": Object.freeze({
    functions: Object.freeze([
      {
        schema: "public",
        name: "create_invoice_with_items",
        // Assinatura tal como a 072 a declara. §37: nome igual + assinatura
        // diferente não é a mesma função.
        args: "p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb",
      },
    ]),
    triggers: Object.freeze([]),
    tables: Object.freeze([]),
    columns: Object.freeze([]),
    indexes: Object.freeze([
      { schema: "public", table: "invoices", name: "uq_invoices_number_per_company" },
      { schema: "public", table: "invoices", name: "uq_invoices_draft_per_client_period" },
    ]),
  }),

  "073_payment_to_cashflow.sql": Object.freeze({
    functions: Object.freeze([
      { schema: "public", name: "is_financial_period_open", args: "p_company_id uuid, p_year integer, p_month integer" },
      { schema: "public", name: "mark_payment_paid", args: "p_company_id uuid, p_payment_id uuid, p_paid_on date" },
      { schema: "public", name: "unmark_payment_paid", args: "p_company_id uuid, p_payment_id uuid" },
    ]),
    triggers: Object.freeze([]),
    tables: Object.freeze([]),
    columns: Object.freeze([]),
    indexes: Object.freeze([]),
  }),
});

/**
 * Notas por migration que o manifesto transporta para quem decide.
 * §18: a existência da função da 072 não prova serialização concorrente.
 */
export const NOTAS = Object.freeze({
  "072_invoice_atomic_creation.sql": Object.freeze([
    "ATOMIC_EFFECT = PROVEN (ensaio em PGlite, no CI)",
    "CONCURRENT_SERIALIZATION = NOT_PROVEN (PGlite não dá duas ligações simultâneas)",
  ]),
});

// ─── Comparação ──────────────────────────────────────────────────────────────

/**
 * Normalização mínima de tipos. Deliberadamente pequena: só sinónimos que o
 * Postgres devolve para o mesmo tipo declarado.
 *
 * Não se inventa normalização a mais — um `text` que aparece como `character
 * varying` é uma diferença real e tem de aparecer como tal.
 */
function normalizarTipo(t) {
  const s = String(t ?? "").toLowerCase().trim();
  if (s === "timestamptz") return "timestamp with time zone";
  if (s === "int4" || s === "int") return "integer";
  if (s === "int2") return "smallint";
  if (s === "bool") return "boolean";
  return s;
}

function comparaTipo(esperado, actual) {
  if (!esperado) return true; // sem expectativa declarada → não se afirma nada
  return normalizarTipo(esperado) === normalizarTipo(actual);
}

/** Normaliza uma assinatura para comparação (espaços e maiúsculas). */
function normalizarArgs(a) {
  return String(a ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ─── Inspecção de uma migration ──────────────────────────────────────────────

/**
 * Estado do schema para uma migration, com o detalhe de cada objecto.
 *
 * `objectos` é uma lista plana de `{ tipo, alvo, estado, detalhe }` — é o que
 * o relatório humano imprime e o que torna um `PARTIAL` accionável em vez de
 * um veredicto sem explicação.
 */
export async function inspecionarSchema(client, migration) {
  const fp = FINGERPRINTS[migration];
  if (!fp) return { estado: SCHEMA.UNKNOWN, objectos: [], nota: "Sem fingerprint definido." };

  const objectos = [];

  try {
    for (const t of fp.tables) {
      const existe = await tabelaExiste(client, t.schema, t.name);
      if (!existe) {
        objectos.push({ tipo: "table", alvo: `${t.schema}.${t.name}`, estado: "ABSENT", detalhe: null });
        for (const c of t.columns) {
          objectos.push({
            tipo: "column",
            alvo: `${t.schema}.${t.name}.${c.name}`,
            estado: "ABSENT",
            detalhe: "tabela ausente",
          });
        }
        continue;
      }
      objectos.push({ tipo: "table", alvo: `${t.schema}.${t.name}`, estado: "PRESENT", detalhe: null });

      const cols = await colunasDe(client, t.schema, t.name);
      for (const c of t.columns) {
        const real = cols.get(c.name);
        if (!real) {
          objectos.push({
            tipo: "column",
            alvo: `${t.schema}.${t.name}.${c.name}`,
            estado: "ABSENT",
            detalhe: `esperado ${c.type}`,
          });
          continue;
        }
        const tipoOk = comparaTipo(c.type, real.type);
        const nulOk = c.nullable === undefined || c.nullable === real.nullable;
        objectos.push({
          tipo: "column",
          alvo: `${t.schema}.${t.name}.${c.name}`,
          estado: tipoOk && nulOk ? "PRESENT" : "MISMATCH",
          detalhe:
            tipoOk && nulOk
              ? null
              : `esperado ${c.type}/${c.nullable ? "null" : "not null"}, actual ${real.type}/${real.nullable ? "null" : "not null"}`,
        });
      }
    }

    for (const c of fp.columns) {
      const cols = await colunasDe(client, c.schema, c.table);
      const real = cols.get(c.name);
      const alvo = `${c.schema}.${c.table}.${c.name}`;
      if (!real) {
        objectos.push({ tipo: "column", alvo, estado: "ABSENT", detalhe: `esperado ${c.type}` });
        continue;
      }
      const tipoOk = comparaTipo(c.type, real.type);
      objectos.push({
        tipo: "column",
        alvo,
        estado: tipoOk ? "PRESENT" : "MISMATCH",
        detalhe: tipoOk ? null : `esperado ${c.type}, actual ${real.type}`,
      });
    }

    for (const f of fp.functions) {
      const encontradas = await funcoesDe(client, f.schema, f.name);
      const alvo = `${f.schema}.${f.name}()`;
      if (encontradas.length === 0) {
        objectos.push({ tipo: "function", alvo, estado: "ABSENT", detalhe: null });
        continue;
      }
      if (!f.args) {
        objectos.push({ tipo: "function", alvo, estado: "PRESENT", detalhe: null });
        continue;
      }
      const bate = encontradas.some((e) => normalizarArgs(e.args) === normalizarArgs(f.args));
      objectos.push({
        tipo: "function",
        alvo,
        // 🔴 Nome certo + assinatura errada **não** é PRESENT. A chamada real
        //    falharia, e um manifesto que dissesse PRESENT estaria a autorizar
        //    uma reconciliação sobre um schema que não é o que o ficheiro diz.
        estado: bate ? "PRESENT" : "MISMATCH",
        detalhe: bate ? null : `assinatura difere — actual: ${encontradas.map((e) => e.args).join(" | ")}`,
      });
    }

    for (const t of fp.triggers) {
      const encontrados = await triggersDe(client, t.schema, t.table);
      const alvo = `${t.schema}.${t.table} → ${t.name}`;
      const achado = encontrados.find((e) => e.name === t.name);
      if (!achado) {
        objectos.push({ tipo: "trigger", alvo, estado: "ABSENT", detalhe: null });
        continue;
      }
      if (achado.functionName !== t.functionName) {
        objectos.push({
          tipo: "trigger",
          alvo,
          // Trigger com o nome certo a apontar para outra função contradiz o
          // que o ficheiro declara — não é só "falta qualquer coisa".
          estado: "CONTRADICTED",
          detalhe: `aponta para ${achado.functionSchema}.${achado.functionName}, esperado ${t.functionName}`,
        });
        continue;
      }
      objectos.push({
        tipo: "trigger",
        alvo,
        estado: achado.enabled ? "PRESENT" : "MISMATCH",
        detalhe: achado.enabled ? null : `existe mas está desactivado (tgenabled=${achado.enabledRaw})`,
      });
    }

    for (const i of fp.indexes) {
      const idx = await indicesDe(client, i.schema, i.table);
      objectos.push({
        tipo: "index",
        alvo: `${i.schema}.${i.table}.${i.name}`,
        estado: idx.has(i.name) ? "PRESENT" : "ABSENT",
        detalhe: null,
      });
    }
  } catch (e) {
    return {
      estado: SCHEMA.ERROR,
      objectos,
      nota: e instanceof Error ? e.message : "Erro de introspecção.",
    };
  }

  if (objectos.length === 0) return { estado: SCHEMA.UNKNOWN, objectos, nota: "Fingerprint vazio." };

  const contradiz = objectos.some((o) => o.estado === "CONTRADICTED");
  const presentes = objectos.filter((o) => o.estado === "PRESENT").length;
  const problemas = objectos.filter((o) => o.estado !== "PRESENT").length;

  let estado;
  if (contradiz) estado = SCHEMA.PARTIAL; // contradição nunca é PRESENT
  else if (problemas === 0) estado = SCHEMA.PRESENT;
  else if (presentes === 0) estado = SCHEMA.ABSENT;
  else estado = SCHEMA.PARTIAL;

  return { estado, objectos, nota: null };
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

/**
 * Estado do ledger para uma migration.
 *
 * `CHECKSUM_MISMATCH` é o caso da 022: a linha existe, mas o checksum guardado
 * não corresponde a nenhuma representação (RAW/LF/CRLF) do ficheiro actual —
 * o ficheiro foi editado depois de aplicado. `historicalChecksumMatches` é a
 * mesma função que o runner usa, por isso o veredicto aqui e lá coincidem.
 */
export function avaliarLedger(linhaLedger, conteudoFicheiro) {
  if (linhaLedger === undefined || linhaLedger === null) {
    return { estado: LEDGER.ABSENT, storedChecksum: null };
  }
  const stored = linhaLedger.checksum ?? null;
  if (!stored) {
    // Linha sem checksum: registada por uma versão antiga do runner. Está
    // reconciliada quanto à presença, mas não há valor para comparar.
    return { estado: LEDGER.PRESENT, storedChecksum: null, semChecksum: true };
  }
  if (historicalChecksumMatches(stored, conteudoFicheiro)) {
    return { estado: LEDGER.PRESENT, storedChecksum: stored };
  }
  return { estado: LEDGER.CHECKSUM_MISMATCH, storedChecksum: stored };
}

// ─── Correspondência e recomendação ──────────────────────────────────────────

/**
 * O nível 3 da evidência.
 *
 * 🔴 `PROVEN` só é possível quando o ledger tem um checksum que bate com o
 *    ficheiro — ou seja, quando o runner aplicou a migration e registou o que
 *    aplicou. Para tudo o que correu no SQL Editor, a resposta é
 *    `UNPROVABLE`, **mesmo que todos os objectos coincidam**: objectos iguais
 *    provam que o schema é compatível com o ficheiro, não que o texto
 *    executado foi aquele.
 */
export function avaliarCorrespondencia({ ledgerEstado, schemaEstado }) {
  if (ledgerEstado === LEDGER.CHECKSUM_MISMATCH) return CORRESPONDENCE.CONTRADICTED;
  if (ledgerEstado === LEDGER.PRESENT) return CORRESPONDENCE.PROVEN;
  if (schemaEstado === SCHEMA.ERROR || schemaEstado === SCHEMA.UNKNOWN) return CORRESPONDENCE.UNPROVABLE;
  return CORRESPONDENCE.UNPROVABLE;
}

export function recomendar({ ledgerEstado, schemaEstado, correspondencia, semChecksum = false }) {
  if (ledgerEstado === LEDGER.ERROR || schemaEstado === SCHEMA.ERROR) return RECOMMENDATION.BLOCKED;

  // Ficheiro editado depois de aplicado. Reconciliar por cima gravaria como
  // canónico um texto que já se sabe não ser o que correu.
  if (ledgerEstado === LEDGER.CHECKSUM_MISMATCH) return RECOMMENDATION.BLOCKED;

  if (ledgerEstado === LEDGER.PRESENT) {
    return semChecksum ? RECOMMENDATION.CANDIDATE_WITH_ASSUMPTION : RECOMMENDATION.ALREADY_RECONCILED;
  }

  // Ledger ausente a partir daqui.
  if (schemaEstado === SCHEMA.PRESENT) {
    // Schema completo, ledger vazio: é a adopção administrativa. Candidata,
    // **com a assunção explícita** de que o ficheiro versionado é a
    // representação canónica pretendida do que já lá está.
    return correspondencia === CORRESPONDENCE.CONTRADICTED
      ? RECOMMENDATION.BLOCKED
      : RECOMMENDATION.CANDIDATE_WITH_ASSUMPTION;
  }

  // Materialização parcial: precisa de análise objecto a objecto, à mão.
  if (schemaEstado === SCHEMA.PARTIAL) return RECOMMENDATION.BLOCKED;

  // Sem prova nenhuma sobre o schema — não se transforma ausência de prova em
  // prova de ausência, nem em autorização.
  if (schemaEstado === SCHEMA.UNKNOWN) return RECOMMENDATION.NOT_CANDIDATE;

  // Schema ausente: é uma migration genuinamente pendente. O runner aplica-a
  // normalmente; não é assunto de reconciliação.
  return RECOMMENDATION.NOT_CANDIDATE;
}

// ─── Manifesto ───────────────────────────────────────────────────────────────

/**
 * Constrói o manifesto. Determinístico: a mesma entrada dá exactamente a mesma
 * saída, sem timestamps nem ordem dependente de `Map`.
 *
 * `lerLedger` é injectado para o CI poder correr com fixtures sem base de
 * dados nenhuma. A decisão nunca depende de haver um Supabase real.
 */
export async function construirManifesto({
  client,
  migrationsDir,
  migrations = Object.keys(FINGERPRINTS),
  lerLedger,
}) {
  const entradas = [];

  let ledgerMapa = new Map();
  let ledgerErro = null;
  try {
    ledgerMapa = await lerLedger();
  } catch (e) {
    ledgerErro = e instanceof Error ? e.message : "Erro ao ler o ledger.";
  }

  for (const migration of [...migrations].sort()) {
    let conteudo = null;
    let ficheiroErro = null;
    try {
      conteudo = readFileSync(join(migrationsDir, migration), "utf8");
    } catch (e) {
      ficheiroErro = e instanceof Error ? e.message : "Ficheiro não encontrado.";
    }

    const currentFileChecksum = conteudo === null ? null : checksumForNewMigration(conteudo);

    const ledger = ledgerErro
      ? { estado: LEDGER.ERROR, storedChecksum: null }
      : avaliarLedger(ledgerMapa.get(migration), conteudo ?? "");

    const schema = ficheiroErro
      ? { estado: SCHEMA.UNKNOWN, objectos: [], nota: ficheiroErro }
      : await inspecionarSchema(client, migration);

    const correspondence = avaliarCorrespondencia({
      ledgerEstado: ledger.estado,
      schemaEstado: schema.estado,
    });

    const recommendation = recomendar({
      ledgerEstado: ledger.estado,
      schemaEstado: schema.estado,
      correspondencia: correspondence,
      semChecksum: Boolean(ledger.semChecksum),
    });

    entradas.push({
      migration,
      ledger: {
        state: ledger.estado,
        storedChecksum: ledger.storedChecksum,
        error: ledgerErro,
      },
      schema: {
        state: schema.estado,
        objects: schema.objectos,
        note: schema.nota,
      },
      currentFile: {
        // 🔴 O nome importa. Não é `APPLIED_CHECKSUM`: é o valor que o runner
        //    passaria a tratar como canónico se reconciliássemos hoje.
        CURRENT_FILE_CHECKSUM: currentFileChecksum,
        error: ficheiroErro,
      },
      evidence: {
        OBJECT_PRESENCE:
          schema.estado === SCHEMA.PRESENT
            ? "PROVEN"
            : schema.estado === SCHEMA.PARTIAL
              ? "PARTIAL"
              : "NOT_PROVEN",
        notes: NOTAS[migration] ?? [],
      },
      correspondence: {
        CORRESPONDENCE_TO_EXECUTED_SQL: correspondence,
        assumption:
          correspondence === CORRESPONDENCE.UNPROVABLE
            ? "A migration versionada é a representação canónica pretendida do schema já materializado. " +
              "Esta assunção NÃO é estabelecida pelo checksum do ficheiro."
            : null,
      },
      recommendation,
    });
  }

  return { entries: entradas };
}

/** Relatório humano. Só nomes de objectos e estados — nunca dados nem credenciais. */
export function formatarManifesto(manifesto) {
  const linhas = [];
  for (const e of manifesto.entries) {
    linhas.push(`${e.migration}`);
    linhas.push(`   ledger : ${e.ledger.state}${e.ledger.storedChecksum ? ` (checksum ${e.ledger.storedChecksum.slice(0, 12)}…)` : ""}`);
    linhas.push(`   schema : ${e.schema.state}`);
    for (const o of e.schema.objects) {
      const marca = o.estado === "PRESENT" ? "✓" : o.estado === "ABSENT" ? "✗" : "!";
      linhas.push(`      ${marca} ${o.tipo} ${o.alvo}${o.detalhe ? ` — ${o.detalhe}` : ""}`);
    }
    if (e.schema.note) linhas.push(`      nota: ${e.schema.note}`);
    linhas.push(`   CURRENT_FILE_CHECKSUM: ${e.currentFile.CURRENT_FILE_CHECKSUM ?? "(sem ficheiro)"}`);
    linhas.push(`   CORRESPONDENCE_TO_EXECUTED_SQL: ${e.correspondence.CORRESPONDENCE_TO_EXECUTED_SQL}`);
    for (const n of e.evidence.notes) linhas.push(`   · ${n}`);
    if (e.correspondence.assumption) {
      linhas.push(`   ⚠️ ${e.correspondence.assumption}`);
    }
    linhas.push(`   → ${e.recommendation}`);
    linhas.push("");
  }

  linhas.push("Nenhuma escrita foi feita. A reconciliação do ledger é a ronda R1,");
  linhas.push("separada, e depende de revisão humana deste manifesto.");
  return linhas;
}
