# T15 — Dashboard financeiro canónico

> **Estado:** implementação **offline** concluída. **Nenhuma alteração à UI.**
> Todo o diff são ficheiros novos — nenhum componente, layout, cor, texto ou
> gráfico existente foi tocado.

---

## 0. 🚨🚨🚨 AVISO CRÍTICO — INTEGRIDADE DE DADOS FINANCEIROS 🚨🚨🚨

**Já ocorreu uma regressão financeira em produção:**

- **pagamentos VARIÁVEIS deixaram de aparecer;**
- **datas dos pagamentos FIXOS ficaram todas iguais.**

**A causa ainda NÃO está determinada.** Ver §5 de `docs/HANDOFF-2026-08-07.md`.

**Esta task não reparou nada e não estava autorizada a fazê-lo.** Não executou
`UPDATE`, `DELETE`, `INSERT`, `UPSERT`, `TRUNCATE`, migration, backfill nem
`ensureMonth`; não tocou em `fixed_variable_payments`; não usou credenciais nem
`.env`; não ligou ao Supabase.

---

## 1. O que a T15 é

A camada que a futura interface do Financeiro V2 vai consumir.

| Task | Responsabilidade |
|---|---|
| **T11** | vocabulário e **aritmética do dinheiro** |
| **T14** | **agregação por período** (o que aconteceu neste intervalo) |
| **T15** | **apresentação semântica** (que cartões, que séries, contra quê se compara) |

A T15 **compõe**: escolhe, rotula, compara e ordena. **Não faz uma única conta
de dinheiro.** Uma guarda estática impede o domínio de importar `vat` ou
`monthly-allocation` para calcular por conta própria.

---

## 2. Auditoria do dashboard atual

### 2.1 Superfície

| Camada | Ficheiro |
|---|---|
| Action | `src/app/actions/financial-dashboard.ts` (365 linhas) |
| Página | `src/app/(dashboard)/dashboard/financeiro/page.tsx` |
| Cliente | `.../financeiro/_components/financial-dashboard-client.tsx` (670 linhas) |
| Componentes | `KpiCard`, `RevenueChart`, `ClientRevenueChart`, `MonthlyTable`, `PeriodCard`, `PeriodBreakdown`, `BreakdownShell` |

### 2.2 Inventário de KPIs

| Cartão no ecrã | O que soma de facto | Fonte atual | Fonte canónica | Correto? | Risco |
|---|---|---|---|---|---|
| **Receita** | `invoices.total` **com IVA**, **inclui rascunhos** | `invoices` | `invoiced` | ❌ nome | IVA tratado como receita da empresa |
| **Custos (Salários)** | só `payroll_records.net_salary` | `payroll_records` | `cost` = folha + despesas | ❌ incompleto | despesas de caixa **nunca entram** |
| **Margem Bruta** | Receita(bruta, c/ rascunhos) − folha | derivado | `margin` c/ base declarada | ❌ | inflacionada **dos dois lados** |
| **Pendente a Receber** | faturas `pendente\|vencido` em **12 meses** | `invoices.status` | `overdue` por `due_date` | ❌ âmbito | não é do período do cartão |
| **Receita Total (ano)** | soma dos meses do ano | `invoices` | `invoiced` do ano | ❌ nome | idem "Receita" |
| **Custos Totais** | folha acumulada | `payroll_records` | `cost` | ❌ incompleto | idem |
| **Projeção Anual** | ver §6 | derivado | `ProjectionResult` | ❌ fórmula | numerador ≠ denominador |
| **Hoje / Semana / Mês** | valor dos **serviços**, c/ IVA | `services` | `scheduled`/`performed` | ⚠️ outra grandeza | discorda de "Receita" sem explicação |
| **Receita por Cliente** | `invoices.total` do ano | `invoices` | `ClientFinancialSummary` | ❌ | cliente sem fatura **invisível** |

**Quatro cartões com nome financeiro errado**, congelados em
`LEGACY_KPI_NAMING` e verificados por teste: `invoiced`, `cost`, `margin`,
`overdue`.

### 2.3 Queries

`getFinancialDashboard` — 2 consultas, **ambas com `error` tratado** (`iErr`,
`pErr`). É a parte boa.

`getOperationalSummary` — 4 consultas:

