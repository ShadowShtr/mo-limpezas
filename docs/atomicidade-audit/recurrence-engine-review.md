# Motor canónico de recorrência — auditoria e unificação

Data: 2026-08-04.

Escopo autorizado desta etapa: **só** o motor de recorrência, em local (sem
Supabase, sem SQL, sem Docker). Migrations 064/065, RPCs, `contracts`/
`services` transacionais, Outbox e Realtime ficam explicitamente fora de
alcance — ver decisão do dono nesta sessão. A reconciliação de schema
064/065 continua **congelada**: nenhum comando `db push`, `migration
repair`, SQL Editor ou deploy foi executado.

## 1. Auditoria — implementações de recorrência encontradas no repositório

| Local | Papel | Estado antes desta etapa |
| --- | --- | --- |
| `src/lib/contract-occurrences.ts` (`getOccurrences`) | Geração real de `services` a partir de contratos — usado por `createContrato`/`updateContrato`/`reconcileFutureServicesForContract` (`src/app/actions/contratos.ts`) e pelo cron `src/app/api/cron/generate-services/route.ts` | Implementação própria, baseada em intervalo `[rangeStart, rangeEnd]` |
| `sheet.tsx` (`calcOccurrences`) — `src/app/(dashboard)/dashboard/contratos/_components/sheet.tsx` | Preview de "próximas N ocorrências" no formulário de contrato (só UI, nunca grava nada) | Segunda implementação independente, baseada em contagem (`count`), com a sua própria cópia das regras de mensal/semanal/quinzenal/personalizado |

Achado confirmado: **bug real de recorrência mensal em janelas de vários
meses**. `getOccurrences` (versão antiga) calculava a ocorrência mensal
apenas para o mês de `rangeStart`, ignorando o resto do intervalo pedido.
`generateServicesForContract` (`src/app/actions/contratos.ts`) chama-o com
uma janela de **3 meses** (`rangeEnd = anchor + 3 meses`) — na prática, um
contrato mensal só gerava **1 serviço no total** por chamada, em vez de 1
por mês dentro da janela. Não havia teste que cobrisse janelas de mais de 1
mês — `src/__tests__/contract-occurrences.test.ts` só testava ranges de um
único mês, por isso o bug nunca foi apanhado.

