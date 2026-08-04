# Estado atual da Mó Limpezas

Última consolidação local: 4 de agosto de 2026.

## Git e publicação

- Base publicada conhecida: `origin/master` no commit `5581784`.
- Branch de correção local: `fix/atomic-contract-calendar-sync`.
- Os commits locais de recorrência, atomicidade e documentação posteriores a `5581784` não devem ser considerados publicados.
- Nenhuma migration 064/065 foi autorizada para execução.

## Migrations

- Baseline registado: migrations numeradas 001-063 e quatro migrations legadas datadas, total de 67 registos.
- Os checksums observados para esses 67 registos coincidiram com os ficheiros locais na auditoria read-only.
- O ledger usado pelo projeto é `public._migrations`.
- O ledger `supabase_migrations.schema_migrations` foi encontrado vazio e não é fonte de verdade nesta fase.
- Objetos equivalentes a parte do rascunho 064 existem no banco sem registo da 064.
- Os checkpoints 064/065 foram retirados de `supabase/migrations` e preservados em `docs/atomicidade-audit/frozen/`.
- `supabase/migration-policy.json` é a classificação executável: 001-063 e legadas estão ativas; 064/065 estão congeladas.
- `scripts/run-migrations.mjs` não aplica nem registra os checkpoints congelados, não faz baseline automático e não executa dados de demonstração.

## Estado funcional

### Confirmado localmente

- motor canónico de recorrência criado;
- defeito mensal multi-mês corrigido;
- testes de recorrência incluem frequências, exclusões e transições horárias;
- erros antes ignorados na reconciliação de contratos passaram a ser propagados;
- cliente/fatura possuem trabalho local de revisão e idempotência dependente das RPCs congeladas.

### Ainda não concluído

- contratos e serviços não são atualizados numa única transação;
- calendário e contratos não possuem sincronização Realtime completa;
- controlo de revisão não cobre todas as mutações;
- geração automática ainda precisa de identidade única de ocorrência e lease robusto;
- recorrência ainda precisa ficar independente do fuso do processo em todos os chamadores;
- RLS, views e funções privilegiadas precisam da matriz final de segurança;
- as RPCs novas de cliente/fatura da 065 não existem no schema operacional aprovado.

## Compatibilidade de deploy

A branch local está **bloqueada para deploy** enquanto qualquer código depender das RPCs congeladas. O bloqueio só termina quando uma migration nova, aprovada e classificada como ativa criar as capacidades necessárias, ou quando o código for adaptado para não depender delas.

O diagnóstico deve apresentar:

- baseline esperado 063;
- 67 migrations ativas registadas;
- 064/065 ausentes do ledger;
- outbox parcial como aviso, não como funcionalidade concluída;
- commit, branch, ambiente e referência pública do projeto.

## Evidência do banco observada

- `domain_mutations` existe e estava vazia;
- `company_change_events` existe, estava vazia e não estava publicada no Realtime;
- `company_sync_state` não existia;
- `record_company_change_event` tinha permissões excessivas;
- `services_full` refletia a migration 063;
- foram observados 20 contratos ativos/efetivos sem serviço futuro, 1 contrato ativo já terminado e 9 serviços futuros sem contrato;
- esses dados exigem classificação humana antes de reparação; não devem ser apagados automaticamente.

## Próxima ordem autorizada

1. concluir e validar diagnóstico/manifesto sem tocar no banco;
2. manter a branch bloqueada para deploy;
3. preparar nova migration de reconciliação a partir do fingerprint atual, sem alterar os checkpoints;
4. revisar SQL e executar somente ensaio transacional com rollback em janela controlada;
5. aplicar primeiro alterações aditivas;
6. publicar código compatível;
7. executar testes com contas e empresa de teste no ambiente existente;
8. só depois remover compatibilidade antiga e reparar dados aprovados.

## T03 concluído (2026-08-04)

