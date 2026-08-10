# T17-B3 — Erros de consulta ignorados nas actions de escrita

> **2026-08-10** · branch `fix/t17b3-action-query-errors`, a partir de
> `chore/t17b2-endurecer-scripts`.
>
> Muda **tratamento de erro**, não regras de negócio. O caminho de sucesso
> ficou semanticamente idêntico, e o número de mutações é exactamente o mesmo.

---

## 0. 🚨 Confirmação

**ZERO** escritas na base · produção · credenciais · migrations · SQL ·
scripts administrativos executados · emails reais · T12 · T13 · T16 ·
Financeiro V2 · novas mutações.

**ZERO** alterações a `payments.ts`, `invoices.ts`, `daily-billing.ts`,
`src/domain/*`, `supabase/`, `scripts/historico/`, `package.json` ou `.env*` —
verificado no diff.

---

## 1. O escopo real: 84 → 65

O lote pedido tinha **84 ocorrências**. Só **65** eram accionáveis.

**19 estavam mal classificadas.** A regra de lote da T17-B1 dizia
"BATCH_3 = está em `actions/` ou tem `use server`" — e não "escreve". Isso pôs
no lote das *actions de escrita* 19 ocorrências de ficheiros com **zero
mutações**:

| Ficheiro | # | O que é |
|---|---|---|
| `reports.ts` | 9 | leitura pura, e superfície financeira excluída |
| `map.ts` | 3 | leitura |
| `pendencias.ts` | 2 | leitura |
| `calendar.ics/route.ts` | 2 | leitura |
| `financial-dashboard.ts` | 1 | leitura, superfície financeira excluída |
| `backups/export/route.ts` | 1 | leitura |
| `push/send/route.ts` | 1 | leitura |

O lote existe para **ordenar por risco**: um erro ignorado numa página de
leitura mostra, no pior caso, uma tabela vazia; num ficheiro que escreve,
autoriza uma escrita que não devia acontecer. Misturar os dois torna o número
inútil para decidir por onde começar.

**`batchOf` foi corrigido** para exigir que o ficheiro escreva. As 19 passaram
a `BATCH_4_PAGINAS_LEITURA`, onde pertencem, e continuam por corrigir.

---

## 2. Resultado

| | Antes | Depois |
|---|---|---|
| `BATCH_3_ACTIONS_ESCRITA` | **84** | **0** |
| Total no repositório | 268 | **198** |
| Ficheiros afectados | 82 | 79 |

| Estado | # |
|---|---|
| **RESOLVED** | **64** |
| **FALSE_POSITIVE** | **1** |
| Reclassificadas para BATCH_4 | 19 |
| STANDBY | 0 |
| BLOCKED (payments/invoices) | 19, intactas |

O total desce 70 (64 corrigidas + 6 falsos positivos de `getPublicUrl`
eliminados do detector — ver §6).

**26 ficheiros alterados** — 23 actions/rotas, o helper novo, o teste novo e o classificador.

---

## 3. Classificação A–H das 65

O que está **medido** é o tratamento aplicado, contado no diff:

| Tratamento | # | Efeito |
|---|---|---|
| **aborta** (`queryFailure` / recusa HTTP 503) | **25** | a mutação não acontece |
| **regista** (`logQueryFailure`) | **39** | caminho de sucesso intacto; a falha deixa de ser invisível |
| falso positivo | 1 | §6 |
| | **65** | |

As classes, com os casos representativos — agrupamento qualitativo, não uma
contagem derivada de ferramenta:

| Classe | Tratamento | Exemplos |
|---|---|---|
| **A** `READ_BEFORE_WRITE` | aborta | `clientes:locations` (arquivar/apagar), `csv-import:clients`, `timesheets`, `generate-services:job` |
| **B** `AUTHORIZATION_READ` | — | **nenhuma no lote**: os guards inline são BATCH_0, fora de âmbito |
| **C** `EXISTENCE_CHECK` | aborta | `update-service` (×4), `vacation:request`, `colaboradores:target` (×3), `intervencoes`, `create-service:location` |
| **D** `DUPLICATE_CHECK` | aborta | `daily-clock:existing`, `timesheet:dupOpen`/`openElsewhere`, `uploads/sign:existing`, `generate-services:existing` |
| **E** `RELATION_LOOKUP` | aborta / regista | `vehicles:collab`/`team`, `notifyTeam:members`/`subs`, `auto-checkout:settings` |
| **F** `POST_WRITE_VERIFICATION` | regista | nomes devolvidos por `createManagementTask`, `revalidateAfterServiceChange` |
| **G** `AUXILIARY_READ` | regista | `*:before` de auditoria, nomes para mensagens, caminhos a revalidar |
| **H** `OTHER` | — | `getPublicUrl` (§6) |