| Tabela | `error` |
|---|---|
| `services` | ✅ tratado (`sErr`) |
| `company_settings` | ❌ **ignorado** + `?? 23` |
| `locations` | ❌ **ignorado** (forma condicional) |
| `contracts` | ❌ **ignorado** → **a avença perde o valor** |

**3 erros ignorados**, já dentro do teto congelado pela guarda da T14.

**Ausência de fonte:** `cash_flow_entries` **não é consultada em lado nenhum do
dashboard**. O conceito "recebido" simplesmente não existe — "Pendente a
Receber" é inferido do texto do estado da fatura.

### 2.4 N+1

Nenhum. As consultas são todas em lote (`.in(...)`, `.or(...)`). O read model
da T15 mantém essa propriedade: recebe relatórios T14 já construídos, e a
composição é `O(n)` sobre listas já em memória, com `Map` para os índices.

---

## 3. Defeitos medidos

### 3.1 "Receita" é faturado bruto com rascunhos

```ts
.neq("status", "cancelado")                       // ← rascunhos entram
revenue = invoices.filter(…).reduce((s, inv) => s + (inv.total ?? 0), 0)
```

`invoices.total` é o valor **com IVA**. Três diferenças face ao que a palavra
"receita" sugere, nenhuma visível no ecrã.

Medido nas fixtures: uma fatura de 1230 € emitida + um rascunho de 5000 € →
o cartão mostra **6230 €**; o canónico, **1230 €**.

### 3.2 A margem está inflacionada dos dois lados

```
margem = faturado_COM_IVA − apenas_a_folha
```

- o **IVA** entra como se fosse receita da empresa — é dinheiro do Estado;
- as **despesas** de `cash_flow_entries` não entram nos custos de todo.

Medido: folha 500 € + despesas 300 € → o cartão "Custos" mostra **500 €**; o
canónico, **800 €**. A margem sai **300 € acima** do real.

### 3.3 A percentagem devolve 0% quando não há denominador

```ts
const pct = m.revenue > 0 ? Math.round((m.margin / m.revenue) * 100) : 0;
```

Um mês com 0 € de receita e 3000 € de custos mostra **"0%"** ao lado de
**"−3000,00 €"**. O 0% não é a percentagem: é a ausência dela, disfarçada de
valor. A fórmula está **duplicada** — uma vez na action, outra no `MonthlyTable`
do cliente.

### 3.4 A margem negativa é achatada no gráfico

```ts
const marginPct = Math.max(m.margin, 0) / maxVal;
```

O mês em que a empresa **perdeu dinheiro** é desenhado na linha de base, com o
mesmo aspecto do mês em que ficou empatada.

### 3.5 Três relógios a decidir que mês é hoje

| Sítio | Relógio | Resultado |
|---|---|---|
| `getFinancialDashboard` | `new Date()` no servidor | **UTC** |
| `getOperationalSummary` | `todayInLisbon()` | **Lisboa** ✅ |
| `financial-dashboard-client` | `new Date()` no browser | fuso do utilizador |

O processo corre em UTC na Vercel (sem `TZ`). Na primeira hora do dia 1 em hora
de verão, os KPIs mostram o mês anterior enquanto os cartões de período mostram
o mês certo. **As duas metades da mesma página discordam.**

### 3.6 O gráfico por cliente esconde quem não tem fatura

Um cliente com serviços realizados e sem fatura emitida **não aparece de todo**
— precisamente o caso das avenças cuja fatura ainda não foi gerada.

### 3.7 Dois números para a mesma pergunta, sem explicação

Os cartões "Hoje / Esta semana / Este mês" partem de `services` (com IVA, avença
dividida por um denominador tirado da memória — defeito §4.3 da T11). O KPI
"Receita" parte de `invoices`. **Nada na página explica porque discordam.**

---

## 4. Módulos entregues

```
src/domain/dashboard/period-selection.ts     períodos a partir de todayCivilDate
src/domain/dashboard/comparison.ts           delta, percentagem, NOT_COMPARABLE
src/domain/dashboard/projection.ts           ProjectionMethod + réplica legada
src/domain/dashboard/data-health.ts          FinancialDataHealth
src/domain/dashboard/client-summary.ts       ClientFinancialSummary + ranking
src/domain/dashboard/dashboard-read-model.ts DashboardFinancialView
src/domain/dashboard/legacy-dashboard.ts     fórmulas antigas (só comparação)
src/domain/dashboard/dashboard-compat.ts     comparador
scripts/compare-dashboard-compat.ts          CLI offline
```

