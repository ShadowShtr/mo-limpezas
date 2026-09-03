// ============================================================================
// Gera o fixture da RPC de pagamento de servicos COMO ESTA EM PRODUCAO
// ============================================================================
//
// A suite da 097 parte do estado real: `set_service_payment_atomic` tal como a
// 086 a deixou, sem guarda de periodo. E sobre ela que o `CREATE OR REPLACE` da
// 097 actua.
//
// Uso: node scripts/gen-097-fixture.mjs

import { readFileSync, writeFileSync } from "node:fs";

const ORIGEM = "supabase/migrations/086_manual_charges_and_atomic_billing.sql";
const DESTINO = "src/__tests__/fixtures/pre-097-service-payment-rpc.sql";
const NOME = "set_service_payment_atomic";

const src = readFileSync(ORIGEM, "utf8");
const inicio = src.indexOf(`CREATE OR REPLACE FUNCTION public.${NOME}(`);
if (inicio < 0) throw new Error(`${ORIGEM} nao define ${NOME} — a base mudou de forma.`);
const fim = src.indexOf("\n$fn$;", inicio);
if (fim < 0) throw new Error(`nao encontrei o fim de ${NOME}`);

const out =
  `-- GERADO de ${ORIGEM} por scripts/gen-097-fixture.mjs. Nao editar a mao.\n` +
  "-- A RPC de pagamento de servicos COMO ESTA EM PRODUCAO (sem guarda de periodo).\n\n" +
  src.slice(inicio, fim + 6) + "\n";

writeFileSync(DESTINO, out);
console.log(`${DESTINO}: ${out.split("\n").length} linhas.`);
