# T17-B1 — Limpeza comprovada não-runtime

> **2026-08-10** · branch `chore/t17b-limpeza-comprovada`, a partir de
> `chore/t17-auditoria-global` (`5254337`).
>
> A T17-A auditou. Esta ronda **age** — mas só onde a prova é completa, e só
> fora do código que corre em produção.

---

## 0. 🚨 Confirmação de integridade

**ZERO** escritas na base · **ZERO** produção · **ZERO** credenciais lidas ·
**ZERO** pagamentos reais · **ZERO** `fixed_variable_payments` · **ZERO**
`due_date`/`source_id` · **ZERO** migrations criadas, alteradas ou aplicadas ·
**ZERO** SQL executado · **ZERO** scripts perigosos executados · **ZERO**
alterações a `payments.ts` ou `invoices.ts` · **ZERO** T12 · **ZERO** T13 ·
**ZERO** T16 · **ZERO** Financeiro V2 · **ZERO** dependências alteradas.

Nenhuma alteração desta ronda consegue modificar dados de clientes: tudo o que
mudou é documentação, relatórios, ferramentas de auditoria offline e testes.

---

## 1. O que foi feito, em uma linha cada

| # | Acção | Resultado |
|---|---|---|
| 1 | O único ficheiro `REMOVER` | **removido**, depois de provar as 10 condições |
| 2 | `planning/` (15 ficheiros) | **arquivado** em `docs/historico/planning/`, sem uma alteração de conteúdo |
| 3 | Scripts capazes de destruir dados | matriz em `docs/SCRIPTS-SAFETY-MATRIX.md` — e **um 15.º descoberto** |
| 4 | 268 erros de consulta ignorados | backlog determinístico, com severidade e lote |
| 5 | 20 guards inline | mapeados, classificados, **nenhum alterado** |
| 6 | Falsos positivos do classificador | 6 corrigidos — e **2 falsos negativos**, que são os que importavam |
| 7 | Testes | 31 na guarda do inventário e dos backlogs |

---

## 2. O ficheiro removido — a prova antes do `git rm`

```
"C\uF03ATempmo-limpezas-dev.log"
```

O nome contém **U+F03A**, o carácter que o Windows usa no lugar de `:` (ilegal
em NTFS). Descodificado, o nome do ficheiro **é** o caminho
`C:\Temp\mo-limpezas-dev.log`: alguém escreveu `> C:\Temp\…` numa shell que
tratou o caminho como nome relativo, e o resultado foi commitado — em
`23b33e1`, na Fase 2 do calendário.

As dez condições, verificadas uma a uma antes de remover:

| | Condição | Resultado |
|---|---|---|
| A | zero imports estáticos | ✅ não é código; zero consumidores no grafo |
| B | zero imports dinâmicos | ✅ nenhum ficheiro versionado nomeia o caminho |
| C | zero referência em `package.json` | ✅ |
| D | zero referência em scripts npm | ✅ |
| E | zero referência em CI | ✅ |
| F | zero referência em Vercel/config | ✅ |
| G | zero convenção de framework | ✅ `.log` na raiz não é convenção de nada |
| H | zero referência documental **activa** | ✅ as 4 ocorrências são metadados da própria auditoria |
| I | conteúdo é log/resíduo | ✅ 542 bytes, 20 linhas de saída de `next dev` |
| J | nada a preservar | ✅ sem segredos, sem dados pessoais, sem informação única |

> ⚠️ **Dois falsos positivos na busca de referências.** `public/sw.js` e
> `scripts/stamp-sw.mjs` contêm a cadeia `mo-limpezas-dev` — mas é o **nome da
> cache do PWA**, não o ficheiro. Foram inspeccionados linha a linha antes de
> se concluir que a porta B estava fechada. Uma busca por subcadeia teria dado
> "tem referências" e travado a remoção; uma busca menos cuidadosa teria dado
> "não tem" pela razão errada.

**Removido.** E o teste que exigia a sua existência foi substituído — ver §7.

---

## 3. `src/proxy.ts` — proibido remover, agora com guarda

Regra permanente, sem prazo:

> **`src/proxy.ts` = MANTER.** É a convenção do Next 16 para o antigo
> `middleware.ts`. Não tem importadores **por desenho**, e é o ficheiro que
> protege todas as rotas por role. Nunca considerar morto por não ter
> importadores.

A protecção já existente (uma decisão manual no classificador e um teste) foi
mantida e **reforçada**, não duplicada: o teste passou a verificar também que a
porta "convenção do framework" está reconhecida como aberta, que é a razão pela
qual o ficheiro não pode ser candidato a remoção.

---

