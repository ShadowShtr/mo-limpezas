# Matriz de segurança dos scripts — `PRODUCTION_DANGEROUS`

> ⚠️ **São 15, não 14.** A T17-A publicou 14. Ao escrever esta matriz
> encontrou-se um 15.º — `import-predios.mjs` — que estava classificado
> `ADMIN_READ` porque escreve por **HTTP à API REST** em vez de pelo SDK, e o
> detector só reconhecia `.insert(`. Ver §0.1.

> **T17-B1 · 2026-08-10 · análise estática.**
>
> 🔴 **Nenhum destes scripts foi executado.** Nada aqui foi descoberto a correr
> código: tudo o que se segue vem de ler o ficheiro. Não houve ligação à base,
> não foi lido nenhum `.env`, não foi impressa nenhuma credencial.
>
> Esta ronda **classifica**. A implementação das guardas em falta é da
> **T17-B2** — ver §6.

---

## 0. O que faz um script entrar nesta lista

O classificador (`scripts/audit-file-inventory.mjs`) marca
`PRODUCTION_DANGEROUS` quando o ficheiro **usa** a chave administrativa
(`SUPABASE_SERVICE_ROLE_KEY` lida de `process.env` ou de `.env.local`, ou
`createAdminClient()`) **e** escreve ou apaga.

A palavra-chave é **usa**. Mencionar a chave não conta — foi esta distinção que
tirou da lista os três scanners de segurança (`scan-secrets.mjs`,
`audit-security.ts`, `check-env.ts`), que contêm o nome da variável porque a
**procuram**. A contagem caiu de 22 para 14 por causa disso.

A chave administrativa contorna RLS. Um erro num destes 15 não é travado por
nenhuma política da base.

## 0.1 O que a própria matriz corrigiu no classificador

Escrever esta matriz obrigou a ler os 14 um a um, e a leitura desmentiu o
classificador em oito pontos. Seis eram ruído; **dois eram falsos "seguro"**, que
é o erro que interessa:

| Script | Antes | Agora | Porquê |
|---|---|---|---|
| `import-predios.mjs` | `ADMIN_READ` | 🔴 `PRODUCTION_DANGEROUS` | escreve em `building_cards` por `POST` a `/rest/v1/`, com a chave administrativa. Sem SDK, portanto sem `.insert(` — o detector não via. Foi por aqui que entraram os 146 prédios reais. |
| `restore-from-history.mjs` | `READ_ONLY` | `WRITE_CAPABLE` | executa `INSERT INTO` / `UPDATE` em SQL por `pg`. Mesma cegueira: escrita que não passa pelo SDK. |

E seis falsos positivos, todos da família **"mencionar ≠ usar"** que a T17-A já
documentara três vezes:

`audit-file-inventory.mjs` (o próprio auditor classificava-se
`PRODUCTION_DANGEROUS`, por conter `SERVICE_ROLE`, `DROP` e `TRUNCATE` dentro
das suas expressões de detecção) · `audit-codebase.mjs` · `check-env.ts` ·
`lib/migration-checksum.mjs` · `lib/migration-runner-guards.mjs` ·
`lib/verify-target-guard.mjs` — todos passaram a `SAFE_OFFLINE` depois de se
provar que nenhum constrói cliente, abre ligação ou chama a API.

> **A lição, agora com a segunda metade.** A T17-A aprendeu que mencionar não é
> usar. Faltava o simétrico: **reconhecer só o caminho conhecido dá um falso
> "seguro"**, e esse é o erro caro. Um detector de escrita que só sabe ler
> `.insert(` declara inofensivo um script que apaga a base por HTTP.
>
> O classificador passou a exigir prova de **capacidade** (constrói cliente, lê
> a cadeia de ligação, ou chama `/rest/v1/`) antes de qualquer outra pergunta, e
> a reconhecer as três formas de escrever: SDK, HTTP e SQL.

---

