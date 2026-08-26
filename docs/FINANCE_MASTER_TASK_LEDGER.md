# FINANCE MASTER TASK LEDGER

Fonte canónica do estado do plano financeiro. Vive numa PR aberta, deliberadamente
**não mesclada** — mesclar em `master` dispara auto-deploy, e não se provoca um
deploy para persistir documentação.

> **Como usar.** Todo o relatório futuro atualiza este ficheiro na branch
> `docs/finance-master-task-ledger`. Nunca a meio de uma operação financeira
> perigosa: primeiro concluir e medir, depois registar.

```
MASTER_BASE_SHA = f001866c9efa2479ab05c9e52308674c5b676f3c
Atualizado      = 2026-08-26
```

---

## 1. Estado das TASKS

| TASK | Título | Estado |
|---|---|---|
| 00 | Baseline / snapshot / mapa completo | **DONE** |
| 01 | Baseline de documentos e anexos | **NEXT** |
| 01A | Forensics do drift schema ↔ ledger de migrations | NOT_STARTED |
| 02 | *(título não fornecido)* | NOT_STARTED |
| 03 | *(título não fornecido)* | NOT_STARTED |
| 04 | *(título não fornecido)* | NOT_STARTED |
| 05 | *(título não fornecido)* | NOT_STARTED |
| 06 | *(título não fornecido)* | NOT_STARTED |
| 07 | *(título não fornecido)* | NOT_STARTED |
| 08 | *(título não fornecido)* | NOT_STARTED |
| 09 | RPC `mark_payment_paid` / reuso de pending cashflow | **PRECOMPLETED_EVIDENCE_READY** |
| 10 | Repair das 6 pendências / preparação | **PRECOMPLETED_EVIDENCE_READY** |
| 11 | Remoção da aba Contas | **BLOCKED_BY_UNIQUE_CONTAS_SEMANTICS** |
| 12–21 | *(títulos não fornecidos)* | NOT_STARTED |
| 22 | Conciliação bancária integrada | NOT_STARTED |
| 23–26 | *(títulos não fornecidos)* | NOT_STARTED |

> Os títulos das TASKS 02–08 e 12–26 não foram fornecidos ao executor. Ficam
> por preencher em vez de inventados — um título inventado aqui passa a ser lido
> como âmbito acordado.

---

## 2. Evidência pré-concluída

Trabalho executado **antes** da criação formal deste ledger. Não é descartado, e
não autoriza saltar TASKS.

### TASK 09 — PR #81

```
BRANCH = fix/reuse-pending-cashflow-on-payment
PR     = #81   OPEN · MERGED = NO · MERGEABLE = YES
HEAD   = a10c7b2bf059acd6ee2eaced65c07e2b409c0565
CI     = 32980073496 · SUCCESS
FILE   = supabase/migrations/079_reuse_pending_cashflow_on_payment.sql

MARK_PAID_REUSES_PENDING      = YES
PENDING_CASHFLOW_ID_PRESERVED = YES
RPC_IDEMPOTENT                = YES
RPC_CONCURRENCY_SAFE          = YES
RPC_FAILURE_ROLLBACK          = YES
REAL_POSTGRES                 = 16.15
TWO_CONNECTION_LOCK_PROOF     = PASS
MIGRATION_ROLLBACK            = pg_get_functiondef reposto exatamente
```

Revalidar contra os invariantes canónicos quando a TASK 02 estiver DONE. Se
continuar compatível → `TASK_09 = DONE`, sem refazer trabalho.

### TASK 10 — PR #82

```
BRANCH   = repair/six-pending-obligations
PR       = #82   OPEN · MERGED = NO · MERGEABLE = YES
BASE     = fix/reuse-pending-cashflow-on-payment @ a10c7b2b
HEAD     = 5eaee43d01025f7f8961a7a527219ab092957738
CI       = 32982219026 · SUCCESS

linhas = 6 · total = 151033 cents
kind = variavel · due_date = NULL · period = mês civil do registo legado
forward / mark-paid / retry / rollback em descartável = PASS
mid-batch persisted = 0 · delete count = 0
```

Depende de TASK 09 **e** de TASK 01A (nenhuma migration em produção antes do
drift estar resolvido).

---

## 3. Regras permanentes

```
PR81_MERGE_AUTHORIZED = NO          PR82_MERGE_AUTHORIZED = NO
PR81_DELETE_BRANCH_ALLOWED = NO     WHILE_PR82_DEPENDS_ON_PR81 = YES
LEDGER_PR_MERGE = NO

MIGRATION_079_PRODUCTION_AUTHORIZED = NO
MIGRATION_079_APPLY_GATE = BLOCKED_BY_SCHEMA_LEDGER_DRIFT_ANALYSIS
SIX_REPAIR_PRODUCTION_AUTHORIZED = NO

PREPARATION_MANIFEST_ONLY = YES     FINAL_EXECUTION_MANIFEST = NO
```