## 4. As três portas — agora um helper, não uma boa intenção

A T17-A registou três falsos positivos, todos do mesmo feitio: "a busca não
encontrou consumidores, logo está morto". Não encontrar não prova que não
existem. Há três caminhos que a busca por imports não vê, e passaram a estar
codificados em `deadCodeDoors()`:

1. **convenção do framework** — o Next carrega pelo nome;
2. **entrada de linha de comandos** — `package.json`, CI, `vercel.json`, mão;
3. **import dinâmico** — especificador construído em tempo de execução.

O resultado das três portas é agora **escrito no inventário** por ficheiro. Um
`REMOVER` futuro tem de as mostrar todas fechadas, e um teste recusa-o se não
mostrar. Enquanto qualquer uma estiver aberta, o veredicto é `STANDBY` —
resposta honesta que não custa nada, contra um `REMOVER` errado que custa um
incidente.

---

## 5. `planning/` — arquivado, não apagado

15 ficheiros movidos com `git mv` para **`docs/historico/planning/`**,
preservando a estrutura interna (`docs/`, `wireframes/`).

Antes de mover, verificado que **nenhum** é consumido por código, script ou CI —
as únicas referências eram documentais (`CLAUDE.md`, `README.md` e os próprios
relatórios de auditoria).

**Nenhum ficheiro foi editado.** Não se "melhorou" texto antigo, não se
actualizaram números históricos, não se reescreveram decisões, não se apagou
contexto. Histórico é histórico.

Acrescentado **`docs/historico/planning/README-ARQUIVO.md`**: explica que o
conteúdo é histórico, que não é fonte operacional, e aponta para os documentos
vigentes.

> ℹ️ Chama-se `README-ARQUIVO.md` e não `README.md` porque `README.md` já era o
> nome de um dos 15 ficheiros preservados. Sobrepor-lhe o novo aviso teria
> apagado histórico para escrever um aviso a dizer que o histórico se preserva.

Referências actualizadas em `CLAUDE.md` (tabela "Onde Está Tudo" e a regra
activa do design system), `README.md` e `docs/README.md`. A linha de histórico
do `CLAUDE.md` que diz *"mover planning docs para pasta planning/"* foi deixada
como está — é o registo do que aconteceu em 2026, não uma instrução.

---

## 6. Scripts perigosos — e o 15.º que faltava

Matriz completa em **[`SCRIPTS-SAFETY-MATRIX.md`](SCRIPTS-SAFETY-MATRIX.md)**.
**Nenhum foi executado. Nenhum foi alterado. Nenhum foi removido.**

| Estado | # |
|---|---|
| `MANUAL_REVIEW` | 4 — `reset-operacao`, `migrate-real-data`, `import-fluxo-junho`, `import-pdf-jun26` |
| `NEEDS_HARD_GUARD` | 8 |
| `KEEP_GUARDED` | 2 |
| `ARCHIVE_CANDIDATE` | 1 |
| `REMOVE_CANDIDATE` | **0** |

### 6.1 O defeito partilhado

**Nenhum dos 15 sabe contra que base está a correr, e nenhum o diz antes de
escrever.** 13 não imprimem o projecto-alvo, 15 não recusam produção nem pedem
confirmação, e **7 lêem `.env.local` cru** com um parser de regex próprio — ou
seja, escrevem onde quer que esse ficheiro aponte. Depois do incidente de
credenciais de 2026-08-06, isso é suficiente para que **nenhum** deva ser
executado enquanto não mudar.

### 6.2 `reset-operacao.mjs`

`MANUAL_REVIEW`. Apaga, sem filtro nenhum, todas as linhas de `services`,
`contracts`, `daily_clocks`, `absences`, `vacation_requests` e
`management_tasks` — e por cascata `timesheets`, incluindo o registo de ponto
das colaboradoras.

Tem dry-run e exige um backup no disco. Não tem `company_id` (**apaga todas as
empresas**), não diz contra que base corre, não pede confirmação, não valida o
backup — e o caminho do backup exigido está **fixo numa data de 2026-07-01**,
pelo que uma pasta antiga autoriza um apagamento de hoje.

O que preserva o financeiro é um **comentário no topo**, não uma guarda.

### 6.3 `migrate-real-data.mjs --wipe` é pior

Apaga a mesma superfície **mais `invoices` e `cash_flow_entries`** — o
financeiro que o `reset-operacao` teve o cuidado de deixar de fora — e **não tem
dry-run**. Basta a flag. Também `MANUAL_REVIEW`.

### 6.4 O 15.º: `import-predios.mjs`

