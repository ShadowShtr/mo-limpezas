# Estado atual da Mó Limpezas

Última consolidação local: 4 de agosto de 2026.

> Para retomar este trabalho noutro computador, ler primeiro
> `docs/HANDOFF-2026-08-04.md` — tem SHA exato, comandos, variáveis de
> ambiente necessárias (só nomes) e a ordem exata dos próximos passos.

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
- **2026-08-05**: o ledger `public._migrations` mistura checksums calculados sobre LF e CRLF, ficheiro a ficheiro, sem padrão por intervalo (mapeamento completo em `docs/atomicidade-audit/migration-checksum-map-2026-08-05.md`). `scripts/lib/migration-checksum.mjs` faz o runner aceitar uma migração histórica quando o checksum do ledger bate com o ficheiro em RAW, LF-normalizado ou CRLF-normalizado; migrações novas gravam sempre o checksum sobre LF normalizado. A PR #27 (`.gitattributes` restrito a 064/065) ficou substituída por esta correção, não foi mesclada. `022_storage_bucket_collaborator_documents.sql` — nenhuma versão em git bate com o checksum do ledger; investigado e não corrigido às cegas (produção correta via `023`). Tratado como exceção formal, estreita e verificável em `supabase/migration-policy.json` → `knownChecksumExceptions` (nome + checksum do ledger + checksum LF do ficheiro atual pinados; qualquer divergência num dos três volta a falhar o `--dry-run`). `--dry-run` limpo (001-065 reconhecidas, `022` como exceção aceite com aviso explícito, `066`/`067` pendentes) idêntico no working directory e num worktree limpo.

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

## Renumeração (2026-08-04, ronda 2 de revisão)

A fundação do outbox passou de `066` para `067`. A vaga aberta pela
classificação dos grants (secção seguinte) revelou que `_migrations`
também precisa de uma correção urgente e isolada — como a antiga 066
(outbox) ainda não estava aplicada, coube-lhe o número seguinte livre
(`067`) e a nova correção de `_migrations` ocupa o `066`, para o runner
aplicar primeiro a proteção do próprio ledger. Ficheiros, scripts,
documentação e `migration-policy.json` todos atualizados em conjunto
(commit único, sem referências partidas).

## Migration 066 (nova) — protege `_migrations`, ensaiada, ainda não aplicada

`supabase/migrations/066_secure_migrations_ledger.sql` — achado da
classificação de grants: `_migrations` tinha RLS **desligada** e grants
completos (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`TRIGGER`/
`REFERENCES`) para `anon`/`authenticated`. Ao contrário do `TRUNCATE`, o
PostgREST **expõe** `INSERT`/`UPDATE`/`DELETE` normalmente — com RLS
desligada isto era explorável de facto via API pública para adulterar o
ledger de migrations. `REVOKE ALL` de `PUBLIC`/`anon`/`authenticated`,
RLS ativa com policy bloqueada (`FOR ALL USING (false)`). Não toca em
`service_role` (mantém os seus grants) nem no dono da tabela (`postgres`,
usado pelo runner — donos ignoram RLS por omissão).

Ensaiada com `node scripts/rehearse-066-secure-migrations-ledger.mjs`
(novo): confirma `anon`/`authenticated`/`PUBLIC` com zero privilégios,
RLS ativa, só a policy bloqueada, fora da publicação Realtime, o runner
(`postgres`, dono) continua a conseguir ler e inserir depois da proteção,
`service_role` mantém os seus grants, e acesso real como `anon`/
`authenticated` (via `SET LOCAL ROLE` + verificação de `permission
denied`) bloqueado tanto para leitura como escrita. Tudo dentro de
`BEGIN...ROLLBACK`, fingerprint idêntico antes/depois.

Escopo estritamente limitado a `_migrations` — as 6 views sinalizadas
(`services_full`, `teams_with_members`, `monthly_hours_summary`,
`services_calendar_summary`, `services_mobile_collaborator`,
`services_financial_private`) ficam para investigação dedicada (ver
secção seguinte), não tocadas aqui.

