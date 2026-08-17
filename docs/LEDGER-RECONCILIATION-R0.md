# LEDGER R0 — motor de reconciliação, só leitura

**Criado:** 2026-08-17
**Estado:** ferramenta pronta. **Nunca correu contra a base real.**
**Escrita no ledger:** não existe aqui. É a ronda **R1**, separada.

---

## O problema

`public._migrations` está parado na 069. As migrations 070–073 foram aplicadas
pelo **SQL Editor**, que executa o SQL e não escreve no ledger.

Para o runner, "ausente do ledger" significa "pendente" — e por isso
`run-migrations --apply` está bloqueado pelo drift guard
(`MIGRATION_LEDGER_SCHEMA_DRIFT`). Ver `docs/LEDGER-RECONCILIATION-PENDING.md`.

Esta ronda constrói a ferramenta que responde, com evidência, se cada migration
pode ou não ser adoptada no ledger. **Não adopta nada.**

---

## Os três níveis de evidência

O ponto central do R0, e a razão de existir um manifesto em vez de um `INSERT`:

| # | Afirmação | Provável? |
|---|---|---|
| 1 | O objecto está materializado na base | **Sim** — introspecção do catálogo |
| 2 | O ficheiro versionado tem checksum X | **Sim** — trivial |
| 3 | Esse ficheiro é byte-a-byte o SQL executado | **Não** |

O nível 3 é impossível para tudo o que correu no SQL Editor: **nada regista o
texto executado**. Não há hash guardado para comparar — é exactamente por isso
que o ledger está vazio.

```
CORRESPONDENCE_TO_EXECUTED_SQL = UNPROVABLE

Assunção aceite: a migration versionada é a representação canónica
pretendida do schema já materializado.
Esta assunção NÃO é estabelecida pelo checksum do ficheiro.
```

Daí o campo chamar-se **`CURRENT_FILE_CHECKSUM`** e nunca `APPLIED_CHECKSUM`:
é o valor que o runner *passaria a tratar como canónico* se reconciliássemos
hoje. O mesmo vale para o `EXPECTED_FILE_CHECKSUM` que o drift guard imprime.

Inserir 071–073 no ledger, se acontecer, é uma **adopção administrativa do
estado actual** — não uma reconstrução forense do evento histórico.

---

## Porque não é uma mensagem de erro que prova

Durante a descoberta (2026-08-17), a prova de que a 072/073 estavam aplicadas
veio de as funções responderem com as **mensagens de negócio escritas nelas
próprias**. Foi evidência forte, e desfez um falso negativo do PostgREST —
chamadas RPC sem argumentos devolvem `PGRST202` porque as funções se resolvem
por assinatura, e funções comprovadamente aplicadas davam o mesmo 404.

Mas é um método mau para uma ferramenta: exige **provocar erros de negócio**
contra produção para saber o que lá está. O R0 pergunta ao catálogo
(`pg_proc`, `pg_trigger`, `information_schema`) em vez de pedir à base que
falhe de uma maneira reconhecível.

---

## A 070 já não precisa de escrita

Corrigindo o que este projecto assumiu antes: **`pg_trigger` + `pg_proc` provam
a presença da 070 sem tocar em `profiles`.**

A guarda dá curto-circuito para `service_role`, por isso *provocá-la* exigiria
uma escrita real sob identidade não-admin. Mas verificar que a função e o
trigger existem, e que o trigger aponta para a função certa e está activo, é
leitura pura de catálogo.

O que continua por provar é o **conteúdo**: função existir ≠ função ter
exactamente a definição do ficheiro actual.

```
OBJECT_PRESENCE           = PROVEN     (quando o catálogo confirma)
FUNCTION_DEFINITION_MATCH = UNKNOWN
```

`pg_get_functiondef(oid)` é leitura e pode acrescentar evidência numa ronda
futura, mas comparar SQL em bruto de forma ingénua produz falsos negativos
(espaços, ordem de cláusulas, forma como o Postgres reescreve o corpo). Fica
fora do R0.

---

## O que a ferramenta verifica

Não é só "a tabela existe". O SQL Editor **não é transaccional por omissão**:
uma execução interrompida a meio deixa a tabela criada e a coluna seguinte por
criar. Só um diff ao nível do objecto distingue isso de uma migration inteira.