Estava classificado `ADMIN_READ`. **Escreve em `building_cards`** por `POST` a
`/rest/v1/`, com a chave administrativa — foi assim que os 146 prédios reais
entraram em produção. Não aparecia como escrita porque o detector só reconhecia
`.insert(` do SDK. Ver §8.

---

## 7. 268 erros de consulta ignorados — backlog, não correcções

**`reports/ignored-query-errors.json`**, gerado por
`scripts/audit-ignored-query-errors.mjs` (estático, offline, determinístico).
**Nenhum foi corrigido.**

O padrão: `const { data: x } = await admin…` sem `error`. A consulta falha,
`data` vem `null`, o `?? []` a seguir dá lista vazia, e o ecrã mostra zero com
ar de número certo.

### 7.1 Severidade

| | # | Critério |
|---|---|---|
| **CRITICAL** | **26** | falha pode parecer sucesso, em dinheiro, autorização ou escrita |
| HIGH | 54 | esconde estado importante ao utilizador |
| MEDIUM | 92 | degrada informação sem confirmação falsa |
| LOW | 96 | telemetria, ou falha que vira recusa |

Os 26 CRITICAL estão em **13 ficheiros**, e os primeiros são exactamente a
superfície financeira: `invoices` (6), `contratos` (3), `daily-billing` (3),
`bank-import/reconcile-db` (3), `payments` (2), `payroll` (2).

> **Porque 26 e não 85.** A primeira contagem foi 85, e estava inflacionada por
> duas coisas. A primeira: a regra de "risco de autorização" procurava a palavra
> `admin` na vizinhança — que é o **nome da variável do cliente Supabase**,
> presente na própria linha da consulta. O mesmo erro "mencionar ≠ usar" que a
> T17-A registou três vezes. A segunda, mais interessante: metade dos casos
> **falha fechado** — o `if (!x) return` a seguir apanha o `null` e nega. Isso
> perde a causa real, mas não confirma nada de falso. Tratar os dois como
> igualmente graves afogaria os 26 que interessam numa lista de 268. Uma lista
> em que tudo é crítico não é uma lista de prioridades.

**`failMode`**: 140 `unchecked` · 128 `fail-closed`.
**Fallbacks**: 215 sem fallback · 46 `?? []` · 8 `?? null` · **3 `?? 0`**.

Os três `?? 0` são o caso mais perigoso do inventário — **erro de consulta
apresentado como 0 €**, indistinguível de um valor real.

### 7.2 Dois exemplos verificados à mão

- **`daily-billing.ts:127`** — se a consulta de `contracts` falhar, `?? []` faz
  com que nenhum contrato tenha `fixed_monthly`, e **a avença desaparece em
  silêncio da cobrança diária**. É a classe exacta da regressão financeira ainda
  sem diagnóstico.
- **`daily-billing.ts:276`** — `syncServicePaymentCashFlow` lê se já existe uma
  entrada de caixa; se a leitura falhar, o código conclui que não existe e
  **insere uma duplicada**.

### 7.3 Ordem de remediação

| Lote | # |
|---|---|
| `BATCH_0_TENANT_AUTORIZACAO` | 79 |
| `BATCH_1_SUPERFICIE_FINANCEIRA` | 44 |
| `BATCH_2_DOCUMENTOS_COLABORADOR` | 11 |
| `BATCH_3_ACTIONS_ESCRITA` | 84 |
| `BATCH_4_PAGINAS_LEITURA` | 30 |
| 🔴 `BLOCKED_FINANCIAL_INCIDENT` | **20** |

`BATCH_0` foi acrescentado acima da ordem do handoff: uma leitura de
autorização que falha em silêncio decide quem entra onde, e isso não é
"informação em falta no ecrã". Inclui o próprio **`requireProfile`**
(`src/lib/auth-guard.ts:65`) e `src/lib/supabase/middleware.ts:37`.

🔴 **`payments.ts` (7) e `invoices.ts` (13) ficam bloqueados.** Tocam a zona da
regressão sem diagnóstico e não podem ser corrigidos antes de um BEFORE real.
Um teste falha se algum deles for agendado para outro lote.

---

## 8. Os falsos positivos — e a metade que faltava da lição

A T17-A deixou uma lição: **mencionar ≠ usar**. Esta ronda encontrou mais dois
casos dela — e depois encontrou a lição **simétrica**, que é a cara.

### 8.1 Mais dois falsos positivos

- **O próprio auditor.** `audit-file-inventory.mjs` classificava-se
  `PRODUCTION_DANGEROUS`, por conter `SERVICE_ROLE`, `DROP`, `TRUNCATE` e
  `/rest/v1/` **dentro das suas próprias expressões de detecção**. O relatório
  versionado dizia 15 enquanto o documento da T17-A dizia 14 e nomeava 14 — a
  discrepância estava lá, por ler.
