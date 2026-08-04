# Riscos operacionais atuais

Última revisão: 4 de agosto de 2026.

| Prioridade | Risco | Controlo obrigatório | Estado |
|---|---|---|---|
| P0 | Branch depende de RPCs não aprovadas | bloquear deploy até compatibilidade de schema | aberto |
| P0 | 064 parcial sem ledger | fingerprint e reconciliação formal | aberto |
| P0 | contrato e serviços fora de transação | RPC atómica com revisão/idempotência | aberto |
| P0 | duas sessões sobrescrevem alterações | `expected_revision` obrigatório | aberto |
| P0 | calendário não converge entre utilizadores | outbox ordenado e recuperação de lacunas | aberto |
| P0 | geração automática duplicada/parcial | identidade única de ocorrência e lease | aberto |
| P0 | erro parcial apresentado como sucesso | resultado estruturado e rollback integral | em correção |
| P0 | policies antigas ampliam acesso | remover policies permissivas e testar matriz RLS | aberto |
| P0 | função interna executável pelo browser | revogar grants e validar ator/empresa | aberto |
| P1 | datas variam por fuso/DST | datas civis canónicas e testes UTC/Lisboa | aberto |
| P1 | formulário guarda props antigas | estado com revisão, dirty e conflito externo | aberto |
| P1 | cache mantém build antigo | política de atualização do Service Worker | parcial |
| P1 | escrita direta no navegador | mover para action/RPC auditada | aberto |
| P1 | ambiente aponta para projeto errado | diagnóstico de commit/ambiente/projeto | em correção |
| P1 | rate limit local em produção | configuração distribuída obrigatória | aberto |
| P1 | documentação induz operação antiga | índice e runbook únicos | corrigido localmente |

## Regras de segurança

- Operações críticas não são colocadas em fila offline por padrão.
- Nenhum retry ocorre sem identidade de mutação.
- Nenhum dado privado é servido por cache público.
- Nenhum serviço é apagado automaticamente por heurística de reconciliação.
- Nenhuma migration é aplicada fora da política e do runbook.
- Nenhum sucesso é mostrado antes da confirmação autoritativa do servidor.

## Sinais de incidente

- contrato alterado com serviços antigos;
- serviço reaparece depois de cancelado;
- dois dispositivos mostram calendários diferentes;
- revisão diminui ou resposta antiga substitui nova;
- job executa duas vezes para a mesma janela;
- outbox apresenta lacuna;
- migration congelada aparece no ledger;
- health mostra commit/projeto/baseline diferente;
- utilizador acessa dados de outra empresa.

Cada sinal exige preservar logs, mutation ID, entidade, revisão, commit e sequência antes de tentar reparação.
