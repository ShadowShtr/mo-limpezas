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
  34 triggers de `revision` (mais que 1 por tabela nalgumas — duplicação
  real, ainda por corrigir), 14 funções `SECURITY DEFINER`, 84 policies,
  RLS ativo em tudo exceto `_migrations`, `company_change_events` fora da
  publicação Realtime, 30 utilizadores Auth, 3 buckets Storage privados.
  Ver `docs/atomicidade-audit/T03-backup-manifesto-2026-08-04.md`.
- Lacuna corrigida: `scripts/backup-all.mjs` não incluía `building_cards`
  nem `data_history` — corrigido, backup novo já cobre as duas.

## Migration 064 (nova) — ensaiada, ainda não aplicada

`supabase/migrations/064_revoke_public_grants_atomic_functions.sql` — só
`REVOKE EXECUTE` de `anon`/`authenticated`/`PUBLIC` em
`record_company_change_event`, `delete_client_atomic` e
`set_invoice_status_atomic` (achado do T03: estavam concedidas em
produção). Confirmado por leitura do código que nenhum destes é chamado
fora de `service_role`, portanto não muda comportamento observável da
aplicação.

Ensaiada com `node scripts/rehearse-migration.mjs` (`BEGIN` → aplica →
verifica 0 grants residuais → `ROLLBACK`) diretamente na base real:
sucesso, fingerprint idêntico antes/depois. **Ainda não aplicada de
verdade** — falta autorização explícita para `node scripts/run-migrations.mjs --apply`.

Já adicionada a `activeMigrations` em `supabase/migration-policy.json`
(68 migrations ativas agora) — o diagnóstico (`/dashboard/sistema/diagnostico`)
passa a reportar corretamente esta migration como pendente até ser
aplicada de facto.

## Pendente — só o dono pode confirmar

- Painel Supabase → Backups e Settings da organização → Billing: plano
  exato e o que inclui (já confirmado visualmente como Free; falta
  confirmar se há alguma retenção de backup mesmo assim).