- **Ferramentas puras** — `audit-codebase.mjs`, `check-env.ts`,
  `lib/migration-checksum.mjs`, `lib/migration-runner-guards.mjs`,
  `lib/verify-target-guard.mjs` — marcadas como capazes de escrever por
  mencionarem verbos SQL e flags.

Corrigir caso a caso era jogar à apanhada. A correcção é de raiz: `stripNonCode`
remove os **literais de regex** antes de aplicar as regras. Uma regra escrita é
uma menção, nunca um uso.

### 8.2 🔴 A metade que faltava: reconhecer só o caminho conhecido dá um falso "seguro"

Dois **falsos negativos**, e são piores do que todos os falsos positivos juntos:

| Script | Era | É | Porquê |
|---|---|---|---|
| `import-predios.mjs` | `ADMIN_READ` | 🔴 `PRODUCTION_DANGEROUS` | escreve por `POST` REST, sem SDK |
| `restore-from-history.mjs` | `READ_ONLY` | `WRITE_CAPABLE` | executa `INSERT`/`UPDATE` por `pg` |

E um terceiro apanhado a meio da correcção: `verify-profile-guards.mjs` — cujo
cabeçalho diz literalmente *"Este script ESCREVE"* — chegou a cair para
`SAFE_OFFLINE` porque o atalho antigo só sabia reconhecer o SDK do Supabase e
ele fala Postgres directo.

> **A lição completa.** Um detector de escrita que só sabe ler `.insert(`
> declara inofensivo um script que apaga a base por HTTP. **Um falso "seguro" é
> pior do que não ter regra nenhuma**, porque produz confiança.

O classificador passou a exigir prova de **capacidade** antes de tudo o resto
(constrói cliente · lê a cadeia de ligação · chama `/rest/v1/`) e a reconhecer as
**três formas de escrever**: SDK, HTTP e SQL.

### 8.3 Dois erros cometidos e corrigidos a caminho disto

Ficam registados porque são instrutivos, não por escrúpulo:

1. **Remover comentários** para evitar a auto-referência produziu o erro
   simétrico: `run-migrations.mjs` caiu de `WRITE_CAPABLE` para `READ_ONLY`,
   porque as flags `--apply`/`--confirm-production` que o tornam capaz de
   escrever estão declaradas **no cabeçalho de uso, em comentário**. Num script
   de CLI, o comentário de uso é a documentação da interface — é prova.
   Resolvido com duas vistas do ficheiro: *capacidade* sem comentários,
   *interface* com eles.
2. **`UPDATE\s+\w` com a flag `/i`** apanhava prosa portuguesa — "update
   manual", "update quando a app está idle" — e promovia `audit-reversoes.mjs`,
   que só lê, a `PRODUCTION_DANGEROUS`. O SQL destes scripts é maiúsculo; a
   linguagem natural à volta não é.

---

## 9. 20 guards inline — mapeados, nenhum tocado

**`reports/auth-guard-inline.json`**, gerado por `scripts/audit-auth-guards.mjs`.

🔴 **Nenhuma action está desprotegida.** 15 usam `requireProfile`, 20 têm guard
inline, **0 sem autenticação**. Total 35 — bate com a T17-A. O defeito é
**duplicação**, não vulnerabilidade: quando a regra de acesso mudar, tem de
mudar em 21 sítios, e o que ficar para trás continua a autorizar pela regra
antiga, em silêncio.

| Veredicto | # |
|---|---|
| `SAFE_TO_CENTRALIZE` | 9 |
| `SEMANTIC_DIFFERENCE` | 5 |
| `NEEDS_TEST` | 5 |
| `STANDBY` | 1 |

Os 5 `SEMANTIC_DIFFERENCE` fazem algo que `requireProfile` não faz: `absences`,
`colaboradores` e `vacation` misturam guard com regra de negócio por papel;
`csv-import` limita o gestor a criar colaboradores (correcção P0-6); `auth` é a
própria superfície de autenticação e arrisca dependência circular.
`whatsapp` fica `STANDBY` porque o ficheiro inteiro está STANDBY.

**Nenhuma action foi alterada.** Centralizar autenticação numa task de limpeza
seria trocar um risco conhecido por um desconhecido.

---

## 10. O que ficou intocado, e continua a ficar

