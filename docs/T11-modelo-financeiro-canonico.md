# T11 — Modelo financeiro canónico: valores, IVA e avenças

> ## 🚨 AVISO DE INTEGRIDADE DE DADOS FINANCEIROS
>
> **Já houve uma regressão de dados na área financeira.** Pagamentos VARIÁVEIS
> deixaram de aparecer e as datas dos pagamentos FIXOS ficaram iguais. A causa
> ainda **não** está determinada: pode ser perda, sobrescrita, clonagem errada,
> query ou UI.
>
> **Nada nesta task repara dados.** A T11 é inteiramente offline: funções puras,
> fixtures sintéticas, testes e análise estática. Não houve um único `UPDATE`,
> `DELETE`, `INSERT`, `UPSERT`, migration, backfill ou acesso ao Supabase.
> `fixed_variable_payments` não foi tocada. Junho/2026 não foi tocado.
>
> Qualquer alteração financeira futura — e em especial a que ligar estes módulos
> aos ecrãs reais — tem de provar **BEFORE = AFTER** para tudo o que não fizer
> parte explícita da alteração autorizada. Ver §12.

---

## 1. O problema, medido

O plano mestre (§32) descreve o sintoma: *"o mesmo contrato pode apresentar
valor diferente no calendário, no relatório, na cobrança e na fatura"*. A
auditoria desta task encontrou **quatro implementações independentes** da mesma
regra de avença, e nenhuma concorda com as outras.

| Local | Fórmula da avença | Arredondamento | Denominador |
|---|---|---|---|
| `daily-billing.ts` `toRow` (~166) | `fixed_price / count` | `round2` **por serviço** | consulta dedicada ao mês inteiro |
| `daily-billing.ts` `computeServiceBillingValue` (~258) | idem — **segunda cópia** | `round2` por serviço | consulta dedicada ao mês inteiro |
| `financial-dashboard.ts` `valueOf` (~161) | `fixed_price / count`, logo × `(1+IVA)` | só no fim, após acumular | **serviços já em memória** |
| `reports.ts` faturação diária (~315) | `fixed_price / count` | só no fim, por dia | serviços do intervalo do ecrã |
| `invoices.ts` (~232) | **não divide** — linha única mensal | `round2` sobre a base somada | não aplicável |

Três defeitos concretos saem daqui.

### 1.1 Cêntimos perdidos, todos os meses

`daily-billing` arredonda a quota de **cada** serviço. Uma avença de 100,00 €
com 3 ocorrências dá 33,33 € × 3 = **99,99 €**. Falta um cêntimo, sempre, e
ninguém o vê porque cada linha está certa.

### 1.2 Denominadores diferentes para o mesmo mês

`daily-billing` conta os serviços do mês com uma consulta dedicada. O
`financial-dashboard` conta apenas os serviços que **já tinha em memória** — e
a janela que carrega é `semana ∪ mês`. Numa semana a cavalo de dois meses, essa
janela **não cobre o mês inteiro**: o denominador fica menor e o valor por
serviço fica **inflacionado**. O mesmo serviço vale mais no Dashboard do que na
Cobrança Diária, no mesmo dia, sem nada de errado nos dados.

### 1.3 Realizado ≠ Faturado, e ninguém dizia porquê

Três ecrãs dividem a avença pelas ocorrências. A fatura não divide: emite uma
linha mensal inteira. Somar o "realizado" do mês **nunca** dá o faturado. As
duas grandezas são legitimamente diferentes — o erro era chamarem-se ambas
"receita" e aparecerem lado a lado sem explicação.

### 1.4 Divergência entre `calculateServiceValue` e `projectValue`

Encontrada nesta auditoria, **não corrigida de propósito**. As duas funções que
decidem o valor de um serviço têm prioridades diferentes:

```
src/lib/service-value.ts       manual → estofos → avença(0) → preço fixo → hora
occurrence-projection.ts (T09) avença(0) → preço fixo → estofos → hora
```

