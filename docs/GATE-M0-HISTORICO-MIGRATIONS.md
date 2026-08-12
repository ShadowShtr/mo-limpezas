# GATE M0 — reconciliação do histórico de migrations

**Data:** 2026-08-12 · **Base:** PR #60, head `389ef10f` · **Método:** só leitura

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
| 🔴 Deriva real de conteúdo | **1** — `022` |

**Veredicto: o baseline é reconstruível, com uma ressalva.** O ramo contém
todas as migrations aplicadas. A única coisa que impede uma reprodução fiel é
o ficheiro `022`, que foi alterado depois de ter sido aplicado.

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

## 3. 🔴 Deriva de checksum — o achado que bloqueia

Três checksums não batem certo com o ficheiro em disco. Dois têm explicação
inócua; um não tem.

| Migration | Disco | Disco em LF | Ledger | Diagnóstico |
|---|---|---|---|---|
| `068_disable_untrusted_profile_bootstrap.sql` | ✗ | ✓ | — | CRLF do checkout |
| `069_guard_profile_tenant_role.sql` | ✗ | ✓ | — | CRLF do checkout |
| **`022_storage_bucket_collaborator_documents.sql`** | ✗ | ✗ | ✗ | **conteúdo alterado** |

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

### Porque é que isto bloqueia um `db reset`

Um ensaio que reexecute a pasta local produz, para esta migration, um
resultado **diferente** do que produção tem. O ensaio deixaria de provar o que
diz provar: seria fiel a 70 das 71, e silenciosamente infiel numa.

Para a 071 em concreto o risco é baixo — o 022 cria um bucket de storage e
políticas, e a 071 não lhe toca. Mas a afirmação «o baseline é reproduzível»
não pode ser feita sem esta ressalva escrita.

**Antes do `db reset`:** decidir se se aceita a divergência do 022 como
conhecida e documentada, ou se se reconcilia primeiro.

---

## 4. O que não foi feito, e porquê

| | |
|---|---|
| `supabase migration list` | Não corrido. O runner deste projeto não escreve em `supabase_migrations.schema_migrations`; o histórico autoritativo é `public._migrations`, e esse foi lido. |
| `supabase db pull` | Não corrido. Pode propor atualizar o histórico remoto, e um prompt aceite por engano seria irreversível. |
| `supabase db dump` | Não corrido. Precisa de credenciais de base de dados que não estão disponíveis nesta sessão. |
| `db reset` / base descartável | **Bloqueado.** Docker está instalado (29.6.1) mas o daemon não está a correr, e não há `psql`. |
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
| **F.** Baseline reproduzível | ⚠️ **sim, com uma ressalva** — deriva real no `022` |

### M1 — ensaio da 071

**Não iniciado.** Bloqueado por falta de base descartável: o daemon do Docker
não está a correr.

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
