# Incidente — materialização implícita de mês em Pagamentos

- **Data do evento:** 2026-08-03
- **Data do diagnóstico:** 2026-08-11
- **Estado:** `INCIDENT_CAUSE_CONFIRMED`
- **Contenção:** PR C — `fix/payments-stop-implicit-materialization`
- **Reparação de Agosto:** `AUGUST_REPAIR = PENDING_READ_ONLY_MANIFEST`
- **Correção do modelo:** por fazer — ver §6

> Este documento não contém identificadores reais, valores, nomes de
> fornecedores nem credenciais. Descreve o mecanismo, não os dados.

---

## 1. O que se viu

Duas queixas, dias separados, aparentemente sem relação:

1. **«Os pagamentos variáveis desapareceram.»**
2. **«As datas dos pagamentos fixos ficaram todas iguais.»**

A primeira parecia perda de dados. A segunda parecia um defeito de
apresentação. Nenhuma das duas leituras estava certa, e ambas têm a mesma
causa.

## 2. A causa

`getPayments(year, month)` — uma função com nome de leitura — chamava
`ensureMonth`, que clonava para o mês pedido todos os pagamentos **fixos** do
mês anterior mais recente, e inseria-os.

```
abrir a página  →  getPayments  →  ensureMonth  →  insert
mudar de mês    →  getPayments  →  ensureMonth  →  insert
```

`getPaymentsReminder`, que alimenta o banner do **Dashboard**, fazia o mesmo
para o mês corrente. Esse caminho era ainda mais largo: bastava um admin ou
gestor entrar na aplicação depois do login.

Nenhum dos dois exigia um clique. **Ler escrevia.**

## 3. A evidência

Da cópia local dos dados, sem acesso à base:

| Momento | Facto |
|---|---|
| `2026-08-03T11:56:02` | Os **15** pagamentos fixos de Agosto criados **no mesmo segundo**, todos com `source_id` preenchido |
| `2026-08-07T10:19:54` | O **primeiro** pagamento variável de Agosto — quatro dias depois, inseridos um por minuto |

O carimbo idêntico ao segundo e o `source_id` em todas as linhas identificam
um único `insert` em lote — não trabalho humano. Os variáveis, esses, têm o
espaçamento irregular de quem escreve à mão.

### Sintoma 1 — os variáveis «desapareceram»

Entre 03/08 11:56 e 07/08 10:19, Agosto tinha 15 fixos e **zero** variáveis.

`ensureMonth` nunca clona variáveis — por desenho, e bem: um gasto pontual de
Julho não é um gasto de Agosto. Mas o mês foi materializado **por leitura**, e
apresentou-se como se estivesse completo. Quem o abriu viu um mês com metade
das linhas e concluiu, com razão, que faltava lá alguma coisa.

**Nada foi apagado.** O mês foi inventado incompleto.

### Sintoma 2 — as datas ficaram iguais

Este é perda de informação real, e não é cosmético.

```
AGOSTO       ←  JULHO (linha de origem)
2026-08-03   ←  2026-11-03     ← mês alterado
2026-08-03   ←  2027-05-03     ← mês alterado
2026-08-03   ←  2027-02-03     ← mês alterado
2026-08-03   ←  2026-08-03
```

`shiftDate` guarda o dia e força o mês de destino. Para um pagamento mensal
está certo. Quatro daqueles pagamentos eram **trimestrais** — venciam-se a
03/08, 03/11, 03/02 e 03/05 — e foram todos gravados como **03/08**.

A função não fez nada de errado em relação ao que sabia. O modelo de dados
**não tem periodicidade**: não há como distinguir mensal de trimestral, e a
função assumiu mensal para tudo.

Contribuiu ainda a apresentação: `fmtDate` mostra dia e mês, sem ano. Duas
datas com anos diferentes apareciam iguais no ecrã.

## 4. O que a PR C fez

Contenção, e só contenção.

| Antes | Depois |
|---|---|
| `getPayments` → `ensureMonth` → `insert` | leitura pura |
| `getPaymentsReminder` → `ensureMonth` → `insert` | leitura pura |
| `PAYMENTS_PAGE_PREEXISTING_AUTO_WRITE = 1` | `= 0` |
| `DASHBOARD_PREEXISTING_AUTO_WRITE = 1` | `= 0` |
| `AUTO_WRITE_ON_RENDER_ALLOWED` com 1 entrada | `{}` |

`ensureMonth` e `shiftDate` saíram de `payments.ts` para
`src/lib/payments-month-materialization.ts`, em quarentena: preservadas,
documentadas, e provadamente não importadas por ninguém. Não foram apagadas
porque repetir pagamentos recorrentes é uma necessidade real do negócio — o que
não pode voltar é esta versão, ligada a um caminho de leitura.

