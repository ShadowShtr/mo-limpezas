// ============================================================================
// Gera o fixture das RPCs de cobranças avulsas COMO ESTÃO EM PRODUÇÃO
// ============================================================================
//
// A suite da 091 precisa de partir do estado real: as três RPCs da 086, sem
// guarda de período, para que o `CREATE OR REPLACE` da 091 tenha alguma coisa
// para substituir. Um `CREATE OR REPLACE` sobre uma função que não existe cria
// uma nova — e o teste passaria sem nunca provar a substituição.
//
// 🔴 O fixture é EXTRAÍDO da 086, não escrito à mão.
//
//    Uma cópia manual diverge no dia em que alguém corrigir a 086 e não o
//    fixture, e a suite passaria a provar a substituição de uma função que já
//    não existe em lado nenhum. Extrair mantém as duas coladas por construção.
//
// Uso: node scripts/gen-086-fixture.mjs

import { readFileSync, writeFileSync } from "node:fs";

const ORIGEM = "supabase/migrations/086_manual_charges_and_atomic_billing.sql";
const DESTINO = "src/__tests__/fixtures/086-manual-charges-rpcs.sql";
const DESTINO_TABELA = "src/__tests__/fixtures/086-manual-charges-table.sql";
const DESTINO_073 = "src/__tests__/fixtures/073-is-financial-period-open.sql";

/** As que a 091 substitui. `create_manual_charge_atomic` não está aqui: é nova. */
const NOMES = [
  "set_manual_charge_payment_atomic",
  "void_manual_charge_atomic",
  "update_manual_charge_atomic",
];

const src = readFileSync(ORIGEM, "utf8");

let out =
  `-- GERADO de ${ORIGEM}\n` +
  "-- As RPCs de cobrancas avulsas COMO ESTAO EM PRODUCAO (sem guarda de periodo).\n" +
  "-- E sobre estas que o CREATE OR REPLACE da 091 actua. Nao editar a mao:\n" +
  "-- regenerar com scripts/gen-086-fixture.mjs.\n\n";

const blocos = [];
for (const nome of NOMES) {
  const inicio = src.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`);
  if (inicio < 0) throw new Error(`086 não tem ${nome} — a fundação mudou de forma.`);

  const fim = src.indexOf("\n$fn$;", inicio);
  if (fim < 0) throw new Error(`não encontrei o fim de ${nome}`);

  blocos.push(src.slice(inicio, fim + 6));
}

// Uma linha em branco entre blocos, e uma só no fim — `git diff --check`
// recusa a linha em branco a mais que um `join` ingénuo deixava.
out += `${blocos.join("\n\n")}\n`;

writeFileSync(DESTINO, out);
console.log(`${DESTINO}: ${out.split("\n").length} linhas, ${NOMES.length} funções.`);

// ─── A tabela, para o shadow ────────────────────────────────────────────────
//
// O shadow parte do dump da forma real de produção, que é anterior à 086 e por
// isso não tem `manual_charges`. A tabela vem daqui — da própria 086, com as
// suas FKs e constraints — em vez de ser redigitada, pela mesma razão das
// funções.
const MARCA_TABELA = "CREATE TABLE IF NOT EXISTS public.manual_charges (";
const iTabela = src.indexOf(MARCA_TABELA);
if (iTabela < 0) throw new Error("086 não tem a tabela manual_charges — a fundação mudou de forma.");

const fimTabela = src.indexOf("\n);", iTabela);
if (fimTabela < 0) throw new Error("não encontrei o fim da tabela manual_charges");

const tabela =
  `-- GERADO de ${ORIGEM}\n` +
  "-- A tabela manual_charges COMO A 086 A CRIOU. Nao editar a mao:\n" +
  "-- regenerar com scripts/gen-086-fixture.mjs.\n\n" +
  `${src.slice(iTabela, fimTabela + 3)}\n`;

writeFileSync(DESTINO_TABELA, tabela);
console.log(`${DESTINO_TABELA}: ${tabela.split("\n").length} linhas.`);

// ─── `is_financial_period_open`, da 073 ─────────────────────────────────────
//
// A precondição da 090 exige esta função com a assinatura exacta, e produção
// tem-na desde a 073. O dump da forma não traz funções, por isso o shadow
// precisa dela — extraída, e não redigitada: a assinatura é o contrato que a
// 090 verifica, e uma cópia à mão podia divergir precisamente aí.
const ORIGEM_073 = "supabase/migrations/073_payment_to_cashflow.sql";
const src073 = readFileSync(ORIGEM_073, "utf8");

const iFn = src073.indexOf("CREATE OR REPLACE FUNCTION public.is_financial_period_open(");
if (iFn < 0) throw new Error("073 não tem is_financial_period_open");

const fimFn = src073.indexOf("\n$$;", iFn);
if (fimFn < 0) throw new Error("não encontrei o fim de is_financial_period_open");

const fn =
  `-- GERADO de ${ORIGEM_073}\n` +
  "-- is_financial_period_open COMO ESTA EM PRODUCAO. Nao editar a mao:\n" +
  "-- regenerar com scripts/gen-086-fixture.mjs.\n\n" +
  `${src073.slice(iFn, fimFn + 4)}\n`;

writeFileSync(DESTINO_073, fn);
console.log(`${DESTINO_073}: ${fn.split("\n").length} linhas.`);
