# Auditoria — Intervencao: edicao, guardar e Pontual

Data: 2026-09-02
Repositorio: `ShadowShtr/mo-limpezas`
Restricoes respeitadas: sem migration, sem producao, sem merge, sem deploy e sem push.

ORIGIN_MASTER_SHA = `e9b01db73e1bacb2c49a000c1867f846dbd248de`
BASE_SHA = `e9b01db73e1bacb2c49a000c1867f846dbd248de`
CURRENT_BRANCH = `fix/intervencao-edicao-pontual`
CURRENT_HEAD = `e9b01db73e1bacb2c49a000c1867f846dbd248de` antes do relatorio
WORKTREE_STATUS = limpo antes da edicao; no final apenas este relatorio novo

## A — Client Search

CLIENT_SEARCH_BRANCH = `feat/contratos-cliente-pesquisavel`
CLIENT_SEARCH_HEAD = `e9b01db73e1bacb2c49a000c1867f846dbd248de` (worktree com alteracoes nao commitadas da frente anterior)
CLIENT_SEARCH_PR = none aberto nesta ronda
CLIENT_SEARCH_TESTS = 26/26 focados; typecheck e lint anteriores passaram
CLIENT_SEARCH_BLOCKER = integrar/revalidar sobre o master escolhido pela direcao; nao tocar nessa worktree

## B — Intervention Edit

INTERVENTION_BASE_SHA = `e9b01db73e1bacb2c49a000c1867f846dbd248de`
INTERVENTION_BRANCH = `fix/intervencao-edicao-pontual`
INTERVENTION_HEAD = `e9b01db73e1bacb2c49a000c1867f846dbd248de`

INTERVENTION_UI_FILE = `src/app/(dashboard)/dashboard/clientes/[id]/_components/interventions-section.tsx` + `src/app/(dashboard)/dashboard/contratos/_components/sheet.tsx`
INTERVENTION_SAVE_HANDLER = `ContratoSheet.handleSubmit` (`sheet.tsx:379`)
INTERVENTION_SERVER_ACTION = `updateContrato` (`src/app/actions/contratos.ts:566`)
INTERVENTION_RPC = nenhuma
INTERVENTION_TABLES = `profiles`, `locations`, `contracts`, `services`, `audit_logs`/`data_history`
DATE_FIELDS = `contracts.starts_on`, `contracts.ends_on`, `services.scheduled_start`, `services.scheduled_end`
TEAM_FIELDS = `contracts.schedule_days[].team_id`, `services.team_id`, `teams`, `team_members`
FREQUENCY_FIELDS = `contracts.frequency`, `interval_days`, `weekdays`, `schedule_days`
REVISION_FIELDS = nenhum em `contracts`/`services`; `updated_at` nao e usado como optimistic concurrency
RLS_POLICIES_RELEVANT = action usa admin client; perfil e validado por `profiles.id = auth user id`; `services.team_id` tambem esta sujeito a FK
REALTIME_RELEVANT = nao ha canal Realtime para esta gravacao; a UI usa `router.refresh`/revalidacao

REPRODUCED = PARTIAL: a UI/DB real nao foi executada por ausencia de fixture segura; o caminho de falha pos-gravacao foi confirmado estaticamente
ERROR_MESSAGE_EXACT = `Falha ao propagar alteracao do contrato.` ou a mensagem original da query/geracao; nao foi possivel obter a mensagem concreta sem executar contra uma base de teste
ROOT_CAUSE_CLASS = RECURRENCE_SYNC_ERROR + NON_ATOMIC_MULTI_WRITE
ROOT_CAUSE_EXACT = `updateContrato` grava `contracts` primeiro e depois executa reconciliao, sincronizacao e geracao de `services`. Uma falha posterior devolve erro, mas nao desfaz a linha do contrato nem as escritas anteriores. A UI interpreta isso como erro ao guardar embora possa existir estado parcial.

TEAM_CHANGE_BEFORE_FIX = nao provado em runtime; payload chega em `schedule_days`, mas a propagacao posterior pode falhar
DATE_CHANGE_BEFORE_FIX = nao provado em runtime; `starts_on`/`ends_on` sao gravados antes da reconciliao
FREQUENCY_CHANGE_BEFORE_FIX = nao provado em runtime; `frequency`/`weekdays` sao gravados, mas nao ha transacao comum com as ocorrencias

CROSS_FRONT_OVERLAP = YES, apenas no ficheiro partilhado de release notes; NO nos ficheiros core desta frente
OVERLAPPING_PR = `#127`, `#128`, `#129`
OVERLAPPING_FILES = `src/release-notes/index.ts` e notas de release; nenhum dos tres PRs altera `contratos.ts`, `ContratoSheet` ou `interventions-section.tsx`

FIN_PERIOD_DEPENDENCY = YES — a propagacao pode alterar ocorrencias e valores economicos futuros consumidos por calendario/cobrancas. A integracao deve usar a fundacao canonica de periodo, nao uma guarda local.
AFFECTED_OPERATION = edicao de contrato recorrente que recalcula/gera servicos futuros
ECONOMIC_DATE = `services.scheduled_start` e o periodo civil da ocorrencia gerada
CURRENT_GUARD = nenhuma guarda de periodo em `updateContrato`; apenas validacoes de campos e protecoes de schema
REQUIRED_INTEGRATION = operacao transacional de contrato/servicos integrada com o protocolo canonico de periodos
RELATED_IMPLEMENTATIONS = uma unica solucao coerente, sem segunda guarda local