**Sequência obrigatória no futuro merge da #81** — a #82 tem-na como base, e
apagar uma branch base já fechou uma PR antes (#73):

1. merge **sem** `--delete-branch`;
2. confirmar #82 ainda OPEN;
3. retarget/rebase da #82 para `master`;
4. só então considerar remover a branch antiga.

**Manifestos das 6.** Nenhum é final. Regerar imediatamente antes de qualquer
execução, com ids de pagamento novos e SHA256 novos. Não reutilizar ids de
manifestos anteriores. Produção está ativa: durante o próprio trabalho da #82
observou-se `payments 113 → 114` e `linked cashflows 6 → 7`. Não é erro — é
sistema em uso, e é a razão de existirem fresh snapshot, expected revision,
`FOR UPDATE` e execução atómica.

---

## 4. Baseline medido — TASK 00

```
POINT_IN_TIME_SNAPSHOT = YES        (2026-08-26, leitura read-only)
```

Estes números **não são permanentes**. São uma fotografia de um sistema em uso
diário.

| Objeto | Contagem |
|---|---|
| `fixed_variable_payments` | 114 |
| `cash_flow_entries` | 453 |
| `expense_categories` | 14 |
| `invoices` | 32 |
| `invoice_items` | 32 |
| `clients` | 962 |
| `locations` | 960 |
| `services` | 1686 |
| `contracts` | 147 |
| `teams` | 16 |
| `profiles` | 28 |
| `payroll_records` | 90 |
| `audit_logs` | 1990 |
| `_migrations` (linhas) | 77 |
| última migration no ledger | `076` (2026-08-20) |
| `070` | ausente do ledger / bloqueada / intocada |

> ⚠️ A primeira leitura usou `reltuples` e reportou `invoice_items = 0` e
> `teams = 0`. São estimativas do planeador de queries, não contagens. Os
> valores acima são `count(*)` exatos. Nenhuma conclusão deste ledger assenta em
> estimativas.

### Fontes canónicas

```
PAYMENT_SOURCE   = fixed_variable_payments → actions/payments.ts
                   + RPC mark_payment_paid / unmark_payment_paid
CASHFLOW_SOURCE  = cash_flow_entries       → actions/cash-flow.ts
CATEGORY_SOURCE  = expense_categories      → actions/expense-categories.ts
CHARGE_SOURCE    = invoices + invoice_items → actions/invoices.ts, daily-billing.ts
CLIENT_SOURCE    = clients + locations     → actions/clientes.ts, locations.ts
CONTAS_SOURCE    = dashboard/financeiro/contas → getAccountsData() em cash-flow.ts

SERVER_ACTIONS = 37 ficheiros · 199 actions exportadas
ROUTES         = 27 páginas de dashboard · 16 rotas de API (4 crons)
```

### Comportamentos únicos da aba Contas

O que a bloqueia (TASK 11):

1. **A Receber** — faturas pendente/vencido por mês;
2. **A Pagar Salários** — `payroll_records` aprovados por mês;
3. **Catálogo de categorias** — `createSuggestedExpenseCategories()`, o **único**
   ponto da aplicação que o cria;
4. Despesas Pendentes — já coberto por Fluxo de Caixa.

Destino esperado: 1 → Cobranças · 2 → Folha de Pagamento · 3 → configuração
financeira · 4 → Pagamentos. Só depois a aba é removível.

---

## 5. Anexos — decisão tomada

```
LEGACY_ATTACHMENT_URL_MIGRATION_NOW = NO
SUPPORT_BOTH_ATTACHMENT_MODELS      = YES
READ_CANONICALLY = attachments + legacy attachment_url
DEDUPLICATE_PRESENTATION = YES
PAYMENT_ATTACHMENT_DUPLICATES_VISIBLE = 0   (objetivo)
```

Existem **dois mecanismos em produção** para o mesmo conceito:

| modelo | referências |
|---|---|
| tabela `attachments` (polimórfica) | 6 |
| coluna legada `fixed_variable_payments.attachment_url` | 17 |

23 ficheiros reais no bucket `payment-attachments`; 21 pagamentos distintos com
anexo; 1 pagamento usa os dois modelos.

Migrar agora aumentaria o risco exatamente durante uma refatoração financeira
grande. A regra desta fase: ler os dois, deduplicar na apresentação por
identidade forte (`bucket` + `object path`), **nunca por nome de ficheiro**. Não
duplicar storage. Não duplicar registo de anexo só para normalizar. Não apagar
a URL legada.

---

## 6. Riscos registados

### `ORPHAN_STORAGE_EVIDENCE` — collaborator-documents

```
collaborator_documents (linhas)      = 0
bucket collaborator-documents        = 3 ficheiros
DELETE_ORPHAN_COLLABORATOR_FILES = NO
MOVE_ORPHAN_COLLABORATOR_FILES   = NO
REUPLOAD = NO
```

Referências partidas na direção inversa à habitual: o ficheiro existe, o registo
não. Investigação read-only, classificação em `KNOWN_PARENT` /
`LIKELY_PARENT` / `UNKNOWN_PARENT`. Só `KNOWN_PARENT` pode alimentar uma futura
proposta de repair. Não procurar por semelhança e declarar dono.

### Buckets configurados mas inexistentes

```
CONFIGURED_BUCKET_MISSING_TASK_ATTACHMENTS  = YES
CONFIGURED_BUCKET_MISSING_ABSENCE_DOCUMENTS = YES
```

`PARENT_BUCKET` mapeia `management_task` → `task-attachments` e `absence` →
`absence-documents`. Nenhum existe em produção, e nenhum dado existe nesses
caminhos. Não criar buckets agora: primeiro classificar se é funcionalidade
ativa, morta, configuração incompleta ou migration em falta.

### `SCHEMA_LEDGER_DRIFT`

```
SCHEMA_LEDGER_DRIFT = YES
LEDGER_078_PRESENT  = NO
ORIGIN_OF_PROD_078_OBJECTS = NOT_PROVEN
```

`domain_mutations`, `company_change_events` e `platform_admins` existem em
produção. Os dois primeiros correspondem a objetos conhecidos da migration 078,
que vive na PR #74, **não está em `master` e não tem linha no ledger**.

Objeto presente no schema **não prova** origem da aplicação. São cinco coisas
distintas que este projeto já confundiu antes: (a) objeto presente; (b) linha no
ledger; (c) ficheiro no repo; (d) checksum coincidente; (e) origem da aplicação.

Proibido até a TASK 01A concluir: baseline, reconcile, inserir linha 078 no
ledger, alterar schema, aplicar a 078, ou assumir que «já está aplicada».

### `BANK_ACCOUNT_RELATIONSHIP_RISK = OPEN`

```
bank_transactions              = 336
  com bank_account_id NULO     = 336
bank_accounts                  = 0
reconciliation matches         = 11
```

Onze correspondências de conciliação assentam em transações que não apontam para
conta nenhuma. Não corrigir na TASK 01. Auditar obrigatoriamente antes de
considerar a Conciliação integrada (TASK 22).

### `FINANCIAL_PERIOD_GUARD_PRODUCTION_EXERCISED = NO`

```
financial_periods = 0
```

Nenhum período foi fechado alguma vez. A guarda `FINANCIAL_PERIOD_CLOSED` nunca
disparou em produção — está por exercitar, não está provada. Não remover, não
concluir que está errada. Provar em PostgreSQL descartável: período aberto,
período fechado, escrita bloqueada, rollback, casos de fronteira.

---

## 7. Critério de DONE da TASK 01

```
FINANCE_DOCUMENT_BASELINE     = COMPLETE
FINANCE_ATTACHMENT_BASELINE   = COMPLETE
PAYMENT_DUAL_ATTACHMENT_MODEL = DOCUMENTED
OPENABILITY_TESTED            = YES
BROKEN_REFS_CLASSIFIED        = YES
ORPHAN_STORAGE_CLASSIFIED     = YES
MISSING_BUCKETS_CLASSIFIED    = YES

STORAGE_MOVE_COUNT   = 0
STORAGE_DELETE_COUNT = 0
STORAGE_UPLOAD_COUNT = 0

LEGACY_ATTACHMENT_URL_MIGRATION_NOW = NO
```

A TASK 01 é baseline, não migration.

---

## 8. Gate de produção

```
PRODUCTION_FINANCIAL_WRITES = 0
PRODUCTION_MIGRATIONS       = 0
PRODUCTION_REPAIRS          = 0
PRODUCTION_STORAGE_WRITES   = 0

PR81_MERGED = NO      PR82_MERGED = NO
#78_EXECUTED = NO     070_TOUCHED = NO
#73 / #74 = intocadas (leitura permitida na TASK 01A; sem rebase, edição,
            merge, fecho, retarget ou aplicação de migration)
```
