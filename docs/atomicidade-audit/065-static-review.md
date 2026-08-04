# Revisao estatica da migration 065

Data: 2026-08-04.

Escopo: revisao local/read-only. Nenhuma migration foi aplicada.

## CLI

| Comando | Resultado |
| --- | --- |
| `npx supabase --version` | `2.111.0` |
| `npx supabase projects list` | `401 Unauthorized` |
| `npx supabase migration list` | `401 Unauthorized` |
| `npx supabase db push --dry-run` | `401 Unauthorized`; dry-run nao produzido |

## Schema real read-only

Artefato: `docs/atomicidade-audit/schema-readonly-065-check.json`.

| Item | Estado atual |
| --- | --- |
| `domain_mutations` | existe; 0 registros |
| `company_change_events` | existe; 0 registros |
| `company_sync_state` | nao existe |
| funcoes atomicas atuais | 4 funcoes da 064 parcial |
| Realtime | `notifications`, `services`; nao inclui `company_change_events` |
| CLI migrations | bloqueado por `401` |

## Matriz bloco por bloco

| Bloco | Objeto alterado | Estado atual encontrado | Alteracao proposta | Motivo | Risco | Compatibilidade com estado parcial | Dados preservados | Teste disponivel agora | Teste pendente | Rollback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `pgcrypto` | nao auditado como instalado | `CREATE EXTENSION IF NOT EXISTS pgcrypto` | `digest(..., sha256)` | baixo; exige permissao | sim | sem dados | revisao estatica | aplicar em descartavel | remover extensao so se nao usada |
| 2 | `revision` | integer em 8 tabelas | garantir coluna e converter para bigint | evitar overflow e padronizar contrato | lock em tabelas | sim, cobre estado 064 parcial | sim | schema read-only | aplicar e medir lock | converter de volta se sem overflow |
| 3 | `fn_increment_revision` | existe, sem `search_path` | recriar com `public, pg_temp` | hardening | baixo | sim | sim | revisao estatica | update real em descartavel | restaurar funcao anterior |
| 4 | `company_sync_state` | ausente | criar tabela com RLS fechado | sequencia por empresa | baixo | sim | nao altera dados existentes | schema read-only | rollback de sequencia | dropar se sem eventos novos |
| 5 | `domain_mutations` | existe incompleta; vazia no real | adicionar `operation/entity_id/request_hash/completed_at` | recibo idempotente completo | `SET NOT NULL` pode falhar se backfill incompleto | sim para tabela vazia e legado simples | classifica legado, nao inventa payload | contagem read-only | aplicar com dados em descartavel | remover colunas se sem dados novos |
| 6 | `company_change_events` | existe com identity, `delivered_at`, `affected_range`; vazia no real | remover identity funcional, transformar range, remover delivered_at | sequencia por empresa e outbox imutavel | reordenacao de eventos existentes; lock | suporta dados sem duplicados por mutation | preserva id/mutation/payload | contagem read-only | aplicar com eventos em descartavel | restaurar colunas/constraints antigas |
| 7 | constraints de eventos | unique atual por `(company_id, mutation_id, domain, event_type)` | unique por `(company_id, mutation_id)` e `(company_id, sequence)` | um evento por mutation | falha se duplicados existentes | tem check previo | sim se sem duplicados | revisao estatica | prova com dados reais copiados | remover nova constraint |
| 8 | overloads antigos | existem assinaturas 064 com `integer`/`tstzrange` | `DROP FUNCTION` exato | evitar RPC antiga acessivel | se chamada antiga ainda usada, quebra | sim; remove overload parcial | sem dados | rg em codigo | teste RPC descartavel | recriar assinatura antiga |
| 9 | `record_company_change_event` | usa `ON CONFLICT DO UPDATE` | recriar sem update, sequencia por empresa | evento imutavel | nao concedido ao `service_role` diretamente | interno funciona via owner | preserva evento existente | revisao estatica | chamada em descartavel | restaurar funcao |
| 10 | helpers `SECURITY DEFINER` | ausentes | criar `assert`, `lock`, `next`, `find`, `complete` | separar contrato atomico | superficie definer maior | revokes no fim | sim | revisao de grants | grants reais apos apply | dropar helpers |
| 11 | advisory lock | ausente | `pg_advisory_xact_lock(hashtext(company), hashtext(mutation))` | serializar mutation | colisao hash teorica; lock ate fim da transacao | sim | sim | revisao estatica | concorrencia real | remover helper |
| 12 | `request_hash` | ausente | hash JSON deterministico por operacao | detectar reutilizacao indevida | precisa estabilidade exata do JSON | sim | recibos antigos viram legado | revisao estatica | retry real | manter legado |
| 13 | RPC fatura | 064 parcial | lock, ator, revisao, caixa, auditoria, evento, recibo | atomicidade fatura/caixa/outbox | ver problemas abaixo | parcial | preserva fatura e caixa via transacao | rg + tsc/lint/test/build | `test:065` real | restaurar RPC anterior |
| 14 | `cash_flow_entries` | indice unico parcial existe | usa `ON CONFLICT` compatível | evitar duplicar caixa | depende do indice existente | sim | sim | schema read-only | aplicar em descartavel | sem alteracao schema |
| 15 | `archive_client_atomic` | ausente | arquivar cliente, cancelar contratos/futuro | evitar delete destrutivo | regra de negocio precisa validar | sim | preserva historico | revisao estatica | teste com dados | restaurar/remover RPC |
| 16 | `delete_empty_client_atomic` | ausente | deletar somente cliente sem historico | permitir limpeza segura | ver problema de `service_payment` | parcial | preserva historico detectado | revisao estatica | teste com caixa service_payment | restaurar/remover RPC |
| 17 | `delete_client_atomic` | existe destrutiva | substituir por erro | impedir delete historico | action atual ainda chama esse nome | tecnicamente sim, produto quebra delete | preserva dados | rg confirmou chamada | ajustar action depois | restaurar RPC antiga apenas emergencial |
| 18 | RLS | eventos select public policy; mutations fechada | policy eventos para `authenticated`; state fechado | frontend le eventos da empresa | precisa teste auth real | sim | sim | schema read-only | Supabase descartavel | restaurar policy antiga |
| 19 | Realtime | nao publica outbox | add table se publicacao existe | entregar eventos | exige teste real | sim | sim | schema read-only | assinatura real | remover da publicacao |
| 20 | grants | record atual exposto a anon/auth | revogar public/anon/auth; grants service_role nas RPCs principais | hardening | helper sem grant direto; ok se interno | sim | sim | schema read-only atual | grants apos apply | restaurar grants |

