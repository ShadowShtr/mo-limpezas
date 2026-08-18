# LEDGER R1 — adopção administrativa de 071–073

> **Estado: DESENHADO, NÃO EXECUTADO.**
> Este documento é o plano revisto. A execução exige autorização explícita na
> conversa, pela REGRA ZERO (`AGENTS.md`). Nada aqui deve ser corrido como
> efeito secundário de outro trabalho.

**Alvo:** registar 071, 072 e 073 em `public._migrations`, sem executar o SQL
delas — já estão materializadas no schema.

**Fora do alvo:** a **070**. Ver [A 070 não entra](#a-070-não-entra).

---

## Porque é que isto é preciso

O SQL Editor do Supabase executa SQL directamente no Postgres, mas não escreve
em `public._migrations` — o ledger deste projecto. As 071–073 foram aplicadas
por essa via a 2026-08-17, portanto o schema tem os objectos e o ledger não tem
as linhas.

Para o runner, «ausente do ledger» significa «pendente». Um `--apply` hoje
tentaria **re-executar** as três sobre uma base com dados financeiros reais. O
drift guard detecta isso e aborta com `MIGRATION_LEDGER_SCHEMA_DRIFT` antes da
primeira escrita — por isso o runner está bloqueado por desenho até esta
reconciliação acontecer.

O R1 não corrige o schema. Corrige o **registo** do schema.

---

## O que já está provado (R0 e R0.1)

| Facto | Onde foi provado |
|---|---|
| 071–073 materializadas, ausentes do ledger | Live run 2026-08-18 — `docs/LEDGER-RECONCILIATION-R0.md` |
| 070 **não** materializada (função e trigger ausentes) | Mesmo live run, por catálogo |
| Nenhum `PARTIAL`, `MISMATCH`, `ERROR` ou `INCONCLUSIVE` | Mesmo live run |
| O runner aceita buracos no ledger | `src/__tests__/migration-ledger-gap.test.ts` |
| Depois do R1, só a 070 fica pendente e não é drift | Teste G3 do mesmo ficheiro |

Os passos 1–5 de `docs/LEDGER-RECONCILIATION-PENDING.md` estão cumpridos. Falta
o passo 6: registar.

---

## 🔴 `--baseline` NÃO serve para este R1

O passo 6 admite `--baseline --apply` como via. **Aqui está eliminado.**

`scripts/lib/migration-runner-core.mjs`, ramo `baseline`:

```js
const toBaseline = files.filter((f) => !applied.has(f));
```

Todas as ausentes, sem escopo — e o ciclo seguinte insere cada uma. Com o
ledger parado na 069, isso são **quatro** migrations, incluindo a 070.

Registar a 070 diria ao ledger que a guarda de `profiles` existe, quando o
catálogo provou que não existe. O runner passaria a considerá-la aplicada e
**nunca mais a aplicaria**: a guarda ficava permanentemente ausente da base e
permanentemente marcada como presente. Não há flag que restrinja o `--baseline`
a um subconjunto.

Por isso o R1 é um `INSERT` explícito, com os três nomes escritos à mão.

---

## A 070 não entra

```
070: ledger ABSENT · schema ABSENT · estado GENUINELY_PENDING
```

A 070 **não** é uma migration aplicada fora do ledger. É uma migration por
aplicar. O R1 não a resolve, não a regista e não a aplica.

Depois do R1 ela continua pendente, e o runner fica destravado para a poder
aplicar — **o que não é autorização para o fazer**. A aplicação da 070 é uma
ronda independente, com o seu próprio gate: executa SQL real sobre `profiles`,
e ao contrário do R1 não é reversível por um `DELETE`.

---

## Via escolhida: SQL Editor

Decidido a 2026-08-18. As alternativas e o motivo da escolha:

| Via | Decisão |
|---|---|
| `--baseline --apply` | ❌ arrastaria a 070 (ver acima) |
| Script novo `--reconcile --only <nomes>` | ❌ código de produção novo para uma operação única; deixaria uma via de escrita no ledger no repo para sempre |
| **SQL Editor, transaccional** | ✅ pequeno, com escopo explícito, reversível |

O SQL Editor foi o que causou esta divergência — mas aqui o alvo é só
`public._migrations`. Não toca no schema nem em dados de negócio, e é
reversível por `DELETE` porque nada é executado, só registado.

---

## Passo 1 — Snapshot (antes de tudo)

Read-only. Guardar o output bruto em `tmp/` (ignorado pelo git), **não editar,
não versionar** — mesma regra da primeira execução do R0.

```sql
SELECT name, checksum, applied_at
  FROM public._migrations
 ORDER BY name;
```

Sugestão de nome: `tmp/r1-ledger-snapshot-<data>.txt`.

Sem este snapshot não há como provar, depois, qual era o estado anterior.

---

## Passo 2 — A transacção

Checksums calculados com `checksumForNewMigration` de
`scripts/lib/migration-checksum.mjs` — `sha256(normalizeToLF(conteúdo))`, o
algoritmo que o runner usa para comparar. Coincidem com os
`CURRENT_FILE_CHECKSUM` do manifesto live de 2026-08-18.

**Sem `ON CONFLICT`,** deliberadamente: um conflito tem de ser visível e
bloquear, não ser actualizado em silêncio.

```sql
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public._migrations
     WHERE name IN (
       '071_finance_periods_and_expense_categories.sql',
       '072_invoice_atomic_creation.sql',
       '073_payment_to_cashflow.sql'
     )
  ) THEN
    RAISE EXCEPTION
      'R1 abortado: pelo menos uma das migrations 071-073 ja consta do ledger.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public._migrations
     WHERE name = '070_guard_profile_managed_fields.sql'
  ) THEN
    RAISE EXCEPTION
      'R1 abortado: a migration 070 nao pode constar do ledger.';
  END IF;
END $$;

INSERT INTO public._migrations (name, checksum) VALUES
  (
    '071_finance_periods_and_expense_categories.sql',
    '0d3d6f24c5d82048193b2b5e834b8bc482c9a0535173358aaca3ef7aa1a775c4'
  ),
  (
    '072_invoice_atomic_creation.sql',
    'cebf3365686de46f24632e135ea5e7ca706c4272f123264f3252bef5cdd5aa35'
  ),
  (
    '073_payment_to_cashflow.sql',
    '2a2f79b61d3aebbe9a5be89321660224100f61337e41e641a80ad108b328c36b'
  );

DO $$
DECLARE
  adopted_count integer;
BEGIN
  SELECT count(*)
    INTO adopted_count
    FROM public._migrations
   WHERE name IN (
     '071_finance_periods_and_expense_categories.sql',
     '072_invoice_atomic_creation.sql',
     '073_payment_to_cashflow.sql'
   );

  IF adopted_count <> 3 THEN
    RAISE EXCEPTION
      'R1 abortado: esperado 3 registos apos INSERT, obtido %.',
      adopted_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public._migrations
     WHERE name = '070_guard_profile_managed_fields.sql'
  ) THEN
    RAISE EXCEPTION
      'R1 abortado: 070 apareceu inesperadamente no ledger.';
  END IF;
END $$;

COMMIT;
```

### Porque há verificação depois do `INSERT` e antes do `COMMIT`

As pré-condições protegem contra o estado **antes**; a verificação posterior
protege contra o resultado **não ser o esperado**. Se a contagem não for
exactamente 3, ou se a 070 aparecer, o `RAISE EXCEPTION` aborta a transacção e
nada é escrito.

Isto torna o `DELETE` de reversão uma segunda linha de defesa, não a primeira:
o caso normal de erro nunca chega a precisar dele.

### Fail-safe em reexecução — *não* idempotente

Validado offline contra PGlite: correr este SQL uma segunda vez **aborta
deliberadamente**, porque as pré-condições encontram as três migrations já
registadas. Não duplica linhas e não escreve nada.

> ⚠️ Isto **não** é idempotência no sentido tradicional. Uma operação
> idempotente pode repetir-se como parte da operação normal; esta não pode. A
> segunda execução é um *erro esperado e bloqueado*, não uma repetição inócua.
> Se abortar, o estado correcto já lá está — verificar com o passo 3, não
> insistir.

---

## Passo 3 — Verificação posterior (read-only)

```sql
SELECT name, checksum
  FROM public._migrations
 WHERE name LIKE '07%'
 ORDER BY name;
```

Esperado: **exactamente** 071, 072, 073. A 070 **ausente**.

Depois, o dry-run do runner (não escreve):

```bash
node scripts/run-migrations.mjs --dry-run
```

Esperado:

```
📋 1 migração(ões) pendente(s): 070_guard_profile_managed_fields.sql
(dry-run) aplicaria: 070_guard_profile_managed_fields.sql
```

**Sem `MIGRATION_LEDGER_SCHEMA_DRIFT`.** Este resultado está provado em teste
(G3 de `migration-ledger-gap.test.ts`); se o drift ainda aparecer, o R1 não fez
o que devia e é preciso parar e investigar antes de qualquer outra coisa.

---

## Reversão

```sql
DELETE FROM public._migrations
 WHERE name IN (
   '071_finance_periods_and_expense_categories.sql',
   '072_invoice_atomic_creation.sql',
   '073_payment_to_cashflow.sql'
 );
```

Seguro **porque o R1 não executa SQL de schema** — só regista. Apagar as três
linhas devolve o estado exacto anterior, comparável contra o snapshot do
passo 1.

> Esta reversibilidade é específica do R1. A aplicação da 070, numa ronda
> futura, executa DDL real e **não** tem uma reversão desta natureza.

---

## Estado esperado no fim

```
070: ledger ABSENT   schema ABSENT    runner PENDING
071: ledger PRESENT  schema PRESENT   runner APPLIED
072: ledger PRESENT  schema PRESENT   runner APPLIED
073: ledger PRESENT  schema PRESENT   runner APPLIED

DRIFT = NONE
```

---

## O que o R1 nunca faz

| Operação | |
|---|---|
| aplicar a 070 | ❌ |
| executar o SQL de 071–073 | ❌ — já estão materializadas |
| `--baseline --apply` | ❌ — arrastaria a 070 |
| `supabase db push` / `migration repair` | ❌ — usam outro ledger |
| deploy | ❌ |
| alterar schema, dados de negócio ou runtime financeiro | ❌ |

---

## Ligações

- `docs/LEDGER-RECONCILIATION-R0.md` — a evidência live que autoriza este plano
- `docs/LEDGER-RECONCILIATION-PENDING.md` — o incidente e os passos 1–6
- `src/__tests__/migration-ledger-gap.test.ts` — prova de que o gap é suportado
- `scripts/lib/migration-checksum.mjs` — `checksumForNewMigration`
- `scripts/lib/migration-drift-guard.mjs` — o travão no runner
- `AGENTS.md` — REGRA ZERO