**Ainda não aplicada — falta autorização explícita para `--apply`.**

## Migration 067 (fundação do outbox) — ensaiada, ainda não aplicada

`supabase/migrations/067_outbox_foundation.sql` (renumerada de 066) —
fundação do outbox: `company_sync_state` (sequência atómica por empresa
via `SELECT ... FOR UPDATE`), `domain_mutations` idempotente
(`operation`/`entity_id`/`request_hash`/`completed_at`,
`find_or_conflict_domain_mutation`, `complete_domain_mutation`,
`lock_domain_mutation`), `company_change_events` sem `IDENTITY` global
(sequência por empresa), `affected_from`/`affected_to` com CHECK de
coerência, `record_company_change_event` reescrita para nunca atualizar
um evento existente (append-only) **e agora com `lock_domain_mutation`
antes do `SELECT`** — corrigido numa segunda ronda de revisão (ver
`docs/atomicidade-audit/067-outbox-foundation-review.md`, secção 0):
sem o lock, duas chamadas concorrentes com o mesmo `mutation_id` podiam
ambas passar o `SELECT` sem encontrar nada e a segunda falhar com
violação de unicidade em vez de devolver o evento idempotente. Publicação
Realtime só adicionada depois de tudo o resto. Não toca em nenhuma RPC de
negócio.

Ensaiada com `node scripts/rehearse-067-outbox-foundation.mjs`
(renumerado) — **21/21 verificações**, incluindo um teste EMPÍRICO de
isolamento (não só leitura da policy): cria 2 empresas e 2 utilizadores
sintéticos dentro da própria transação, assume a role `authenticated`
com `request.jwt.claim.sub` de cada um (exatamente como o PostgREST
faz), e confirma que o utilizador da empresa A nunca vê o evento da
empresa B e vice-versa; confirma que `anon` recebe permission denied;
confirma que `authenticated` nem consegue `SELECT` em `domain_mutations`.
Tudo dentro de `BEGIN...ROLLBACK` — nada persistido, fingerprint idêntico
antes/depois.

Detalhe completo, riscos e limitação assumida (concorrência entre duas
ligações reais não pôde ser testada pré-aplicação, só a correção lógica
do `SELECT...FOR UPDATE`/lock) em
`docs/atomicidade-audit/067-outbox-foundation-review.md`.

**Ainda não aplicada — falta autorização explícita para `--apply`.**
`activeMigrations` já tem as duas migrations (71 migrations ativas).

## Portão de autorização das 066/067 — condições do dono (2026-08-04)

Autorização de aplicação em produção **negada por agora**. Condições
antes de reconsiderar:

1. ✅ Branch publicada em `origin/fix/atomic-contract-calendar-sync` para
   revisão independente do commit exato.
2. ✅ `next_company_sequence` reexaminada — já usa o padrão seguro pedido
   (`INSERT ... ON CONFLICT DO NOTHING` antes do `SELECT ... FOR UPDATE`),
   não a versão racy.
3. ✅ Corrida em `record_company_change_event` corrigida (`lock_domain_mutation`
   antes do `SELECT`) numa segunda ronda de revisão. Falta prova empírica
   com ligações reais simultâneas (só possível com staging).
4. ✅ Investigação do incidente do `TRUNCATE` concluída — sem evidência de
   exploração passada; achado maior encontrado e agora **classificado**
   (não tratado como 528 falhas). Ver
   `docs/atomicidade-audit/incidente-truncate-2026-08-04.md`.
5. ✅ `_migrations` (achado com exploração prática confirmada, ao
   contrário do TRUNCATE) corrigido como migration 066 própria, isolada,
   ensaiada.
6. ✅ Errata documental da 065 registada sem editar a migration já
   aplicada — ver `docs/atomicidade-audit/065-errata-explorabilidade-truncate.md`.