## Problemas encontrados

### P1 - ator e permissao sao validados depois do recibo existente

Alteracao necessaria:
Mover `assert_company_manager` para antes de `find_or_conflict_domain_mutation` nas RPCs publicas ou incluir validacao equivalente antes de qualquer retorno idempotente.

Motivo:
Hoje uma chamada com `company_id + mutation_id + request_hash` ja existente retorna resultado antes de validar `p_actor`.

Problema que resolve:
Impede que um ator invalido receba resultado autoritativo de mutation existente.

Arquivos ou objetos afetados:
`supabase/migrations/065_fix_domain_atomicity_outbox.sql`: `set_invoice_status_atomic`, `archive_client_atomic`, `delete_empty_client_atomic`.

Risco:
Baixo localmente; precisa teste real.

Pode ser feita somente localmente?
Sim.

Exige alteracao no banco?
Somente quando a 065 for aplicada futuramente.

Exige serviço externo?
Nao.

Alternativa sem serviço externo:
Documentar bloqueio e nao aprovar 065.

Consequencia de nao fazer:
Falha de seguranca em caminho idempotente.

### P2 - `delete_empty_client_atomic` nao bloqueia caixa `service_payment`

Alteracao necessaria:
Adicionar bloqueio para `cash_flow_entries.reference_type = 'service_payment'` associado aos `services` do cliente/local.

