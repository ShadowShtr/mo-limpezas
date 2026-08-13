# GATE M0 — reconciliação do histórico de migrations

**Data:** 2026-08-12 · **Base:** PR #60 · **Método:** só leitura

> Atualizado duas vezes depois da revisão do dono:
>
> - **§3.1** — a divergência do `022` já estava cercada por uma política de
>   exceção, e o relatório original não a mencionava;
> - **§5** — 🔴 este relatório afirmou que o índice único de origem não
>   existia. **Afirmou mal.** A `024` já o cria e está aplicada.

Objetivo: provar que o estado que precede a 071 é reconstruível, antes de a
ensaiar contra uma base descartável.

---

## Resumo

| | |
|---|---|
| Ficheiros no ramo | **73** |
| Linhas no ledger de produção | **71** |
| Por aplicar | **070**, **071** — e só essas |
| No ledger sem ficheiro correspondente | **nenhuma** |
| Checksums que batem certo | **68 de 71** |
| Deriva real de conteúdo | **1** — `022`, **exceção já pinada** |

**Veredicto: baseline reprodutível para o escopo da 071**, com a exceção
histórica aceite do `022`. Este ensaio **não certifica byte-a-byte todo o
histórico de storage** — e não precisa de o fazer, porque a 071 não lhe toca.

---

## 1. A descoberta que muda a análise

**Este projeto não usa o mecanismo de migrations do Supabase CLI.**

Usa um runner próprio (`scripts/run-migrations.mjs`) com um ledger em
`public._migrations`, cujas colunas são:

```
name        022_storage_bucket_collaborator_documents.sql
checksum    sha256 do conteúdo
applied_at  timestamptz
```

A chave é o **nome completo do ficheiro**, mais um checksum. Não é o
timestamp, não é uma versão extraída do prefixo.

Isto responde à questão levantada sobre os três `20260609_*`.

### Os três `20260609` não são uma anomalia — aqui

Estão no ledger como três linhas distintas, todas aplicadas:

```
20260609_kanban_columns.sql
20260609_profiles_hourly_rate.sql
20260609_timesheet_limits.sql
```

Para este runner, três ficheiros com o mesmo prefixo de data são três
migrations diferentes, tal como seriam três ficheiros com nomes quaisquer. A
ordem entre elas é alfabética e estável, e nenhuma toca nas tabelas das outras.

**Mas a preocupação continua válida como dívida latente.** O Supabase CLI
reconcilia por *versão extraída do nome*, e para ele estes três seriam **uma**
migration de versão `20260609`. No dia em que alguém correr `supabase db push`
ou `supabase migration list` neste projeto, o histórico deixa de bater certo.

```
HISTORICAL_DUPLICATE_VERSION = YES (latente)
IMPACTO_NO_RUNNER_ACTUAL     = NENHUM
IMPACTO_SE_MIGRAR_PARA_O_CLI = QUEBRA
```

Não renomear, não apagar, não fazer `migration repair`. Registar, e decidir
antes de qualquer migração de ferramenta.

---

## 2. As 066 e 067 — localizadas, e irrelevantes para a 071

Lidas com `git ls-tree` e `git show` sobre a branch congelada. **Sem checkout,
sem executar SQL, sem tocar no stash.**

| | |
|---|---|
| Ficheiros | `066_secure_migrations_ledger.sql` · `067_outbox_foundation.sql` |
| Commit de origem | `8b52f6b`, 2026-08-04 |
| Mensagem | «protege public._migrations; renumera fundação do outbox para 067» |
| Blob 066 | `65288a72eacad3f41ab540be8559066dbd421f89` |
| Blob 067 | `40c4b5b4a23f88c9a57e43cfb3340cad33a0e680` |
| Aplicadas? | **Não** — o ledger salta de `065` para `068` |
| Integradas noutro ficheiro? | Não. Não existem no ramo atual sob outro nome. |

