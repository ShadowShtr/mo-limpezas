# T17-B2 — Endurecimento dos scripts administrativos

> **2026-08-10** · branch `chore/t17b2-endurecer-scripts`, a partir de
> `chore/t17b-limpeza-comprovada`.
>
> A T17-B1 classificou o risco. Esta ronda **fecha-o** — e continua
> inteiramente offline.

---

## 0. 🚨 Confirmação de integridade

**ZERO** escritas na base · produção · credenciais lidas · pagamentos reais ·
migrations · SQL executado · T12 · T13 · T16 · Financeiro V2 · dependências
alteradas · alterações a `payments.ts`, `invoices.ts` ou `src/domain/*`.

**Nenhum script administrativo foi executado.** A única coisa que correu foi a
**recusa** de um script arquivado, para provar que sai com código 1 antes de
tocar em seja o que for.

---

## 1. O que mudou

| # | Acção | Resultado |
|---|---|---|
| 1 | 4 `MANUAL_REVIEW` | **arquivados** em `scripts/historico/`, selados com recusa sem escapatória |
| 2 | Guardas comuns | `admin-script-guard.mjs` (decisão pura) + `admin-db.mjs` (I/O) |
| 3 | Parsers de `.env.local` | **7 → 0** |
| 4 | Projecto-alvo | declarado, confrontado e **impresso** antes de qualquer trabalho |
| 5 | `company_id` | obrigatório em toda a escrita |
| 6 | `dry-run` | passou a ser o comportamento por omissão |
| 7 | Produção | recusada por omissão — e o **desconhecido conta como produção** |
| 8 | Scripts migrados | **11** |
| 9 | Testes | 22 novos, todos offline |

---

## 2. Os 4 arquivados

Decisão do proprietário: **arquivar, não apagar.** `git mv` para
`scripts/historico/`, conteúdo histórico preservado abaixo do selo.

`reset-operacao.mjs` · `migrate-real-data.mjs` · `import-fluxo-junho.mjs` ·
`import-pdf-jun26.mjs`

O selo explica **porquê** cada um saiu, e a recusa é deliberadamente **sem
escapatória**: não há flag, variável de ambiente nem argumento que a contorne.
Se o que fazem voltar a ser preciso, o caminho é ler o código e escrever uma
ferramenta nova com as guardas actuais — não desbloquear estas.

Um teste verifica que a recusa é a **primeira instrução executável** de cada
ficheiro, não apenas que a mensagem existe. Uma recusa depois de uma leitura de
`.env.local` já seria tarde demais.

---

## 3. As guardas

**`scripts/lib/admin-script-guard.mjs`** — decisão **pura**: sem I/O, sem
`process.exit`, sem rede. Segue o padrão que já existia em
`verify-target-guard.mjs`. É o que permite testar a decisão a sério, em vez de
testar mensagens no ecrã.

**`scripts/lib/admin-db.mjs`** — o I/O, que obedece ao veredito.

| Regra | Porquê |
|---|---|
| `--project-ref <ref>` obrigatório, **confrontado** com o ambiente | transforma "eu julgava estar no projeto de testes" num erro, em vez de num incidente |
| `--apply` para escrever | o modo tem de ser uma escolha, nunca o que acontece por descuido |
| Produção recusada; **desconhecido = produção** | um guard que só protege quando está bem configurado não protege nada no dia em que alguém se esquece de o configurar |
| `--company-id <uuid>` obrigatório | a chave administrativa contorna o RLS: sem âmbito, a escrita atinge todas as empresas |
| Alvo impresso antes de trabalhar | deve ser impossível correr um destes scripts e ficar sem saber onde se mexeu |
| `db.write` nunca ignora o erro | é o padrão que a T17-B1 contou 268 vezes na aplicação; não se repete aqui |

`MO_PRODUCTION_PROJECT_REF` foi acrescentada ao `.env.example`. Não é segredo —
aparece na URL pública.

### 3.1 Porque não `dotenv`

`dotenv` injecta em `process.env`, e um script que leia
`process.env.SUPABASE_SERVICE_ROLE_KEY` directamente volta a escapar ao guard.
`loadEnvFile()` devolve um objecto local que só o guard vê.

---

## 4. Os 11 scripts migrados

`create-admins` · `create-colaborador` · `fix-num-people` · `fix-service-times`
· `fix-weekend-services` · `geocode-locations` · `import-contratos-5` ·
`import-predios` · `restore-backup` · `restore-contratos` · `restore-servicos`

Mais `backup-all`, `backup-now` e `send-password-recovery`, que só passaram a
usar o carregador único (não escrevem na base).

### 4.1 Defeitos encontrados durante a migração

Ler cada script para o migrar revelou coisas que a análise estática não vira:

- 🔴 **`fix-weekend-services.mjs`** — as **duas** deteções de conflito ignoravam
  o erro. Se a consulta falhasse, o código concluía "não há conflito" e movia o
  serviço **para cima de outro**. Falha aberta com dano real na escala.
- 🔴 **`import-contratos-5.mjs`** — a idempotência dependia de uma leitura que
  ignorava o erro. Falhando, `taken` vinha vazio e **todas as intervenções eram
  reinseridas**. Além disso, `--dry` significava que escrever era o
  comportamento por omissão — o contrário do que torna um engano recuperável.
- 🔴 **`restore-contratos` / `restore-servicos`** — pasta de backup e data
  **fixas no código** (`backups/2026-07-01_pre-reset/`, `2026-07-01`). Um script
  de restauro amarrado a uma data restaura sempre o mesmo estado antigo. A data
  vinha de `process.argv[2]`, que hoje podia ser uma flag.