| Migration | Verificação |
|---|---|
| **070** | função `fn_guard_profile_managed_fields`; trigger em `public.profiles`, com função alvo e estado de activação |
| **071** | `expense_categories` e `financial_periods` **coluna a coluna** (tipo + nulabilidade); `expense_category_id` em `cash_flow_entries` e `fixed_variable_payments` |
| **072** | `create_invoice_with_items` **com assinatura**; índices `uq_invoices_number_per_company` e `uq_invoices_draft_per_client_period` |
| **073** | `mark_payment_paid`, `unmark_payment_paid`, `is_financial_period_open`, cada uma **com assinatura** |

> Nome igual + assinatura diferente **não** é `PRESENT`. A chamada real
> falharia, e um manifesto que dissesse `PRESENT` autorizava reconciliação
> sobre um schema que não é o que o ficheiro declara.

---

## Estados

**Ledger:** `PRESENT` · `ABSENT` · `CHECKSUM_MISMATCH` · `ERROR`
**Schema:** `PRESENT` · `ABSENT` · `PARTIAL` · `UNKNOWN` · `ERROR`
**Correspondência:** `PROVEN` · `UNPROVABLE` · `CONTRADICTED`

**Recomendação:**

| Valor | Significado |
|---|---|
| `ALREADY_RECONCILED` | Ledger tem a linha e o checksum bate |
| `CANDIDATE_WITH_ASSUMPTION` | Schema presente, ledger ausente — adopção administrativa |
| `BLOCKED` | Parcial, contradito, ou estado indeterminado |
| `NOT_CANDIDATE` | Schema ausente (migration genuinamente pendente) ou sem prova |

Expectativa com a evidência actual: **071, 072, 073 →
`CANDIDATE_WITH_ASSUMPTION`**. A **070** depende do catálogo, e só sai de
`UNVERIFIED` quando a ferramenta correr com ligação directa.

---

## Condições de paragem

- **`PARTIAL` bloqueia.** Reaplicar às cegas sobre metade dos objectos é o caso
  mais perigoso.
- **`CHECKSUM_MISMATCH` bloqueia.** É o caso da **022**: ficheiro editado depois
  de aplicado. Reconciliar por cima gravava como canónico um texto que já se
  sabe não ser o que correu.
- **Falha de leitura bloqueia.** `ERROR` nunca vira "ausente".
- **A 070 não entra na reconciliação enquanto for `UNVERIFIED`.** Preencher uma
  linha porque "provavelmente foi aplicada" faz o ledger deixar de reflectir
  evidência e passar a reflectir hipótese.

---

## Como correr (quando houver ligação)

```bash
export SUPABASE_DB_URL='postgres://…'     # nunca colar em chat, nunca versionar
node scripts/reconcile-migrations.mjs --confirm-target <host>
node scripts/reconcile-migrations.mjs --confirm-target <host> --json tmp/manifest.json
```

Precisa de **ligação Postgres directa** — o catálogo não é acessível por
PostgREST.

Salvaguardas:

1. Imprime **host, base de dados e utilizador** antes de correr. Nunca a
   password, nunca a URL completa: manifestos acabam em logs de CI.
2. Exige `--confirm-target <host>` a repetir o host — para ninguém apontar isto
   a uma base por engano, mesmo sendo leitura.
3. Abre a sessão em **`BEGIN READ ONLY`** e fecha com `ROLLBACK`. Mesmo que uma
   query mutável passasse pelo código, o Postgres recusava-a.
4. `--apply`/`--reconcile`/`--fix` saem com **`RECONCILIATION_WRITE_NOT_ENABLED`**.
   Reconhecidos para recusar, não ignorados: um argumento descartado em silêncio
   deixa quem o escreveu convencido de que algo aconteceu.

**O manifesto JSON não se versiona** — envelhece com a base. As fixturas
versionadas são os testes.

---

## R1 — o que vem depois, e não está aqui

Só depois deste manifesto ser produzido contra a base real e **revisto por uma
pessoa**. R1 terá: linhas exactas, nomes exactos, checksums escolhidos
deliberadamente, snapshot anterior, transacção, `INSERT` mínimo, verificação
posterior e plano de reversão.

Nada disso existe hoje — nem como comando desligado.

---

## Ligações

- `scripts/lib/migration-reconciliation.mjs` — motor
- `scripts/reconcile-migrations.mjs` — CLI
- `src/__tests__/migration-reconciliation.test.ts` — 30 testes
- `docs/LEDGER-RECONCILIATION-PENDING.md` — o incidente
- `scripts/lib/migration-drift-guard.mjs` — o travão no runner
