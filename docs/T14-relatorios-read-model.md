# T14 — Relatórios operacionais e financeiros

> **Estado:** implementação **offline** concluída. **Nada está ligado a nenhum
> ecrã.** Todo o diff são ficheiros novos — zero alterações a ficheiros de
> aplicação existentes.

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

Qualquer alteração futura em pagamentos, financeiro, `invoices`, `invoice_items`,
contratos, `services`, datas, valores, migrations, backfills ou sincronização
deve ser tratada como **potencialmente destrutiva** e começa pela baseline
BEFORE × AFTER (§15 do handoff).

---

## 1. O que a T14 é

A T11 fixou o **vocabulário** e a **aritmética do dinheiro**. A T14 fixa a
**agregação por período** que os relatórios fazem por cima disso.

A pergunta a que responde é "quanto aconteceu neste período". Hoje há quatro
respostas diferentes — Relatórios, Cobrança Diária, Dashboard Financeiro e
Faturação — porque cada ecrã carrega os seus dados, escolhe as suas datas,
aplica o seu IVA e inventa o seu vocabulário.

**Quatro regras**, cada uma ligada a um defeito medido:

| # | Regra | Defeito que fecha |
|---|---|---|
| 1 | falha de fonte **nunca** vira zero | erro de consulta apresentado como 0 € |
| 2 | REALIZADO ≠ FATURADO ≠ RECEBIDO | quatro ecrãs, o mesmo rótulo, números diferentes |
| 3 | o denominador da avença vem do **mês inteiro** | valor por dia dependente da janela do ecrã |
| 4 | o mês usa **a mesma fórmula** do dia | totais que não fecham com a soma dos dias |

---

## 2. Auditoria — produtores e consumidores

### 2.1 Superfície mapeada

| Camada | Ficheiro |
|---|---|
| Relatórios (action) | `src/app/actions/reports.ts` |
| Relatórios (página) | `src/app/(dashboard)/dashboard/relatorios/page.tsx` |
| Relatórios (UI + CSV + PDF) | `.../relatorios/_components/reports-tabs.tsx` |
| Dashboard Financeiro | `src/app/actions/financial-dashboard.ts` |
| Cobrança Diária | `src/app/actions/daily-billing.ts` |
| Faturação | `src/app/actions/invoices.ts` |
| Caixa / contas | `src/app/actions/cash-flow.ts` |
| Folha | `src/app/actions/payroll.ts`, `src/lib/payroll-calc.ts` |
| Valor do serviço | `src/lib/service-value.ts` |
| Fronteiras de data | `src/lib/lisbon-time.ts` |

### 2.2 Inventário de queries — `reports.ts`

| # | Tabela | Filtro empresa | Filtro data | `error` | Risco |
|---|---|---|---|---|---|
| 1 | `profiles` | ✅ sessão | — | **ignorado** | lista vazia = "sem colaboradores" |
| 2 | `timesheets` | ✅ | `clock_in_at` ✅ Lisboa | **ignorado** | horas a 0 sem aviso |
| 3 | `absences` | ✅ | sobreposição ✅ | **ignorado** | absentismo a 0 |
| 4 | `company_settings` | ✅ | — | **ignorado** + `?? 23` | IVA 23% assumido |
| 5 | `services` (receita) | ✅ | `scheduled_start` ✅ | **ignorado** | receita a 0 |
| 6 | `locations` | ❌ (por `id`) | — | **ignorado** | serviço sem local é **descartado** |
| 7 | `clients` | ✅ | — | **ignorado** | nomes ficam "—" |
| 8 | `services` (2.ª vez) | ✅ | ✅ | **ignorado** | contagens a 0 |
| 9 | `teams` | ✅ | — | **ignorado** | tabela vazia |
| 10 | `contracts` | ❌ (por `id`) | — | **ignorado** | **avença perde o valor** |

**10 consultas, 10 com `error` ignorado.** Nenhuma distingue "falhou" de "não há".

A #6 é a mais silenciosa: `if (!loc) continue` — um serviço cujo local não
carregou desaparece da receita sem deixar rasto.

### 2.3 `financial-dashboard.ts`

- `last12Months()` e `currentMonth` usam **`new Date()`** — o processo corre em
  **UTC** na Vercel (não há `TZ` configurada, ver auditoria de 2026-07-06). Na
  primeira hora do dia 1 em hora de verão, o "mês atual" é o mês anterior.
- `locations` e `contracts` com `error` ignorado (forma condicional).
- Janela `semana ∪ mês` com denominador de avença tirado dos serviços em
  memória → §4.3 da T11.

### 2.4 `daily-billing.ts`

