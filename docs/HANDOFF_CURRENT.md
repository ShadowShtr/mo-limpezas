# HANDOFF — continuar noutro computador

**Lê este ficheiro primeiro.** Foi escrito para que uma sessão nova, noutra
máquina, sem acesso a este chat, consiga continuar exatamente do ponto atual.

```
PROJECT            = ShadowShtr/mo-limpezas
HANDOFF_TIMESTAMP  = 2026-08-26 (actualizado no fim da ronda F14)
MASTER_REMOTE_SHA  = 0527127b1eaf5385b55d5dbfad6d61f0afcf56fb
F14_A = FIXED_AND_PROVEN   F14_B = FIXED_AND_PROVEN   F14_C = FIXED_AND_PROVEN
MASTER_INTEGRATION_GATE = BLOCKED_BY_86_RUNTIME_GIT_DIVERGENCE
```

## ⚠️ O SHA de produção não é o SHA do master

```
GIT_MASTER_SHA                = 0527127b1eaf5385b55d5dbfad6d61f0afcf56fb
ACTUAL_PRODUCTION_DEPLOYED_SHA = NOT_PROVEN / USER_ROLLED_BACK_PREVIOUS_DEPLOYMENT
```

A PR #86 foi mesclada em `master` a 2026-08-26T17:58Z e disparou auto-deploy. O
proprietário **reverteu manualmente** o runtime para um deployment anterior.
Portanto o que corre em `molimpezas.pt` **não é** o topo do `master`.

Três conceitos que não se podem confundir a partir daqui:

| conceito | valor |
|---|---|
| `GIT_MASTER_SHA` | `0527127b` |
| `LATEST_GIT_DEPLOYABLE_SHA` | `0527127b` |
| `ACTUAL_PRODUCTION_DEPLOYED_SHA` | **não provado** — anterior a `0527127b` |

Antes de qualquer conclusão sobre comportamento em produção, ler o SHA do
deployment ativo na Vercel. Não assumir.

---

## Primeiro passo no computador novo

```bash
git clone https://github.com/ShadowShtr/mo-limpezas
cd mo-limpezas
git fetch origin --prune
git branch -a
```

1. ler este ficheiro;
2. abrir a **PR #83** (`docs/FINANCE_MASTER_TASK_LEDGER.md`) — é o estado do plano;
3. conferir o registo de branches, mais abaixo;
4. **não aplicar migration nenhuma**;
5. continuar em `NEXT_EXACT_ACTION`;
6. fazer snapshot read-only fresco de produção sempre que for preciso medir.

```bash
git switch --track origin/docs/finance-master-task-ledger        # o ledger
git switch --track origin/fix/reuse-pending-cashflow-on-payment  # F14-A, PR #81
git switch --track origin/fix/payment-cashflow-safe-unmark       # F14-B, PR #87
git switch --track origin/repair/six-pending-obligations-hardened # F14-C, PR #88
```

🔴 **Docker é obrigatório** para reproduzir as provas desta ronda: os ensaios
correm PostgreSQL 16 em contentor descartável. Sem ele, a suite F14 não corre —
e o workflow de CI também não a corre, porque usa PGlite. As 60 verificações
das três PRs são evidência **local**; a CI cobre o resto.

---

## NEXT_EXACT_ACTION

**Preparar o EXPAND da identidade de colaboradores (Option A), sobre a #89.**

```
NEXT_TASK = COLLABORATOR_IDENTITY_EXPAND_PREPARATION
```

A #89 está pronta e verde, e **fica parada** — mesclá-la dispara auto-deploy, e
o SHA activo em produção ainda é inferido, não provado. Antes de a mesclar:
prova directa do deployment no painel da Vercel.

O trabalho seguinte não espera por esse merge: parte da branch da #89, que já
tem o modelo estável mais as protecções. Ver «Rollout obrigatório», acima —
PHASE A primeiro, e nada de runtime a exigir schema que ainda não existe.

```
MASTER_INTEGRATION_GATE = BLOCKED_BY_86_RUNTIME_GIT_DIVERGENCE
```

O F14-A, o F14-B e o F14-C estão **fechados e provados**: três PRs empilhadas,
CI verde em todas, zero escritas em produção. O que bloqueia agora não é
trabalho financeiro por fazer — é o `master` não ser o que corre em produção.

A PR #81 está `CONFLICTING` contra o `master`. **Não rebasear, não retargetar,
não mesclar.** O `master` avançou com a #86 enquanto o runtime foi revertido à
mão: até se saber o que corre mesmo em `molimpezas.pt`, integrar seria empilhar
por cima de um estado que ninguém provou.

A ordem a seguir:

1. ler o SHA do deployment activo na Vercel — não assumir o topo do `master`;
2. decidir o destino da #86 e da arquitectura de colaboradores;
3. reconciliar 077/078/079 (ver TASK 01A: produção tem 4 dos 9 objectos da 078,
   origem não provada);
4. só então a pilha #81 → #87 → #88.

---

## Ronda MASTER/COLLABORATOR_RECONCILIATION — em curso

