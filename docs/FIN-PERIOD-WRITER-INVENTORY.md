# Inventário dos writers financeiros — participação no protocolo de período

Estado sobre `master` @ `f453999`, com as migrations 090..097 **aplicadas em
produção** (ledger completo, checksums a bater) e o runtime do R1 integrado.

O guard que fixa este documento é `src/__tests__/fin-period-writer-guard.test.ts`.
Enquanto houver linhas na tabela de dívida no fim, `PERIOD_SENSITIVE_RACY_WRITERS`
**não é zero** — e este documento não diz que é.

## As três classificações

| Estado | O que significa |
|---|---|
| `LOCKED_ATOMIC` | O writer escreve por uma RPC que adquire o **mesmo** `pg_advisory_xact_lock` que o fecho, dentro da transação que escreve, e valida depois de o ter. Serializa com o fecho. |
| `RACY` | Há guarda de período, mas noutra transação — ou dentro da RPC sem adquirir o lock. Lê «aberto», o fecho entra pelo meio, a escrita entra num mês fechado. |
| `NO_GUARD` | Não há guarda nenhuma. |

`FOR UPDATE` + `is_financial_period_open()` dentro de uma RPC **não** basta e não
conta como `LOCKED_ATOMIC`: o `FOR UPDATE` serializa contra outros writers da
mesma linha, mas não contra o `close`, que não toca nessa linha.

## Writers convertidos

Todos `LOCKED_ATOMIC`. Nenhum destes ficheiros escreve directamente numa tabela
sensível ao período — verificado, não presumido: o guard varre `src/` inteiro à
procura de `.from("<tabela>")` seguido de escrita, e falha se um deles reaparecer.

| Ficheiro | RPCs | Migration |
|---|---|---|
| `src/app/actions/payments.ts` | `create_payment_atomic`, `update_payment_atomic`, `set_payment_status_atomic`, `delete_payment_atomic` | 092 |
| `src/app/actions/cash-flow.ts` | `create_cashflow_entry_atomic`, `update_cashflow_entry_atomic`, `delete_cashflow_entry_atomic` | 093 |
| `src/app/actions/invoices.ts` | `set_invoice_status_atomic`, `delete_invoice_atomic` | 094 |
| `src/app/actions/bank-reconciliation.ts` | `confirm_bank_match_atomic`, `reject_bank_match_atomic`, `manual_bank_match_atomic`, `set_bank_transaction_ignored_atomic`, `create_cashflow_from_bank_transaction_atomic`, `delete_bank_import_atomic` | 095 |
| `src/app/actions/daily-billing.ts` | `set_service_payment_atomic` | 097 |
| `src/app/actions/financial-periods.ts` | `close_financial_period_atomic`, `reopen_financial_period_atomic` | 090 |

Cobranças avulsas (091) estão em `manual-charges`, já encaminhadas antes desta
frente.

`src/app/actions/clientes.ts` deixou de ter caminho de destruição: o
arquivamento é `archive-only`, e a tabela de clientes não expõe `deleteCliente`.
Um cliente arquivado mantém faturas, movimentos e histórico.

## A dívida que falta — e é uma só

| Ficheiro | Tabela | Estado | Dono |
|---|---|---|---|
| `src/app/actions/payroll.ts` | `cash_flow_entries` (INSERT directo) | `RACY` | **PR #156** |

A 096 está aplicada em produção e o contrato existe —
`upsert_payroll_records_atomic`, `adjust_payroll_record_atomic`,
`approve_payroll_records_atomic`, `mark_payroll_paid_atomic`. O que falta é o
writer passar a chamá-lo.

Enquanto ficar assim, marcar a folha como paga cria o movimento de caixa por
fora da transação: um mês fechado não trava essa escrita, e uma falha a meio
pode deixar a folha paga sem movimento, ou o movimento sem a folha.

O guard tem um teste dedicado a esta linha. Quando a #156 entrar, a excepção
deixa de corresponder a código real e o teste **falha** — obrigando a que saia
da lista em vez de ficar esquecida a dar ar de estado normal.

## Escritas directas que não são dívida

Inventariadas com razão, e o guard falha se alguma delas desaparecer do código
sem sair daqui.

| Ficheiro | Tabela | Porquê não conta |
|---|---|---|
| `src/app/actions/colaboradores.ts` | `invoices` | Anonimiza `created_by` ao remover uma pessoa. Não toca em valor, data nem estado. |
| `src/app/actions/colaboradores.ts` | `payroll_records` | Anonimiza `approved_by`, pela mesma razão. |
| `src/lib/payments-month-materialization.ts` | `fixed_variable_payments` | Módulo em quarentena, sem nenhum caminho da aplicação a chegar-lhe; `payments-no-implicit-materialization.test.ts` falha se alguém o importar. |

## Porque é que o guard varre as escritas, e não só as chamadas

Verificar apenas que o ficheiro chama a RPC certa passaria com um ficheiro que a
chama num caminho e escreve à mão noutro — que é precisamente a forma que a
regressão costuma ter. O padrão «ler, decidir em TypeScript, escrever» é o que
sai naturalmente de quem escreve a funcionalidade seguinte: reaparece sozinho, e
sem guard reaparece sem ninguém dar por isso. A única prova de que voltou seria
um mês fechado a mudar de valor.