- **N+1 real**: um `SELECT` por mês dentro de `for (const ym of monthsNeeded)`
  (linha ~143), e outro por serviço em `computeServiceBillingValue`.
- 8 consultas com `error` ignorado.

---

## 3. Defeitos medidos

### 3.1 Erro de query a fingir-se de zero

```ts
const { data: contracts } = await admin.from("contracts")…   // sem error
const contractMap = Object.fromEntries((contracts ?? []).map(…));
```

Consulta falha → `data: null` → `?? []` → mapa vazio → a avença vale 0 € →
**o relatório mostra 0 € de receita com o mesmo aspecto de um mês sem receita.**

Num relatório financeiro isso é pior do que um erro: é um número errado com ar
de número certo, sobre o qual alguém decide.

### 3.2 Absentismo contado para além do período

`reports.ts`, bloco ABSENTISMO:

```ts
.lte("starts_on", endDate).gte("ends_on", startDate)    // filtro CERTO
dias = round((ends_on − starts_on) / 86400000) + 1      // conta ERRADA
```

Uma baixa de **1 de agosto a 30 de setembro** (61 dias) entra:

| Relatório | Antigo | Canónico |
|---|---|---|
| agosto (31 dias) | **61** | 31 |
| setembro (30 dias) | **61** | 30 |
| soma | **122** | 61 |

O KPI "Dias de falta" da página soma essa coluna. **61 dias de falta num mês de
31 é impossível, e nada avisava.**

> `src/lib/payroll-calc.ts` faz `Math.max`/`Math.min` contra os limites do
> período **antes** de subtrair — ou seja, **já calcula a interseção e está
> certo**. O defeito é só do módulo de relatórios. A guarda estática é estreita
> de propósito para não acusar a implementação correcta.

### 3.3 Estados agrupados por omissão

```ts
if (status === "concluido") … else if ("cancelado") … else if ("falta") …
else entry.agendado += 1        // ← em_curso, sem_cobertura, e o que vier
```

Um serviço **sem equipa atribuída** (`sem_cobertura`) é indistinguível de um
serviço normalmente agendado. E qualquer estado novo do schema entra ali sem
aviso.

### 3.4 A avença invisível

`services.calculated_value` de uma ocorrência de avença é **0 por desenho**
(`calculateServiceValue`: a fatura cobra o contrato, 1 linha/mês).

A receita dos Relatórios soma esse campo → **um contrato de 300 €/mês com
serviços concluídos contribui com 0 €** para o KPI "Receita (s/ IVA)".

No **separador ao lado da mesma página**, a "Faturação diária" mostra os
300 € divididos pelos dias. **Dois números na mesma página, ambos rotulados como
receita.**

### 3.5 A exportação recalcula

`reports-tabs.tsx`:

```ts
r.total_receita.toFixed(2),                     // base do servidor
(r.total_receita * vatFactor).toFixed(2),       // IVA refeito no browser
(r.total_receita * (1 + vatFactor)).toFixed(2)  // total refeito no browser
```

E outra vez no PDF (`exportClientePdf`), com o seu próprio `vatFactor`.

O IVA é aplicado sobre a **soma** do cliente, ignorando o `apply_vat` linha a
linha: **um cliente com serviços isentos e não isentos leva IVA a mais no
ficheiro que vai para a contabilidade.**

Medido: 150 € (100 € com IVA + 50 € isentos) → antigo 34,50 € de IVA; canónico
23,00 €.

### 3.6 Dias vazios ausentes da série

A Faturação Diária constrói o mapa **só a partir dos dias que têm serviço**. Um
dia sem serviços não existe na saída, e o gráfico salta-o em vez de mostrar zero.

### 3.7 IVA 23% assumido por omissão

`vat_rate ?? 23` em **6 ficheiros**. Se a leitura de `company_settings` falhar,
o relatório apresenta a taxa portuguesa corrente como se fosse configuração da
empresa. Uma consulta falhada fica indistinguível de uma taxa configurada.

---

## 4. Módulos entregues

```
src/domain/reports/period.ts               períodos civis + INTERSEÇÃO
src/domain/reports/integrity.ts            fontes, códigos, completude
src/domain/reports/report-sources.ts       formas de entrada (linhas já carregadas)
src/domain/reports/absence-metrics.ts      absentismo dentro do período
src/domain/reports/operational-metrics.ts  contagens e horas
src/domain/reports/report-read-model.ts    o DTO + agregação diária/mensal
src/domain/reports/export-adapter.ts       CSV/PDF sem recálculo
src/domain/reports/legacy-reports.ts       fórmulas antigas (só comparação)
src/domain/reports/reports-compat.ts       comparador legacy × canónico
scripts/compare-reports-compat.ts          CLI offline
```