## 1. O defeito que os 14 partilham

**Nenhum sabe contra que base está a correr, e nenhum o diz antes de escrever.**

| Defeito comum | Scripts afectados |
|---|---|
| não mostra URL/projecto/ambiente antes de escrever | **13 de 14** (só `restore-backup` imprime a origem do backup) |
| não recusa produção, nem pede confirmação adicional | **14 de 14** |
| não tem passo de confirmação interactiva | **14 de 14** |
| lê `.env.local` cru, com um parser de regex próprio | **7 de 14** |

Os 7 que fazem `fs.readFileSync(".env.local")` escrevem **onde quer que esse
ficheiro aponte**. Se o `.env.local` da máquina tiver as credenciais de
produção — e o incidente de 2026-08-06 mostrou que já teve — o script escreve em
produção sem uma única linha a avisar. É exactamente o modo de falha do §9 do
`AGENTS.md`: *"nunca usar valores padrão que apontem para produção"*.

🔴 **Enquanto isto não mudar, nenhum dos 14 deve ser executado por ninguém.**

---

## 2. Matriz

Legenda das colunas: **dry-run** = comporta-se como leitura sem `--apply` ·
**confirm** = exige confirmação adicional além da flag · **scope** = restringe
a escrita a uma `company_id` · **rollback** = tem caminho de reversão.

| # | Script | Finalidade | Escrita | Tabelas / recursos | admin key | dry-run | confirm | scope | rollback | Recomendação |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `create-admins.mjs` | criar/promover contas de administração | `upsert` | `profiles` + Auth | ✅ | ❌ | ❌ | ✅ | ❌ | **NEEDS_HARD_GUARD** |
| 2 | `create-colaborador.mjs` | criar uma conta de colaborador | `upsert` | `profiles` + Auth | ✅ | ❌ | ❌ | ✅ | ❌ | **NEEDS_HARD_GUARD** |
| 3 | `fix-num-people.mjs` | corrigir `num_people` em massa | `update` | `services`, `contracts`, `team_members` | ✅ | ✅ | ❌ | ❌ | ❌ | **NEEDS_HARD_GUARD** |
| 4 | `fix-service-times.mjs` | corrigir horários em massa | `update` | `services`, `contracts` | ✅ | ✅ | ❌ | ❌ | ❌ | **NEEDS_HARD_GUARD** |
| 5 | `fix-weekend-services.mjs` | corrigir serviços de fim-de-semana | `update` | `services` | ✅ | ✅ | ❌ | ✅ | ❌ | **NEEDS_HARD_GUARD** |
| 6 | `geocode-locations.mjs` | preencher lat/lng via geocoder | `update` | `locations` + rede externa | ✅ | ❌ | ❌ | ❌ | ❌ | **NEEDS_HARD_GUARD** |
| 7 | `import-contratos-5.mjs` | importar 5 contratos | `insert` | `contracts`, `services` | ✅ | ❌ | ❌ | ✅ | ❌ | **ARCHIVE_CANDIDATE** |
| 8 | `import-fluxo-junho.mjs` | importar fluxo de caixa de Junho | `insert` | **`cash_flow_entries`** | ✅ | ❌ | ❌ | ✅ | ❌ | 🔴 **MANUAL_REVIEW** |
| 9 | `import-pdf-jun26.mjs` | importar a operação de um PDF | `insert` | `teams`, `clients`, `locations`, `contracts`, `services` | ✅ | ❌ | ❌ | ✅ | ❌ | 🔴 **MANUAL_REVIEW** |
| 9b | `import-predios.mjs` | importar 146 prédios de rotas em PDF | `POST` REST | `building_cards` (lê `teams`) | ✅ | ✅ | ❌ | ✅ | ❌ | **KEEP_GUARDED** — ver §0.1 |
| 10 | `migrate-real-data.mjs` | migração inicial + `--wipe` | `delete`, `insert`, `update` | `profiles`, `clients`, `locations`, `teams`, `team_members` — e no `--wipe` também **`invoices`, `cash_flow_entries`**, `timesheets`, `services`, `contracts`, … | ✅ | ❌ | ❌ | ❌ no `--wipe` | ❌ | 🔴 **MANUAL_REVIEW** |
| 11 | `reset-operacao.mjs` | apagar a operação | `delete` | `services`, `contracts`, `daily_clocks`, `absences`, `vacation_requests`, `management_tasks` (+ cascatas) | ✅ | ✅ | ❌ | ❌ | parcial | 🔴 **MANUAL_REVIEW** — ver §3 |
| 12 | `restore-backup.mjs` | restaurar de `backups/<stamp>/` | `upsert` | qualquer tabela do manifesto | ✅ | ✅ | ❌ | ❌ | n/a (é o rollback) | **KEEP_GUARDED** |
| 13 | `restore-contratos.mjs` | restaurar contratos de um JSON | `upsert` | `contracts` | ✅ | ❌ | ❌ | ❌ | n/a | **NEEDS_HARD_GUARD** |
| 14 | `restore-servicos.mjs` | restaurar serviços de um JSON | `upsert` | `services` | ✅ | ❌ | ❌ | ❌ | n/a | **NEEDS_HARD_GUARD** |

