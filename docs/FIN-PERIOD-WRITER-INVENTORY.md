# Inventário dos writers financeiros — participação no protocolo de período

Estado sobre `master` @ `1b2fdae`, com as migrations 090..097 **aplicadas em
produção** (ledger completo, checksums a bater) e o runtime integrado até à
folha, inclusive.

**`PERIOD_SENSITIVE_RACY_WRITERS = 0`.** Nenhuma escrita que decida o valor de um
mês acontece fora da transação que valida esse mês.

O guard que fixa este documento é `src/__tests__/fin-period-writer-guard.test.ts`.

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
| `src/app/actions/payroll.ts` | `upsert_payroll_records_atomic`, `adjust_payroll_record_atomic`, `approve_payroll_records_atomic`, `mark_payroll_paid_atomic` | 096 |

Cobranças avulsas (091) estão em `manual-charges`, já encaminhadas antes desta
frente.

`src/app/actions/clientes.ts` deixou de ter caminho de destruição: o
arquivamento é `archive-only`, e a tabela de clientes não expõe `deleteCliente`.
Um cliente arquivado mantém faturas, movimentos e histórico.

## A folha — a última a entrar, e como se soube que tinha entrado

Até à 096 estar aplicada, `src/app/actions/payroll.ts` fazia um INSERT directo
em `cash_flow_entries`: marcar a folha como paga criava o movimento de caixa por
fora da transação, um mês fechado não travava essa escrita, e uma falha a meio
podia deixar a folha paga sem movimento — ou o movimento sem a folha.

Passou a escrever pelas quatro RPCs da 096. `mark_payroll_paid_atomic` cria o
movimento dentro da mesma transação que marca o registo como pago, com a
proveniência escrita (`reference_type = 'payroll'`), e um segundo pedido igual
devolve o que já ficou gravado em vez de duplicar.

O que vale a pena registar é **como** isto ficou fechado: a excepção da folha
estava inventariada aqui e no guard, e o teste «cada excepção inventariada
continua a existir» falhou no instante em que o INSERT directo desapareceu do
código. A lista não se limpou por alguém se ter lembrado dela — limpou-se porque
deixar de a limpar partia o build. É essa a diferença entre uma lista de
excepções e uma desculpa.

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
