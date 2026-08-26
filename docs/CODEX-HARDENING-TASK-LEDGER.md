# Codex Hardening Task Ledger

Base inicial: `f001866c9efa2479ab05c9e52308674c5b676f3c` (`origin/master`).

Este ledger acompanha trabalho paralelo de hardening. Nenhuma branch ou PR do
Codex e mesclada automaticamente. Todas exigem revisao do Claude.

| Task | Estado | PR | HEAD | CI | Claude review |
|---|---|---|---|---|---|
| CODEX_TASK_00 - transformar achados em provas | IN_PROGRESS | #84 | 6d9d4e8 | SUCCESS | YES |
| CODEX_TASK_01 - invoice/cash atomicity | DONE | #84 | 6d9d4e8 | SUCCESS | YES |
| CODEX_TASK_02 - invoice_items query error | DONE | #84 | 6d9d4e8 | SUCCESS | YES |
| CODEX_TASK_03 - daily billing atomicity | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_04 - exclusao mutua de receita | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_05 - payroll/cash atomicity | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_06 - reconciliation integrity | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_07 - finance RLS | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_08 - SECURITY DEFINER | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_09 - attachment delete safety | BLOCKED | - | - | - | YES |
| CODEX_TASK_10 - paid payment integrity | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_11 - closed-period semantics | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_12 - adversarial review #81/#82 | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_13 - finance realtime | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_14 - reporting correctness | NOT_STARTED | - | - | - | YES |
| CODEX_TASK_15 - bank import original | BLOCKED | - | - | - | YES |
| CODEX_TASK_16 - invoice PDF archive | BLOCKED | - | - | - | YES |

## Finding evidence

### CODEX-FIN-INV-001

- `SEVERITY = P0`
- `ORIGINAL_STATUS = CONFIRMED`
- `REPRODUCED = CONFIRMED_REPRODUCED`
- `REPRO_TEST = invoice-cash-atomicity-contract.test.ts failed 5/5 before fix`
- `ROOT_CAUSE = invoice update and cash-flow mutation use separate requests`
- `AFFECTED_SOURCES = invoices, cash_flow_entries`
- `AFFECTED_CONSUMERS = Cobrancas, Cliente, Resumo, Fluxo de Caixa, Conciliacao, Relatorios`
- `FIX = thin action calls canonical set_invoice_status_atomic RPC`
- `POSTGRES_PROOF = 9/9 with rollback, two-connection concurrency, period and reconciliation guards`
- `MUTATION_PROOF = forced cash insert and audit failures leave invoice/cash/audit/outbox unchanged`

### CODEX-FIN-INV-002

- `SEVERITY = P0`
- `ORIGINAL_STATUS = CONFIRMED`
- `REPRODUCED = CONFIRMED_REPRODUCED`
- `REPRO_TEST = invoice-cash-atomicity-contract.test.ts failed before fix because billedError was absent`
- `ROOT_CAUSE = invoice_items query error is discarded and converted to []`
- `AFFECTED_SOURCES = invoice_items, services`
- `AFFECTED_CONSUMERS = Servicos por faturar, geracao de faturas`
- `FIX = getUnbilledServices returns the invoice_items query error explicitly`
- `QUERY_ERROR_IS_EMPTY = NO`

## Current PR evidence

- `RED_BEFORE_FIX = 6/6 contract assertions failed across CODEX-FIN-INV-001/002`
- `GREEN_AFTER_FIX = 14/14 unit/contract, 9/9 PostgreSQL, 233/233 affected consumers`
- `REAL_POSTGRES = PostgreSQL 16, disposable Docker container, two independent pool clients`
- `ROLLBACK = executed successfully and hardened migration reapplied`
- `CI_INTEGRATION = PostgreSQL service uses synthetic local credentials only`

## Isolation

- `TOUCHES_DOCUMENT_RELATION = NO`
- `DOCUMENT_LOSS = 0`
- `ATTACHMENT_LOSS = 0`
- `STORAGE_DELETE = 0`
- `STORAGE_MOVE = 0`
- `MIGRATION_NUMBER_PROVISIONAL = YES`
- `PRODUCTION_WRITES = 0`
