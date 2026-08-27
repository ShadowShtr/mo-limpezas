# Handoff — troca de PC — 2026-08-27

> Continuidade técnica sanitizada. Não contém segredos nem detalhes operacionais de produção. Não autoriza merge, migration, repair, backfill ou deploy.

## Base observada

- `master`: `8a90f6df60ded87f58c98cdab81ed13e8c8234a4`
- Onda financeira atual: `077 -> 078 -> 079 -> 080 -> 081`
- `070`: continua bloqueada e fora da onda.
- `082`: adiada para a integração do Financeiro V2.

## Stack F14 publicada

| PR | Branch | HEAD observado | Papel |
| --- | --- | --- | --- |
| #97 | `migration/077-secure-migrations-ledger` | `b3cd43c8c8e2875859209b13b668687436d6ee8f` | 077 |
| #99 | `migration/078-reconciled` | `b54db96622b40672340ade7e5f8a131a0a25d41b` | 078 |
| #100 | `migration/079-f14a-reuse-pending` | `f158f93c42133fe3f7b38bbb919c72aec1bc5744` | 079 |
| #104 | `migration/f14b-payment-cashflow-provenance` | `3d52e8bf2112fbea208b9dd389187aa27184361c` | 080 + 081 |
| #105 | `migration/f14c-six-pending-repair` | `53846841f89192dabcef9b44c482b4ec9c7e5926` | tooling futuro das 6 |
| #108 | `migration/f14d-atomic-finance-mutations` | `824aa967906ff82d3d2629316f56a0349fe62a10` | 082 / TOCTOU, adiada |
| #109 | `migration/f14e-pending-cashflow-contract` | `9ecff60423c4baa4efa7c6318a9d81e3d7480a27` | contrato reaplicado, adiado |

Revalidar todos os HEADs e CI ao retomar.

## PR #84

- `codex/hardening-invoice-cash-atomicity`
- HEAD observado: `f356dca152c0f6c4942de9ac3ec1ffa41c92945b`
- O número provisional `080` foi removido.
- Número final permanece `UNASSIGNED`.
- Base antiga: não integrar sem reconciliação futura contra `master` atual.

## Decisão pendente obrigatória antes de merge de 079/080/081

A revisão provou que migrations 079/080/081 possuem wrappers transacionais internos que podem quebrar a atomicidade entre efeito de schema e provenance no ledger quando executadas dentro do runner transacional.

Decisão da direção técnica:

- corrigir isso antes de qualquer merge dessas migrations;
- remover/adaptar wrappers internos de modo que a transação do runner seja a autoridade;
- repetir Postgres real, migration chain, rehearsals e CI afetados;
- reempilhar descendentes quando necessário;
- `BASE_CHANGED = REVALIDATION_REQUIRED`.

077/078 não foram apontadas com esse defeito na revisão atual.

## Merge

Nenhum merge está autorizado por este handoff.

Plano conceitual após a correção e nova validação:

`#97 -> #99 -> #100 -> #104`

#105 permanece fora da onda de migration e deve voltar apenas na fase de repair das 6, salvo nova decisão.

## Runbook de produção

Existe um rascunho local informado pelo Claude no PC antigo, mas ele NÃO deve ser tratado como dependência nem versionado em repositório público.

O runbook executável deve ser regenerado depois dos merges a partir de:

- `master` SHA fresco;
- ledger fresco;
- schema fresco;
- checksums/fingerprints frescos;
- preflight fresco.

Nunca executar o rascunho antigo.

## Financeiro V2 congelado

Preservar para revisão posterior:

- #98 — unified read model;
- #101 — nova UI Pagamentos;
- #102 — superseded for integration;
- #103 — legacy nav `PREPARED_ONLY`;
- #108/#109 — fundação/contrato para a reconciliação posterior.

Não integrar antes de fechar a onda 077→081.

## Equipas na fila

- #106 — core transacional BUILD_AHEAD;
- #107 — UI/runtime BUILD_AHEAD.

Decisão atual: `CORRIGIR`, não reconstruir do zero.

Requisitos preservados:

- Calendário → Equipas e Menu lateral → Equipas continuam interfaces diferentes;
- drag do Calendário é local até Guardar;
- membership guardada no Calendário deve refletir composição permanente conforme decisão do produto;
- viatura continua diária;
- não substituir membership permanente por override diário;
- concorrência fina por colaborador;
- identidade de pessoa e conta de acesso não pode ser presumida igual;
- dirty close/refresh não perde alterações;
- stale count da página Equipas continua corrigido;
- migration de Equipas continua provisional e sem número até nova varredura.

## Ordem mestre de retomada

1. Atualizar clone e verificar estado real de `master`, branches, PRs e CI.
2. Ler os MDs canónicos do projeto.
3. Corrigir atomicidade transacional de 079/080/081.
4. Reempilhar/retestar/re-CI todos os descendentes afetados.
5. Fazer nova inspeção read-only de produção apenas quando necessária e autorizada.
6. Pedir autorização explícita antes do primeiro merge.
7. Depois dos merges, gerar runbook 077→081 final.
8. Proprietário executa migrations manualmente uma por vez somente quando `PRODUCTION_EXECUTION_READY = YES`.
9. Proveniência histórica.
10. Repair das 6.
11. Competência histórica.
12. Financeiro V2.
13. Retirada de legacy UI.
14. Invoice hardening #84 no momento apropriado.
15. Equipas #106/#107.
16. Cobranças manuais.

## Regras permanentes

Antes de cada alteração:

`ALVO -> O QUE CRIA -> QUEM CONSOME -> O QUE DEPENDE -> O QUE SINCRONIZA -> O QUE PODE QUEBRAR`

- `BASE_CHANGED = REVALIDATION_REQUIRED`
- `RELATED_IMPLEMENTATIONS = ONE_COHERENT_SOLUTION`
- `NO_DATA_LOSS = YES`
- `UNKNOWN_STATE = FAIL_CLOSED`
- `FAIL_FAST_REQUIRED = YES`
- `POSTGRES_REQUIRED_SKIPPED = 0`
- `NODE_MODULES_LOCAL_IS_NOT_EVIDENCE = YES`

Sem autorização explícita:

- `PRODUCTION_WRITES = 0`
- `PRODUCTION_MIGRATIONS = 0`
- `PRODUCTION_REPAIRS = 0`
- `PRODUCTION_BACKFILLS = 0`
- `MERGES = 0`
- `DEPLOYS = 0`

## Comandos iniciais no novo PC

```bash
git fetch --all --prune
git status
git branch --show-current
git rev-parse origin/master
git log --oneline --decorate -n 20 origin/master
```

Depois conferir as PRs acima antes de qualquer checkout/rebase/alteração.

Este handoff é `INPUT_FOR_DECISION`; o estado real no Git/GitHub no momento da retomada continua sendo a fonte de verdade.