**A T11 é a fonte financeira.** Nada foi recriado: `money`, `vat`,
`monthly-allocation`, `financial-model` e `consumer-parity` são consumidos como
estão. O domínio de relatórios **não contém uma única divisão de dinheiro**.

Três guardas estáticas provam-no (`reports-adhoc-guard.test.ts`):
`src/domain/reports` não conhece Supabase, não lê `process.env`, não tem
`"use server"` e **não lê o relógio**.

---

## 5. O read model

```
financial:
  contracted  scheduled  performed  invoiced  received
  outstanding overdue    expenses   payroll   cost   margin
  vat (net/vat/gross)    vatRatePct  marginBasis

operations:
  counts (7 estados)  scheduled  completed  cancelled  absences
  scheduledHours  workedHours  absenceHours  absenceDays

metadata:
  period  periodKey  wholeMonth  asOf
  generatedAt  freshestSourceAt
  completeness  sources[]  integrityIssues[]
```

Nenhum montante é um `number` solto: todos são `FinancialAmount` da T11, com
`cents | null`, `origin` e `completeness`.

### 5.1 Fontes de cada conceito

| Conceito | Fonte | Regra |
|---|---|---|
| **contracted** | `contracts` | `ativo` + `fixed_monthly`, vigência a tocar a janela, **mês inteiro** |
| **scheduled** | `services` | tudo menos `cancelado`; avença via alocação |
| **performed** | `services` | só `concluido`; avença via alocação |
| **invoiced** | `invoices` | exclui `rascunho` **e** `cancelado` |
| **received** | `cash_flow_entries` | `entrada` + `confirmado`. **Nunca `services.payment_status`** |
| **overdue** | `invoices` | emitida, não paga, `due_date < asOf` |
| **expenses** | `cash_flow_entries` | `saida` + `confirmado`, **excluindo `salario`** |
| **payroll** | `payroll_records` | por `period_year`/`period_month` |
| **cost** | derivado | `payroll + expenses`, sem dupla contagem |
| **outstanding** | derivado | `invoiced − received` |
| **margin** | derivado | base **explícita** (`performed`/`invoiced`/`received`) |

**Sem dupla contagem nos custos:** as saídas de caixa com categoria `salario`
são espelho da folha e ficam de fora das despesas. Contá-las nas duas parcelas
duplicaria o custo do mês inteiro.

### 5.2 Completude

`COMPLETE` (todas as fontes pedidas carregaram) · `PARTIAL` (alguma falhou, há
dados) · `FAILED` (nenhuma carregou — a UI **não deve mostrar** o relatório,
porque exibir zeros seria mentir).

`NOT_REQUESTED` é distinto de `FAILED`: um relatório operacional que nunca pediu
a folha não está degradado. Confundi-los faria todos os relatórios parecerem
parciais para sempre, e um aviso que aparece sempre deixa de ser lido.

### 5.3 Códigos de integridade

**Falhas de fonte:** `SERVICES_QUERY_FAILED` · `CONTRACTS_QUERY_FAILED` ·
`INVOICES_QUERY_FAILED` · `INVOICE_ITEMS_QUERY_FAILED` · `PAYMENTS_QUERY_FAILED` ·
`PAYROLL_QUERY_FAILED` · `TIMESHEETS_QUERY_FAILED` · `ABSENCES_QUERY_FAILED` ·
`SETTINGS_QUERY_FAILED`

**Inconsistências:** `INVOICED_WITHOUT_ITEMS` · `RECEIVED_GT_INVOICED` ·
`NEGATIVE_OUTSTANDING` · `MONTHLY_ALLOCATION_MISMATCH` ·
`UNALLOCATED_MONTHLY_AMOUNT` · `MISSING_FINANCIAL_SOURCE` ·
`DUPLICATE_SERVICE_ID` · `DUPLICATE_INVOICE_ITEM` · `UNKNOWN_STATUS` ·
`INVALID_DATE_RANGE` · `RECORD_OUTSIDE_PERIOD` · `PARTIAL_MONTH_WINDOW` ·
`VAT_RATE_UNAVAILABLE`

**Nenhum código autoriza uma correcção automática.** A T14 detecta e classifica.

Nenhum problema carrega a mensagem do Supabase, o SQL, a política de RLS ou a
stack — só um código estável e uma nota técnica escrita por nós. `subject` é
sempre um identificador técnico, **nunca** nome de cliente ou morada: um
relatório de integridade pode acabar num ficheiro exportado.

---

