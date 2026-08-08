# Pipeline financeiro canónico — T11 → T14 → T15

> Contrato entre as três camadas de leitura financeira. Escrito depois da
> **revisão de fecho** de 2026-08-08, que percorreu as três de ponta a ponta.
>
> Este documento não substitui `docs/T11-modelo-financeiro-canonico.md`,
> `docs/T14-relatorios-read-model.md` nem
> `docs/T15-dashboard-financeiro-canonico.md`. Diz o que cada camada **pode** e
> **não pode** fazer, e onde é a fronteira.

---

## 0. 🚨 AVISO DE INTEGRIDADE DE DADOS FINANCEIROS

A regressão de pagamentos (variáveis desaparecidos, datas dos fixos iguais)
**continua sem diagnóstico**. Ver §0 e §5 de `docs/HANDOFF-2026-08-07.md`.

**Nenhuma das três camadas escreve.** Todas são puras: sem Supabase, sem
`.env`, sem rede, sem relógio. Provado por guardas estáticas em
`billing-adhoc-guard`, `reports-adhoc-guard` e `dashboard-adhoc-guard`.

---

## 1. O fluxo

```
linhas da base (carregador, na fronteira)
        │   converte UMA vez: timestamp → dia civil de Lisboa
        │                     euros     → MoneyCents
        ▼
T11  src/domain/billing/      SIGNIFICADO
        │   money · vat · monthly-allocation · financial-model
        ▼
T14  src/domain/reports/      AGREGAÇÃO POR PERÍODO
        │   period · integrity · report-read-model
        ▼
T15  src/domain/dashboard/    APRESENTAÇÃO SEMÂNTICA
        │   period-selection · comparison · projection · dashboard-read-model
        ▼
futura UI                     FORMATA. Não calcula.
```

**Dependências verificadas** (análise estática, revisão de fecho):

```
dashboard → reports  (9)      reports → billing  (8)
dashboard → billing  (7)      reports → scheduling (3)
dashboard → scheduling (2)    billing → scheduling (3)
```

**Zero inversões.** Nenhuma camada baixa importa uma camada alta.

Fora de `src/domain`, os únicos consumidores são **testes**. Nada está ligado a
runtime.

---

## 2. Responsabilidades

### T11 — `src/domain/billing/`

**PODE:** definir o que é dinheiro (`MoneyCents`) · arredondar (uma vez, à
entrada) · calcular IVA (`applyVat`, `extractVatFromGross`) · distribuir a
avença (`allocateMonthlyAmount`) · derivar `outstanding` e `margin` · declarar
os nove conceitos e as suas origens.

**NÃO PODE:** conhecer períodos de relatório · saber que fontes existem ·
decidir que ecrã mostra o quê.

**É a única camada que faz aritmética de dinheiro.**

### T14 — `src/domain/reports/`

**PODE:** definir períodos civis e interseção · classificar fontes e
integridade · agregar por janela · aplicar os helpers da T11 a valores já
decididos · contar serviços, horas e ausências.

**NÃO PODE:** inventar uma fórmula de dinheiro · assumir uma taxa de IVA ·
transformar erro de consulta em zero · decidir apresentação.

**É a única camada que decide o que entra num período.**

### T15 — `src/domain/dashboard/`

**PODE:** escolher que cartões existem · rotular · comparar períodos · ordenar
clientes · projectar · compor a saúde dos dados.

**NÃO PODE:** somar, dividir, multiplicar ou arredondar dinheiro · importar
`vat` ou `monthly-allocation` para calcular · ler o relógio · alterar um
`FinancialAmount`.

**Prova estrutural:** os 11 KPIs da `DashboardFinancialView` são a **mesma
referência de objecto** dos montantes do relatório da T14 — verificado por teste
com `toBe` (identidade, não igualdade). A T15 não reconstrói nenhum montante.

---

## 3. Os onze conceitos, camada a camada

| Conceito | Fonte | T11 | T14 | T15 |
|---|---|---|---|---|
| `contracted` | `contracts` | declara origem `contract` | soma mensalidades dos meses tocados (FULL_MONTH) | cartão + comparação **snapshot** |
| `scheduled` | `services` ≠ cancelado | aloca a avença | soma com IVA por linha | cartão + série diária |
| `performed` | `services` concluídos | aloca a avença | idem, só concluídos | cartão + série |
| `invoiced` | `invoices` | — | exclui `rascunho` e `cancelado` | cartão (legado chama-lhe "Receita") |
| `received` | `cash_flow_entries` | — | `entrada` + `confirmado` | cartão |
| `outstanding` | derivado | `computeOutstanding` | propaga | cartão **snapshot** |
| `overdue` | `invoices` | — | `due_date < asOf`, não pago | cartão **snapshot** |
| `expenses` | `cash_flow_entries` | — | `saida` confirmada, **excl. `salario`** | cartão + série (aditivo) |
| `payroll` | `payroll_records` | — | por `period_year`/`period_month` | cartão **snapshot** |
| `cost` | derivado | — | `payroll + expenses` | cartão **snapshot** |
| `margin` | derivado | `computeMargin` c/ base | propaga com `marginBasis` | cartão + `marginPercent` tipada |

