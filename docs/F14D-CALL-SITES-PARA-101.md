# F14-D — os pontos de chamada que a #101 tem de trocar

A migration **082** entrega as RPC atómicas. **Sozinha não corrige nada**: enquanto
as Server Actions continuarem a fazer `select → decisão → escrita separada`, o
código corre pelo caminho sem guarda e a corrida mantém-se aberta.

Este documento existe para que a reconstrução da **#101** não deixe nenhum caminho
por trocar. É mapa, não autorização: **a #101 não foi tocada nesta frente.**

## O que muda, e porquê

| ficheiro | função | linha na #101 | corrida | RPC a usar |
|---|---|---|---|---|
| `src/app/actions/payments.ts` | `updatePayment` | 274 | lê «sem movimento» → B corre `mark_payment_paid` → A grava o valor | `update_payment_amount_atomic(uuid, uuid, numeric)` |
| `src/app/actions/payments.ts` | `deletePayment` | 480 | lê «sem movimento» → B liga um → A apaga o pagamento | `delete_payment_atomic(uuid, uuid)` |
| `src/app/actions/cash-flow.ts` | `updateCashFlowEntry` | 244 | lê «sem conciliação» → B confirma → A altera | `update_cashflow_entry_atomic(uuid, uuid, jsonb)` |
| `src/app/actions/cash-flow.ts` | `deleteCashFlowEntry` | 359 | idem, a apagar | `delete_cashflow_entry_atomic(uuid, uuid)` |

`src/app/actions/bank-reconciliation.ts` → `confirmMatch` **já está trocado nesta
PR**, porque vive no `master` e não na #101.

## Porque é que o `confirmMatch` não podia ficar para depois

**Um lock só serializa contra quem o pede.** As quatro funções acima trancam a
linha com `FOR UPDATE` antes de decidirem. Enquanto a confirmação de conciliação
escrevesse com um `update` directo, sem tomar lock nenhum, trancar do lado do
movimento não provaria coisa nenhuma — a outra escrita passava ao lado.

É a metade da correcção que é fácil esquecer, e por isso vai junto com a
migration em vez de ficar para a integração da UI.

## O que a troca não pode alterar

- **A mensagem pública.** As RPC levantam códigos técnicos (`PAYMENT_ALREADY_PAID`,
  `PAYMENT_LINKED_TO_CASHFLOW`, `CASHFLOW_RECONCILED`, `CASHFLOW_MANAGED_BY_ORIGIN`,
  `CASHFLOW_FIELD_NOT_EDITABLE`); quem clica continua a ler a mesma frase de sempre.
- **O `company_id`.** Continua a vir de `profile.company_id` e nunca do cliente.
  Cada RPC recebe-o e confronta-o com a linha — nunca o aceita por si só.
- **O caminho canónico.** Server Action → `requireProfile(admin/gestor)` →
  `service_role` → RPC. Nenhuma das seis funções é executável por `PUBLIC`,
  `anon` ou `authenticated`, e a 082 fecha-as ela própria.

## O que fica coerente no modelo de leitura

Uma mutação bem sucedida tem de deixar o `FinanceLedgerRow` coerente:

- alterar o valor de um pagamento **já ligado** é recusado — é isso que impede
  `payment.amount ≠ cash_flow_entries.amount`, que o razão marcaria como
  `linked_amount_mismatch`;
- apagar um pagamento ligado é recusado — evita o `orphan_payment_reference`;
- nenhuma das RPC cria um segundo movimento para o mesmo pagamento, portanto
  `duplicate_payment_link` continua inalcançável pela aplicação.