Achado secundário (já apontado no histórico do próprio ficheiro): as duas
implementações já tinham divergido uma vez antes — o preview de "diário"
chegou a não saltar fins de semana enquanto a geração real saltava. É
exatamente o padrão que a regra 8/10 do AGENTS.md proíbe ("duplicar
recorrência" / consulta ou cálculo copiado noutro ficheiro).

## 2. Motor canónico criado

`src/domain/scheduling/recurrence-engine.ts` — módulo puro (sem I/O, sem
Supabase, só datas), com:

- `iterateOccurrences(contract, from)` — gerador único, base de tudo o
  resto. Produz ocorrências em ordem cronológica crescente a partir de
  `from` (ou do início do contrato, o que for mais tarde), avançando
  mês a mês / dia a dia / N-em-N dias conforme a frequência, até
  `ends_on` ou a um travão de segurança (~20 anos) que só existe para
  nunca correr infinitamente se um consumidor esquecer de parar de
  iterar — nunca é o critério de paragem em uso normal.
- `occurrencesInRange(contract, rangeStart, rangeEnd)` — corta por data;
  usado pela geração real de `services`. Substitui o `getOccurrences`
  antigo com a **mesma assinatura e mesmo comportamento**, exceto a
  correção do bug mensal.
- `occurrencesFrom(contract, from, count)` — corta por contagem; usado
  pelo preview do formulário.
- `shiftToNextBusinessDay`, `DOW_TO_KEY`, `toDateStr` — utilitários
  partilhados, uma só definição.

`src/lib/contract-occurrences.ts` deixou de ter lógica própria — é agora
só um re-export (`getOccurrences` = `occurrencesInRange`) para não obrigar
a alterar todos os chamadores de uma vez. `contratos.ts` e o cron
continuam a importar `getOccurrences` de `@/lib/contract-occurrences` sem
qualquer alteração de código — herdam a correção automaticamente por
importarem pelo nome, não por terem sido tocados.

`sheet.tsx` (`OccurrencePreview`/`calcOccurrences`) passou a ser um
adaptador fino sobre `occurrencesFrom` — monta um `RecurrenceContract`
mínimo (schedule sintético, já que o preview só mostra datas) e devolve
`Date[]`. É alteração só de UI, não tocou em nenhuma `action`.

## 3. Correção do bug mensal

Antes: `monthly` calculava **uma única data**, no mês de `rangeStart`.

Depois: avança `monthCursor` mês a mês (nunca antes do mês de início do
contrato), aplicando o desvio de fim de semana a cada mês, e para em
`ends_on` ou quando o cursor ultrapassa o fim do intervalo pedido pelo
chamador (com tolerância de até 2 dias para o desvio de fim de semana, tal
como o comportamento antigo já tinha para "personalizado").

Coberto por teste (`src/__tests__/recurrence-engine.test.ts`):
`"gera uma ocorrência por mês quando a janela cobre 6 meses (bug
histórico: só gerava 1 no total)"` e um segundo teste que reproduz
exatamente a janela de 3 meses usada por `generateServicesForContract`.

## 4. Testes novos

`src/__tests__/recurrence-engine.test.ts` — 32 testes:

- Mensal em janela de vários meses (o bug corrigido) — 4 testes.
- `shiftToNextBusinessDay` — 3 testes.
- Semanal/quinzenal/3-em-3-semanas — 3 testes.
- Personalizado — 2 testes.
- Diário — 1 teste.
- `occurrencesFrom` (preview por contagem, incluindo atravessar a
  virada do ano) — 2 testes.
- DST (mudança de hora em Portugal, 2026-03-29 início e 2026-10-25 fim
  do horário de verão) — 3 testes: diário e semanal a atravessar a
  transição sem saltar nem duplicar dia, mensal com dia-âncora perto da
  transição de outubro.
- Invariantes, aplicados a todas as 6 frequências via `it.each`:
  nunca gera datas duplicadas nem fora de ordem; `iterateOccurrences`
  e `occurrencesInRange` concordam no prefixo dentro da mesma janela;
  exclusões manuais respeitadas; lista vazia sem `schedule_days`.

Os 12 testes antigos de `src/__tests__/contract-occurrences.test.ts`
continuam a passar sem alteração (só o `getOccurrences` que importam
mudou de implementação por baixo, não de comportamento observável).

Resultado local: `npm test` — 31 ficheiros, **540 testes, 0 falhas**.

## 5. Mapeamento da integração do cron (documentação — sem alteração de código)

`src/app/api/cron/generate-services/route.ts` já importa `getOccurrences`
de `@/lib/contract-occurrences` — ou seja, **já está a usar o motor
canónico nesta mesma entrega**, sem precisar de nenhuma alteração de
código, porque consome pelo nome do wrapper de compatibilidade. Isto foi
confirmado, não presumido: `contract-occurrences.test.ts` (que testa via
`getOccurrences`, o mesmo símbolo que o cron importa) passa integralmente
depois da troca de implementação.

Diferença de uso a registar para uma fase futura (sem tocar agora):

- O cron chama `getOccurrences(contract, monthStart, monthEnd)` sempre com
  uma janela de **exatamente um mês** — por isso nunca foi atingido pelo
  bug mensal de vários meses (só `generateServicesForContract`, com janela
  de 3 meses, era atingido).
- Consumo direto de `src/domain/scheduling/recurrence-engine.ts` (sem
  passar pelo wrapper `src/lib/contract-occurrences.ts`) pode substituir o
  import do cron numa fase futura, quando o wrapper for descontinuado —
  não há urgência, o wrapper não tem custo de comportamento, só indireção.
- Fora de alcance nesta etapa: qualquer redesenho transacional da
  geração de `services` (ver secção 6 do ponto de paragem em
  `docs/ATOMICIDADE-IMPLEMENTACAO.md` sobre `createContrato`/
  `updateContrato` não usarem RPC/transação real) — decidido pelo dono
  como próxima fase separada, depois da reconciliação 064/065.

## 6. Validações locais

```text
git diff --check: passou, apenas avisos CRLF (normais neste repo)
npx tsc --noEmit: passou
npm run lint: passou, 0 erros/avisos
npm test: 31 arquivos, 540 testes, 0 falhas
npm run build: passou, 50 páginas geradas
```

## 7. Correção adicional (menor, acordada nesta sessão)

`archiveCliente` (`src/app/actions/clientes.ts`) não tem nenhum chamador
em nenhum componente da UI — confirmado por `git grep` no histórico
completo, não só nesta branch. A mensagem de erro de `deleteCliente` para
`CLIENT_HAS_HISTORY` prometia "Pode arquivar o cliente como ação
separada", uma funcionalidade que não existe na prática. Removida a
promessa da mensagem (`src/app/actions/clientes.ts` e
`src/app/(dashboard)/dashboard/clientes/_components/table.tsx`) até o
botão de arquivar ser efetivamente ligado à UI — decisão do dono: opção
"remover a promessa" em vez de "ligar o botão agora", por ser mais segura
antes da reconciliação 064/065.

## 8. Estado explicitamente fora de alcance nesta etapa

```text
supabase/migrations/064_domain_atomicity_outbox.sql
supabase/migrations/065_fix_domain_atomicity_outbox.sql
RPCs (archive_client_atomic, delete_empty_client_atomic, set_invoice_status_atomic, etc.)
clientes.ts / invoices.ts (lógica de mutation_id/revision já existente — não tocada)
contratos.ts — createContrato/updateContrato como transação real (RPC)
Outbox / company_change_events / Realtime
Qualquer banco (Docker, Supabase, produção)
```

Hash congelado de referência (065, inalterado nesta etapa):

```text
cb68199dce5ed90e0a1afde60cd47aef3891ad00c6033b23d8c8fff63a61383d  supabase/migrations/065_fix_domain_atomicity_outbox.sql
```