Não foram exportadas de `payments.ts` de propósito: num módulo `"use server"`,
cada export torna-se uma server action que o browser pode invocar por RPC.

**Um mês vazio passa a dizer que está vazio.** Não se mostram KPIs a `0,00 €`
num mês sem linhas: ausência de dados não é ausência de despesa, e a leitura
contrária é a mais cara possível.

**Não foi acrescentado nenhum botão de «Gerar mês».** Seria a substituição
óbvia, e produziria exactamente as mesmas datas erradas — só que com o
consentimento de quem carregasse.

## 5. O que a PR C não fez

- **Não reparou Agosto.** As linhas com data esmagada continuam como estão.
- **Não tocou em nenhum `due_date` nem em nenhum `source_id`.**
- **Não gerou Setembro** nem nenhum outro mês.
- **Não corrigiu `shiftDate`.** Corrigi-la sem periodicidade no modelo seria
  trocar uma suposição errada por outra.
- **Não executou SQL, migration nem nada contra a base.**

### `AUGUST_REPAIR = PENDING_READ_ONLY_MANIFEST`

A informação perdida **é recuperável**: cada linha de Agosto tem `source_id`
a apontar para a linha de Julho que lhe deu origem, e essa conserva a data
verdadeira.

O próximo passo é um **manifesto só de leitura** — cada filho de Agosto ao lado
do respectivo pai de Julho, com a data actual e a data proposta — para revisão
humana. Só depois, e com autorização explícita e separada, os `UPDATE`
dessas linhas, numa transacção.

Não se repara nada por inferência automática.

## 6. A correção do modelo (proposta, por decidir)

O defeito de fundo é que **a periodicidade não existe no modelo**.

```sql
-- proposta, não aplicada
ALTER TABLE fixed_variable_payments
  ADD COLUMN recurrence_interval_months smallint,  -- 1 mensal, 3 trimestral, 12 anual
  ADD COLUMN recurrence_anchor_date     date;      -- a data de referência real
```

Com estes dois campos, repetir um pagamento passa a ser aritmética sobre a
âncora, e não uma deslocação cega do mês.

### `LEGACY_RECURRENCE_UNKNOWN = não inferir automaticamente`

As linhas que já existem não têm periodicidade. **Não deve ser adivinhada.**

Poderia parecer seguro deduzi-la do histórico — «esta descrição aparece de três
em três meses, logo é trimestral». Não é: foi precisamente uma suposição
plausível sobre um dado em falta que causou este incidente. Uma segunda
suposição, agora aplicada a toda a base, seria o mesmo erro em escala maior.

As linhas antigas ficam marcadas como desconhecidas, e são **perguntadas** —
uma vez, ao dono — não deduzidas.

Além disso, quando a geração voltar:

- é um **acto explícito do utilizador**, nunca um efeito de render;
- mostra o que vai criar **antes** de criar;
- não corre sobre meses que já tenham linhas.

## 7. O que este incidente ensinou sobre as guardas

Ao escrever os testes desta PR, um teste de mutação — reintroduzir o defeito de
propósito e confirmar que a guarda o apanha — mostrou que **três guardas
passavam na mesma** se a escrita fosse movida para outro ficheiro e importada
de volta:

```ts
import { ensureMonth } from "@/lib/…";
export async function getPayments() { await ensureMonth(…); … }
```

O detector seguia delegação apenas **dentro** do mesmo ficheiro. Um `insert` a
um import de distância era invisível.

É a mesma família de erro que este projecto já apanhou várias vezes:
**reconhecer só o caminho conhecido dá um «seguro» falso** — e um falso seguro
é pior do que guarda nenhuma, porque dispensa quem lê de olhar.

`createWriteCapabilityResolver` passou a seguir imports locais. Ao fazê-lo,
descobriu de imediato uma capacidade de escrita real que nunca tinha estado
inventariada: `recalcSuggestions` → `generateSuggestions` → `upsert`, na
conciliação bancária. Não é capacidade nova; era capacidade invisível.

---

## Anexo — cronologia

| Data | O quê |
|---|---|
| 2026-08-03 | Mês de Agosto materializado por leitura; 4 datas trimestrais esmagadas |
| 2026-08-07 | Primeiros variáveis de Agosto lançados à mão |
| 2026-08-11 | Diagnóstico fechado a partir da cópia local; causa confirmada |
| 2026-08-11 | PR C — contenção: ler deixa de escrever |
| — | Manifesto de reparação de Agosto (só leitura) |
| — | Reparação de Agosto, com autorização separada |
| — | `recurrence_interval_months` / `recurrence_anchor_date` |