Motivo:
A regra exige nao apagar cliente com pagamento ou movimento financeiro.

Problema que resolve:
Evita apagar servicos/cliente com movimentos financeiros de pagamento avulso.

Arquivos ou objetos afetados:
`supabase/migrations/065_fix_domain_atomicity_outbox.sql`: `delete_empty_client_atomic`.

Risco:
Baixo localmente; precisa teste real.

Pode ser feita somente localmente?
Sim.

Exige alteracao no banco?
Somente quando a 065 for aplicada futuramente.

Exige serviço externo?
Nao.

Alternativa sem serviço externo:
Declarar `delete_empty_client_atomic` nao aprovado.

Consequencia de nao fazer:
Risco de perda de historico financeiro `service_payment`.

### P3 - action local ainda chama `delete_client_atomic`

Alteracao necessaria:
Atualizar a action local para chamar `archive_client_atomic` ou `delete_empty_client_atomic` conforme fluxo de UI.

Motivo:
A 065 desativa `delete_client_atomic`.

Problema que resolve:
Evita quebrar exclusao/arquivamento de cliente depois da 065.

Arquivos ou objetos afetados:
`src/app/actions/clientes.ts`; possivelmente UI de clientes.

Risco:
Medio; muda contrato de produto.

Pode ser feita somente localmente?
Sim.

Exige alteracao no banco?
Exige 065 aplicada futuramente para RPC nova existir.

Exige serviço externo?
Nao.

Alternativa sem serviço externo:
Manter action bloqueada ate decidir fluxo.

Consequencia de nao fazer:
A action chamara RPC desativada e recebera erro.

### P4 - triggers de revision nao sao recriados pela 065

Alteracao necessaria:
Adicionar `DROP TRIGGER IF EXISTS`/`CREATE TRIGGER` para as tabelas aprovadas, ou declarar que a 065 so suporta o estado auditado com triggers ja existentes.

Motivo:
A 065 garante a funcao, mas nao garante que todos os triggers existam.

Problema que resolve:
Compatibilidade com estado parcial onde colunas existem mas triggers nao.

Arquivos ou objetos afetados:
`supabase/migrations/065_fix_domain_atomicity_outbox.sql`.

Risco:
Baixo; locks DDL curtos.

Pode ser feita somente localmente?
Sim.

Exige alteracao no banco?
Somente quando a 065 for aplicada futuramente.

Exige serviço externo?
Nao.

Alternativa sem serviço externo:
Limitar contrato da 065 ao estado real auditado.

Consequencia de nao fazer:
Outro ambiente parcial pode ficar sem OCC real.

## Validações executadas

| Validacao | Resultado |
| --- | --- |
| `node --check scripts/test-065-domain-atomicity.mjs` | passou |
| `npx tsc --noEmit` | passou |
| `npm run lint` | passou |
| `npm test` | 29 arquivos, 493 testes passaram |
| `npm run build` | passou |
| consulta read-only schema | passou; artefato gerado |

## Testes pendentes

```text
PENDENTE — NÃO EXECUTADO POR AUSÊNCIA DE BANCO DESCARTÁVEL NO AMBIENTE ATUAL
```

- Aplicar 064 + 065 em banco limpo.
- Aplicar 065 em copia restaurada do estado auditado.
- Executar `npm run test:065` contra banco descartavel.
- Teste concorrente real.
- Teste real de Realtime.
- Teste real de rollback.
- `db push --dry-run` util; bloqueado por `401 Unauthorized`.

## Conclusao

A 065 nao deve ser aplicada sem banco descartavel, mas os quatro problemas locais identificados nesta revisao foram corrigidos na branch.

