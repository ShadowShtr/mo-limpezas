# LEDGER_RECONCILIATION_PENDING

**Aberto:** 2026-08-17
**Estado:** aberto — não resolvido nesta ronda, e deliberadamente
**Âmbito:** operacional (migrations e ledger). **Não** é trabalho do Financeiro V2.

---

## O que está errado

O schema de produção tem objectos que o ledger de migrations não conhece.

| Migration | Schema | Ledger `public._migrations` |
|---|---|---|
| `070_guard_profile_managed_fields.sql` | **UNVERIFIED** | ABSENT |
| `071_finance_periods_and_expense_categories.sql` | **VERIFIED_APPLIED_OUTSIDE_LEDGER** | ABSENT |
| `072_invoice_atomic_creation.sql` | **VERIFIED_APPLIED_OUTSIDE_LEDGER** | ABSENT |
| `073_payment_to_cashflow.sql` | **VERIFIED_APPLIED_OUTSIDE_LEDGER** | ABSENT |

Última entrada no ledger: `069_guard_profile_tenant_role.sql`, 2026-08-05.

## Porque aconteceu

As migrations foram aplicadas pelo **SQL Editor** do dashboard Supabase. O SQL
Editor executa o SQL e mais nada — não escreve em `public._migrations`, porque
não sabe que essa tabela é o ledger deste projeto.

Não é um caso novo. O `CLAUDE.md` registra o mesmo padrão para as migrations
021, 022, 027, 043, 049, 051 e 052. O que é novo é o tamanho da divergência
(quatro migrations seguidas) e o facto de três delas serem a base do
Financeiro V2.

## Mecanismo oficial deste projeto

O runner autoritativo é **`scripts/run-migrations.mjs`**, e o ledger é
**`public._migrations`**.

O **Supabase CLI não é o mecanismo oficial** (`supabase db push`,
`supabase migration repair`). Usa a tabela `supabase_migrations.schema_migrations`,
que é outro ledger — corrê-lo aqui criaria uma terceira versão da verdade em
vez de reconciliar as duas que já existem.

---

## Consequência prática, hoje

Para o runner, "ausente do ledger" significa "pendente". Sem protecção, um
`--apply` tentaria re-executar 071/072/073 sobre uma base com dados
financeiros reais.

Isso está **bloqueado** desde 2026-08-17 pelo drift guard
(`scripts/lib/migration-drift-guard.mjs`): o runner detecta a divergência por
introspecção do catálogo e aborta com `MIGRATION_LEDGER_SCHEMA_DRIFT` **antes
da primeira escrita**.

### O que não se pode usar até isto ser reconciliado

- `node scripts/run-migrations.mjs --apply` — aborta, por desenho
- `supabase db push` — ledger errado, ver acima
- `supabase migration repair` — idem

### O que continua a funcionar normalmente

- A aplicação. Os objectos existem, o runtime usa-os. O Financeiro V2 lê e
  escreve pela 071/072/073 sem saber nem precisar de saber do ledger.
- `--dry-run`, que passou a reportar o estado ledger↔schema de cada migration.
- `npm run rehearse:071`, que corre em PGlite e não toca em produção.

---

## Sobre a 070 — porque fica UNVERIFIED

A 070 cria `public.fn_guard_profile_managed_fields()` e um trigger sobre
`profiles`. Não é sondável como as outras:

1. Não é exposta pelo PostgREST (é uma função de trigger).
2. A função **dá curto-circuito para `service_role`** — e `service_role` é o
   único contexto de que as ferramentas automáticas dispõem.

Provar que está aplicada exigiria uma escrita em `profiles` de produção sob uma
identidade não-admin, para ver se a guarda dispara. **Não se faz uma escrita em
produção para satisfazer um fingerprint.**

Por isso a 070 não tem fingerprint no drift guard, e o estado é `UNKNOWN`.
`UNKNOWN` não bloqueia nem autoriza: é a ausência de prova registada como
ausência de prova.

> ⚠️ Não converter isto em "070 não está aplicada". Não sabemos. Quem
> reconciliar tem de a verificar por outra via — inspecção directa do catálogo
> com uma ligação Postgres, que vê `pg_trigger` sem depender do PostgREST.

---

## Como reconciliar (quando for autorizado)

Não está feito, e **não deve ser feito como efeito secundário de outro
trabalho**. Precisa de autorização explícita, pela REGRA ZERO
(`AGENTS.md`).

A ordem que faz sentido:

1. **Ligação Postgres directa** (`SUPABASE_DB_URL`), não PostgREST — para ver
   `pg_proc`, `pg_trigger` e `information_schema` sem intermediários.
2. **Verificar a 070** por `pg_trigger` / `pg_proc`, e só então decidir o
   estado dela.
3. **Comparar objecto a objecto** o que cada migration declara com o que a base
   tem. Uma migration aplicada por SQL Editor pode ter sido aplicada
   *parcialmente* — o editor não é transaccional por omissão, e uma execução
   interrompida a meio deixa exactamente isso.
4. **Calcular o checksum com o algoritmo do runner** (`checksumForNewMigration`
   em `scripts/lib/migration-checksum.mjs`). Não inventar, não usar hash de
   outra ferramenta: o runner compara com este e só com este.
5. **Decidir por migration**, não em bloco:
   - objectos todos presentes e ficheiro inalterado desde a aplicação →
     candidata a registo no ledger;
   - materialização parcial → **não registar**; precisa de correcção manual
     primeiro;
   - dúvida → não registar.
6. **Registar** com `--baseline --apply` (que marca sem executar) ou por
   `INSERT` explícito, com o checksum do passo 4.

> `--baseline` **é** esta reconciliação. Desde 2026-08-17 avisa quando vai
> registar migrations já materializadas, em vez de o fazer em silêncio — mas o
> aviso não substitui os passos 1–5.

### O que o runner nunca faz

Não se auto-reconcilia. A tentação é óbvia — "o objecto existe, então registo
e sigo" — e é o que fica proibido: apagaria a prova de que algo correu por
fora, que é a única pista de que a base e o repo divergiram. O drift guard
detecta e para. Escrever no ledger é decisão humana.

---

## Ligações

- `scripts/lib/migration-drift-guard.mjs` — a detecção
- `src/__tests__/migration-drift-guard.test.ts` — fixtures dos estados
- `src/__tests__/migration-runner-drift-abort.test.ts` — prova que aborta antes de escrever
- `docs/PRODUCTION-RUNBOOK.md` — operação de produção
- `AGENTS.md` — REGRA ZERO
