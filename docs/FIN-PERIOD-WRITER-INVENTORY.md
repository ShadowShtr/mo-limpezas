# Inventário dos writers financeiros — participação no protocolo de período

Revalidado sobre `feat/091-fin-writers-atomic-manual-charges` @ `78138aa`
(base: `master` @ `1daec61`, com a 090 já generalizada para N períodos).

Este documento é a lista de trabalho da adopção. Enquanto tiver linhas
`RACY` ou `NO_GUARD`, `FIN_PERIOD_DOMAIN_COMPLETE = NO` — e o runtime de
fecho (#138) não pode ser publicado, porque o `close` passaria a adquirir um
recurso que metade dos writers não adquire, dando protecção parcial com ar de
protecção completa.

## As três classificações, e o que distingue a segunda da terceira

| Estado | O que significa |
|---|---|
| `LOCKED_ATOMIC` | O writer adquire o **mesmo** `pg_advisory_xact_lock` que o fecho, dentro da transação que escreve, e valida depois de o ter. Serializa com o fecho. |
| `RACY` | Existe guarda de período, mas em transação diferente da escrita — ou dentro da RPC mas **sem** adquirir o lock. Lê «aberto», o fecho entra pelo meio, e a escrita entra num mês fechado. |
| `NO_GUARD` | Não há guarda nenhuma. Escreve num mês fechado sem sequer perguntar. |

`FOR UPDATE` + `is_financial_period_open()` dentro de uma RPC **não** basta e
não conta como `LOCKED_ATOMIC`. O `FOR UPDATE` serializa contra outros writers
da mesma linha; não serializa contra o `close`, que não toca nessa linha. Sem o
advisory lock partilhado, os dois lados continuam a não se ver.

## Inventário

### Pagamentos fixos e variáveis — `src/app/actions/payments.ts`

| # | Writer | Caminho de escrita | Períodos que toca | Estado |
|---|---|---|---|---|
| 1 | `createPayment` | INSERT directo em `fixed_variable_payments` | `period_year`/`period_month` (competência) | `NO_GUARD` |
| 2 | `updatePayment` | `update_payment_atomic` (088) | competência actual + competência nova + data do movimento ligado | `NO_GUARD` |
| 3 | `setPaymentStatus('pago')` | `mark_payment_paid` (079) | competência + data do movimento que nasce (hoje) | `RACY` |
| 4 | `setPaymentStatus('pendente')` | `unmark_payment_paid` (081) | competência + data do movimento que é removido/despromovido | `RACY` |
| 5 | `setPaymentStatus(outros)` | UPDATE directo do `status` | competência — `status='pendente'` é bloqueador de fecho | `NO_GUARD` |
| 6 | `deletePayment` | `delete_payment_atomic` (082) | competência + data do movimento apagado | `NO_GUARD` |
| — | `uploadPaymentAttachment`, `deletePaymentAttachment` | metadados de anexo | nenhum | `NOT_PERIOD_SENSITIVE` |

As RPCs 079/081 chamam `is_financial_period_open` lá dentro. É por isso que
estão em `RACY` e não em `NO_GUARD` — e é exactamente o caso que a tabela acima
avisa que não chega.

### Fluxo de caixa directo — `src/app/actions/cash-flow.ts`

| # | Writer | Caminho de escrita | Períodos que toca | Estado |
|---|---|---|---|---|
| 7 | `createCashFlowEntry` | guarda na action + INSERT directo | data do movimento | `RACY` |
| 8 | `updateCashFlowEntry` | guarda na action + `update_cashflow_entry_atomic` (082) | data actual + data nova | `RACY` |
| 9 | `deleteCashFlowEntry` | guarda na action + `delete_cashflow_entry_atomic` (082) | data do movimento | `RACY` |

### Faturas — `src/app/actions/invoices.ts`

| # | Writer | Caminho de escrita | Períodos que toca | Estado |
|---|---|---|---|---|
| 10 | `generateInvoices` | `create_invoice_with_items` + UPDATE de `services` | `period_start` da fatura | `NO_GUARD` |
| 11 | `updateInvoiceStatus` | guarda na action + UPDATE + INSERT/DELETE em `cash_flow_entries` | `period_start` + data do movimento criado/removido | `RACY` |
| 12 | `deleteInvoice` | guarda na action + DELETE | `period_start` | `RACY` |

### Conciliação bancária — `src/app/actions/bank-reconciliation.ts`

| # | Writer | Caminho de escrita | Períodos que toca | Estado |
|---|---|---|---|---|
| 13 | `confirmMatch` | `confirm_bank_match_atomic` (082) | `transaction_date` + data do movimento de caixa emparelhado | `NO_GUARD` |
| 14 | `rejectMatch` | UPDATEs directos em `matches` e `bank_transactions` | `transaction_date` | `NO_GUARD` |
| 15 | `manualMatch` | INSERT em `matches` + UPDATE de `bank_transactions` | `transaction_date` + data do movimento | `NO_GUARD` |
| 16 | `ignoreTransaction` | UPDATE de `bank_transactions.status` | `transaction_date` — `status='pending'` é bloqueador de fecho | `NO_GUARD` |
| 17 | `createEntryFromTransaction` | guarda na action + INSERT em `cash_flow_entries` + `matches` | `transaction_date` (é a data do movimento criado) | `RACY` |
| 18 | `deleteImport` | DELETE em `bank_statement_imports`, cascata para `bank_transactions` e `matches` | período de CADA transacção apagada | `NO_GUARD` |
| — | `createBankAccount`, `recalcSuggestions` | conta bancária; sugestões | nenhum | `NOT_PERIOD_SENSITIVE` |

`deleteImport` é o writer com o maior conjunto de períodos de todo o sistema: um
extracto pode atravessar meses, e a cascata apaga tudo de uma vez.

### Folha — `src/app/actions/payroll.ts`

| # | Writer | Caminho de escrita | Períodos que toca | Estado |
|---|---|---|---|---|
| 19 | `calculateAndSavePayroll` | UPSERT em `payroll_records` | `period_year`/`period_month` | `NO_GUARD` |
| 20 | `adjustPayrollRecord` | UPDATE de `payroll_records` | `period_year`/`period_month` | `NO_GUARD` |
| 21 | `approvePayrollRecords` | UPDATE de `status` | `period_year`/`period_month` | `NO_GUARD` |
| 22 | `markPayrollPaid` | UPDATE de `payroll_records` + INSERT em `cash_flow_entries` | competência da folha + data do movimento | `NO_GUARD` |

### Pagamento de serviços — `src/app/actions/daily-billing.ts`

| # | Writer | Caminho de escrita | Períodos que toca | Estado |
|---|---|---|---|---|
| 23 | `setServicePayment` | INSERT/UPDATE/DELETE directos em `cash_flow_entries` + UPDATE de `services` | data do serviço + data do movimento novo + data do movimento existente | `NO_GUARD` |

`set_service_payment_atomic` existe na 086, mas o runtime publicado **não a
chama**: `setServicePayment` escreve directamente. A adopção tem de cobrir os
dois — a RPC e o caminho que a substitui.

### Cobranças avulsas — 091

| # | Writer | Caminho de escrita | Períodos que toca | Estado |
|---|---|---|---|---|
| 24 | `create_manual_charge_atomic` | 091 | `charge_date` | `LOCKED_ATOMIC` |
| 25 | `update_manual_charge_atomic` | 091 | `charge_date` actual + nova | `LOCKED_ATOMIC` |
| 26 | `set_manual_charge_payment_atomic` | 091 | `charge_date` + data de cada movimento existente + hoje (só quando entra dinheiro) | `LOCKED_ATOMIC` |
| 27 | `void_manual_charge_atomic` | 091 | `charge_date` | `LOCKED_ATOMIC` |

### Fecho e reabertura — 090

| # | Writer | Caminho de escrita | Estado |
|---|---|---|---|
| 28 | `close_financial_period_atomic` | 090 | `LOCKED_ATOMIC` |
| 29 | `reopen_financial_period_atomic` | 090 | `LOCKED_ATOMIC` |

## Contagem

```
WRITER_INVENTORY_TOTAL      = 32   (29 numerados + 3 não sensíveis agrupados)
PERIOD_SENSITIVE_TOTAL      = 29
LOCKED_ATOMIC               = 6    (091 × 4, 090 × 2)
RACY                        = 8    (3, 4, 7, 8, 9, 11, 12, 17)
NO_GUARD                    = 15   (1, 2, 5, 6, 10, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23)
NOT_PERIOD_SENSITIVE        = 3
```

## Maior conjunto de períodos numa única operação económica

A pergunta que a 090 tinha de responder para deixar de ser um protocolo de par:

| Operação | Períodos |
|---|---|
| `updatePayment` com mudança de competência e movimento ligado | 3 — competência actual, competência nova, data do movimento |
| `set_manual_charge_payment_atomic` a receber sobre caixa antigo | 3 — cobrança, movimento antigo, hoje |
| `setServicePayment` a mudar o recebimento | 3 — serviço, movimento existente, hoje |
| `confirmMatch` | 2 — transacção bancária, movimento de caixa |
| `deleteImport` | **N** — um por cada mês tocado pelo extracto |

`deleteImport` fecha a discussão: não há número fixo. É por isso que a primitiva
canónica recebe uma lista e não um par, e é por isso que a 090 passou a
`lock_financial_periods_many`.

## Agrupamento das migrations de adopção

Agrupado por coerência transaccional e de rollback, não por ficheiro de action:

| Migration | Domínio | Writers |
|---|---|---|
| 091 | Cobranças avulsas | 24–27 · **feito** |
| 092 | Pagamentos fixos e variáveis | 1–6 |
| 093 | Fluxo de caixa directo | 7–9 |
| 094 | Faturas | 10–12 |
| 095 | Conciliação bancária | 13–18 |
| 096 | Folha — segurança de período apenas | 19–22 |
| 097 | Pagamento de serviços | 23 |

A recorrência **não** tem número reservado: recebe `NEXT_FREE_MIGRATION` depois
de esta lista estar fechada.