## Correcoes locais aplicadas em 2026-08-04

| Problema | Risco | Arquivo alterado | Funcao alterada | Solucao aplicada | Teste local | Teste PostgreSQL pendente | Estado final |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Recibo idempotente antes da autorizacao | ator invalido poderia obter resultado existente | `supabase/migrations/065_fix_domain_atomicity_outbox.sql` | `set_invoice_status_atomic`, `archive_client_atomic`, `delete_empty_client_atomic` | `assert_company_manager` agora roda antes do advisory lock e antes de `find_or_conflict_domain_mutation`; retorno estavel `FORBIDDEN_ACTOR` | `atomicity-065-static.test.ts` valida ordem auth -> lock -> recibo | PENDENTE - NAO EXECUTADO POR AUSENCIA DE BANCO DESCARTAVEL NO AMBIENTE ATUAL | corrigido localmente |
| `service_payment` nao bloqueava delete vazio | perda de historico financeiro | `supabase/migrations/065_fix_domain_atomicity_outbox.sql` | `delete_empty_client_atomic` | adicionadas travas e contagens para servicos, timesheets, faturas, invoice_items, caixa invoice, caixa service_payment e contratos historicos; retorno `{ ok:false, code:'CLIENT_HAS_HISTORY', history }` | teste estatico valida `service_payment`, `CLIENT_HAS_HISTORY` e ausencia de delete em cash_flow_entries | PENDENTE - NAO EXECUTADO POR AUSENCIA DE BANCO DESCARTAVEL NO AMBIENTE ATUAL | corrigido localmente |
| Action ativa chamava `delete_client_atomic` | action quebraria apos 065 e chamaria RPC desativada | `src/app/actions/clientes.ts`, `src/app/(dashboard)/dashboard/clientes/_components/table.tsx`, `src/lib/cliente-sheet-fields.ts`, `src/app/(dashboard)/dashboard/clientes/_components/clientes-tabs.tsx` | `deleteCliente`, `archiveCliente` | `deleteCliente` chama `delete_empty_client_atomic`; `archiveCliente` chama `archive_client_atomic`; UI passa `revision`; `CLIENT_HAS_HISTORY` nao vira sucesso; sem arquivamento automatico | testes estaticos validam chamadas e parametros | PENDENTE - NAO EXECUTADO POR AUSENCIA DE BANCO DESCARTAVEL NO AMBIENTE ATUAL | corrigido localmente |
| Triggers de revision nao garantidos | ambiente parcial poderia ficar sem OCC ou com trigger duplicado | `supabase/migrations/065_fix_domain_atomicity_outbox.sql` | bloco `fn_increment_revision` | adicionados `DROP TRIGGER IF EXISTS` e `CREATE TRIGGER` explicitos para 8 tabelas; query de auditoria documentada | teste estatico valida todos os triggers | PENDENTE - NAO EXECUTADO POR AUSENCIA DE BANCO DESCARTAVEL NO AMBIENTE ATUAL | corrigido localmente |

## Validacoes locais apos correcoes

| Comando | Resultado |
| --- | --- |
| `node --check scripts/test-065-domain-atomicity.mjs` | passou |
| `npx tsc --noEmit` | passou |
| `npm run lint` | passou, sem falhas |
| `npm test` | 30 arquivos, 502 testes, 0 falhas, 6.11s |
| `npm run build` | passou; compile 7.7s, TypeScript 15.2s, 50 paginas geradas em 569ms |

## Buscas finais

`delete_client_atomic` permanece apenas em migrations preservadas/065, documentacao historica, auditorias e teste estatico. Nenhuma action ativa chama `rpc("delete_client_atomic")`.

Triggers esperados na 065:

```text
trg_clients_revision
trg_locations_revision
trg_contracts_revision
trg_services_revision
trg_teams_revision
trg_team_members_revision
trg_invoices_revision
trg_invoice_items_revision
```

## Pendencias mantidas