```
F14_ROUND = COMPLETE
MASTER_COLLABORATOR_RECONCILIATION = IN_PROGRESS
```

### O runtime não é o `master` — e também não é o pré-#86

Medido a 2026-08-26 com `vercel inspect molimpezas.pt`:

```
ACTIVE_PRODUCTION_DEPLOYMENT_ID = dpl_38it94GjVxsyxT6e3WWNM3c6C3Jt
ACTIVE_PRODUCTION_DEPLOYMENT_TIME = 2026-08-26T18:08:38Z
ACTIVE_PRODUCTION_ALIASES = molimpezas.pt · www.molimpezas.pt ·
  mo-limpezas.vercel.app · mo-limpezas-git-codex-adversarial-r-bc1cbb-…
ACTIVE_PRODUCTION_DEPLOYED_SHA = dcda4c06  ← INFERIDO, não lido
PRODUCTION_EQUALS_MASTER = NO
PRODUCTION_EQUALS_PRE86  = NO
```

🔴 **O rollback não foi para o `master` pré-#86.** Foi para um deployment da
branch da **#85** (`codex/adversarial-review-81-82`), cuja base é `f001866` e
que **não contém a #86**. Em comportamento é equivalente ao pré-#86 — a #85 só
toca `src/__tests__/`, `docs/`, `package.json` e `reports/`, zero runtime.

> ⚠️ **Fechar ou mesclar a #85 pode reciclar o deployment que serve
> `molimpezas.pt`.** Enquanto a #89 não for mesclada, a #85 fica aberta e
> intocada. `PR85_FROZEN = YES`.

O SHA é **inferido** por alias de branch e correlação de timestamps: o
`vercel inspect` deste CLI não expõe `meta.githubCommitSha`.
`DIRECT_PROOF = REQUIRED` antes de qualquer merge.

### #86 — três estados distintos

```
PR86_GIT_STATE = MERGED (0527127b)     PR86_GIT_REVERTED = NO → a #89 prepara-o
PR86_RUNTIME_STATE = NOT_RUNNING       PR86_RUNTIME_ROLLED_BACK = YES
ROOT_CAUSE = CODE_SCHEMA_ORDERING
```

A #86 mudou `getCurrentProfile` de `.eq("id", user.id)` para
`.eq("auth_user_id", user.id)`, com a coluna a viver numa migration **draft**
que nenhum runner aplica. O merge disparou auto-deploy, o runtime passou a
interrogar produção por uma coluna inexistente, e a consulta do perfil deixou
de devolver nada — para toda a gente, admin incluído.

Não foi um bug de colaboradores. Foi uma inversão de ordem.

### PR #89 — o revert, pronta e parada

```
REVERT_BRANCH = hotfix/reconcile-master-after-86
REVERT_PR = #89   HEAD = e3c22991   CI = 33022510192 SUCCESS   MERGEABLE = YES
MERGE = NO   ← mesclar dispara auto-deploy
```

O revert está isolado em `d33d017`, com árvore **byte a byte** igual a
`f001866`. A árvore **final** da PR não é: acrescenta a guarda de ordem, a
release note e a infraestrutura de retirada.

### Decisão registada: retirada de notas, sem quebrar a imutabilidade

```
RELEASE_NOTE_86 = WITHDRAWN_PRESERVED
RELEASE_NOTE_IMMUTABILITY = PRESERVED
GENERIC_IMMUTABILITY_EXCEPTION = NO
```

A nota da #86 anunciava algo que o revert removeu. Apagá-la destruiria o que
alguém disse ter lido; mantê-la mentiria. A saída é uma terceira: a nota fica
byte a byte, com a mesma `key`, ainda no catálogo — e um artefacto **separado**
e igualmente imutável (`src/release-note-withdrawals/`) diz que deixou de ser
oferecida. Passa a haver diferença entre «existiu no histórico» e «ainda deve
ser mostrada».

🔴 **Uma correcção que importa preservar.** Argumentei que a nota «nunca chegou
a ser lida» porque o `publishedAt` era posterior ao deployment. **Está errado:**
`releaseElegivel` compara `publishedAt` com
`max(profileCreatedAt, activatedAt)` e **nunca com o relógio** — uma nota com
data futura é elegível na mesma. O teste `RN04b` existe para impedir que
alguém volte a usar esse raciocínio.

Task separada, por decidir:
`RELEASE_NOTE_PUBLISHED_AT_SEMANTICS_AUDIT` — o `publishedAt` é metadado
histórico ou hora de publicação agendada?

### Decisão registada: arquitectura de colaboradores

```
COLLABORATOR_ARCHITECTURE = OPTION_A
IDENTITY_IDS_PRESERVED = YES
OPTION_B = REJECTED_FOR_NOW
RLS_AUDIT_REQUIRED = YES
```

**O modelo actual, medido:**

```
AUTH_ENTITY   = auth.users            PERSON_ENTITY = public.profiles
AUTH_PROFILE_LINK = profiles.id **IS** auth.users.id
                    (PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE)
```

