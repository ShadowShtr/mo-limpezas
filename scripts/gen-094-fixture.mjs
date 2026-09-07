// ============================================================================
// Gera o fixture da RPC de faturas COMO ESTA EM PRODUCAO
// ============================================================================
//
// A suite da 094 parte do estado real: `create_invoice_with_items` tal como a
// 072 a deixou, sem guarda de periodo. E sobre ela que o `CREATE OR REPLACE` da
// 094 actua — sem isto, a migration criava uma funcao nova em vez de substituir
// e a precondicao nunca seria exercitada.
//
// Uso: node scripts/gen-094-fixture.mjs

import { readFileSync, writeFileSync } from "node:fs";

const ORIGEM = "supabase/migrations/072_invoice_atomic_creation.sql";
const DESTINO = "src/__tests__/fixtures/pre-094-invoice-rpc.sql";
const NOME = "create_invoice_with_items";

const src = readFileSync(ORIGEM, "utf8");
const inicio = src.indexOf(`CREATE OR REPLACE FUNCTION public.${NOME}(`);
if (inicio < 0) throw new Error(`${ORIGEM} nao define ${NOME} — a base mudou de forma.`);

// 🔴 Esta funcao usa `$$` como delimitador, nao `$fn$`. O fim e o primeiro
//    `\n$$;` depois do inicio — o `$$` de abertura esta na mesma linha do `AS`.
const fim = src.indexOf("\n$$;", inicio);
if (fim < 0) throw new Error(`nao encontrei o fim de ${NOME}`);

const out =
  `-- GERADO de ${ORIGEM} por scripts/gen-094-fixture.mjs. Nao editar a mao.\n` +
  "-- A RPC de faturas COMO ESTA EM PRODUCAO (sem guarda de periodo).\n\n" +
  src.slice(inicio, fim + 4) + "\n";

writeFileSync(DESTINO, out);
console.log(`${DESTINO}: ${out.split("\n").length} linhas.`);