7. ✅ SQL de reversão da 067 escrito e **testado** (aplicar → rollback →
   fingerprint idêntico ao original, dentro do mesmo tipo de ensaio). Ver
   `docs/atomicidade-audit/067-rollback.sql`.
8. ⏳ **Bloqueado — precisa de projeto Supabase de staging/descartável**,
   criado pelo dono (sem acesso ao painel/API de gestão); credenciais
   ficam só num `.env.staging.local` local, nunca em chat/docs/commits:
   teste de concorrência real (matriz completa — empresa nova com 2
   ligações, empresa existente com 20, empresas diferentes sem bloqueio
   cruzado, rollback sem estado órfão, mesmo `mutation_id` concorrente,
   `mutation_id` diferentes, falha a meio reverte tudo), teste de
   Realtime real (2 clientes autenticados, isolamento, reconexão,
   duplicação/perda de eventos, `anon` bloqueado).
9. ⏳ Snapshot/backup imediatamente antes da aplicação — por fazer no
   momento da aplicação real, não antes.
10. ⏳ Cadeia canónica de migrations (064/065 na branch principal, não só
    nesta branch) — por resolver, ver secção própria abaixo.

## Achado adicional — grants perigosos, agora classificados (não são 528 falhas)

Fora do escopo das 066/067: **528 grants** de `TRUNCATE`/`DELETE`/
`INSERT`/`UPDATE`/`TRIGGER`/`REFERENCES` a `anon`/`authenticated` em
praticamente todas as tabelas e views do schema `public`. Classificação
real (não um `REVOKE` cego):

- **44 tabelas/views com `TRUNCATE`/`TRIGGER`/`REFERENCES`** — categoria
  "revogar quase certamente" (mitigado na prática por `anon`/
  `authenticated` não terem `LOGIN` e a API pública não expor
  `TRUNCATE`, mas viola menor privilégio de qualquer forma).
- **`_migrations`**: RLS desligada + grants completos — única com
  exploração prática confirmada (PostgREST expõe INSERT/UPDATE/DELETE).
  **Corrigida como migration 066** (ver secção acima).
- **6 views com escrita direta** (`services_full`, `teams_with_members`,
  `monthly_hours_summary`, `services_calendar_summary`,
  `services_mobile_collaborator`, `services_financial_private`) — sem
  `security_invoker=true` conhecido (achado histórico anterior a esta
  sessão); precisa de investigação dedicada por view
  (`is_insertable_into`, triggers `INSTEAD OF`, dono, `security_invoker`)
  antes de qualquer correção — não deve ser classificada como explorável
  só pela leitura dos grants.
- **`companies`/`audit_logs`**: grants de escrita mas RLS ligada sem
  policy para esses comandos — seguro na prática (RLS nega por omissão
  sem policy), só grants redundantes.
- Resto: precisa de auditoria tabela a tabela (`INSERT`/`UPDATE`/`DELETE`)
  e de sequências (`USAGE`), nunca um `REVOKE` global — pode quebrar
  funcionalidade legítima da aplicação.

Recomendado como entrega própria e separada (matriz RLS completa),
depois de resolvida a decisão sobre 066/067. Detalhe completo em
`docs/atomicidade-audit/incidente-truncate-2026-08-04.md`.

## Cadeia canónica de migrations — 064/065 só nesta branch

Risco operacional identificado: 064 e 065 já foram **aplicadas em
produção**, mas os ficheiros só existem em
`fix/atomic-contract-calendar-sync`, não na branch principal
(`master`/`origin/master`). Antes de aplicar 066/067, a cadeia oficial
precisa ficar consistente: 064/065 presentes na branch canónica, com os
mesmos checksums do que foi realmente aplicado, registo correto em
`_migrations`, sem `--baseline` para mascarar diferenças, e aplicação da
066/067 separada do deploy do resto do código desta branch (que tem
muitas outras alterações — recorrência, atomicidade de clientes/faturas
— não relacionadas a migrations). Decisão de como fazer isto
(entrega de migrations isolada vs. integração controlada) — por definir
com o dono.

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