INTERVENTION_FIX_IMPLEMENTED = NO
TEAM_CHANGE_AFTER_FIX = N/A
DATE_CHANGE_AFTER_FIX = N/A
FREQUENCY_CHANGE_AFTER_FIX = N/A
COMBINED_CHANGE_AFTER_FIX = N/A
REOPEN_PERSISTENCE = N/A; requer teste de integracao com base de teste
ATOMICITY = FAIL: sem RPC/transacao unica; os `try/catch` apenas convertem a falha em erro e nao fazem rollback
STALE_CONCURRENCY = FAIL: nao existe `expected_revision` nem comparacao de snapshot; last-write-wins
CALENDAR_SYNC = PARTIAL: revalidacao e sincronizacao de ocorrencias existem, mas podem ficar parciais
TEAM_SYNC = PARTIAL: `schedule_days` propaga para ocorrencias futuras nao excepcionais, sem commit atomico

### Correcao proposta

Criar uma operacao transacional unica para editar o contrato, validar todas as equipas da empresa, reconciliar ocorrencias, sincronizar valores/equipas e gerar faltas. A operacao deve receber uma revisao/snapshot esperado e falhar fechado em caso stale. Nao dividir em updates independentes nem fazer fallback sem revisao.

## C — Pontual

FREQUENCY_CURRENT_VALUES = `daily`, `weekly`, `biweekly`, `triweekly`, `monthly`, `custom`
FREQUENCY_DB_TYPE = `TEXT`
FREQUENCY_DB_CONSTRAINT = `contracts_frequency_check` aceita apenas os seis valores acima (`supabase/migrations/055_triweekly_frequency.sql`)
FREQUENCY_DOMAIN_ENGINE = `src/domain/scheduling/recurrence-engine.ts`; desconhecido resulta em zero ocorrencias, e nao em uma ocorrencia unica
FREQUENCY_WRITERS = `ContratoSheet`, `createContrato`, `updateContrato`, `ServiceCreateSheet`
FREQUENCY_READERS = motor canonico, preview, tabela de contratos, cron, reconciliacao e adaptador `contract-occurrences`

EXISTING_ONE_TIME_CONCEPT = servico pontual em `services` com `contract_id IS NULL`, criado por `createService`; a ficha do cliente ja o apresenta separado de contratos recorrentes
REUSE_EXISTING_SEMANTICS = YES para servico pontual; nao transformar isso em uma frequencia de `contracts`
PONTUAL_CANONICAL_VALUE = `services.contract_id = NULL` + uma linha com a data/hora/equipa escolhidas
PONTUAL_SEMANTICS_CONFIRMED = YES para o conceito existente; NO para adicionar um novo valor a `contracts.frequency`
PONTUAL_MIGRATION_REQUIRED = YES se Pontual for adicionado a `contracts.frequency`, porque altera o `CHECK`; NO se a UI apenas reutilizar o fluxo existente de servico pontual
PONTUAL_SCHEMA_PROPOSAL = nao alterar schema nesta ronda; expor Pontual como modo de criacao que chama `createService`, mantendo contratos exclusivamente recorrentes
PONTUAL_EXISTING_FUTURE_OCCURRENCES_POLICY = servico pontual nao tem futuras automaticas; duplicacao e uma nova acao explicita. Conversao recorrente <-> pontual nao existe hoje e precisa de decisao de produto, sem apagar/mover passado

PONTUAL_IMPLEMENTED = NO
PONTUAL_SINGLE_OCCURRENCE_TEST = N/A; o fluxo existente `createService` deve ser coberto numa task propria
PONTUAL_NO_FUTURE_RECURRENCE = garantido pelo modelo existente (`contract_id IS NULL`), nao testado nesta branch
PONTUAL_REOPEN = N/A
PONTUAL_CALENDAR = o servico pontual existente aparece no calendario; nenhuma alteracao feita
EXISTING_FREQUENCIES_REGRESSION = 368/368 focados passaram; suite completa teve 3.644 testes passados

## D — Gates

FILES_CHANGED = apenas este relatorio
UNRELATED_FILES = nenhum
RELEASE_NOTE = nao necessaria: nao houve alteracao visivel de produto; `src/release-notes/index.ts` esta em overlap com #127/#128/#129
FOCUSED_TESTS = 4 ficheiros, 368/368 passaram
POSTGRES_TESTS = nenhum teste PostgreSQL especifico de Intervencao existe nesta base
POSTGRES_REQUIRED_SKIPPED = bloqueado: fixtures PostgreSQL da suite falharam ao iniciar por `permission denied while trying to connect to the docker API`; nao foi usada producao
TYPECHECK = PASS
LINT = PASS
SECRETS = PASS
AUDIT = PASS (`highConfidence` vazio)
BUILD = BLOCKED antes do build por `npx tsx`/npm cache `EPERM`, sem `tsx` local instalado
DIFF_CHECK = PASS

PR_NUMBER = none
PR_STATE = not opened
MERGE_EXECUTED = NO
PRODUCTION_WRITES = 0
PRODUCTION_MIGRATIONS = 0
DEPLOY = 0

BLOCKER = falta de transacao/RPC e de fixture PostgreSQL segura para provar e corrigir o fluxo sem risco de escrita parcial; Pontual em `contracts.frequency` tambem exigiria migration e criaria semantica duplicada
NEXT_RECOMMENDED_ACTION = devolver a direcao tecnica para revisao e integracao posterior. Abrir uma task de fundacao transacional para contratos/servicos e, depois, uma decisao explicita sobre a UX de Pontual.