### A regra que separa G de tudo o resto

> **"Se esta leitura mentir, alguma escrita acontece que não devia?"**

Se sim, aborta (`queryFailure`). Se não, regista (`logQueryFailure`) e o
comportamento fica **exactamente** como estava. Não é uma escolha de estilo.

Para as auxiliares não se inventou nenhum estado "parcial": estas actions não o
têm no contrato, e acrescentá-lo seria a T05/T06, não esta ronda. A única
excepção está em §5.

---

## 4. Os defeitos que valem a ronda

Nove são do mesmo feitio do `fix-weekend-services.mjs` que a T17-B2 encontrou:
**uma deteção que, ao falhar, responde "está tudo bem"**.

| Onde | O que acontecia |
|---|---|
| 🔴 `generate-services:existing` | a verificação de idempotência do cron mensal. Erro → conjunto vazio → "ainda não há nada este mês" → **o lote inteiro era gerado outra vez** |
| 🔴 `update-service:clashes` | deteção de sobreposição. Erro → "sem conflitos" → serviço remarcado **por cima de outro** |
| 🔴 `reschedule:getConflicts` | idem, no drag do calendário |
| 🔴 `daily-clock:existing` | duplicado do ponto do dia. Erro → **dois pontos** para a mesma pessoa no mesmo dia |
| 🔴 `timesheet:dupOpen` / `openElsewhere` | idem, para o ponto por serviço |
| 🔴 `clientes:locations` (arquivar) | erro → 0 locais → **cliente arquivado com serviços futuros marcados** |
| 🔴 `clientes:locations` (apagar) | erro → cascata não corre → dados órfãos |
| 🔴 `csv-import:clients` | mapa vazio → a importação inteira criava locais órfãos ou saltava tudo, e reportava-o como normal |
| 🔴 `generate-services:job` | cursor a 0 → o cron recomeçava do princípio, regerando |
| ⚠️ `import de referência` | `maxRef` a 0 → colisão de `reference_number` |

Nenhum destes daria erro. Todos reportariam sucesso.

---

## 5. A única alteração de contrato

`cancelService` ganhou **`notifyFailed?: boolean`** — campo opcional, nenhum
consumidor obrigado a mudar.

Sem ele, `sent: 0` com `ok: true` significava as duas coisas: "não havia
ninguém para avisar" e "não consegui saber quem avisar". A diferença é a equipa
aparecer, ou não, a um serviço cancelado. O cancelamento **não** é desfeito — já
está gravado, e desfazê-lo seria pior.

Em `notifyTeam` (notifications.ts) o contrato já tinha `ok: false` com `error`,
por isso a distinção coube sem acrescentar nada.

---

## 6. A armadilha, pela sétima vez

Duas vezes nesta ronda:

**No detector.** `admin.storage.from(bucket).getPublicUrl(path)` devolve
`{ data }` e é **síncrono** — não tem `error` nenhum para desestruturar. A
expressão apanhava-o na mesma (casa com `= admin` sem exigir `await`) e
produzia um "erro ignorado" que ninguém pode corrigir: não há erro. Seis
ocorrências, agora excluídas por `NOT_A_QUERY`.

**Na guarda que escrevi para esta ronda.** A primeira versão varria os
ficheiros tocados à procura de `const { data: x } = await admin…`. Acusou **42
sítios** — quase todos os *guards inline de autenticação*, que são BATCH_0 e
estão explicitamente fora do âmbito — e 8 mensagens de driver vindas de
escritas, não de leituras. A guarda media o ficheiro inteiro quando o
compromisso era um lote definido.

> Uma guarda que falha por coisas que a task decidiu **não** fazer é desligada
> na primeira semana, e a partir daí não guarda nada.

Substituída por uma que guarda o que é decidível sem ambiguidade: **o
classificador não deve voltar a encontrar ocorrências em BATCH_3**. Mesma
ferramenta que definiu o lote, mesmo critério.

---

## 7. Riscos que ficam registados, não corrigidos

### `PARTIAL_WRITE_RISK`

**`uploadTaskAttachment`** e **`collaborator-documents`**: o ficheiro vai para o
storage **antes** da linha ser escrita na base. Se a escrita falhar, o ficheiro
fica lá. Não foi implementado nenhum `remove` compensatório — sem transação, um
delete improvisado pode apagar um ficheiro que afinal era bom.

