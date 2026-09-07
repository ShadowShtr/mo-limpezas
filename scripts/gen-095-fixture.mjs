// ============================================================================
// Gera o fixture da RPC de conciliacao COMO ESTA EM PRODUCAO
// ============================================================================
//
// A suite da 095 parte do estado real: `confirm_bank_match_atomic` tal como a
// 082 a deixou, sem guarda de periodo. E sobre ela que o `CREATE OR REPLACE` da
// 095 actua.
//
// Uso: node scripts/gen-095-fixture.mjs

import { readFileSync, writeFileSync } from "node:fs";

const ORIGEM = "supabase/migrations/082_atomic_finance_mutations.sql";
const DESTINO = "src/__tests__/fixtures/pre-095-bank-rpc.sql";
const NOME = "confirm_bank_match_atomic";

const src = readFileSync(ORIGEM, "utf8");
const inicio = src.indexOf(`CREATE OR REPLACE FUNCTION public.${NOME}(`);
if (inicio < 0) throw new Error(`${ORIGEM} nao define ${NOME} — a base mudou de forma.`);
const fim = src.indexOf("\n$fn$;", inicio);
if (fim < 0) throw new Error(`nao encontrei o fim de ${NOME}`);

const out =
  `-- GERADO de ${ORIGEM} por scripts/gen-095-fixture.mjs. Nao editar a mao.\n` +
  "-- A RPC de conciliacao COMO ESTA EM PRODUCAO (sem guarda de periodo).\n\n" +
  src.slice(inicio, fim + 6) + "\n";

writeFileSync(DESTINO, out);
console.log(`${DESTINO}: ${out.split("\n").length} linhas.`);