**Nenhum conceito muda de significado ao mudar de camada.** Verificado por teste
para os onze.

---

## 4. As invariantes

### 4.1 Dinheiro é sempre inteiro

`MoneyCents` é um `number` com marca de tipo. Entra na fronteira via
`eurosToCents`, sai na fronteira via `centsToEuros`/`formatCents`.

**Dentro do domínio não há vírgula flutuante.** Verificado ponta a ponta: todos
os KPIs, todos os pontos da série diária e mensal, e a decomposição de IVA são
`Number.isSafeInteger` ou `null`.

`as MoneyCents` só é legítimo em `money.ts` (os construtores da marca) e nos
comparadores. Qualquer outro sítio é uma via de escape que salta
`assertMoneyCents`.

### 4.2 `null` ≠ `0` ≠ `UNAVAILABLE`

| Estado | Significado | `cents` |
|---|---|---|
| `COMPLETE` + `0` | **aconteceu zero** | `0` |
| `PARTIAL` | parte da fonte em falta | valor parcial |
| `UNAVAILABLE` | **não há base para calcular** | `null` |

Uma consulta falhada **nunca** vira `0`. Verificado: o mês vazio e a fonte
falhada são distinguíveis em todas as camadas.

### 4.3 Falha degrada só o que dela depende

Caixa falhada →

```
received     UNAVAILABLE
outstanding  UNAVAILABLE   (herda)
margin       depende da base
invoiced     AVAILABLE     ← continua fiável
performed    AVAILABLE
contracted   AVAILABLE
relatório    PARTIAL       ← não FAILED
```

`FAILED` fica reservado para "nenhuma fonte pedida carregou". Degradar tudo por
uma fonte tornaria o aviso permanente, e um aviso permanente deixa de ser lido.

`NOT_REQUESTED` não degrada: um relatório operacional que nunca pediu a folha
não está avariado — está a responder a outra pergunta. O montante correspondente
fica `UNAVAILABLE`, o relatório continua `COMPLETE`.

### 4.4 Aditivo × snapshot

```
ADDITIVE_CONCEPTS      scheduled · performed · invoiced · received · expenses
NON_ADDITIVE_CONCEPTS  contracted · payroll · cost · overdue · outstanding
```

A soma dos dias fecha no mês para os aditivos (`checkDailyMonthlyParity`).

`contracted` e `payroll` são **mensais**: cada janela diária do mês vê o mesmo
registo, e somar 31 dias daria 31 mensalidades. `overdue` e `outstanding` são
**saldos num instante**, não fluxos.

> **`SNAPSHOT_KPIS` da T15 deriva de `NON_ADDITIVE_CONCEPTS` da T14** — não é
> uma cópia. Antes da revisão de fecho eram duas listas escritas à mão em
> ficheiros diferentes, com o mesmo conteúdo e mantidas em separado. Um teste
> verifica que as duas continuam a coincidir exactamente.

### 4.5 A percentagem é um tipo

| Situação | `PercentDelta.kind` |
|---|---|
| há base | `VALUE` |
| base 0, actual > 0 | `NOT_COMPARABLE` — **nunca `+∞%`** |
| ambos 0 | `UNCHANGED_ZERO` |
| falta um lado | `UNAVAILABLE` |

**Nunca devolve `NaN` nem `Infinity`.**

### 4.6 O IVA é calculado uma só vez

A T11 tem `applyVat` (base → parcelas) e `extractVatFromGross` (bruto → base),
com `net + vat = gross` fechada por construção.

A T14 **usa** o helper sobre valores já decididos — não é recálculo, é a
aplicação canónica. A T15 **não lhe toca**: recebe montantes já resolvidos. Uma
guarda estática impede o domínio do dashboard de importar `billing/vat`.

Uma taxa indisponível gera `VAT_RATE_UNAVAILABLE`. **Nunca 23% assumido.**

### 4.7 Datas

`CivilDate` (T07) é a representação única: `"YYYY-MM-DD"`, sem hora, sem fuso.
Aritmética em `Date.UTC`, imune a horário de verão.

Períodos são **fechados dos dois lados**: `{start: "2026-08-01", end:
"2026-08-31"}` é agosto inteiro, 31 dias.

A semana é de **segunda a domingo**, pela mesma `startOfWeek` que o motor de
recorrência da T07 usa.