| dependência de `profiles.id = auth.uid()` | contagem |
|---|---|
| políticas RLS | **99** |
| ficheiros de migration | **34** |
| chaves estrangeiras para `profiles(id)` | **43** |

Hoje é **impossível** um colaborador sem login: a FK é obrigatória. Não é
limitação de UI, é estrutural.

Sete tabelas laborais apontam para `profiles(id)` com `ON DELETE CASCADE`:
`payroll_records`, `team_members`, `collaborator_documents`, `absences`,
`vacation_requests`, `timesheets`, `push_subscriptions`.

**Porquê a Option A.** Preservar os ids das pessoas vale mais do que evitar
trabalho de RLS. As políticas auditam-se, testam-se e migram-se por etapas;
trocar a identidade laboral por uma tabela nova obrigaria a migrar folha,
documentos, equipas, calendário e histórico para ids novos — sob aquele
cascade, é o cenário de ligação partida silenciosa.

🔴 **Isto não significa alterar 99 políticas às cegas.** Significa criar uma
camada canónica que resolva `auth.uid() → profile id` num sítio só, e migrar
as políticas contra ela. Copiar a mesma subconsulta por dezenas de políticas
seria repetir, em RLS, o erro que o helper único do F14-A evitou.

A análise da Option B fica registada, não apagada.

### Rollout obrigatório

```
PHASE A — EXPAND    schema compatível; código antigo continua a funcionar
PHASE B — MIGRATE   backfill determinístico; zero mudanças de id ou password
PHASE C — RUNTIME   passa a usar a relação nova, com compatibilidade
PHASE D — CONTRACT  muito depois, remover o pressuposto antigo
```

`MIGRATION_NUMBER_FINAL = UNASSIGNED` — a 077/078/079 continuam por
reconciliar.

---

## Ronda F14 — fechada em 2026-08-26