Quatro guardas estáticas provam que `src/domain/dashboard`:
não conhece Supabase · não lê `process.env` · **não lê o relógio** ·
**não faz aritmética de dinheiro própria**.

Uma quinta prova que **a UI não foi tocada**: o cliente do dashboard continua a
não importar nada do domínio novo.

---

## 5. O read model

```
DashboardFinancialView
  period · periodKey · comparisonPeriod
  health          FinancialDataHealth
  kpis            11 conceitos, cada um com availability + comparison
  operational     serviços agendados/concluídos/cancelados/faltas + comparação
  marginBasis     explícita
  series.daily    todos os dias, vazios incluídos
  series.monthly  agregação mensal com marginPercent tipada
  projection      ProjectionResult | null
  topClients      ordenados pela grandeza declarada
```

### 5.1 Disponibilidade por KPI

`AVAILABLE` · `PARTIAL` · `UNAVAILABLE`, **por cartão**.

Se a caixa falhar, `received` fica `UNAVAILABLE` (`cents: null`) mas `invoiced`
continua fiável. A interface esconde ou marca um sem degradar a página inteira.
**Nunca 0 como substituto de "não sei".**

### 5.2 Nomes canónicos e o registo da divergência

Cada KPI leva `label` (nome canónico), `legacyLabel` (o texto actual do ecrã,
quando difere) e `divergenceNote` (porque é que difere). `misnamedKpis()`
devolve os quatro.

**Nenhum texto visível foi alterado.** É registo documental para que a UI nova
não herde a ambiguidade sem dar por isso.

### 5.3 Comparação com o período anterior

`current` · `previous` · `absoluteDelta` · `percentDelta` · `trend` · `snapshot`.

A percentagem é um **tipo**, não um número:

| Situação | Resultado |
|---|---|
| há base | `VALUE` com a percentagem |
| base 0, actual > 0 | `NOT_COMPARABLE` — **nunca `+∞%`** |
| ambos 0 | `UNCHANGED_ZERO` — distinto de "variou 0%" |
| falta um lado | `UNAVAILABLE` |

Testado: **nunca devolve `NaN` nem `Infinity`**, em nenhuma combinação.

`snapshot: true` marca os conceitos que são **saldos** e não fluxos
(`contracted`, `outstanding`, `overdue`, `payroll`, `cost`) — comparar dois
saldos não é o mesmo que comparar dois fluxos, e a UI deve dizê-lo.

### 5.4 Séries

**Diária:** todos os dias do período, vazios incluídos. A soma do realizado
diário bate com o KPI mensal (teste). A **margem diária é `null`** de propósito:
a folha é mensal e contaminaria o dia (ver `NON_ADDITIVE_CONCEPTS` da T14).

**Mensal:** `marginPercent` tipada — o mês sem receita e com margem negativa dá
`NOT_COMPARABLE`, não "0%".

---

## 6. Projeção — a área perigosa

### 6.1 A fórmula actual, decomposta

```ts
monthsWithRevenue = yearMonths.filter(m => m.revenue > 0 && m.month < currentMonth);
avgMonthlyRevenue = yearRevenue / monthsWithRevenue.length;   // ← ≠ conjuntos
remainingMonths   = 12 - currentMonth;
projected         = yearRevenue + avgMonthlyRevenue * remainingMonths;
```

| | |
|---|---|
| numerador | `yearRevenue` — **todos** os meses, incluindo o corrente, incompleto |
| denominador | meses **anteriores** ao corrente **que tiveram receita** |

Três consequências, todas a **sobrestimar**:

1. o mês corrente entra no numerador e **não** no denominador;
2. meses a zero são **excluídos** do denominador — um mês sem faturação é um
   facto do negócio, não uma observação em falta;
3. `remainingMonths = 12 − currentMonth` trata o mês corrente como terminado.

**Exemplo aritmético** (Jan 1000 €, Fev 1000 €, Mar corrente 200 €):

```
yearRevenue       = 2200
monthsWithRevenue = 2
média             = 1100      ← nenhum mês rendeu 1100 €
projetado         = 12 100 €
```

Uma projeção linear coerente daria **12 000 €**. A diferença não é
arredondamento: é o método.

