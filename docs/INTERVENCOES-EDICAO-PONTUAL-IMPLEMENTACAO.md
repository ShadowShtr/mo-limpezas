# Implementação: contratos e intervenções

Data: 2026-09-03

## Estado de base

```text
ORIGIN_MASTER_SHA = 1daec61b26c41dccd64e103b4a7c73c3cc65682a
BASE_CHANGED = NO
REVALIDATION_REQUIRED = NO
LOCAL_HEAD = 14cdbf523752aed39b59c633a2b92c3127ac24e4
WORKTREE_STATUS = limpo no início; alterações isoladas na branch de intervenção
```

Foram lidos `AGENTS.md`, `CLAUDE.md`, a auditoria anterior e todos os `.md` do projeto. `INSTRUCOES_OPERACIONAIS_DO_PROJETO.md` não existe neste checkout.

## A — Client search

```text
CLIENT_SEARCH_BASE = 1daec61b26c41dccd64e103b4a7c73c3cc65682a
CLIENT_SEARCH_BRANCH = feat/contratos-cliente-pesquisavel
CLIENT_SEARCH_HEAD = dee1cf42285c91165d07720cc45f912cd5a66dbd
CLIENT_SEARCH_PR = https://github.com/ShadowShtr/mo-limpezas/pull/145 (Draft)

FILE_OVERLAP_DETECTED = YES
REUSE_EXISTING_COMPONENT = não decidido
CLIENT_SEARCH = implementado e revalidado em branch separada
ACCENT_INSENSITIVE = não revalidado nesta branch
CLIENT_SELECTION = não revalidado nesta branch
LOCAL_RESET = não revalidado nesta branch
EDIT_MODE = não revalidado nesta branch
COPY_MODE = não revalidado nesta branch
FIXED_CLIENT = não revalidado nesta branch
KEYBOARD_MOBILE = não revalidado nesta branch

CLIENT_SEARCH_TESTS = 26/26
CLIENT_SEARCH_CI = não aguardado
CLIENT_SEARCH_READY = YES localmente; Draft PR #145 aberta
```

O worktree `feat/contratos-cliente-pesquisavel` permanece intocado por esta implementação.

## B — Intervention save

```text
INTERVENTION_BASE = 1daec61b26c41dccd64e103b4a7c73c3cc65682a
INTERVENTION_BRANCH = fix/intervencao-edicao-pontual
INTERVENTION_HEAD = 786e6ce (último estado validado antes deste relatório)
INTERVENTION_PR = https://github.com/ShadowShtr/mo-limpezas/pull/146 (Draft)

AUDIT_ROOT_CAUSE_RECONFIRMED = YES
REAL_SAVE_PATH = ContratoSheet.handleSubmit -> updateContrato -> apply_contract_change_atomic (candidata)
WRITES_BEFORE_FIX = location, contract, services futuros, audit_logs, em chamadas independentes
PARTIAL_WRITE_REPRODUCED = YES — falha sintética numa escrita posterior deixou parcial no caminho legado; a prova nova confirma rollback

ATOMIC_RPC_REUSED = NO — não existe RPC compatível; T09 está congelada/incompatível
NEW_ATOMIC_RPC_REQUIRED = YES
SCHEMA_CANDIDATE_FILE = docs/INTERVENTION_ATOMIC_SCHEMA_CANDIDATE.sql
MIGRATION_NUMBER_ASSIGNED = NO
INTERVENTION_FIX_IMPLEMENTED = CANDIDATE YES; DB_FIRST_REQUIRED=YES; NOT_MERGEABLE_UNTIL_SCHEMA_NUMBERED

TEAM_EDIT = incluído no plano e aplicado com guardas company/contract/status
DATE_EDIT = incluído no plano de horários e serviços
SCHEDULE_EDIT = frequência, weekdays e schedule_days projetados antes da escrita
COMBINED_EDIT = uma RPC candidata com contrato, serviços e auditoria na mesma transação
REOPEN_PERSISTENCE = commit/read provado no PGlite; reabertura na base real ainda não provada
CALENDAR_SYNC = serviços futuros recebem horários projetados
TEAM_SYNC = serviços futuros recebem a equipa projetada
STALE_CONCURRENCY = PASS — timestamp stale e lock de contrato entre duas sessões reais
PARTIAL_WRITE_AFTER_FIX = 0 na prova PGlite com falha posterior

MANUAL_SERVICE_OVERRIDE_MECHANISM = services.is_exception; update-service e reschedule marcam edição manual
IS_EXCEPTION_OR_EQUIVALENT = YES
MANUAL_EDIT_SURVIVES_RESYNC = PASS — a RPC recusa UPDATE de ocorrência protegida
FINANCIAL_STACK_DEPENDENCY = YES — campos financeiros são preservados no patch; stack financeira não foi alterada
```