**066** protege `public._migrations` de `anon`/`authenticated` — o ledger tinha
RLS desligada e grants completos, e qualquer cliente autenticado podia
adulterá-lo via `/rest/v1/_migrations`.

**067** cria a fundação do outbox: `company_sync_state`, `domain_mutations`
idempotente e `company_change_events` imutável. 350 linhas.

### 🔴 A 071 não depende de nenhuma das duas

Verificado por leitura das referências:

```
REFERENCES public.companies
REFERENCES public.profiles
REFERENCES public.expense_categories   (a sua própria)
```

E zero menções a `_migrations`, `company_sync_state`, `domain_mutations` ou
`company_change_events`.

**Conclusão:** o salto 066/067 é ortogonal ao ensaio da 071. Não é preciso
extrair, portar ou aplicar nenhuma delas para ensaiar a 071 — e não devem ser
arrastadas para dentro deste trabalho, que é o que aconteceria se as
tratássemos como pré-requisito.

Continuam por extrair, em PRs isolados, como estava decidido desde o incidente
de 2026-08-05.

---

## 3. Deriva de checksum

Três checksums não batem certo com o ficheiro em disco. Dois têm explicação
inócua; um não tem.

| Migration | Disco | Disco em LF | Ledger | Diagnóstico |
|---|---|---|---|---|
| `068_disable_untrusted_profile_bootstrap.sql` | ✗ | ✓ | — | CRLF do checkout |
| `069_guard_profile_tenant_role.sql` | ✗ | ✓ | — | CRLF do checkout |
| **`022_storage_bucket_collaborator_documents.sql`** | ✗ | ✗ | ✗ | **conteúdo alterado** — ver §3.1 |

Os dois primeiros são artefacto do Windows: o git faz checkout em CRLF, o
checksum foi calculado sobre LF. O conteúdo é o mesmo — o blob do git confirma.

O **022 diverge mesmo em LF**:

```
ledger      63f34214405a7ae2…
disco (LF)  444dd49eb07ec2be…
git blob    444dd49eb07ec2be…
```

O ficheiro versionado **não é o que foi aplicado em produção**. O `CLAUDE.md`
tem a explicação provável: a política RLS usava `role = 'colaborador'` e foi
corrigida para `'colaboradora'` depois de a migration já estar aplicada.

### 3.1 🔴 Correção ao relatório original — a exceção já existia

A primeira versão deste documento apresentou a divergência do `022` como um
achado bloqueante. **Estava incompleta.** O projeto já tinha o caso cercado
desde 2026-08-05, em `supabase/migration-policy.json`:

```json
{
  "migration": "022_storage_bucket_collaborator_documents.sql",
  "ledgerChecksum":               "63f34214405a7ae2…",
  "acceptedNormalizedLfChecksum": "444dd49eb07ec2be…",
  "reason": "divergência histórica documentada; estado final garantido pela 023."
}
```

Os dois valores **coincidem exactamente** com os que foram medidos aqui de
forma independente, a partir do ledger de produção e do ficheiro em disco. Duas
derivações independentes a chegar ao mesmo número é a melhor confirmação
possível de que a exceção descreve o caso real, e não uma aproximação.

A política é **imposta pelo runner** (`scripts/lib/migration-checksum.mjs`,
com teste em `migration-checksum.test.ts`), o que muda a natureza da coisa:
não é uma nota num documento, é um controlo. Qualquer alteração futura ao
ficheiro `022` produz um checksum diferente do aceite e **invalida a
exceção** — o runner pára.

E o estado funcional foi reposto pela `023_fix_collaborator_documents_upload.sql`,
que corrige o bucket e a política.

**Decisão do dono, 2026-08-12:** aceitar a divergência e avançar. Reconciliar
o `022` agora aumentaria o risco e misturaria dívida histórica de storage com
mecânicas financeiras.

### Porque é que isto ainda assim limita o ensaio

Um ensaio que reexecute a pasta local produz, para esta migration, um
resultado **diferente** do que produção tem. O ensaio deixaria de provar o que
diz provar: seria fiel a 70 das 71, e silenciosamente infiel numa.