### 6.2 O que a T15 fez

| Método | Estado |
|---|---|
| `LEGACY_AVERAGE_OF_NONZERO_MONTHS` | réplica exacta, para comparação |
| `LINEAR_BY_COMPLETED_MONTHS` | variante canónica, **claramente marcada** |
| `LINEAR_BY_CALENDAR_DAY` | extrapolação por dias civis |
| `SERVICE_BASED` | **STANDBY** — devolve `METHOD_IN_STANDBY` |

`CURRENT_PROJECTION_METHOD` continua **apontado ao legado**, com um teste a
fixá-lo. Mudá-lo altera um número visível no dashboard: é decisão de produto.

> **Dias civis, não úteis.** A definição de "dia útil" nesta empresa não está
> escrita em lado nenhum e há serviços ao sábado. Assumir Seg–Sex seria inventar
> regra de negócio.

> `SERVICE_BASED` **devolve** em vez de lançar — uma projeção é um cartão
> informativo, e rebentar o dashboard por causa dele seria pior. Contrasta com
> `PRORATED` na T11, que **lança**, porque lá o valor entra em facturação real.

---

## 7. Custos e margem

`cost = payroll + expenses`, **sem dupla contagem**: as saídas de caixa com
categoria `salario` são espelho da folha e ficam fora das despesas (regra
herdada da T14, com teste próprio na T15).

A margem declara sempre a base (`performed` | `invoiced` | `received`). Não há
um campo `margin` sem contexto.

---

## 8. Contratado × realizado, faturado × recebido

`contractedVsPerformed` devolve o delta **e mais nada**. A diferença **não é
"perda"**: pode ser trabalho por fazer no mês, cancelamentos, faltas, um
contrato começado a meio (com `PRORATED` em standby) ou uma avença sem
ocorrências. Tirar conclusões é de quem lê.

`invoicedVsReceived` usa o `outstanding` já derivado pela T11 e **pode ser
negativo** — nunca há clamp a zero. Recebido acima de faturado é informação, e a
T14 já o assinala com `RECEIVED_GT_INVOICED`.

`overdue` usa `due_date < asOf`, não o texto do estado. `asOf` vem de fora, para
que um dashboard de um mês passado seja reproduzível tal como era.

---

## 9. Clientes

`ClientFinancialSummary` tem `performed`, `invoiced`, `received`, `outstanding`
e `completedServices` — **nunca um campo `revenue` genérico**.

Um cliente aparece se tiver **qualquer** uma das grandezas, e não apenas
faturação: `performedWithoutInvoice` marca quem tem trabalho feito e nenhuma
fatura emitida. É a correcção do defeito §3.6.

**O nome do cliente não entra no domínio.** Só `clientId` e valores; o nome fica
na fronteira. Um DTO financeiro pode acabar num ficheiro exportado.

`topClientsBy` exige a grandeza (`invoiced` | `received` | `performed` |
`outstanding`) e desempata por `clientId`, para que a ordem nunca oscile entre
carregamentos.

---

## 10. Saúde dos dados

`FinancialDataHealth`: `completeness` · `trustworthy` · `issuesCount` ·
`criticalCount` · `sourcesUnavailable` · `sourcesNotRequested` · `byCode` ·
`generatedAt` · `freshestSourceAt`.

`mergeDataHealth` assume o estado **mais fraco** dos períodos, e a frescura do
conjunto é a do dado **mais antigo** — dizer que o dashboard está fresco porque
uma das fontes é recente seria a mesma mentira que mostrar zeros por uma
consulta falhada.

`freshestSourceAt` a `null` significa **desconhecida**. Nunca se finge tempo
real.

**Nenhuma UI foi implementada** — é só o contrato.

---

## 11. Comparador

```bash
npx tsx scripts/compare-dashboard-compat.ts
```

Offline, fixtures sintéticas, `assertNoWriteFlags` recusa flags de escrita,
nunca liga ao Supabase.

**15 casos · 14 divergentes.**

| Razão | Casos |
|---|---|
| `REVENUE_INCLUDES_VAT` | 12 |
| `PENDING_NOT_PERIOD_SCOPED` | 11 |
| `PROJECTION_MISMATCHED_BASIS` | 10 |
| `NEGATIVE_MARGIN_CLAMPED` | 3 |
| `MARGIN_PCT_ZERO_MASK` | 2 |
| `REVENUE_INCLUDES_DRAFTS` | 1 |
| `COSTS_IGNORE_EXPENSES` | 1 |
| `MARGIN_INFLATED` | 1 |
| `CLIENT_WITHOUT_INVOICE_HIDDEN` | 1 |