| Área | Estado |
|---|---|
| **Realtime** (8 handlers, 5 sem `company_id`, 2 com `payload.new`) | `BLOCKED_T16` — não tocado |
| **Cache** (126 `revalidatePath`, 5 amplos a `/dashboard`) | `BLOCKED_T16` — não tocado |
| **Migrations** (72) | intactas. **070 continua NÃO APLICADA.** Nada renumerado, nada consolidado |
| **SQL congelado** (T08/T09) | `FROZEN`, não aplicado |
| **T11/T14/T15** (`src/domain/billing`, `reports`, `dashboard`) | intocado |
| **Legacy financeiro** (4 módulos) | `STANDBY` — comparadores da transição |
| **`payments.ts` / `invoices.ts`** | intocados |
| **Dependências** | nenhum update, nenhum `npm audit fix` |
| **Artefactos locais sensíveis** | não lidos, não aplicados, não modificados |

---

## 11. Contagem de ficheiros

| | # |
|---|---|
| T17-A | 557 |
| − resíduo removido | −1 |
| + artefactos da T17-B1 | +8 |
| **Total** | **564** |

Os 8: `SCRIPTS-SAFETY-MATRIX.md` · `T17-B1-LIMPEZA-COMPROVADA.md` ·
`README-ARQUIVO.md` · `audit-ignored-query-errors.mjs` · `audit-auth-guards.mjs`
· `ignored-query-errors.json` · `auth-guard-inline.json` ·
`t17b-backlog-guard.test.ts` — que se contam a si próprios, como aconteceu na
T17-A.

| Estado | T17-A | T17-B1 |
|---|---|---|
| MANTER | 507 | **532** |
| STANDBY | 34 | **32** |
| ARQUIVAR | 15 | **0** |
| REMOVER | 1 | **0** |

`ARQUIVAR` a zero é a conclusão da acção, não uma omissão: os 15 foram
arquivados e passaram a `MANTER` na categoria nova `doc-historico`. `STANDBY`
desce de 34 para 32 por causa das reclassificações da §8.

> O número **não está fixado em lado nenhum**. A fonte é `git ls-files` mais o
> classificador determinístico; a guarda exige regeneração sempre que a lista
> muda, e foi assim que a discrepância 552/557 da T17-A apareceu.

---

## 12. Testes

**31 novos ou reescritos**, em duas suites:

`src/__tests__/t17-inventory-guard.test.ts` (21) — inventário completo, sem
fantasmas, toda a classificação com razão; **o padrão U+F03A não volta**;
`src/proxy.ts` continua `MANTER` e reconhecido como convenção; nenhuma entrada
de framework ou de CLI é dada como morta; um `REMOVER` exige as três portas
fechadas; os scanners de segurança e o próprio auditor não são confundidos com
ameaças; os comparadores offline não são dados como capazes de escrever; escrita
por HTTP e por SQL conta como escrita; o arquivo histórico está preservado.

`src/__tests__/t17b-backlog-guard.test.ts` (10) — os backlogs são coerentes,
toda a ocorrência tem severidade e lote, `payments`/`invoices` continuam
bloqueados, `fail-closed` nunca é `CRITICAL`, os `CRITICAL` continuam a ser uma
lista accionável, e **nenhum relatório contém credenciais nem dados pessoais**.

O teste da T17-A que **exigia** que o candidato a `REMOVER` continuasse a
existir foi substituído — mantê-lo passaria a congelar o lixo no repositório.
Um teste amarrado a um nome protege um ficheiro; um teste amarrado ao padrão
protege o repositório.

### Gates

`npm run secrets:scan` → **nenhuma credencial** ·
`npm run typecheck` → **0 erros** · `npm run lint:strict` → **0** ·
`npm test` → **1949 testes** · `npm run audit:code:strict` → **passa** ·
`git diff --check` → limpo.

> ⚠️ **`src/__tests__/scan-secrets.test.ts` não colige em Windows**
> (`SyntaxError`). É **pré-existente e alheio a esta ronda** — já registado na
> T17-A §14 — e passa no CI Linux.

---

## 13. O que a T17-B2 herda

1. decidir com o proprietário o destino dos **4 `MANUAL_REVIEW`**;
2. **um** helper partilhado de acesso administrativo: imprime o projecto-alvo,
   recusa produção sem confirmação, e acaba com os 7 parsers de `.env.local`;
3. `dry-run` por omissão nos 8 `NEEDS_HARD_GUARD`; `company_id` obrigatório;
4. os erros ignorados, por lote — **`BATCH_0` primeiro**, `payments`/`invoices`
   só depois do diagnóstico financeiro;
5. `AUTH_GUARD_CENTRALIZATION`, começando pelos 9 `SAFE_TO_CENTRALIZE`.

**Nada disto foi começado aqui.** Esta ronda é de limpeza comprovada, e a prova
tinha de vir primeiro.