O runtime usa apenas a RPC candidata. O SQL não está em `supabase/migrations/`, não tem número reservado e contém os cabeçalhos `NOT_FOR_PRODUCTION`, `NOT_A_MIGRATION` e `MIGRATION_NUMBER_PENDING_TECHNICAL_DIRECTION`.

## C — Pontual

```text
PONTUAL_CANONICAL_SEMANTIC = serviço standalone com services.contract_id = NULL
PONTUAL_CONTRACT_FREQUENCY_CREATED = NO
PONTUAL_UI = opção existente “Serviço pontual” em ServiceCreateSheet
PONTUAL_CREATE = recurring=false -> createService
PONTUAL_ONE_SERVICE = YES por writer existente; prova desta ronda é estática
PONTUAL_CONTRACT_CREATED = NO
PONTUAL_FUTURE_GENERATION = 0
PONTUAL_EDIT = calendário/ServiceDetailSheet -> updateServiceTime, updateServiceValue e updateServiceNotes
PONTUAL_REOPEN = carregamento existente do serviço no calendário; não reaberto contra DB real
PONTUAL_CALENDAR = YES
PONTUAL_FROM_CONTRACT = BLOCKED_NEEDS_PRODUCT_DECISION — não fazer detach destrutivo
EXISTING_FREQUENCIES_REGRESSION = focused 130/130; suite completa sem regressão funcional nova atribuída
```

Não foi criado `contracts.frequency = 'pontual'`, nem alterado o domínio de frequência recorrente.

## D — Gates

```text
FILES_CHANGED =
  docs/INTERVENTION_ATOMIC_SCHEMA_CANDIDATE.sql
  docs/INTERVENCOES-EDICAO-PONTUAL-IMPLEMENTACAO.md
  reports/code-audit.json
  reports/file-classification.json
  src/app/actions/contratos.ts
  src/domain/scheduling/atomic-contract-plan.ts
  src/release-notes/2026-09-03-intervencoes-pontuais.ts
  src/release-notes/index.ts
  src/__tests__/atomic-contract-plan.test.ts
  src/__tests__/intervention-atomic-candidate-postgres.test.ts
  src/__tests__/intervention-atomic-candidate.test.ts
RELEASE_NOTES = src/release-notes/2026-09-03-intervencoes-pontuais.ts e index.ts
FOCUSED_TESTS = 130/130 antes; 10/10 testes específicos finais
POSTGRES_TESTS = 3/3 PGlite + 7/7 PostgreSQL real: commit, rollback, stale, lock e exceção
POSTGRES_REQUIRED_SKIPPED = 0
FULL_SUITE = 154 ficheiros passados, 25 falhados, 1 skipped; 3665 testes passados, 6 falhados, 471 skipped
TYPECHECK = PASS
LINT = PASS
BUILD = BLOCKED — prebuild não encontrou/obteve tsx; npm EACCES ao registry/cache
SECRETS = PASS
AUDIT = PASS — highConfidence vazio
DIFF_CHECK = PASS
CI = não aguardado

PRODUCTION_WRITES = 0
PRODUCTION_MIGRATIONS = 0
MERGE_EXECUTED = NO
DEPLOY = 0
```

Os failures da suite completa foram ambientais ou preexistentes: Docker sem acesso, timeouts de suites pesadas/CLI e o guard de rede `verify-target-guard`. O teste PGlite que excedeu o hook padrão sob carga foi corrigido e passou isoladamente com timeout explícito.

```text
BLOCKER = schema candidate ainda sem número/aplicação, push/PR bloqueados por credenciais GitHub ausentes e integração dependente da direção técnica
NEXT_ACTION = devolver tudo à direção técnica
```

Não foram tocadas migrations 090+, financial periods, payments, payroll, payment recurrence, branches do Claude, produção ou deployment.

## Handoff final

