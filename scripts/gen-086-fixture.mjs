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