Para a 071 em concreto o risco é baixo — o `022` cria um bucket de storage e
políticas, e a 071 não lhe toca. Mas o ensaio tem de dizer o que prova e o que
não prova:

```
BASELINE_REPRODUZIVEL_PARA_071 = SIM
CERTIFICA_HISTORICO_DE_STORAGE = NAO
EXCECAO_022                    = ACEITE E PINADA
```

---

## 5. 🔴 Correção — o índice único de origem já existia

Este relatório e o corpo do PR #60 afirmaram, como achado de auditoria:

> `UNIQUE(company, reference_type, reference_id)` ❌ não existe

**Falso.** A `024_cash_flow_reference_integrity.sql` já o cria, e está
aplicada no ledger:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS cash_flow_entries_reference_unique
  ON cash_flow_entries (company_id, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
```

Mesmas colunas, mesma condição parcial que a 071 propunha recriar com o nome
`uq_cash_flow_origin`.

### Como é que a auditoria falhou

Consultei o esquema vivo pela API REST, que devolve **colunas** e não
**índices**. Vi que a coluna `reference_type` existia e concluí, sem prova, que
a restrição de unicidade não existia — quando nunca cheguei a procurá-la. Não
li os ficheiros de migration à procura dela.

O erro tem uma forma reconhecível: **usar uma fonte que não consegue responder
à pergunta e tratar o silêncio como resposta negativa.** É o mesmo padrão que
transforma uma query falhada num zero.

### O que foi corrigido

- a 071 deixou de criar `uq_cash_flow_origin`;
- o teste que exigia o índice dentro da 071 foi substituído por um que prova
  que a protecção existe no baseline, vinda da 024;
- o corpo do PR #60 foi corrigido.

Dois índices equivalentes com nomes diferentes não acrescentam protecção:
custam escrita em cada insert, para sempre, e deixam quem vier a seguir sem
saber qual é o verdadeiro.

---

## 4. O que não foi feito, e porquê

| | |
|---|---|
| `supabase migration list` | Não corrido. O runner deste projeto não escreve em `supabase_migrations.schema_migrations`; o histórico autoritativo é `public._migrations`, e esse foi lido. |
| `supabase db pull` | Não corrido. Pode propor atualizar o histórico remoto, e um prompt aceite por engano seria irreversível. |
| `supabase db dump` | Não corrido. Precisa de credenciais de base de dados que não estão disponíveis nesta sessão. |
| `supabase db reset` | **Não usado.** Exige Docker. A base descartável foi feita de outra maneira — PGlite, Postgres em WASM dentro do Node. Ver o M1 abaixo. |
| `migration repair` | Proibido, e não corrido. |

---

## Resultado

### M0 — histórico

| | |
|---|---|
| **A.** 066 localizado | ✅ blob `65288a72`, commit `8b52f6b` |
| **B.** 067 localizado | ✅ blob `40c4b5b4`, mesmo commit |
| **C.** Origem provada | ✅ nunca aplicadas; a 071 não depende delas |
| **D.** Duplicado 20260609 | ✅ confirmado como **latente** — inócuo para o runner atual, quebra se migrar para o CLI |
| **E.** Histórico remoto lido | ✅ 71 linhas, só leitura |
| **F.** Baseline reproduzível | ✅ **sim, para o escopo da 071** — exceção do `022` aceite e pinada em `migration-policy.json`, imposta pelo runner |

### M1 — ensaio da 071

**✅ EXECUTADO. 51 de 51 verificações passaram.**

`npm run rehearse:071`

🔴 **Corre no CI**, dentro do check obrigatório
(`typecheck · lint · testes · auditoria · migração · build`). Enquanto foi só
uma corrida manual registada aqui, «CI verde» não provava nenhuma destas
verificações — provava as outras, e esta ficava por conta de quem lesse o
relatório.

A migration ainda não está aplicada em lado nenhum, e é isso que torna o passo
útil: prova a cada alteração que **continua** a aplicar limpa, que não semeia
nada, e que o rollback funciona.

Sem Docker: **PGlite**, Postgres 18.3 compilado para WASM, a correr dentro do
processo do Node. Nasce vazia, morre no fim, não abre porta nem lê credenciais.

Tratar o Docker como bloqueio era um erro meu — havia uma alternativa no
alcance do projecto e não a procurei.

| Fase | Resultado |
|---|---|
| Baseline pré-071 verificado | ✔ as duas tabelas, o índice da 024, e a ausência do que a 071 cria |
| 071 aplica | ✔ sem erro |
| Zero seed | ✔ `expense_categories` com 0 linhas |
| Zero classificação automática | ✔ 3 de 3 linhas históricas ficaram sem categoria |
| `expense_category_id` nullable | ✔ |
| Não recria o índice de origem | ✔ e o da 024 continua lá |
| Mesma origem duas vezes | ✔ recusada pela base |
| Origens iguais, empresas diferentes | ✔ permitidas |
| Duas despesas manuais sem origem | ✔ permitidas (índice parcial) |
| `financial_periods` — mês 0, 13, duplicado, estado inválido | ✔ todos recusados |
| Reabrir sem motivo / com motivo em branco | ✔ recusado |
| RLS activo | ✔ nas duas tabelas novas |
| Expressões das políticas | ✔ leitura e escrita ligadas a `company_id`/`profiles`/`auth.uid()`; escrita exige `admin` ou `gestor`; nenhuma permissiva por omissão |
| Rollback | ✔ esquema idêntico ao baseline, coluna a coluna |
| Reaplicar depois do rollback | ✔ |

O rollback é SQL explícito, e tinha de ser: a 071 termina com `COMMIT`, e um
`ROLLBACK` depois disso não desfaz nada. Está no mesmo script, e foi ensaiado
como o resto.

#### Âmbito declarado do ensaio

O ensaio prova uma coisa e não prova outra, e as duas ficam escritas antes de
começar — para ninguém depois lhe atribuir uma garantia que ele não dá:

> **Baseline reprodutível para o escopo da 071, com exceção histórica aceite
> da 022. Este rehearsal não certifica byte-a-byte todo o histórico de
> storage.**

O que ficou de fora, e é deliberado:

- **as 71 migrações históricas não foram reexecutadas.** Muitas dependem de
  coisas que só existem no Supabase — `auth.users`, `storage.objects`, os
  papéis `service_role`/`authenticated`, extensões próprias — e falhariam por
  razões que nada têm que ver com a 071. O baseline reproduz **exactamente
  aquilo de que a 071 depende**, e nada mais, para o ensaio não passar a
  testar o andaime;
- **o RLS não foi exercido em execução.** As expressões das políticas são
  inspeccionadas em `pg_policies.qual` — verifica-se que ligam `company_id` ao
  `profiles` do utilizador e que a escrita exige `admin`/`gestor` — mas nenhuma
  consulta é feita como um utilizador autenticado, porque aqui `auth.uid()`
  devolve sempre `NULL`;

- o estado exacto do bucket `collaborator-documents` tal como está em
  produção — a 022 diverge, a 023 repõe o estado funcional, e nenhuma das
  duas é tocada pela 071;
- as 066 e 067, que nunca foram aplicadas nesta linha;
- a dívida latente dos três `20260609`, que só se manifesta se o projeto
  migrar para o mecanismo de migrations do CLI.

---

## Confirmações

```
PRODUCTION MIGRATION      = NO
MIGRATION REPAIR          = NO
DB PUSH                   = NO
DB PULL                   = NO
PRODUCTION DATA WRITE     = NO
AUGUST REPAIR             = NO
STASH SENSÍVEL TOCADO     = NO
BRANCH CONGELADA EXECUTADA = NO   (lida com ls-tree/show, sem checkout)
SCHEMA DUMP COMMITADO     = NO    (nenhum dump foi produzido)
```