```text
PENDENTE — NÃO EXECUTADO POR AUSÊNCIA DE BANCO DESCARTÁVEL NO AMBIENTE ATUAL
```

- Aplicar 064 + 065 em banco limpo.
- Aplicar 065 em copia restaurada.
- Executar `npm run test:065` contra banco descartavel.
- Teste concorrente real.
- Teste real de Realtime.
- Teste real de rollback.

## Rodada final local - rejected, triggers e UTF-8

Data: 2026-08-04.

Escopo: somente arquivos locais. Nenhuma migration foi aplicada.

Decisoes implementadas:

- `domain_mutations` permanece como a unica estrutura de idempotencia.
- `domain_mutations.status` passa a aceitar somente `succeeded` e `rejected`.
- `CLIENT_HAS_HISTORY` e persistido como rejeicao idempotente de negocio com `status = 'rejected'`.
- Replays com o mesmo `company_id + mutation_id` retornam o mesmo `result`; nova tentativa de usuario deve gerar nova `mutation_id`.
- `CLIENT_HAS_HISTORY` nao apaga linhas, nao altera revisao do cliente, nao cria `company_change_event` e nao aciona arquivamento automatico.
- Triggers que chamam exatamente `public.fn_increment_revision` sao removidos dinamicamente por funcao executada, independentemente do nome, e recriados com um unico nome canonico.
- Outra funcao de trigger que contenha alteracao textual de `NEW.revision` gera `REVISION_TRIGGER_CONFLICT` com tabela, trigger e funcao.
- A deteccao de conflito por `pg_get_functiondef` e textual/conservadora; precisa validacao real em banco descartavel.
- `src/app/actions/clientes.ts` e `table.tsx` foram restaurados do commit-base `5581784` e receberam apenas alteracoes localizadas.

Contrato final das RPCs:

- Sucesso: `{ "ok": true, "code": "OK" }` com campos da entidade/evento.
- Rejeicao previsivel: `{ "ok": false, "code": "CODIGO_ESTAVEL" }`.
- Codigos cobertos: `OK`, `INVALID_INPUT`, `FORBIDDEN_ACTOR`, `NOT_FOUND`, `REVISION_CONFLICT`, `MUTATION_REUSE_CONFLICT`, `CLIENT_HAS_HISTORY`, `INTERNAL_ERROR`.
- Exceptions ficam reservadas para falha tecnica, integridade inesperada ou estado impossivel que deve reverter a transacao.

Testes estaticos adicionados:

- `CLIENT_HAS_HISTORY` usa `rejected`, nao `completed` com `ok:false`.
- Rejeicao nao chama outbox, delete nem arquivamento.
- Replay consulta e devolve recibo existente.
- UI gera nova `mutation_id` por action server default, sem guardar ID permanente no componente.
- Triggers sao normalizados por funcao executada.
- Contagem final de trigger por tabela deve ser exatamente um.
- Conflito textual em outra funcao de trigger interrompe a migration.
- Textos UTF-8 esperados em `table.tsx` foram preservados.
- Trechos modificados nao usam `as any`, `as never`, `@ts-ignore` ou `@ts-expect-error`.

Validacoes locais desta rodada:

| Comando | Resultado |
| --- | --- |
| `git diff --check` | passou; apenas avisos CRLF |
| `node --check scripts/test-065-domain-atomicity.mjs` | passou |
| `npx tsc --noEmit` | passou |
| `npm test -- src/__tests__/atomicity-065-static.test.ts` | 15 testes passaram |

Pendencias reais permanecem:

```text
PENDENTE — NÃO EXECUTADO POR AUSÊNCIA DE BANCO DESCARTÁVEL NO AMBIENTE ATUAL
```

- Aplicacao real da 065.
- Concorrencia/advisory lock real.
- Rollback real.
- Realtime real.
- Validacao SQL do bloco dinamico de triggers em PostgreSQL.