## 6. Diária × mensal

O relatório mensal é construído pela **mesma função** (`buildReport`) do diário,
sobre uma janela maior. Não há um caminho "mensal" com aritmética própria.

`checkDailyMonthlyParity` prova, para cada conceito aditivo, que a soma dos dias
bate **exactamente** com o mês.

### 6.1 O que NÃO é aditivo — e porquê

| Conceito | Razão |
|---|---|
| `contracted` | valor **mensal** do contrato — cada dia do mês vê o mesmo |
| `payroll` | `payroll_records` é por período mensal, não por data |
| `cost` | inclui a folha, logo herda o problema |
| `overdue` | **saldo** num instante (`asOf`), não um fluxo |
| `outstanding` | derivado de saldos |

> **Este defeito foi encontrado por um teste, não por leitura.** A primeira
> versão pôs `cost` na lista de aditivos; a paridade falhou com
> `31 × a folha do mês`. A parcela `expenses` (movimentos de caixa, que têm
> data) **é** aditiva e ficou na lista; `payroll` e `cost` saíram.

Forçar a soma onde a semântica não cabe é exactamente o que produz totais que
ninguém consegue reconciliar. Por isso a lista é explícita e curta, e há uma
segunda constante (`NON_ADDITIVE_CONCEPTS`) com a razão de cada exclusão, para
que a UI possa recusar-se a somar em vez de o descobrir num total errado.

---

## 7. Datas e fuso

`period.ts` trabalha em **datas civis** (`CivilDate` da T07), nunca em `Date`.
`absences.starts_on`/`ends_on`, `cash_flow_entries.date` e
`invoices.period_start` são colunas `DATE`: não têm hora nem fuso, e
representá-las como `Date` obriga a inventar ambos — é daí que vêm os desvios de
±1 dia do projecto.

O domínio **nunca vê um timestamp**. Quem carrega converte `scheduled_start`
para o dia civil de Lisboa uma vez, na fronteira (`lisbonDateOf` de
`scripts/t08-io.ts` já faz isto para a T08), e a partir daí o fuso não pode
enganar-se.

`asOf` e `generatedAt` vêm sempre de fora. Uma guarda estática impede
`new Date()` e `Date.now()` dentro de `src/domain/reports` — sem isso, um
relatório de um mês passado não seria reproduzível tal como era.

Testado: outubro de 2026 (fim da hora de verão) tem 31 dias distintos na série;
fevereiro comum tem 28, bissexto 29; janelas a atravessar a fronteira do ano.

---

## 8. Comparador

```bash
npx tsx scripts/compare-reports-compat.ts
npx tsx scripts/compare-reports-compat.ts --out tmp/t14-relatorio.json
```

Offline, fixtures sintéticas, `assertNoWriteFlags` recusa
`--apply`/`--execute`/`--write`/`--commit`/`--force`. Nunca liga ao Supabase,
nunca lê credenciais.

**17 casos · 17 divergentes.**

| Razão | Casos |
|---|---|
| `EMPTY_DAYS_MISSING` | 17 |
| `CENTS_LOST_IN_SPLIT` | 7 |
| `MONTHLY_INVISIBLE_IN_REVENUE` | 7 |
| `ABSENCE_OVERCOUNTED` | 5 |
| `VAT_ON_AGGREGATE` | 2 |
| `STATUS_BUCKETED` | 1 |

Absentismo: **−62 dias** acumulados (o antigo contava a mais). **1 caso** com um
total impossível para o período.

> ⚠️ **NÃO transformar isto numa estimativa de impacto real.** São fixtures
> sintéticas. O impacto real exigiria ler produção, que esta task não faz e não
> está autorizada a fazer.

---

## 9. Guarda anti-regressão

`src/__tests__/reports-adhoc-guard.test.ts`, com inventário congelado e contagem
por ficheiro (medido em 2026-08-08):

| Regra | Inventário |
|---|---|
| `ABSENCE_FULL_DURATION` | `reports.ts`: 1 |
| `STATUS_ELSE_BUCKET` | `reports.ts`: 1 |
| `VAT_DEFAULT_23` | 6 ficheiros, 7 ocorrências |
| `IGNORED_QUERY_ERROR` | teto por ficheiro financeiro (47 no total) |

Ficheiro novo com o padrão → falha. Contagem a crescer → falha. Contagem a
encolher → passa, com instrução para actualizar o inventário.

O padrão `IGNORED_QUERY_ERROR` existe em **~250 sítios** no repositório inteiro.
A T14 congela apenas a superfície que produz **números financeiros**. Baixá-lo
em toda a parte é uma frente própria.

---