- 🔴 **Restauros sem filtro de empresa** — um backup com vários tenants era
  restaurado por inteiro, com a chave administrativa a contornar o RLS. Agora
  filtram por `company_id`, o que torna a flag real e não decorativa.
- ⚠️ **`create-admins` e `create-colaborador` imprimiam a password** no ecrã.
  Quem corre o script foi quem definiu `SEED_PASSWORD`, por isso já a sabe —
  imprimi-la só a punha no histórico da shell. Removido.
- ⚠️ **`geocode-locations`** tinha `catch { fail++ }`: uma chave Mapbox inválida
  dava 100% de falhas sem uma linha a dizer porquê. E a paginação ignorava o
  erro, o que daria "0 locais a geocodificar" — sucesso aparente sem ter feito
  nada.
- ⚠️ **`import-predios`** deduzia o `company_id` a partir da equipa 11: o script
  descobria sozinho em que empresa ia escrever, o que é o oposto de uma guarda.
  Agora é declarado, e as equipas fixas são validadas contra ele.

---

## 5. 🔴 O zero que quase foi falso

Ao migrar os scripts, os **15 `PRODUCTION_DANGEROUS` desapareceram do inventário
de uma vez** — passaram todos a `SAFE_OFFLINE`.

Continuavam a escrever na base com a chave administrativa. Só tinham deixado de
a pedir directamente: onde havia `createClient(process.env.SUPABASE_SERVICE_ROLE_KEY)`
passou a haver `openAdminDb(...)`, e o classificador não conhecia a forma nova.

É o **mesmo falso "seguro"** que a T17-B1 apanhou em `import-predios.mjs` —
desta vez provocado pela própria correcção. A capacidade não mudou; mudou a
forma de a exercer, e um detector que só conhece a forma antiga dá luz verde à
nova.

Daí a classe **`ADMIN_GUARDED_WRITE`**: continua a ser poder a sério, e não se
confunde com uma ferramenta offline.

| Risco | # |
|---|---|
| `SAFE_OFFLINE` | 22 |
| **`ADMIN_GUARDED_WRITE`** | **11** |
| `ADMIN_READ` | 6 |
| `WRITE_CAPABLE` | 3 |
| **`PRODUCTION_DANGEROUS`** | **0** |

> O zero significa **"nenhum usa a chave crua"**, nunca "nenhum escreve".

---

## 6. A armadilha, pela sexta vez

Esta é a lição que o projecto continua a reaprender, agora nos **próprios
testes** desta ronda. A primeira versão de `admin-script-guard.test.ts` falhou
três vezes, todas por detectar **menções** em vez de **usos**:

1. `audit-file-inventory.mjs` e `scan-secrets.mjs` acusados de "escrevem com a
   chave administrativa" — porque **procuram** a chave;
2. o selo de arquivo acusado de "tem escapatória" — porque **explica**, em
   prosa, que a flag `--force` existia;
3. `audit-file-inventory.mjs` acusado de "importa um script arquivado" — porque
   contém a cadeia `docs/historico/`, que classifica.

Corrigido com o mesmo remédio do classificador: analisar o **código**, sem
comentários nem literais de regex. Uma regra escrita é uma menção, nunca um uso.

> Contagem até agora: 3 falsos positivos na T17-A, 2 na T17-B1 (mais 2 falsos
> negativos), 3 nos testes da T17-B2. **A análise estática erra sempre para o
> lado de confundir o texto com o comportamento** — e nas duas direcções.

---

## 7. Testes

**22 novos** em `src/__tests__/admin-script-guard.test.ts`, todos offline:

A decisão pura — flags lidas nas duas formas, argumentos próprios do script
preservados, alvo obrigatório, divergência entre alvo declarado e real, projeto
não identificável, dry-run por omissão, produção recusada, **desconhecido
tratado como produção**, `company_id` obrigatório e validado.

Que a guarda é aplicada — nenhum script activo tem parser próprio de
`.env.local`, todo o que escreve com a chave administrativa passa por
`openAdminDb`, nenhum decide sozinho o `--apply`, nenhum imprime uma password.

Os arquivados — os 4 continuam versionados, cada um recusa **como primeira
instrução executável**, sem escapatória, e nenhum script activo os importa.

Mais 2 na guarda do inventário da T17-B1, actualizados para o estado novo.

### Gates

`secrets:scan` sem credenciais · `typecheck` 0 · `lint:strict` 0 ·
`npm test` · `audit:code:strict` passa · `git diff --check` limpo.

⚠️ `src/__tests__/scan-secrets.test.ts` não colige em Windows (`SyntaxError`) —
**pré-existente e alheio**, registado desde a T17-A §14; passa no CI Linux.

---

## 8. O que fica para depois

- **`send-password-recovery.mjs`** envia email real a pessoas reais — também
  irreversível. Não passa pelo guard, que cobre escrita em base de dados e não
  envio de mensagens. Merece guarda equivalente.
- **`import-contratos-5.mjs`** continua `ARCHIVE_CANDIDATE`: foi endurecido, mas
  a decisão de o arquivar não foi tomada.
- **T17-B3** — os erros ignorados não financeiros
  (`BATCH_3_ACTIONS_ESCRITA`, 84), pela ordem acordada.
- **Diagnóstico de pagamentos** antes de qualquer toque em `daily-billing`,
  `payments` ou `invoices`.
