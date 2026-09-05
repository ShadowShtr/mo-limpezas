// ============================================================================
// Gera o fixture das RPCs de pagamentos COMO ESTÃO EM PRODUÇÃO
// ============================================================================
//
// A suite da 092 precisa de partir do estado real: as quatro RPCs que a 092
// substitui, na versão que está em produção hoje, para que o `CREATE OR
// REPLACE` tenha alguma coisa para substituir. Um `CREATE OR REPLACE` sobre uma
// função que não existe cria uma nova — e o teste passaria sem nunca provar a
// substituição, nem a precondição que a exige.
//
// 🔴 A migration que define cada função NÃO é a do número mais alto que lhe
//    toca — é a ÚLTIMA que a define. E as duas coisas não coincidem aqui:
//
//      · `mark_payment_paid`   → 079 define, **081 redefine** (proveniência);
//      · `unmark_payment_paid` → 081;
//      · `update_payment_atomic` → 082 define, **088 redefine** (competência);
//      · `delete_payment_atomic` → 082.
//
//    Extrair `mark_payment_paid` da 079 dava a versão SEM escrita de
//    proveniência — e a suite provaria o comportamento de uma função que já não
//    existe em produção há duas migrations. Este ficheiro nomeia a origem de
//    cada uma explicitamente por isso mesmo.
//
// Uso: node scripts/gen-092-fixture.mjs

import { readFileSync, writeFileSync } from "node:fs";

const DESTINO = "src/__tests__/fixtures/pre-092-payment-rpcs.sql";

/** [função, migration que a define POR ÚLTIMO, delimitador do corpo] */
const FONTES = [
  ["assert_payment_cashflow_link", "supabase/migrations/079_reuse_pending_cashflow_on_payment.sql", "$guard$;"],
  ["mark_payment_paid", "supabase/migrations/081_safe_unmark_payment_paid.sql", "$fn$;"],
  ["unmark_payment_paid", "supabase/migrations/081_safe_unmark_payment_paid.sql", "$fn$;"],
  ["update_payment_atomic", "supabase/migrations/088_payment_competence_idempotent_edit.sql", "$fn$;"],
  ["delete_payment_atomic", "supabase/migrations/082_atomic_finance_mutations.sql", "$fn$;"],
];

let out =
  "-- GERADO por scripts/gen-092-fixture.mjs. Nao editar a mao.\n" +
  "-- As RPCs de pagamentos COMO ESTAO EM PRODUCAO, cada uma extraida da\n" +
  "-- migration que a define POR ULTIMO. E sobre estas que a 092 actua.\n\n";

const blocos = [];
for (const [nome, origem, fim_delim] of FONTES) {
  const src = readFileSync(origem, "utf8");
  const inicio = src.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`);
  if (inicio < 0) throw new Error(`${origem} não define ${nome} — a base mudou de forma.`);

  // 🔴 `lastIndexOf` não serve e `indexOf` a partir do início também não: uma
  //    migration define várias funções, e o fim desta é o PRIMEIRO delimitador
  //    depois do seu início.
  const fim = src.indexOf(`\n${fim_delim}`, inicio);
  if (fim < 0) throw new Error(`não encontrei o fim de ${nome} em ${origem}`);

  blocos.push(`-- ${nome} — de ${origem}\n` + src.slice(inicio, fim + 1 + fim_delim.length));
}

out += `${blocos.join("\n\n")}\n`;
writeFileSync(DESTINO, out);
console.log(`${DESTINO}: ${out.split("\n").length} linhas, ${FONTES.length} funções.`);
