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
NEXT_TASK = REVISÃO DE INTEGRAÇÃO — a frente de colaboradores está pronta
```

As seis fases estão feitas e verdes: EXPAND, backfill, resolver e RLS,
name-only, gestão de acesso, e a matriz de endurecimento. Ver «Identidade e
acesso de colaboradores», mais abaixo.

O que falta **não é implementação**: é decidir a integração, e isso passa por
três coisas que só o proprietário pode desbloquear —

1. confirmar no painel da Vercel o SHA do deployment activo (a #89 espera-o);
2. autorizar o merge da #89, que alinha o `master` com o runtime;
3. reconciliar a 077/078/079, sem o que nenhuma migration desta frente pode ser
   aplicada.

A **PHASE A está feita e verde** — ver «EXPAND», mais abaixo. O que se segue é
a PHASE C: migrar as políticas para `get_my_profile_id()`, uma de cada vez e
com teste. A PHASE D (largar o pressuposto `id = auth.uid()` da chave
primária) só depois de nada no código o assumir.

O name-only no ecrã vem **depois** da PHASE C, nunca antes: a base já o aceita,
mas o runtime ainda lê pela convenção antiga.

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

## Identidade e acesso de colaboradores — as seis fases

```
BRANCH = feat/collaborator-identity-resolver   PR = #91
BASE   = feat/collaborator-identity-expand (#90) → hotfix/... (#89) → master
CHOSEN_ARCHITECTURE = OPTION_A     IDENTITY_IDS_PRESERVED = YES
MIGRATION_NUMBER_FINAL = UNASSIGNED
```

| fase | o quê | estado |
|---|---|---|
| A — EXPAND | `auth_user_id` nullable, FK do `id` largada, backfill | PROVEN |
| B — BACKFILL | determinístico, dentro do EXPAND | PROVEN |
| C — RESOLVER + RLS | `get_my_profile_id()`, 12 políticas migradas | PROVEN |
| D — NAME-ONLY | criar pessoa só com o nome, sem conta | PROVEN |
| E — ACESSO | criar, senha temporária, desactivar, reactivar | PROVEN |
| F — ENDURECIMENTO | matriz completa com tudo aplicado junto | PROVEN |

### O que mudou para quem usa o sistema

Criar um colaborador passa a exigir **só o nome**. NIF, IBAN, email, telefone e
dados de contrato ficam por preencher até alguém os saber — e ficam `NULL`,
não inventados. O código anterior fabricava um email
(`nome.1724713200000@demo.escala.pt`) porque o serviço de autenticação exige
um, e guardava-o como se fosse o endereço da pessoa.

Criar a pessoa deixou de criar conta de acesso. Quem precisar de entrar recebe
acesso à parte, no perfil, com senha temporária que é obrigado a trocar.

### Quatro defeitos de segurança encontrados pelo caminho

Nenhum apareceu ao ler o código. Todos apareceram ao executá-lo, e três só
existiam **por causa** do EXPAND — cenários que o código antigo nunca teve de
considerar porque não podiam acontecer.

1. **`get_my_profile_id()`, ramo de compatibilidade.** Respondia a
   `id = auth.uid()` sem verificar que a conta existe. Um token com o `sub`
   igual ao id de uma pessoa **sem** conta era resolvido como essa pessoa.

2. **`get_my_company_id()` e `get_my_role()`, da 014.** O mesmo, e pior: o
   token forjado devolvia a empresa dela, e com ela a leitura de todos os
   colegas.

3. **Nove políticas de dados pessoais.** `collaborator_id = auth.uid()` compara
   o id de uma **pessoa** com o de uma **sessão**. Antes da correcção, um token
   forjado devolvia horas, recibo de vencimento, faltas, ponto, fotografias,
   notificações e subscrições — nas **sete** tabelas. Há um teste que mede o
   antes, não só o depois.

4. **Lacuna de cobertura, minha.** Um teste de mutação mostrou que a guarda
   `AND auth_user_id IS NULL` do `UPDATE` podia ser removida sem nenhum teste
   ficar vermelho: o índice único do identificador técnico mascarava a corrida
   antes de ela chegar à base. Sem a mutação, teria reportado a cobertura como
   completa.

### O que se recusou fazer

```
COLLABORATOR_CREATE_AUTH_WRITE = 0
ADMIN_CAN_VIEW_CURRENT_PASSWORD = NO
PASSWORD_PLAINTEXT_STORAGE = NO
```

O identificador de entrada **não é** o email da pessoa: deriva do id, num
domínio `.invalid`. Usar o email pessoal misturaria o sítio onde se fala com
alguém e a forma como essa pessoa entra — mudar de email deixaria de poder
entrar, e quem não tem email não poderia ter acesso.

O que se guarda depois de definir uma senha não contém a senha: fica quem a
definiu e quando. A senha aparece uma vez no ecrã, para ser comunicada.

### Compatibilidade — a lição da #86, aplicada

```
OLD_RUNTIME_AFTER_EXPAND = PASS      ADMIN_REGRESSION = 0
EXISTING_PROFILE_IDS_CHANGED = 0     PAYROLL_LINK_LOSS = 0
DOCUMENT_LOSS = 0                    ORPHAN_AUTH = 0
DUPLICATE_AUTH = 0                   CROSS_COMPANY = BLOCKED
```

`must_change_password` nasce `NOT NULL DEFAULT false`. Se fosse anulável, as
contas existentes ficavam com `NULL`, e um código defensivo que lesse `NULL`
como «obrigar por precaução» mandava **todos os administradores** para o ecrã
de trocar senha na manhã seguinte — sem terem recebido senha nenhuma. O valor
por omissão é o que já era verdade.

### Prova

```
POSTGRES 16 (Docker):  18 + 15 + 18 + 12 + 18 + 9 = 90 verificações
DOMÍNIO:               22 (name-only) + 34 (ciclo de acesso)
SUITE COMPLETA:        3295/3295 · 133/133 ficheiros
CLEAN_INSTALL:         PASS em cada milestone (git archive + npm ci)
CI:                    verde em todas as HEADs
```

Mutações que ficaram vermelhas quando deviam: sem largar a FK antiga (6), sem o
`EXISTS` de segurança (3), sem o backfill (4), `get_my_company_id` revertida
(1), políticas revertidas (8+1), sem compensação (2), sem a guarda `IS NULL`
(1), `must_change_password DEFAULT true` (1), email fabricado reposto (2).

---

## EXPAND da identidade de colaborador — PHASE A feita

```
BRANCH = feat/collaborator-identity-expand
PR = #90   HEAD = e83fee41   CI = 33024444801 SUCCESS   MERGEABLE = YES
BASE = hotfix/reconcile-master-after-86 (a #89, nunca o master)
MIGRATION_NUMBER_FINAL = UNASSIGNED
```

| | |
|---|---|
| `profiles.auth_user_id` | coluna nova, nullable, `ON DELETE SET NULL` |
| FK de `profiles.id` para `auth.users` | **largada** — a chave primária e os valores ficam |
| backfill | `auth_user_id = id` para todos os perfis existentes |
| `get_my_profile_id()` | terceira da família de `get_my_company_id()` / `get_my_role()` (014) |

```
IDENTITY_IDS_PRESERVED = YES        OLD_RUNTIME_AFTER_EXPAND = PASS
EXPAND_BACKWARD_COMPATIBLE = YES    ROLLBACK_WITH_NEW_DATA = BLOCKED
EXISTING_PROFILE_IDS_CHANGED = 0    PAYROLL_PARENT_IDS_CHANGED = 0
DOCUMENT_PARENT_IDS_CHANGED = 0     TEAM_MEMBER_IDS_CHANGED = 0
```

O backfill mantém `id = auth.uid()` e `auth_user_id = auth.uid()`
equivalentes — é por isso que as 99 políticas continuam correctas sem se lhes
tocar.

### A auditoria RLS foi mais favorável do que o número sugeria

```
RLS_AUDIT_OBJECT_COUNT = 99
  · 72 seguem o padrão idêntico `FROM profiles WHERE id = auth.uid()`
  · 4 usam `id = auth.uid()` directo (acesso ao próprio perfil)
  · as restantes «variantes» contadas antes eram comentários de teste
CANONICAL_AUTH_TO_PROFILE_RESOLVER = get_my_profile_id() (existe, testada)
```

🔴 **A camada canónica já existia no projecto.** `get_my_company_id()` e
`get_my_role()`, da 014, resolvem o mesmo tipo de pergunta com
`SECURITY DEFINER` para não reentrarem na RLS que servem. Não se inventou um
padrão novo — seguiu-se o que lá estava. Migrar uma política passa a ser trocar
uma expressão pela função, não tomar 99 decisões.

### Três defeitos que só a execução apanhou

1. **Adicionar a coluna não chegava.** Com a FK do `id` de pé, criar uma pessoa
   sem conta continuava impossível. Seis testes vermelhos disseram-no.

2. 🔴 **O ramo de compatibilidade de `get_my_profile_id()` abria um buraco de
   segurança.** Sem exigir que a conta exista mesmo em `auth.users`, quem
   soubesse o id de uma pessoa **sem** login podia fazer-se passar por ela.
   Antes desta migration era impossível — um id de perfil era sempre um id de
   conta. Ao permitir pessoas sem conta, a equivalência deixou de valer.

3. A política de `profiles` no ensaio recorria a si própria — o mesmo defeito
   que a 014 corrigiu.

Nenhum apareceu ao reler o SQL.

```
15/15 em Postgres 16 · verificado por mutação:
  sem largar a FK antiga    ⇒ 6 vermelhos
  sem o EXISTS de segurança ⇒ 1 vermelho
  sem o backfill            ⇒ 4 vermelhos
```

### Uma lição de ferramenta, para não se repetir

A CI falhou uma vez por `@types/pg` em falta, com o typecheck a passar
localmente: o pacote estava no `node_modules` por resíduo de outra branch, e o
`package.json` desta linha não o declarava. **A instalação limpa é a única
verificação que conta** — `git archive` + `npm ci`, não o worktree actual.

Na mesma sessão, um `; echo $?` capturou o código de saída do `echo` e não do
script, e um `tsc` correu num directório vazio a devolver zero. Os três
produziam um verde que não significava nada.

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
| `feat/collaborator-identity-expand` | Claude | PHASE A da identidade | `d741a6cc` | #90 | OPEN, CI verde, stacked sobre a #89 | não |
| `feat/collaborator-identity-resolver` | Claude | fases C a F | `dc7d0135` | #91 | OPEN, CI verde, stacked sobre a #90 | não |
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
