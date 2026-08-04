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