Um contrato com `fixed_price = 200` **e** `upholstery_units = 3 × 25` vale
**75 €** pela UI e **200 €** pelo cron. Fixado em teste
(`billing-boundaries.test.ts`). Corrigir muda valores de serviços reais em
qualquer das duas direcções, e a T11 é offline — a decisão é do Financeiro V2.

---

## 2. O que a T11 entrega

Cinco módulos puros em `src/domain/billing/`. Nenhum está ligado a um ecrã.

| Módulo | Responsabilidade |
|---|---|
| `money.ts` | Cêntimos inteiros, conversão, política de arredondamento |
| `vat.ts` | IVA canónico: `net + vat = gross`, sempre |
| `monthly-allocation.ts` | Distribuição da avença, determinística, sem perder cêntimos |
| `financial-model.ts` | Os nove conceitos + read model para a futura UI |
| `consumer-parity.ts` | Selectores que provam que os quatro ecrãs concordam |
| `legacy-formulas.ts` | As fórmulas antigas capturadas, só para comparação |
| `billing-compat.ts` | Comparador legacy × canónico sobre fixtures |

---

## 3. Regra de cêntimos

Dinheiro é `MoneyCents` — inteiro, com marca de tipo em tempo de compilação.

**Política de arredondamento única: half-up sobre o valor decimal**, aplicada
uma só vez, à entrada. Escolhida por reproduzir o comportamento actual seguro
(`Math.round(x * 100) / 100` é half-up para positivos), com duas correcções:

- **negativos** arredondam *away from zero*, para que um estorno de −0,005 € dê
  −0,01 € e não 0;
- **`Number.EPSILON`** compensa o caso `59.985`, cujo binário fica abaixo do
  ponto médio e que `toFixed(2)` arredonda para `59.98` contra a intuição de
  quem escreveu o valor.

A partir da conversão, toda a aritmética é inteira e exacta. Nenhum
arredondamento intermédio.

### `null` ≠ `0`

`eurosToCents(null)` devolve `null`. "Não há base para calcular" e "custa zero
euros" são coisas diferentes e continuam distinguíveis em todo o modelo — a
mesma distinção que a T09 já tinha fixado para a avença.

---

## 4. Avença: distribuição determinística

```
base    = trunc(|total| / count)
resto   = |total| % count
as primeiras `resto` posições da ORDEM CANÓNICA levam +1 cêntimo
```

100,00 € em 3 → **33,34 / 33,33 / 33,33**. Soma: 100,00 €. Exacto, por
construção, para qualquer total e qualquer contagem.

**Invariante, sem excepções:**

```
outcome === "ALLOCATED"  ⟹  sum(allocations) === totalCents
```

### Ordem canónica

`occurrence_date`, e em empate `id`. **Nunca** `created_at`, nunca a ordem em
que a consulta devolveu as linhas, nunca a posição no array. Se a ordem de
chegada mudasse, o resto da divisão mudaria de ocorrência e o mesmo mês passaria
a mostrar números diferentes sem nada ter mudado nos dados.

Datas inválidas vão para o fim da ordem, contadas em `invalidDateCount`, em vez
de rebentar a alocação inteira — um `starts_on` corrompido já aconteceu em
produção (ver `safeFormat` em `src/lib/utils.ts`).

### Sem ocorrências

Valor mensal > 0 e zero ocorrências elegíveis **não divide por zero e não
inventa receita**. Devolve `UNALLOCATED_NO_OCCURRENCES` e expõe o montante em
`unallocatedCents` — dinheiro contratado que não deve aparecer como realizado,
mas também não deve desaparecer sem rasto.

O comportamento antigo era `Math.max(1, count)`: com zero ocorrências, o mês
inteiro colava-se a **uma única linha**. É o pior caso medido pelo comparador.

### Elegibilidade — decisão de quem chama