- Projeto Supabase confirmado como plano **Free** — sem PITR nem backup
  automático garantido. O backup manual (`scripts/backup-all.mjs`) e a
  cadeia de migrations em `supabase/migrations/` passam a ser a única rede
  de segurança real deste projeto. Decisão do dono: continuar mesmo assim,
  sem upgrade de plano nem projeto Supabase adicional para ensaio — todo o
  ensaio de migration passa a ser feito por `BEGIN...ROLLBACK` diretamente
  na base real, nunca aplicação direta sem ensaio primeiro.
- Fingerprint completo capturado por leitura direta (`scripts/schema-inventory.mjs`):
  67 migrations no ledger (bate com a política), 8 tabelas com `revision`,
  14 funções `SECURITY DEFINER`, 84 policies, RLS ativo em tudo exceto
  `_migrations`, `company_change_events` fora da publicação Realtime,
  30 utilizadores Auth, 3 buckets Storage privados. Ver
  `docs/atomicidade-audit/T03-backup-manifesto-2026-08-04.md`.
- **Correção a um achado anterior desta mesma etapa:** a contagem de "34
  triggers de revision" reportada inicialmente estava errada — a query
  contava TODOS os triggers dessas 8 tabelas (`updated_at`, captura de
  histórico, guardas de campo), não só os de `revision`. Reconfirmado por
  leitura direta e filtrado pelo nome da função: cada uma das 8 tabelas
  tem exatamente **1** trigger `trg_<tabela>_revision → fn_increment_revision`,
  sem duplicação. Não há bug de revisão a incrementar mais que 1 por
  update — a normalização de triggers proposta na 065 congelada não é
  necessária no estado atual.
- Lacuna corrigida: `scripts/backup-all.mjs` não incluía `building_cards`
  nem `data_history` — corrigido, backup novo já cobre as duas.
- **Achado grave, ainda não corrigido em produção**: `anon` e
  `authenticated` tinham (antes da migration 065 nova, ver abaixo)
  privilégios completos — incluindo `TRUNCATE` — em `domain_mutations` e
  `company_change_events`. RLS não cobre `TRUNCATE` no Postgres (limitação
  do motor, não erro de policy) — qualquer cliente com a chave `anon`
  podia apagar as duas tabelas por completo. Impacto real até agora: zero
  (tabelas vazias). Corrigido pela migration 065 nova (ver abaixo).

## Migration 064 (nova) — APLICADA em produção (2026-08-04 16:33 UTC)

`supabase/migrations/064_revoke_public_grants_atomic_functions.sql` — só
`REVOKE EXECUTE` de `anon`/`authenticated`/`PUBLIC` em
`record_company_change_event`, `delete_client_atomic` e
`set_invoice_status_atomic` (achado do T03: estavam concedidas em
produção). Confirmado por leitura do código que nenhum destes é chamado
fora de `service_role`, portanto não muda comportamento observável da
aplicação.

Ensaiada com `node scripts/rehearse-migration.mjs` (`BEGIN` → aplica →
verifica 0 grants residuais → `ROLLBACK`) diretamente na base real:
sucesso, fingerprint idêntico antes/depois. Com autorização explícita do
dono, aplicada de verdade via `node scripts/run-migrations.mjs --apply`
(`MIGRATION_CONFIRM_PROJECT_REF` confirmado contra o projeto). Verificado
por leitura direta pós-aplicação: 0 grants residuais a
anon/authenticated/PUBLIC nas 3 funções, registo correto em
`public._migrations` com checksum.

`activeMigrations` em `supabase/migration-policy.json` já tinha esta
migration (68 migrations ativas) — o diagnóstico
(`/dashboard/sistema/diagnostico`) passa a reportar o ledger como
alinhado com o código outra vez.

## Migration 065 (nova) — APLICADA em produção (2026-08-04 16:47 UTC)

`supabase/migrations/065_revoke_public_grants_outbox_tables.sql` — fecha
o achado grave descrito acima: `REVOKE ALL` de `anon`/`authenticated` em
`domain_mutations` e `company_change_events` (incluindo `TRUNCATE`,
`INSERT`, `UPDATE`, `DELETE` — não só `EXECUTE` de função como a 064),
com `GRANT SELECT` de volta só em `company_change_events` para
`authenticated` (caminho de leitura pretendido para gestores, já
protegido por RLS).

