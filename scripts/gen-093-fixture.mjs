// ============================================================================
// Gera o fixture das RPCs de fluxo de caixa COMO ESTAO EM PRODUCAO
// ============================================================================
//
// A suite da 093 parte do estado real: as tres funcoes da 082 sobre as quais o
// `CREATE OR REPLACE` da 093 actua. Sem elas, a migration criava funcoes novas
// em vez de substituir, e a suite passava sem provar a substituicao nem a
// precondicao que a exige.
//
// `lock_cashflow_for_manual_mutation` vem inteira e NAO e alterada pela 093 —
// e a guarda de linha que as outras duas invocam.
//
// Uso: node scripts/gen-093-fixture.mjs

import { readFileSync, writeFileSync } from "node:fs";

const ORIGEM = "supabase/migrations/082_atomic_finance_mutations.sql";
const DESTINO = "src/__tests__/fixtures/pre-093-cashflow-rpcs.sql";

const NOMES = [
  "lock_cashflow_for_manual_mutation",
  "update_cashflow_entry_atomic",
  "delete_cashflow_entry_atomic",
];

const src = readFileSync(ORIGEM, "utf8");

let out =
  `-- GERADO de ${ORIGEM} por scripts/gen-093-fixture.mjs. Nao editar a mao.\n` +
  "-- As RPCs de fluxo de caixa COMO ESTAO EM PRODUCAO (guarda de periodo so na\n" +
  "-- server action, uma viagem antes). E sobre estas que a 093 actua.\n\n";

const blocos = [];
for (const nome of NOMES) {
  const inicio = src.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`);
  if (inicio < 0) throw new Error(`${ORIGEM} nao define ${nome} — a base mudou de forma.`);
  const fim = src.indexOf("\n$fn$;", inicio);
  if (fim < 0) throw new Error(`nao encontrei o fim de ${nome}`);
  blocos.push(src.slice(inicio, fim + 6));
}

out += `${blocos.join("\n\n")}\n`;
writeFileSync(DESTINO, out);
console.log(`${DESTINO}: ${out.split("\n").length} linhas, ${NOMES.length} funcoes.`);