O módulo **recebe** o conjunto elegível. Não decide se uma falta conta, se um
cancelamento conta, se só o concluído conta. Isso é decisão de produto, muda
conforme o ecrã, e não pode viver escondida dentro de um helper.
`consumer-parity.ts` oferece `SCHEDULED` e `PERFORMED` como políticas
explícitas, reproduzindo o comportamento actual (uma falta continua a ocupar a
agenda e continua a ser cobrada).

### Proporcionalidade — **STANDBY**

`PRORATED` existe no tipo e **lança um erro** se for usada. A regra real para
contratos iniciados ou terminados a meio do mês (por dias de calendário? por
ocorrências previstas? conta o dia de início?) é uma decisão de negócio que
ainda não foi tomada. Inventar uma seria mudar facturação real com base num
palpite. `FULL_MONTH` é o comportamento actual e o único implementado.

---

## 5. IVA canónico

Uma função, três parcelas, invariante fechada:

```
net + vat = gross     (sempre, exactamente, em cêntimos inteiros)
```

Arredonda **uma única vez**, sobre o imposto, e deriva o gross por soma inteira.
É isso que garante a invariante mesmo quando a taxa produz meios cêntimos
(0,01 € a 23% = 0,0023 € → 0 cêntimos de imposto, e o gross continua 0,01 €).

**A taxa nunca está fixa em código.** Vem de `company_settings.vat_rate` através
de quem chama. As fixtures usam 23% por ser a taxa portuguesa corrente. Uma
guarda estática falha se aparecer um `* 1.23` literal (§8).

**Cliente isento anula o `apply_vat` da linha** — é o comportamento actual de
`generateInvoices`, e a regra fiscal é do cliente, não do serviço.

### Soma de linhas, não linha da soma

`sumVatBreakdowns` soma os IVAs **já arredondados por linha**, não o IVA da base
somada. As duas contas diferem em cêntimos, e esta é a que a fatura tem de usar:
o cliente vê as linhas, e as linhas têm de somar exactamente o rodapé.

---

## 6. Os nove conceitos

| Conceito | Definição | Fonte |
|---|---|---|
| **Contratado** | valor previsto pelo contrato | `contracts` |
| **Agendado** | valor das ocorrências planeadas | `services` não cancelados |
| **Realizado** | valor do trabalho efectivamente feito | `services` concluídos |
| **Faturado** | valor emitido em fatura | `invoices` / `invoice_items` |
| **Recebido** | dinheiro reconhecido em caixa | `cash_flow_entries` |
| **Em aberto** | faturado − recebido | derivado |
| **Vencido** | em aberto cujo vencimento passou | `invoices` |
| **Custo** | despesa e folha reconhecidas | `payroll_records`, caixa |
| **Margem** | receita definida − custos definidos | derivado |

**Regras que fecham a ambiguidade:**

- não chamar "realizado" a receita recebida;
- não chamar "faturado" a recebido;
- não usar `services.payment_status` como substituto de fatura/pagamento quando
  não representa a mesma coisa;
- **a base da margem é explícita** (`performed` | `invoiced` | `received`) —
  a escolha muda o número, e cada ecrã tinha feito a sua em silêncio.

Cada montante (`FinancialAmount`) traz `cents`, `origin` e `completeness`. Nunca
um `number` solto: foi a falta de contexto que permitiu somar realizado com
faturado. `completeness: "UNAVAILABLE"` implica `cents: null` — nunca 0.

---

## 7. Read model — reserva para a nova UI

**A imagem da nova UI ainda não chegou. Nada de UI foi implementado, alterado ou
removido nesta task.**

`FinancialReadModel` é o contrato que a futura interface vai receber.

> **REGRA: a UI não calcula dinheiro.** Não divide, não multiplica por 1,23, não
> arredonda. Recebe cêntimos já decididos e formata. Qualquer componente que
> precise de um número que não esteja no read model é sinal de que **falta um
> campo no contrato** — não de que o componente deve fazer a conta.

`consumer-parity.ts` demonstra a forma final: uma `MonthlyBillingView`, quatro
selectores que apenas escolhem o que mostrar. Nenhum faz aritmética.