## 10. Divergências e standbys — **não resolvidos nesta task**

### 10.1 Estofos × `fixed_price` (herdado da T11 §4.10)

```
src/lib/service-value.ts        calculateServiceValue: estofos ANTES de fixed_price
occurrence-projection.ts (T09)  projectValue:          fixed_price ANTES de estofos
```

Um contrato com `fixed_price = 200` **e** `3 × 25` de estofos vale **75 €** pela
UI e **200 €** pelo cron. **Continua por decidir.** Os relatórios da T14
respeitam o valor que já lhes é entregue (`ServiceInput.valueCents`) e não
arbitram — corrigir em qualquer direcção altera o valor real de serviços.

### 10.2 `PRORATED` (herdado da T11 §4.8)

Um contrato que começa ou termina a meio do mês contribui com o **mês inteiro**
(`FULL_MONTH`) e o valor fica `PARTIAL` com `PARTIAL_MONTH_WINDOW`. **A T14 não
decide proporcionalidade** — a regra (por dias de calendário? por ocorrências
previstas? conta o dia de início?) é decisão de negócio por tomar.

### 10.3 Fuso do "mês atual" no Dashboard

`last12Months()` usa `new Date()` num processo que corre em UTC. Fica
**diagnosticado, não corrigido**: alterá-lo mexe em runtime de produção, e a
T14 é offline.

### 10.4 N+1 na Cobrança Diária

Um `SELECT` por mês dentro do laço, e outro por serviço em
`computeServiceBillingValue`. O read model da T14 é alimentado **em lote**
(`monthlyOccurrences` entregue de uma vez), mas ligar isso é integração.

### 10.5 Jornada diária de ausência

O schema não define nenhuma. `absenceHoursWithinPeriod` **exige** que quem chama
passe `hoursPerDay`; sem ela devolve `null`, não zero. Inventar 8 h aqui faria o
absentismo em horas parecer um facto quando seria um palpite — e esse número
entraria depois em comparações de custo.

### 10.6 `invoice_items`

`InvoiceInput.itemCount` aceita `null` (itens não carregados) e o código
`INVOICE_ITEMS_QUERY_FAILED` existe, mas nenhum carregador os traz ainda — a
detecção de `DUPLICATE_INVOICE_ITEM` fica preparada e por exercitar.

---

## 11. Integração futura — o que falta

**Nada da T14 está ligado.** Para o Financeiro V2:

1. escrever os carregadores que devolvem `SourceResult` em vez de `{ data }`
   com `error` ignorado;
2. converter timestamps para dia civil de Lisboa **uma vez**, na fronteira;
3. converter euros para cêntimos **uma vez**, na fronteira (`eurosToCents`);
4. carregar `monthlyOccurrences` do **mês inteiro** para cada avença tocada —
   uma consulta por mês, nunca por serviço;
5. ligar ecrã e exportação ao **mesmo** DTO;
6. cada ligação prova **BEFORE = AFTER** antes de substituir o ecrã antigo.

**A nova UI não faz contas.** Não divide, não multiplica por 1,23, não
arredonda. Qualquer componente que precise de um número que não esteja no read
model é sinal de que **falta um campo no contrato** — não de que o componente
deve fazer a conta.

---

## 12. Verificação

| Gate | Resultado |
|---|---|
| `npm run secrets:scan` | ver §37 do relatório de entrega |
| `npm run typecheck` | limpo |
| `npm run lint:strict` | limpo |
| `npm test` | ver relatório de entrega |
| `npm run audit:code:strict` | limpo |

**Testes novos:** 184, em 6 ficheiros
(`report-period`, `report-absences`, `report-operational`, `report-read-model`,
`report-export-adapter`, `reports-compat`, `reports-adhoc-guard`).

> ℹ️ **Nota de ambiente (herdada da T11):** `src/__tests__/scan-secrets.test.ts`
> não colige no Windows (`SyntaxError` ao importar `scripts/scan-secrets.mjs`).
> É **pré-existente e alheio** à T14 — falha igualmente na branch base. No CI
> (Linux) passa. Por isso o total local é inferior ao do CI.

> ℹ️ **Armadilha já apanhada uma vez:** o auditor lê o inventário de
> `git ls-files --cached`. Procedimento correcto:
> `git add -A && npm run audit:code:json && git add -A`.

---

## 13. Confirmação de segurança

**ZERO** writes · **ZERO** migrations · **ZERO** credenciais · **ZERO** produção ·
**ZERO** alterações a `fixed_variable_payments` · **ZERO** T12 · **ZERO** T13 ·
**ZERO** UI nova · **ZERO** alterações de dependências.