**`deleteCalendarService`**: regista a exceção e depois apaga. Se a segunda
falhar, a primeira já está gravada. O código **já** diz isso ao utilizador
("A exceção ficou registada mas a eliminação falhou") — comportamento correcto,
mantido.

### `STANDBY_T12_T13_OR_FUTURE_ATOMICITY`

Todos os `DUPLICATE_CHECK` desta ronda continuam a ser *check-then-write* sem
transação: entre a leitura e a escrita, outro pedido pode inserir. Fechar a
leitura reduz muito a janela — deixa de haver duplicado por **avaria**, que era
o caso comum — mas não a elimina. A solução é constraint única ou RPC, o que
exige migration. Fora de âmbito por construção.

Afecta: `daily_clocks` (ponto do dia), `timesheets` (ponto por serviço),
`service_photos` (por `client_event_id`), `building_cards` (`sort_order`).

### `IRREVERSIBLE_MESSAGE_GUARD`

Da T17-B2, ainda aberto: **`send-password-recovery.mjs`** envia email real a
pessoas reais. É irreversível e o guard de base de dados não o cobre. Merece
frente curta própria — `--apply`, alvo declarado, confirmação. **Nenhum email
foi enviado nesta ronda.**

---

## 8. Códigos e mensagens

Uma só mensagem para o utilizador, em `src/lib/query-error.ts`:

> *"Não foi possível confirmar os dados necessários. Tenta novamente."*

Deliberadamente **distinta de "não encontrado"**: é essa confusão que a ronda
desfaz. Quem a lê sabe que o problema foi técnico e que repetir faz sentido — o
que não é verdade de um "não existe".

Nas rotas API, **HTTP 503** e não 500: a leitura falhou, o pedido não é
inválido, e repetir faz sentido.

`error.message`, `details` e `hint` do PostgREST **nunca** saem para o ecrã —
trazem nomes de tabelas, colunas, políticas RLS e, no caso de `details`, valores
das próprias linhas. Vão para o log com prefixo `[query:<contexto>]`, e só
`code` e `message`.

Não se criou nenhum código novo em `ACTION_ERROR_CODES`: as actions deste lote
usam a forma antiga `{ ok, error }`, e migrá-las é a T05/T06. Onde já se usa
`ActionResult`, o caminho continua a ser `internalFailure`.

---

## 9. Provas

### Zero novas mutações

```
23 ficheiros .ts alterados
mutations base: 100  |  head: 100  |  delta: 0
nenhum ficheiro mudou de contagem
```

Contadas `.insert(`, `.update(`, `.upsert(`, `.delete(`, `.rpc(` em cada
ficheiro alterado, base contra head.

### O invariante

`src/__tests__/query-error.test.ts` — **15 testes**, todos offline. O cliente é
um duplo que **regista** as escritas em vez de as executar; a contagem é a
prova.

Cobre: `PGRST116` é ausência e não avaria · a mensagem não é "não encontrado" ·
o detalhe do driver não chega ao resultado · o log leva `code` e `message` e
mais nada · **o fluxo corrigido pára antes da mutação** · o fluxo antigo
escrevia à mesma (demonstração do defeito) · ausência legítima continua a dar
"não encontrado" · o caminho de sucesso não mudou.

Mais a guarda do lote: BATCH_3 a zero, os outros lotes por corrigir e contados,
`payments`/`invoices` ainda bloqueados.

### Gates

`secrets:scan` sem credenciais · `typecheck` 0 · `lint:strict` 0 ·
`audit:code:strict` passa · `git diff --check` limpo.

⚠️ `scan-secrets.test.ts` não colige em Windows — **pré-existente**, desde a
T17-A §14; passa no CI Linux.

---

## 10. O que fica para a próxima

Por ordem de risco, com o número actual:

| Lote | # | Nota |
|---|---|---|
| `BATCH_0_TENANT_AUTORIZACAO` | 79 | os guards inline; cruza com `AUTH_GUARD_CENTRALIZATION` |
| `BATCH_4_PAGINAS_LEITURA` | 49 | inclui as 19 reclassificadas |
| `BATCH_1_SUPERFICIE_FINANCEIRA` | 44 | **depende do diagnóstico de pagamentos** |
| `BLOCKED_FINANCIAL_INCIDENT` | 19 | `payments` + `invoices`, congelados |
| `BATCH_2_DOCUMENTOS_COLABORADOR` | 7 | |

**25 CRITICAL** continuam abertos — todos em BATCH_0, BATCH_1 ou BLOCKED. É
onde estão `daily-billing` e a avença que desaparece, e é por isso que o
diagnóstico de pagamentos vem antes.