O que a paridade afirma: sobre o mesmo conjunto elegível, **a soma fecha sempre
no valor do contrato**. O que **não** afirma: que o valor de um dia na Cobrança
Diária é igual ao de um dia nos Relatórios — não é, e não deve ser, porque um
divide o agendado e o outro o realizado.

---

## 8. Compatibilidade medida

`scripts/compare-billing-compat.ts` — offline, fixtures sintéticas, nunca liga
ao Supabase, nunca lê credenciais, recusa flags de escrita.

```bash
npx tsx scripts/compare-billing-compat.ts
npx tsx scripts/compare-billing-compat.ts --vat 6 --out tmp/t11-relatorio.json
```

**Matriz padrão (7 valores × 9 contagens × com/sem IVA = 126 casos, IVA 23%):**

| | Casos | Divergentes |
|---|---|---|
| Matriz completa | 126 | **89** |
| Excluindo contagem 0 | 112 | **75** |

**Desvio acumulado face ao canónico, excluindo os casos de contagem 0:**

| Consumidor | Desvio |
|---|---|
| Cobrança Diária | **−0,74 €** (perde cêntimos) |
| Relatórios | 0,00 € (acumula antes de arredondar) |
| Dashboard (c/ IVA) | **−0,36 €** |

Pior caso isolado: `99,99 € ÷ 31` → **0,14 €** de desvio.

**Os casos de contagem 0 dominam o total** e por isso estão separados: o
comportamento antigo (`Math.max(1, count)`) cola o mês inteiro numa linha, o que
num caso de 1000 € com IVA dá **1230,00 €** de diferença. Não é arredondamento —
é receita inventada.

**Razões encontradas:**

| Razão | Ocorrências |
|---|---|
| `CENTS_LOST_IN_SPLIT` | 84 |
| `CONSUMERS_DISAGREE` | 72 |
| `VAT_ROUNDING_ORDER` | 41 |
| `NO_OCCURRENCES_FALLBACK` | 14 |

> ⚠️ **Estes números são de fixtures sintéticas.** Não há estimativa de impacto
> em euros reais, e não deve haver: exigiria ler contratos e serviços de
> produção, o que esta task não faz. O impacto real fica para o diagnóstico
> read-only, que é uma frente separada.

---

## 9. Guarda contra regressões

`src/__tests__/billing-adhoc-guard.test.ts` congela o inventário dos sítios que
hoje fazem a conta à mão, com o número exacto de ocorrências por ficheiro.

- ficheiro **novo** com um dos padrões → falha;
- ficheiro conhecido que **ganhe** ocorrências → falha;
- ocorrências **removidas** (objectivo do Financeiro V2) → passa, e a mensagem
  diz para actualizar o inventário.

Três padrões concretos, cada um ligado a um defeito medido — `AVENCA_SPLIT`,
`VAT_INLINE_FACTOR`, `VAT_RATE_DIVISION` — mais um que proíbe `* 1.23` literal.
**Não** há regex genérica a tentar detectar "qualquer conta com dinheiro": daria
falsos positivos em barras de progresso e durações, e seria desligada na
primeira semana.

> Nota: a primeira versão de `VAT_INLINE_FACTOR` só apanhava `vatRate` e deixava
> passar o `vatRatePct` do próprio `withVat`. A guarda detectou o buraco na
> primeira execução, através da verificação "o inventário corresponde à
> realidade". O padrão foi alargado.

---

## 10. Auditoria de `calculations.ts`

| Função | Classificação | Nota |
|---|---|---|
| `haversineDistanceM` | **canónico** | usado por `/api/app/timesheet`. Não é dinheiro. |
| `isValidCoord` | **canónico** | validação de GPS. |
| `calcMonthlyGross` | **legado** | folha usa `payroll.ts`; esta versão usa `toFixed`. |
| `calcServiceValue` | **morto** | sem consumidor. Duplica a via horária de `calculateServiceValue`, com `parseFloat(toFixed(2))` em vez de `round2`. |