### Contagem por recomendação

| Estado | # | Scripts |
|---|---|---|
| `KEEP_GUARDED` | 2 | 9b, 12 |
| `NEEDS_HARD_GUARD` | 8 | 1, 2, 3, 4, 5, 6, 13, 14 |
| `ARCHIVE_CANDIDATE` | 1 | 7 |
| `MANUAL_REVIEW` | 4 | 8, 9, 10, 11 |
| `REMOVE_CANDIDATE` | **0** | — |

**Zero `REMOVE_CANDIDATE` é uma conclusão, não uma omissão.** Não se provou de
nenhum dos 15 que já não serve para nada, e a T03 mostra que estes ficheiros
sobrevivem a passagens de limpeza porque continuam a parecer úteis. Apagar sem
decisão do proprietário substituiria um risco por outro.

---

## 3. `reset-operacao.mjs` — tratado à parte

**Não executar. Não testar contra base nenhuma. Não remover sem decisão do
proprietário.**

### O que apaga

Todas as linhas, sem filtro nenhum além de `id ≠ 0`, das tabelas:
`services` · `contracts` · `daily_clocks` · `absences` · `vacation_requests` ·
`management_tasks`.

Por cascata da chave estrangeira, `services` arrasta ainda `timesheets`,
`service_reinforcements`, `service_price_audit` e `service_photos` — o registo
de ponto das colaboradoras incluído.

### O que o próprio ficheiro diz que preserva

Empresa, utilizadores, equipas, clientes, locais e **todo o financeiro**
(`cash_flow_entries`, faturas, salários, banco). As entradas de caixa
sobrevivem, mas perdem a ligação ao serviço que as originou.

> ⚠️ Esta preservação é **afirmada no comentário do topo**, não verificada por
> nada. É uma promessa por omissão: o financeiro fica de fora porque não está na
> lista, não porque exista alguma guarda que o proteja. Acrescentar uma tabela à
> lista é uma linha.

### Protecções que existem

- **dry-run por omissão** — sem `--apply` só conta linhas;
- **exige um backup no disco** antes de apagar.

### Protecções que faltam

- 🔴 **nenhum `company_id`.** O `.delete().neq("id", ZERO)` é global. Numa base
  multi-tenant apaga **todas as empresas**, não só a que se pretendia;
- 🔴 **não diz contra que base vai correr.** Lê `.env.local` cru e usa o que lá
  estiver;
- 🔴 **não recusa produção nem pede confirmação** — basta escrever `--apply`
  uma vez;