Ensaiada com `node scripts/rehearse-migration.mjs` (generalizado nesta
etapa para também capturar grants de tabela, não só de função) —
sucesso, dentro da transação `authenticated` fica só com `SELECT` em
`company_change_events` e nada em `domain_mutations`, `ROLLBACK`
confirmado eficaz, fingerprint idêntico antes/depois. Com autorização
explícita do dono, aplicada de verdade via `--apply`. Verificado por
leitura direta pós-aplicação: `authenticated` tem exatamente `SELECT`
em `company_change_events`, nada em `domain_mutations`, `anon` sem
nenhum privilégio em nenhuma das duas — o `TRUNCATE` aberto está
fechado. `activeMigrations` já tinha esta migration (69 migrations
ativas).

## Migration 066 (nova) — ensaiada com sucesso total (20/20), ainda não aplicada

`supabase/migrations/066_outbox_foundation.sql` — fundação do outbox:
`company_sync_state` (sequência atómica por empresa via `SELECT ... FOR
UPDATE`), `domain_mutations` idempotente (`operation`/`entity_id`/
`request_hash`/`completed_at`, `find_or_conflict_domain_mutation`,
`complete_domain_mutation`, `lock_domain_mutation`), `company_change_events`
sem `IDENTITY` global (sequência por empresa), `affected_from`/`affected_to`
com CHECK de coerência, `record_company_change_event` reescrita para nunca
atualizar um evento existente (append-only), e publicação Realtime só
adicionada depois de tudo o resto. Não toca em nenhuma RPC de negócio.

Ensaiada com `node scripts/rehearse-066-outbox-foundation.mjs` (novo,
específico desta migration) — **20/20 verificações**, incluindo um teste
EMPÍRICO de isolamento (não só leitura da policy): cria 2 empresas e 2
utilizadores sintéticos dentro da própria transação, assume a role
`authenticated` com `request.jwt.claim.sub` de cada um (exatamente como o
PostgREST faz), e confirma que o utilizador da empresa A nunca vê o
evento da empresa B e vice-versa; confirma que `anon` recebe permission
denied; confirma que `authenticated` nem consegue `SELECT` em
`domain_mutations`. Tudo dentro de `BEGIN...ROLLBACK` — nada persistido,
fingerprint idêntico antes/depois.

Detalhe completo, riscos e limitação assumida (concorrência entre duas
ligações reais não pôde ser testada pré-aplicação, só a correção lógica
do `SELECT...FOR UPDATE`) em
`docs/atomicidade-audit/066-outbox-foundation-review.md`.

**Ainda não aplicada — falta autorização explícita para `--apply`.**
`activeMigrations` já tem esta migration (70 migrations ativas).

## PITR/backup — confirmado pelo dono (2026-08-04)

Todos os projetos Supabase desta conta estão no plano **Free**: sem PITR,
sem backup automático/gerido pela Supabase. Confirmado diretamente pelo
dono (painel Backups + Billing da organização), não é suposição. Decisão
explícita: continuar em produção assim mesmo, sem upgrade de plano nem
projeto adicional. Consequência operacional permanente enquanto isto não
mudar:

- o backup manual (`node scripts/backup-all.mjs`) é a única cópia de
  dados recuperável — deve ser corrido antes de qualquer migration que
  toque em dados, não só em schema;
- não há rede de segurança da Supabase para desfazer uma migration mal
  aplicada — por isso o ensaio `BEGIN...ROLLBACK`
  (`scripts/rehearse-migration.mjs`) antes de `--apply` deixa de ser
  "boa prática" e passa a ser obrigatório, sem exceção, para qualquer
  migration que altere estrutura ou dados;
- migrations destrutivas (`DROP COLUMN`, `DELETE`, etc.) exigem backup
  manual fresco imediatamente antes, sempre.
