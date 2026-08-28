# F14-D — os caminhos atómicos já estão ligados. A #101 tem de os preservar.

> **Este documento mudou de propósito.** Antes listava quatro pontos de chamada
> que a #101 teria de trocar. Deixou de ser verdade: **a #108 liga-os agora**,
> no `master`. O que a #101 tem de fazer é **não os desligar**.

## Estado

Estas cinco Server Actions passam pelas RPC atómicas da **082**:

| ficheiro | função | RPC |
|---|---|---|
| `src/app/actions/payments.ts` | `updatePayment` | `update_payment_atomic` |
| `src/app/actions/payments.ts` | `deletePayment` | `delete_payment_atomic` |
| `src/app/actions/cash-flow.ts` | `updateCashFlowEntry` | `update_cashflow_entry_atomic` |
| `src/app/actions/cash-flow.ts` | `deleteCashFlowEntry` | `delete_cashflow_entry_atomic` |
| `src/app/actions/bank-reconciliation.ts` | `confirmMatch` | `confirm_bank_match_atomic` |

Nenhuma delas faz `select → decisão → escrita separada`. Nenhuma escreve
directamente na tabela depois de a RPC ter decidido.

## O que a #101 não pode reintroduzir

A branch antiga da #101 foi escrita antes desta frente e contém o padrão
inseguro nas mesmas funções. Durante a reconstrução semântica, **qualquer
conflito nestes ficheiros resolve-se a favor do `master`.**

```
❌  ler o estado → decidir → .update() / .delete()
✅  chamar a RPC atómica e traduzir o código de erro
```

`BUILD_AHEAD != MERGE_AHEAD` — a #101 foi construída à frente, mas o `master`
é que é canónico.

## Porque é que isto se perde com facilidade

O padrão inseguro **parece** correcto: lê, verifica, escreve. O que falta não
se vê no código — é o intervalo entre a leitura e a escrita, onde cabe outra
pessoa. Um `select` seguido de um `update` passa em revisão precisamente porque
cada linha, isolada, está bem.

Se um destes caminhos regredir, `src/__tests__/finance-actions-rpc-routing.test.ts`
fica vermelho. Verificado por mutação: repor o `delete` directo no
`deletePayment` dá 3 vermelhos; devolver ao `confirmMatch` uma escrita de
seguimento dá 2.

## O que a troca não pode alterar, e não alterou

- **A mensagem pública.** As RPC levantam códigos técnicos
  (`PAYMENT_ALREADY_PAID`, `PAYMENT_LINKED_TO_CASHFLOW`, `CASHFLOW_RECONCILED`,
  `CASHFLOW_MANAGED_BY_ORIGIN`, `BANK_TRANSACTION_ALREADY_RECONCILED`); quem
  clica lê uma frase escrita para o caso. A mensagem do PostgreSQL nunca chega
  ao ecrã.
- **O `company_id`.** Vem de `profile.company_id` e nunca do cliente. Cada RPC
  confronta-o com a linha.
- **Uma edição é uma escrita.** `update_payment_atomic` recebe o patch inteiro
  e grava tudo num só `UPDATE`. Não há uma RPC para o valor e um `update` para o
  resto: essa divisão deixava uma edição composta gravar metade — o valor
  passava, a descrição falhava, a acção devolvia erro, e o dinheiro mudava à
  mesma.
- **Valor nulo e valor inalterado.** Um pagamento pendente pode não ter valor, e
  o formulário reenvia o valor que não mudou. `NULL` é legítimo e um valor igual
  é no-op — continua a ser possível corrigir a descrição de um pagamento já pago.
- **A competência move-se com o vencimento**, dentro do mesmo `UPDATE`; um
  `due_date` posto a `null` não a altera.
- **As guardas de período.** Continuam na Server Action, antes da RPC: são elas
  que dão a mensagem com o nome do mês, que a base não sabe dar.

## Coerência com o razão unificado

Cada recusa mantém o `FinanceLedgerRow` coerente:

- alterar o valor de um pagamento **ligado** é recusado → nunca aparece
  `linked_amount_mismatch`;
- apagar um pagamento ligado é recusado → nunca aparece
  `orphan_payment_reference`;
- nenhuma RPC cria um segundo movimento para o mesmo pagamento →
  `duplicate_payment_link` continua inalcançável pela aplicação.