- ⚠️ **o backup exigido está fixo num caminho de uma data concreta**
  (`backups/2026-07-01_pre-reset/_MANIFEST.json`). A guarda passa se essa pasta
  antiga existir no disco, mesmo que o conteúdo não tenha nada a ver com o
  estado actual da base. Um backup de mais de um mês a autorizar um apagamento
  de hoje não é uma protecção — é um carimbo;
- 🔴 **não valida o backup.** Não verifica idade, origem, contagens, nem que
  cobre as tabelas que vai apagar;
- ⚠️ **os erros por tabela não abortam** — o laço faz `continue`, deixando a
  base meio apagada sem falhar.

### O nome comunica o risco?

**Parcialmente, e é isso que o torna perigoso.** "reset da operação" soa a
repor o estado de trabalho. O que faz é um apagamento global e irreversível que
inclui o registo de ponto — prova de trabalho de pessoas reais. E "operação"
sugere um limite (por oposição a "financeiro") que **nenhuma linha de código
impõe**.

### Classificação

🔴 **`MANUAL_REVIEW`** — decisão do proprietário. Se a resposta for "manter", a
T17-B2 tem de acrescentar, no mínimo: `company_id` obrigatório, impressão do
projecto-alvo, recusa explícita de produção, backup validado em vez de um
caminho fixo, e aborto ao primeiro erro.

### E `migrate-real-data.mjs --wipe`

**É pior, e não tem sequer dry-run.** Apaga a mesma superfície operacional
**mais `invoices` e `cash_flow_entries`** — exactamente o financeiro que o
`reset-operacao` teve o cuidado de deixar de fora — sem `--apply`, sem
confirmação, sem `company_id`, com uma lista de utilizadores a preservar
gravada à mão no código. A flag `--wipe` chega para o disparar.

Está no mesmo patamar de risco. Fica também em **`MANUAL_REVIEW`**, e a mesma
proibição de execução aplica-se.

---

## 4. Onde estão os outros 27 scripts

Fora desta matriz, e sem alteração nesta ronda:

| Risco | # | Estado |
|---|---|---|
| `SAFE_OFFLINE` | 21 | MANTER — provado que não constroem cliente, não lêem cadeia de ligação e não chamam a API |
| `ADMIN_READ` | 5 | MANTER — chave administrativa só para ler; fora de qualquer execução automática |
| `WRITE_CAPABLE` | 3 | STANDBY — escrevem sem chave administrativa (RLS ainda se aplica). Inclui `restore-from-history.mjs`, promovido nesta ronda |
| `READ_ONLY` | 0 | — |

> As contagens mudaram face à T17-A (13/6/5/3) por causa das oito
> reclassificações da §0.1, não porque tenham sido acrescentados scripts.

---

## 5. Regra permanente

Nenhum script desta matriz entra em execução automática: nem `package.json`,
nem CI, nem cron, nem `prebuild`. Verificado nesta ronda — **nenhum dos 15 é
referido por nenhum deles.**

Executar qualquer um deles à mão exige autorização explícita do proprietário na
conversa em curso, nos termos do **§1 do `AGENTS.md`**. Uma autorização antiga
não serve.

---

## 6. O que fica para a T17-B2

Deliberadamente **não** feito aqui: acrescentar flags, inventar confirmações ou
mudar comportamento destrutivo. Improvisar uma guarda num script que apaga dados
é a forma mais rápida de criar a falsa sensação de que ele já é seguro.

A T17-B2 deve, por esta ordem:

1. decidir com o proprietário o destino dos 4 `MANUAL_REVIEW`;
2. criar **um** helper partilhado de acesso administrativo que imprima o
   projecto-alvo, recuse produção sem confirmação explícita e acabe com os 7
   parsers de `.env.local` feitos à mão;
3. aplicar `dry-run` por omissão aos 8 `NEEDS_HARD_GUARD`;
4. exigir `company_id` em toda a escrita;
5. arquivar o `ARCHIVE_CANDIDATE`.