Três defeitos confirmados pela revisão adversarial do Codex (#85), corrigidos e
provados em PostgreSQL 16 real. Nenhum foi aplicado em lado nenhum.

```
F14_A = FIXED_AND_PROVEN     PR #81   HEAD e99872e6
F14_B = FIXED_AND_PROVEN     PR #87   HEAD 29b6336f
F14_C = FIXED_AND_PROVEN     PR #88   HEAD e47312fd

F14_POSTGRES_PROOF    = LOCAL_DOCKER_POSTGRES16
F14_CI_POSTGRES_PROOF = NO
```

🔴 **CI verde não substitui a prova local.** O workflow corre `rehearse:071`
(PGlite); as 60 verificações da ronda F14 exigem Docker e correm apenas neste
computador. As duas coisas são evidência de coisas diferentes, e confundi-las
seria dar por provado o que não foi.

| | o que era | o que passou a ser |
|---|---|---|
| **F14-A** | o ramo de conflito relia só o `id` e aceitava a linha | relê a linha completa com `FOR UPDATE` e valida pelos mesmos invariantes, num helper único chamado pelos dois caminhos |
| **F14-B** | `unmark` apagava o movimento, legado incluído, com cascade para a conciliação | proveniência explícita: apaga o que criou, **restaura** o que adoptou, recusa o conciliado e recusa o desconhecido |
| **F14-C** | o `UPDATE` do repair condicionava a 6 dos 13 campos do manifesto | condiciona aos 13, e regista a adopção na mesma transacção |

**A decisão que mais pesa, e porquê.** A primeira versão do F14-B tratava a
ausência de proveniência como «criado pelo mark», por continuidade com a 073.
Estava errada: não haver registo não prova que o movimento foi criado pelo
`mark` — prova que ninguém sabe. Para as linhas anteriores a esta
infraestrutura as duas hipóteses continuam abertas, e uma delas é «já cá
estava», que é o caso cuja destruição o F14-B existe para impedir.

```
UNKNOWN_PROVENANCE_UNMARK = FAIL_CLOSED
```

O preço é conhecido e aceite: desmarcar um movimento antigo passa a exigir que
alguém lhe determine a origem primeiro. Recusar uma operação legítima
corrige-se com uma classificação; apagar histórico financeiro não se corrige.

**Como é que se sabe que os testes provam alguma coisa.** Cada correcção foi
mutada e vista a ficar vermelha — um teste que passa com e sem o código que
diz testar não prova nada:

```
migration do unmark seguro fora   ⇒ 10 de 17 vermelhos
UNKNOWN volta a apagar            ⇒ B13 e B14 vermelhos
guarda do rollback fora           ⇒ B20 vermelho
guards do UPDATE do repair fora   ⇒ 6 vermelhos
proveniência fora do forward      ⇒ 2 vermelhos
```

**A prova histórica não foi tocada.** O harness da #85 lê a 079 fixada em
`a10c7b2b`: continua a reproduzir o defeito, e é isso que se quer dele. A
prova da HEAD corrigida vive num ficheiro novo
(`f14a-old-vs-new-postgres.test.ts`) que corre o mesmo cenário contra as duas
versões e exige as duas metades — a antiga reproduz, a nova bloqueia.

```
HISTORICAL_BASELINE_PRESERVED = YES
TARGET_HEAD_ADVERSARIAL_MATRIX = PASS
```

### Migrations desta ronda — sem número, por desenho

```
MIGRATION_NUMBER_FINAL = UNASSIGNED
```

Vivem em `supabase/migrations/draft/`, que o runner **não lê** — confirmado por
execução, não por leitura do código. O número só se atribui quando a 077/078/079
estiverem reconciliadas; escolher um «080» hoje seria fingir que a sequência é
conhecida.

### TASK nova: `PAYMENT_CASHFLOW_PROVENANCE_BACKFILL`

Consequência directa do `FAIL_CLOSED`. Auditoria read-only dos movimentos
ligados a pagamentos que já existem, para os classificar em
`PROVEN_CREATED_BY_MARK`, `PROVEN_ADOPTED` ou `UNKNOWN`. Só as categorias
provadas podem receber proveniência por reparação; `UNKNOWN` continua bloqueado
para `unmark`.

**Não executar agora.** E não classificar por `created_at`, `description`,
`notes` ou proximidade temporal: um palpite bem-intencionado sobre dinheiro
continua a ser um palpite.

---

## Cópia local antiga — congelada

```
OLD_LOCAL_REPO_REQUIRES_FORENSIC_REVIEW = YES
```

`C:Usersshadoprojectsmo-limpezas`, branch `chore/repair-historical-cashflow`,
HEAD `cc97bcc` — **não existe no remoto**. Árvore limpa, sem stashes.

`DELETE = NO` · `PUSH = NO` · `CHERRY_PICK = NO`. Pode conter trabalho histórico
nunca publicado; decide-se numa task própria (`LEGACY-LOCAL-REPO-FORENSICS`),
não por arrasto. O repositório operacional é `C:Usersshadomo-limpezas`.

---

## Registo de branches

Nenhuma branch tem commits por enviar. `LOCAL_HEAD == REMOTE_HEAD` em todas.

| branch | dono | propósito | HEAD | PR | estado | apagar? |
|---|---|---|---|---|---|---|
| `master` | — | tronco | `0527127b` | — | — | não |
| `docs/finance-master-task-ledger` | Claude | ledger + este handoff | ver PR #83 | #83 | OPEN, não mesclar | **não** |
| `fix/reuse-pending-cashflow-on-payment` | Claude | migration 079 | `e99872e6` | #81 | OPEN, CI verde, **F14-A corrigido e provado** | **NUNCA** |
| `fix/payment-cashflow-safe-unmark` | Claude | F14-B, proveniência e unmark seguro | `29b6336f` | #87 | OPEN, CI verde, stacked sobre a #81 | **NUNCA** |
| `repair/six-pending-obligations-hardened` | Claude | F14-C, sucessora da #82 | `e47312fd` | #88 | OPEN, CI verde, stacked sobre a #87 | não |
| `repair/six-pending-obligations` | Claude | repair das 6 | `5eaee43d` | #82 | OPEN, **SUPERSEDED_FOR_HARDENING** pela #88 | não |
| `repair/payment-competence-backfill` | Claude | backfill dos 29 | `94ecdc14` | #78 | OPEN, ⛔ não executar | não |
| `fix/secure-migrations-ledger` | Claude | migration 077 | `f54d62cb` | #73 CLOSED | branch viva | não |
| `feat/domain-mutation-change-event-foundation` | Claude | migration 078 | `a8475227` | #74 | OPEN | não |
| `codex/hardening-invoice-cash-atomicity` | Codex | atomicidade fatura/caixa, migration 080 provisória | `0a5da475` | #84 | OPEN, revisão Claude requerida | não |
| `codex/adversarial-review-81-82` | Codex | revisão adversarial de #81/#82 | `dcda4c06` | #85 | OPEN, 🔴 **serve produção** | **NUNCA** |
| `hotfix/reconcile-master-after-86` | Claude | revert da #86 + protecções | `e3c22991` | #89 | OPEN, CI verde, **não mesclar** | não |
| `codex/fix-collaborator-name-only-create` | Codex | colaborador só com nome | `1cc405d0` | #86 | **MESCLADA** | — |

> 🔴 **`fix/reuse-pending-cashflow-on-payment` não pode ser apagada.** A #82 tem-na
> como base. Apagar uma branch base já fechou uma PR automaticamente neste
> repositório (aconteceu à #73). `--delete-branch` é proibido.
>
> Sequência obrigatória quando a #81 for mesclada: merge **sem** `--delete-branch`
> → confirmar #82 ainda OPEN → retarget/rebase da #82 para `master` → só então
> considerar remover a branch antiga.

Existem ~50 branches antigas já mescladas ou arquivadas, todas presentes no
remoto. Nenhuma tem trabalho exclusivo local.

---

## Registo de PRs

| PR | dono | base | head | estado | CI | migration | prod |
|---|---|---|---|---|---|---|---|
| #73 | Claude | `fix/migration-runner-targeted-apply` | `f54d62cb` | CLOSED (auto, base apagada) | — | 077 | não aplicada |
| #74 | Claude | `fix/secure-migrations-ledger` | `a8475227` | OPEN | — | 078 | **parcialmente materializada, origem não provada** |
| #78 | Claude | `master` | `94ecdc14` | OPEN | — | — | ⛔ não executar |
| #80 | Claude | `master` | `c8ed2be7` | MERGED 26/08 13:51 | verde | — | em produção |
| #81 | Claude | `master` | `e99872e6` | OPEN, **CONFLICTING** | verde | 079 | não aplicada |
| #82 | Claude | `fix/reuse-pending-cashflow-on-payment` | `5eaee43d` | OPEN, superseded | verde | — | não executado |
| #87 | Claude | `fix/reuse-pending-cashflow-on-payment` | `29b6336f` | OPEN | **success** (`33012489618`) | draft, sem número | não aplicada |
| #88 | Claude | `fix/payment-cashflow-safe-unmark` | `e47312fd` | OPEN | **success** (`33013600532`) | — | não executado |
| #83 | Claude | `master` | ver ledger | OPEN | docs | — | não mesclar |
| #84 | Codex | `master` | `0a5da475` | OPEN | verde (reportado) | **080 provisória** | não aplicada |
| #85 | Codex | `master` | `dcda4c06` | OPEN | verde (reportado) | — | só reprodução |
| #86 | Codex | `master` | `1cc405d0` | **MERGED** 26/08 17:58 | — | draft colaborador | **revertido em runtime pelo proprietário** |

---

## 🔴 Evidência em conflito — #81 e #82

Duas fontes independentes chegaram a conclusões diferentes sobre o mesmo código.
**Ambas ficam registadas.** A do Codex era mais recente e reproduzia em
PostgreSQL real; onde divergia, prevalecia.

```
CONFLICTING_EVIDENCE = RESOLVED_2026_08_26
```

🟢 **Resolvido.** Os três findings foram corrigidos e provados — ver «Ronda F14»,
mais acima. O que se segue é o registo do que era, e continua a valer como
descrição do defeito e da razão por que existia. As secções não foram
reescritas de propósito: apagar o diagnóstico depois de o corrigir tiraria a
única explicação de porque é que o código tem hoje a forma que tem.

**Uma correcção ao finding do F14-A.** O Codex listava três sintomas, um deles
«`status = pendente` apesar de o pagamento terminar `pago`». Isso era amplo
demais, e a distinção importa:

```
F14_A_STATUS_PENDING_ACCEPTED_WITHOUT_TRANSITION = BUG
F14_A_STATUS_PENDING_ACCEPTED_AND_CONFIRMED      = CORRECT_BEHAVIOR
F14_A_STATUS_UNEXPECTED_ACCEPTED                 = BUG
```

Uma linha concorrente com empresa, referência, tipo e valor correctos, em
`pendente`, é economicamente a mesma ocorrência: convertê-la é o propósito
inteiro da 079. O defeito não era o `status` da linha — era o ramo não reler
nem converter, deixando o movimento preso em `pendente` com o pagamento
`pago`. É essa divergência que desapareceu.

### O que o Claude provou (#81/#82, ensaios próprios)

Postgres 16.15 descartável, 61/61 e 37/37: reutilização do movimento pendente
com preservação de `id`, idempotência, duas ligações concorrentes com bloqueio
real medido (1242 ms), erro forçado com reversão total, rollback que repõe a
definição da 073 byte a byte. Forward das 6, marcar pago, retry, falha a meio
com prestate integral, rollback seguro.

Isto continua verdadeiro **para os caminhos que exercitou**.

### F14-A — `CONFIRMED_BUG` (Codex, PR #85)

**O meu erro.** Os guardas da 079 (`company`, `type`, `amount`, referência) só
correm no ramo `IF FOUND` — o caminho que lê o movimento **antes** de inserir.
No ramo `ELSE`, quando o `INSERT ... ON CONFLICT DO NOTHING` colide com uma
linha inserida concorrentemente por outra ligação, o código relê **apenas o
`id`** e aceita o que encontrar.

Codex reproduziu com um trigger como barreira determinística: a ligação A pára
antes do `INSERT`, B insere uma linha com a mesma identidade única, A continua.
Resultado aceite sem erro:

- `type = entrada` numa saída;
- valor `999.00` para uma obrigação de `100.00`;
- `status = pendente` com o pagamento a terminar `pago`.

Escrevi num comentário que isto «não pode acontecer para o mesmo pagamento (a
tranca acima impede-o)». A tranca serializa duas chamadas *à RPC*; não impede um
`INSERT` direto de outra ligação. O comentário estava errado.

**Correção proposta (não implementada):** depois do conflito, reler a linha
completa e passá-la exatamente pelas mesmas validações do caminho de
reutilização, abortando em qualquer divergência.

### F14-B — `CONFIRMED_BUG` (Codex)

`unmark_payment_paid` **apaga** o movimento de caixa com aquela origem. Depois
do repair das 6, o movimento com aquela origem é o **movimento legado
reutilizado** — e desmarcar apaga-o. O schema não distingue «movimento criado
pelo mark» de «movimento preexistente adotado».

```
SCHEMA_OR_PROTOCOL_GAP = YES
```

Pior: se o movimento estiver conciliado, o `DELETE` cascateia para a
correspondência de conciliação, enquanto a transação bancária continua marcada
como reconciliada — apaga evidência financeira e deixa estados divergentes.

Eu tinha registado, na própria 079, que não tocava em `unmark_payment_paid` e
que a consequência ficava «registada como pendente, não como esquecido». Estava
certo em nomeá-la; subestimei-a ao chamar-lhe decisão de negócio separada. É um
caminho de perda de dados.

**Correção proposta:** registar proveniência e prestate de reutilização de forma
transacional; no unmark, apagar apenas o que o mark criou; para movimento
legado, restaurar o prestate; recusar unmark quando exista conciliação.

### F14-C — `PARTIAL` (Codex)

A atomicidade do executor das 6 está segura. O **prestate do manifesto está
incompleto**: o `UPDATE` só é condicional a `amount`, `status`, `type`,
`company_id`, `reference_type` e `reference_id`. Ficam desprotegidos
`description`, `date`, `category`, `expense_category_id`, `notes` e `created_at`.

Consequências reproduzidas: uma categoria estruturada atribuída depois do
snapshot é sobrescrita pelo valor antigo; uma data alterada depois do snapshot
gera competência a partir da data velha; um anexo criado antecipadamente para o
UUID alvo é silenciosamente adotado quando o pagamento nasce.

O rollback recusa pagamento pago e não faz rollback parcial — mas aceita apagar
o repair depois de alterações em descrição, categoria, notas e competência, e
deixa anexo órfão.

### Períodos financeiros

```
CURRENT_PERIOD_POLICY = COMPETENCE_ONLY
```

A RPC valida apenas o período da **competência**. Uma competência aberta com
data de caixa em mês fechado passa. Política proposta: validar os dois — a
competência protege a obrigação, `p_paid_on` protege o movimento de caixa.

---

## TASK 01A — forensics do drift (concluída)

Leitura fresca de produção, 2026-08-26. Zero escritas.

```
LEDGER_ROWS = 77   (última entrada: 076, 2026-08-20)
ausentes do ledger: 066 067 070 077 078 079
```

### 078 versus produção, objeto a objeto

A 078 declara 3 tabelas, 5 funções e 1 índice. Produção tem **4 dos 9**.

| objeto declarado pela 078 | produção | classificação |
|---|---|---|
| `company_change_events` (tabela) | existe | `PARTIAL_078_MATCH` |
| `domain_mutations` (tabela) | existe | `PARTIAL_078_MATCH` |
| `company_sync_state` (tabela) | **não existe** | `EXPECTED_078_MISSING` |
| `record_company_change_event()` | existe, `SECURITY DEFINER` | `PARTIAL_078_MATCH` |
| `complete_domain_mutation()` | **não existe** | `EXPECTED_078_MISSING` |
| `find_or_conflict_domain_mutation()` | **não existe** | `EXPECTED_078_MISSING` |
| `lock_domain_mutation()` | **não existe** | `EXPECTED_078_MISSING` |
| `next_company_sequence()` | **não existe** | `EXPECTED_078_MISSING` |
| `idx_company_change_events_company_sequence` | **não existe**; existe `idx_company_change_events_pending` | `DIFFERENT_FROM_078` |

```
PROD_078_OBJECT_COUNT      = 4 de 9
EXACT_078_MATCH_COUNT      = 0
PARTIAL_078_MATCH_COUNT    = 3
DIFFERENT_COUNT            = 1
MISSING_COUNT              = 5
EXTRA_COUNT                = 0
078_SCHEMA_MATCH           = PARTIAL
ORIGIN_OF_PROD_078_OBJECTS = NOT_PROVEN
LEDGER_078_PRESENT         = NO
```

**O que isto quer dizer.** Produção **não** tem a 078 da PR #74. Tem uma versão
**anterior e incompleta** dela: as duas tabelas centrais e uma função, com um
índice de nome e definição diferentes. Nenhum objeto bate exatamente com o que a
078 declara hoje.

Estado e origem continuam separados: os objetos estão presentes; quem os criou
não é verificável agora. Não é `APPLIED`.

`company_change_events` e `domain_mutations` têm RLS ativa e 1 política cada.

### Outras verificações

```
077 aplicada?  NÃO — public._migrations sem RLS, 0 políticas.
               O acesso público ao ledger continua aberto: é o que a 077 fecha.
079 aplicada?  NÃO — mark_payment_paid não contém CASHFLOW_LINK_AMOUNT_MISMATCH.
070            intocada, ausente do ledger, em blockedMigrations.
```

As colunas `revision` existem em 8 tabelas (`clients`, `contracts`, `invoices`,
`invoice_items`, `locations`, `services`, `teams`, `team_members`) com
`fn_increment_revision`. **Não vêm da 078** e não estão em nenhuma migration do
`master`. Origem `UNKNOWN_ORIGIN` — mais um objeto fora do ledger.

### Consequência operacional

```
SCHEMA_LEDGER_DRIFT = YES
RUNNER_079_GATE     = BLOCKED_BY_SCHEMA_LEDGER_DRIFT
```

`SAFE_RECONCILIATION_OPTIONS`, por ordem de preferência:

1. **decidir o destino da 078 primeiro** — a PR #74 tem de ser reconciliada com
   o que produção realmente tem, ou reescrita como migration idempotente que
   completa o que falta. Preferida: sem isto, qualquer aplicação da 078 falha ou
   duplica;
2. aplicar a 079 isoladamente pelo SQL Editor e registar a linha no ledger — só
   depois de F14-A corrigido, e continua a deixar o drift por resolver;
3. baseline/reconcile do ledger — **rejeitada**: apagaria a prova de que algo
   correu fora do runner.

```
PREFERRED_RECONCILIATION_OPTION = 1
RECONCILIATION_EXECUTED = NO
```

---

## Baseline de documentos e anexos (TASK 01)

```
payment-attachments: 23 ficheiros
  tabela `attachments`                     6 referências
  coluna legada `attachment_url`          17 referências
  pagamentos com anexo                    21
  pagamentos com os dois modelos           1
  órfãos 0 · referências partidas 0 · abertura 26/26 (tamanho confere)
```

🔴 O pagamento com os dois modelos aponta para **objetos diferentes** — um PDF e
uma imagem, carregados com 22 horas de intervalo. **Não são duplicados.** Nunca
deduplicar por pagamento; só por identidade forte do objeto (`bucket` +
`storage_path`), nunca por nome de ficheiro.

```
LEGACY_ATTACHMENT_URL_MIGRATION_NOW = NO
SUPPORT_BOTH_ATTACHMENT_MODELS      = YES
```

Vias de anexo no schema: 2 ativas (`attachments`,
`fixed_variable_payments.attachment_url`) e 4 com zero linhas
(`management_tasks.attachment_url`, `absences.document_url`,
`collaborator_documents.file_url`, `service_photos.storage_path`).

**3 objetos órfãos** em `collaborator-documents` (a tabela tem 0 linhas). O
caminho é gerado por `buildDocumentStoragePath()` e resolve para um perfil que
existe → proprietário `KNOWN_PARENT`; registo do documento `UNKNOWN`. Categoria,
notas e visibilidade não se recuperam de um ficheiro. Não apagar, não mover, não
reenviar. Origem da perda: não provada.

Buckets `task-attachments` e `absence-documents` não existem, e não há um único
dado que aponte para eles: configuração incompleta nunca exercitada.

---

## Riscos abertos

```
PRODUCTION_IS_LIVE_DURING_REFACTOR          = YES
BANK_ACCOUNT_RELATIONSHIP_RISK              = OPEN
FINANCIAL_PERIOD_GUARD_PRODUCTION_EXERCISED = NO
MISSING_STORAGE_BUCKET_CONFIGURATION        = OPEN
DUAL_PAYMENT_ATTACHMENT_MODEL               = SUPPORTED
078_SCHEMA_LEDGER_DRIFT                     = PARTIAL / ORIGIN NOT_PROVEN
COLLABORATOR_ACCESS_REDESIGN                = PENDING_CODEX/CLAUDE_REVIEW
MASTER_INTEGRATION_GATE                     = BLOCKED_BY_86_RUNTIME_GIT_DIVERGENCE
OLD_LOCAL_REPO_REQUIRES_FORENSIC_REVIEW     = YES
PAYMENT_CASHFLOW_PROVENANCE_BACKFILL        = PENDING_AUDIT
RELEASE_NOTE_PUBLISHED_AT_SEMANTICS_AUDIT   = PENDING_DECISION
COLLABORATOR_RLS_AUDIT                      = REQUIRED (99 políticas)
PR85_SERVES_PRODUCTION                      = YES — não fechar, não mesclar
```

**A pilha financeira não entra no `master` por agora.** A #81 está
`CONFLICTING`, e resolvê-lo seria integrar por cima de um `master` que não
corresponde ao runtime. Primeiro a #86 e os colaboradores; depois a
reconciliação 077/078/079; só então a pilha.

**Produção mexe-se durante o trabalho.** Observado nesta sessão: `payments`
113 → 114, movimentos ligados 6 → 7, e um anexo novo criado às 15:39. Nenhum
snapshot antigo serve de prestate. Antes de qualquer execução: snapshot fresco,
ids frescos, manifesto fresco, hashes frescos, guarda de staleness, transação.

**Conciliação bancária:** 336 transações, **todas** com `bank_account_id` nulo,
`bank_accounts` vazia, 11 correspondências assentes nisso.

**Período financeiro:** `financial_periods` está vazia. A guarda
`FINANCIAL_PERIOD_CLOSED` nunca disparou em produção. Não remover, não concluir
que está errada — provar em Postgres descartável.

---

## Reparações — estado

| repair | branch | forward | rollback | Docker | manifesto | produção |
|---|---|---|---|---|---|---|
| 6 obrigações pendentes | `repair/six-pending-obligations` | ensaiado 37/37 | ensaiado, recusa após atividade | destruído | preparação apenas | **NÃO EXECUTADO** |
| competência dos 29 (#78) | `repair/payment-competence-backfill` | preparado | por implementar | — | hashes inválidos | **NÃO EXECUTADO** |

```
PREPARATION_MANIFEST_ONLY = YES     FINAL_EXECUTION_MANIFEST = NO
```

Manifestos brutos **não são versionados** — contêm ids de produção. Só ficam
registados contagem, hash e estado. Os hashes gerados nesta sessão
(`2f0376db…` / `2f0fb2e4…`) são de preparação e **já não devem ser autorizados**:
produção mudou desde então.

---

## Decisão registada: colaborador ≠ conta de acesso

Ainda **não implementada**. Preservada aqui para não se perder.

- criar colaborador exige **apenas o Nome**; NIF, IBAN, email, telefone, morada,
  datas e dados laborais são opcionais;
- criar colaborador **não** cria conta Auth;
- no perfil existe «Criar acesso». O admin pode definir senha temporária,
  redefinir para nova senha temporária e desativar acesso;
- o admin **não** pode consultar a password atual. Password em claro **nunca** é
  guardada;
- primeiro login após senha temporária → `must_change_password = true`;
- autenticação de admin/gestor é separada e não pode regredir por causa disto.

```
COLLABORATOR_ACCESS_REDESIGN = PENDING_CODEX/CLAUDE_REVIEW
PERSONAL_DATA_COMMITTED = NO
```

O pedido original continha dados pessoais reais (nome, NIF, IBAN). **Não foram
versionados** e não devem ser. Fixtures sintéticas apenas.

---

## Arquitetura financeira alvo (aprovada, por implementar)

```
Financeiro → Resumo · Pagamentos · Cobranças · Folha de Pagamento · Conciliação
Pagamentos → Todos · Fixos · Variáveis
Tabela     → Data · Descrição · Vencimento · Categoria · Origem · Valor · Estado · Ações
```

**Fluxo de Caixa** sai da navegação futura, mas `cash_flow_entries` **permanece**
como tabela.

**Contas** só pode sair depois de realocar: A Receber → Cobranças · A Pagar
Salários → Folha · Categorias → configuração canónica · Despesas Pendentes →
Pagamentos.

```
CONTAS_UNIQUE_SEMANTICS_REMAIN = YES
CONTAS_UI_REMOVAL_SAFE = NO
```

### Cobranças — especificação a preservar

Cobrança manual; cliente existente ou novo; `client_id` canónico; Avença ou
Serviço; contrato opcional; fonte única de verdade; integração com o perfil do
cliente; «Editar todas»; pagamento de 50% / 100% / valor personalizado dentro do
Editar; 50% do saldo restante; pagamento atómico; idempotência; concorrência;
recibo de caixa uma só vez; sem cobrança duplicada no perfil.

Ainda não implementado. Não perder.

---

## Estado local no momento do handoff

```
WORKTREE_COUNT = 5   (nenhum removido)
```

| caminho | branch | HEAD | limpo |
|---|---|---|---|
| `mo-limpezas` | `master` | `0527127b` | sim |
| `mo-limpezas-ledger` | `docs/finance-master-task-ledger` | ver PR #83 | sim |
| `mo-limpezas-codex-invoice` | `codex/hardening-invoice-cash-atomicity` | `0a5da475` | sim |
| `mo-limpezas-codex-adversarial` | `codex/adversarial-review-81-82` | `dcda4c06` | sim |
| `mo-limpezas-codex-collaborator` | `codex/fix-collaborator-name-only-create` | `1cc405d0` | sim |

**Stash.** Existe um `stash@{0}: On test/isolated-production-tenants: hotfix wip`,
com alterações a `src/app/(dashboard)/layout.tsx` e `src/proxy.ts`. É o hotfix do
loop `/login ↔ /dashboard` de 2026-08-05. Verifiquei: `master` já contém a
substância (`maybeSingle`, log do erro, `signOut()` antes do redirect, e o
`isPublic && profileRole` no proxy) — entrou pela PR #30. O stash é uma cópia
superada.

```
STASH_RELEVANT_ITEMS = 0
```

Não foi apagado. Não é backup de nada — se este PC desaparecer, nada se perde
com ele.

**Harness de ensaio.** Tudo o que é preciso para reproduzir as provas está
versionado: `scripts/rehearse-079.mjs` e `scripts/rehearse-six-repair.mjs` (PR
#81/#82), `scripts/repairs/` (PR #82), `src/__tests__/adversarial-81-82-postgres.test.ts`
(PR #85). Nenhum harness crítico vive apenas em temporários.

Ficheiros de diagnóstico gerados em `scratchpad` durante a sessão **não** foram
versionados: são consultas read-only descartáveis, recriáveis a partir das
queries documentadas neste ficheiro.

```
LOCAL_ONLY_RELEVANT_ITEMS = 0
```