O domínio **nunca lê o relógio**. `todayCivilDate`, `asOf`, `generatedAt` e
`freshestSourceAt` vêm todos de fora, para que um relatório de um mês passado
seja reproduzível tal como era. Verificado por guarda estática: zero
`new Date()`/`Date.now()` em `billing`, `reports` e `dashboard`.

---

## 5. Módulos legacy

`legacy-formulas.ts` (T11) · `legacy-reports.ts` (T14) · `legacy-dashboard.ts`
(T15) reproduzem as fórmulas antigas **sem as alterar**, para os comparadores
poderem medir a diferença.

**Consumidores verificados:** só os comparadores do próprio domínio e os testes.
Nenhum código de aplicação os importa. Nenhum é reexportado por barrel.

As guardas anti-ad-hoc isentam-nos **por ficheiro**, nunca por pasta — o resto
de cada domínio continua a ser varrido.

---

## 6. Comparadores

```bash
npx tsx scripts/compare-billing-compat.ts     # 126 casos · 89 divergentes
npx tsx scripts/compare-reports-compat.ts     #  17 casos · 17 divergentes
npx tsx scripts/compare-dashboard-compat.ts   #  15 casos · 14 divergentes
```

Todos offline, fixtures sintéticas, `assertNoWriteFlags`, sem Supabase.

> ⚠️ **Os três medem coisas diferentes e os seus números NÃO se somam.** A T11
> mede desvio de cêntimos na avença; a T14, divergência de agregação; a T15,
> divergência de KPI. Juntá-los produziria um número sem significado.
>
> ⚠️ **Nenhum é estimativa de impacto real.** As fixtures são inventadas. Medir
> o impacto exigiria ler produção.

---

## 7. Bloqueios que atravessam as três camadas

| # | Bloqueio | Estado |
|---|---|---|
| 1 | **`PRORATED`** | lança se pedido; nenhum caller o passa. `FULL_MONTH` por omissão |
| 2 | **Estofos × `fixed_price`** | 75 € pela UI, 200 € pelo cron. Nenhum domínio novo arbitra — o valor chega já decidido em `ServiceInput.valueCents` |
| 3 | **Método de projeção** | `CURRENT_PROJECTION_METHOD` fixo no legado, com teste |
| 4 | **`SERVICE_BASED`** | devolve `METHOD_IN_STANDBY` |
| 5 | **Base da margem do produto** | `invoiced` por omissão; qual o produto quer fica por decidir |
| 6 | **`vat_rate ?? 23`** | 6 ficheiros de aplicação, congelados por guarda. No domínio: obrigatória ou `UNAVAILABLE` |
| 7 | **Fuso do "mês atual"** | três relógios na aplicação; diagnosticado, não corrigido |
| 8 | **Nomes dos cartões** | "Receita", "Custos", "Margem Bruta", "Pendente a Receber" registados em `LEGACY_KPI_NAMING`; texto visível **não alterado** |

---

## 8. Como ligar isto ao Financeiro V2

1. escrever carregadores que devolvem `SourceResult` — **nunca** `const { data }`
   com o `error` ignorado;
2. resolver o dia de Lisboa **uma vez** (`todayInLisbon()`) e passar
   `todayCivilDate`;
3. converter euros → cêntimos **uma vez**, na fronteira;
4. carregar `monthlyOccurrences` do **mês inteiro** por avença — uma consulta por
   mês, nunca por serviço;
5. `buildReport` (mês, mês anterior, 12 meses) + `buildDailySeries`;
6. `buildDashboardView` **uma vez**;
7. a UI lê `view.kpis[…].amount.cents` e formata;
8. `view.health.trustworthy === false` → avisar **antes** de mostrar números;
9. cada cartão ligado prova **BEFORE = AFTER** antes de substituir o antigo.

**Qualquer componente que precise de um número fora do read model é sinal de que
falta um campo no contrato** — não de que o componente deve fazer a conta.

---

## 9. Testes que guardam este contrato

| Ficheiro | O que prova |
|---|---|
| `financeiro-pipeline.test.ts` | integração T11→T14→T15 de ponta a ponta |
| `billing-adhoc-guard.test.ts` | sem contas de dinheiro ad hoc |
| `reports-adhoc-guard.test.ts` | sem agregações ad hoc; domínio puro |
| `dashboard-adhoc-guard.test.ts` | sem cálculo no dashboard; **UI não tocada** |

O `financeiro-pipeline` cobre: fluxo completo · avença sem perder cêntimos ·
paridade diária/mensal · falha parcial granular · zero legítimo × indisponível ·
prejuízo que continua prejuízo · dinheiro sempre inteiro · identidade de
referência dos 11 KPIs · bloqueios fechados · períodos coerentes · IVA uma só
vez · determinismo.