**Nada foi removido.** `calcServiceValue` já estava assinalado como sem
consumidor na T09 e a decisão foi deixá-lo onde está. Manter a mesma decisão
aqui evita misturar limpeza de código morto com modelo financeiro; a remoção é
candidata para o Financeiro V2, depois de confirmar que não há consumidor
dinâmico.

---

## 11. Fronteiras entre módulos

```
T09  contrato ──────────────────────► valor de UMA ocorrência
     (occurrence-projection.ts)        projectValue / upholsteryTotal

T11  ocorrências + contrato ────────► agregação, distribuição, classificação
     (domain/billing/*)                allocate / applyVat / summary
```

**A T11 nunca recalcula scheduling e nunca inventa um terceiro valor de
serviço.** A regra de estofos da T09 (`upholstery_units × upholstery_unit_price`)
mantém-se intacta e está fixada em teste; a T11 não cria outra fórmula, e o
campo `unit_value` — que só existia no formulário e nunca foi coluna — continua
a não existir.

`src/lib/service-value.ts` mantém-se como fonte do valor base do serviço não
mensal, como o plano mestre exige. Não foi criada nenhuma função concorrente
para o mesmo conceito.

---

## 12. Regra de preservação para o Financeiro V2

Antes de qualquer alteração que toque em dados, capturar a baseline:

```
COUNT total · COUNT fixos · COUNT variáveis · COUNT por período
MIN/MAX due_date por período · SUM(amount) por período e tipo
conjunto de ids · conjunto de source_id
```

Depois comparar. **Nenhuma linha existente pode desaparecer, mudar de tipo,
data, valor, origem ou período sem fazer parte explícita da alteração
autorizada.** Uma única invariante inesperada a mudar → **ROLLBACK / ABORT**.

---

## 13. Standby

Fica para depois, com a razão:

| Item | Porquê |
|---|---|
| **Ligar os consumidores** (daily-billing, reports, dashboard, invoices) | muda números apresentados; exige BEFORE × AFTER com dados reais |
| **Política `PRORATED`** | decisão de negócio por tomar |
| **Divergência `calculateServiceValue` × `projectValue`** (§1.4) | qualquer correcção muda valores de serviços reais |
| **Notas de crédito / negativos** | a aritmética suporta-os; o produto ainda não tem semântica definida |
| **Remoção de `calcServiceValue`** | limpeza de código morto, domínio diferente |
| **Nova UI Financeiro** | aguarda a imagem do proprietário |
| **Reparação de pagamentos** | aguarda o diagnóstico read-only |
| **`vat_rate` por linha de fatura** | hoje é global por empresa; mudar exige schema |

---

## 14. Riscos

- **Ligar os consumidores muda relatórios antigos.** Um mês que mostrava 99,99 €
  passará a mostrar 100,00 €. É a correcção certa, mas é uma mudança visível em
  números que alguém já leu. Deve entrar com o comparador na mão.
- **`sumVatBreakdowns` pode diferir do IVA que a fatura já gravou.** Faturas
  emitidas usaram "IVA da base somada"; o canónico usa "soma dos IVAs por linha".
  Faturas existentes **não devem ser recalculadas** — só as novas.
- **A guarda estática só cobre três padrões.** Uma quarta forma de fazer a conta
  à mão passaria despercebida. É o preço de não ter falsos positivos.
- **A alocação é sensível ao conjunto elegível.** Se o Financeiro V2 mudar a
  política (ex.: falta deixa de contar), o valor por dia muda para todos os
  contratos de avença. É decisão de produto, e tem de ser tomada explicitamente.

---

## 15. SQL

**Zero.** Esta task não criou nenhuma migration, não usou `supabase/frozen/` e
não alterou `supabase/migrations/`. A migration 070 continua por aplicar, tal
como estava. Nenhuma garantia estrutural nova se revelou necessária para o
modelo financeiro puro.