> ⚠️ **NÃO transformar isto numa estimativa de impacto real.** São fixtures
> sintéticas. O impacto real exigiria ler produção, que esta task não faz e não
> está autorizada a fazer.

---

## 12. Guarda anti-regressão

`src/__tests__/dashboard-adhoc-guard.test.ts`, inventário medido em 2026-08-08:

| Regra | Inventário |
|---|---|
| `MATH_MAX_1_COUNT` | `daily-billing.ts`: 1 · `financial-dashboard.ts`: 1 |
| `ZERO_PCT_MASK` | `financial-dashboard.ts`: 1 |
| `MARGIN_CLAMP` | `financial-dashboard-client.tsx`: 1 |
| `CLOCK_FOR_PERIOD` | teto por ficheiro financeiro (16 no total) |

---

## 13. Standbys — **não resolvidos de propósito**

| # | Item | Porquê |
|---|---|---|
| 1 | **Qual a projeção certa** | decisão de negócio; `CURRENT_PROJECTION_METHOD` fica no legado |
| 2 | **`SERVICE_BASED`** | falta decidir se projecta por contratos activos, ocorrências ou histórico |
| 3 | **`PRORATED`** (T11 §4.8) | contrato a meio do mês conta o mês inteiro |
| 4 | **Estofos × `fixed_price`** (T11 §4.10) | 75 € pela UI, 200 € pelo cron |
| 5 | **Fuso do "mês atual"** | diagnosticado; corrigir mexe em runtime |
| 6 | **`vat_rate ?? 23`** | 6 ficheiros, congelados pela guarda da T14. No domínio a taxa é obrigatória ou `UNAVAILABLE` |
| 7 | **Base da margem do produto** | `invoiced` por omissão; qual o produto quer fica por decidir |
| 8 | **Divergência serviços × faturas** | os cartões de período e o KPI "Receita" medem coisas diferentes; unificar é decisão de produto |

---

## 14. Preparação para o Financeiro V2

Quando a imagem da nova interface chegar:

1. escrever os carregadores que devolvem `SourceResult` (T14);
2. resolver o dia de Lisboa **uma vez** e passar `todayCivilDate`;
3. construir os relatórios T14 (mês, mês anterior, 12 meses, série diária);
4. chamar `buildDashboardView` **uma vez**;
5. a UI **lê** `view.kpis[…].amount.cents` e formata. Não divide, não multiplica
   por 1,23, não arredonda;
6. `view.health.trustworthy === false` → a UI avisa **antes** de mostrar números;
7. cada cartão ligado prova **BEFORE = AFTER** antes de substituir o antigo.

Qualquer componente que precise de um número que não esteja no read model é
sinal de que **falta um campo no contrato** — não de que o componente deve fazer
a conta.

---

## 15. Verificação

| Gate | Resultado |
|---|---|
| `npm run secrets:scan` | ver relatório de entrega |
| `npm run typecheck` | limpo |
| `npm run lint:strict` | limpo |
| `npm test` | ver relatório de entrega |
| `npm run audit:code:strict` | exit 0 |

**Testes novos:** 130, em 6 ficheiros (`dashboard-periods`,
`dashboard-comparison`, `dashboard-projection`, `dashboard-read-model`,
`dashboard-client-summary`, `dashboard-compat`, `dashboard-adhoc-guard`).

> ℹ️ **Nota de ambiente (herdada da T11/T14):** `scan-secrets.test.ts` não colige
> no Windows. **Pré-existente e alheio** — no CI (Linux) passa.

> ℹ️ **Armadilha:** o auditor lê o inventário de `git ls-files --cached`.
> Procedimento: `git add -A && npm run audit:code:json && git add -A`.

---

## 16. Confirmação de segurança

**ZERO** writes · **ZERO** migrations · **ZERO** credenciais · **ZERO** produção ·
**ZERO** alterações a `fixed_variable_payments` · **ZERO** T12 · **ZERO** T13 ·
**ZERO** UI nova · **ZERO** alterações à UI existente · **ZERO** alterações de
dependências.