```text
BASE_SHA = 1daec61b26c41dccd64e103b4a7c73c3cc65682a
BRANCH = fix/intervencao-edicao-pontual
HEAD = 3f1ea64
COMMITS = 14cdbf5, 13756d5, 29de0f6, 2333a00, 3f1ea64

PATCH_BACKUP = C:\Users\tecno\Documents\Codex\2026-08-31\mol\handoff-artifacts\intervencao-2026-09-03-final\patches
BUNDLE_BACKUP = C:\Users\tecno\Documents\Codex\2026-08-31\mol\handoff-artifacts\intervencao-2026-09-03-final\intervencao.bundle

ROOT_CAUSE = múltiplas escritas independentes em updateContrato permitiam estado parcial
ATOMIC_RPC_CANDIDATE = docs/INTERVENTION_ATOMIC_SCHEMA_CANDIDATE.sql
MIGRATION_NUMBER_ASSIGNED = NO

POSTGRES_REAL = PASS — contentor PostgreSQL 17 descartável via harness do projeto
POSTGRES_TESTS = 7/7
POSTGRES_REQUIRED_SKIPPED = 0
ROLLBACK_ALL = PASS
STALE = PASS
CONCURRENCY = PASS — duas sessões, FOR UPDATE de contrato
TEAM_EDIT = PASS
DATE_EDIT = PASS
SCHEDULE_EDIT = PASS
COMBINED_EDIT = PASS
REOPEN = PASS — readback após commit; UI real não foi aberta

PONTUAL_SEMANTIC = services.contract_id IS NULL
PONTUAL_ONE_SERVICE = PASS — 1 service
PONTUAL_CONTRACT_ID = NULL
PONTUAL_CONTRACT_CREATED = 0
PONTUAL_FUTURE_GENERATION = 0
PONTUAL_EDIT = PASS — caminho existente de edição standalone
PONTUAL_FROM_RECURRENT = BLOCKED_NEEDS_PRODUCT_DECISION

MANUAL_OVERRIDE_MECHANISM = services.is_exception
MANUAL_EDIT_SURVIVES_RESYNC = PASS

FULL_SUITE = BLOCKED_ENVIRONMENT — 154 ficheiros passados, 25 falhados, 1 skipped; 3665 testes passados, 6 falhados, 471 skipped
FAILURES = Docker sem acesso no sandbox; 3 timeouts de CLI T08; 1 timeout de setup PGlite sob carga; 1 timeout de fixture secure-migrations; 1 verify-target-guard sem erro de rede esperado. O timeout PGlite foi corrigido; a prova PostgreSQL real passou.
BUILD = BLOCKED_ENVIRONMENT — npm EACCES ao obter tsx em https://registry.npmjs.org/tsx; logs não puderam ser escritos em C:\Users\tecno\AppData\Local\npm-cache\_logs
TYPECHECK = PASS
LINT = PASS
SECRETS = PASS
AUDIT = PASS — diagnostics vazio/highConfidence vazio
DIFF_CHECK = PASS

INTERVENTION_PUSH = PASS — push normal sem force-push
INTERVENTION_PR = https://github.com/ShadowShtr/mo-limpezas/pull/146 (Draft)

OVERLAP_FILE = src/app/(dashboard)/dashboard/contratos/_components/sheet.tsx
OVERLAP_WORKTREE = C:\Users\tecno\Documents\Codex\2026-08-31\mol\work\contratos-cliente-pesquisavel
OVERLAP_BRANCH = feat/contratos-cliente-pesquisavel
OVERLAP_HEAD = 46fe901
OVERLAP_OWNER = trabalho anterior do próprio Codex
OVERLAP_UNCOMMITTED = NO — preservado em commit
OVERLAP_REASON = mesmo ficheiro editado; recuperação segura em branch própria
OVERLAP_CLASSIFICATION = CASE C

CLIENT_SEARCH_IMPLEMENTED = YES
CLIENT_SEARCH_BRANCH = feat/contratos-cliente-pesquisavel
CLIENT_SEARCH_HEAD = 46fe901
CLIENT_SEARCH_TESTS = 26/26
CLIENT_SEARCH_BUILD = BLOCKED_ENVIRONMENT — mesmo prebuild npm EACCES ao obter tsx
CLIENT_SEARCH_PUSH = PASS — push normal sem force-push
CLIENT_SEARCH_PR = https://github.com/ShadowShtr/mo-limpezas/pull/145 (Draft)

CLIENT_SEARCH_PATCH_BACKUP = C:\Users\tecno\Documents\Codex\2026-08-31\mol\handoff-artifacts\contratos-2026-09-03-final\patches
CLIENT_SEARCH_BUNDLE_BACKUP = C:\Users\tecno\Documents\Codex\2026-08-31\mol\handoff-artifacts\contratos-2026-09-03-final\contratos.bundle

PRODUCTION_WRITES = 0
PRODUCTION_MIGRATIONS = 0
PRODUCTION_REPAIRS = 0
MERGES = 0
DEPLOYS = 0
TASK_CLOSED = NO — handoff pendente
NEXT_RECOMMENDED_ACTION = devolver à direção técnica para validação dos diffs e posterior integração com a stack do Claude
```
