# Financeiro V2 — PR A · casca visual e navegação read-only

> **2026-08-11** · branch `feat/financeiro-v2-shell`, a partir de
> `fix/t17b3-action-query-errors` (`e5ef5df`).
>
> Constrói a **casca**. Não liga T11→T14→T15 a dados reais — isso é o PR B.

---

## 0. 🚨 Confirmação

**ZERO** base de dados · produção · credenciais · migrations · SQL ·
pagamentos alterados · `fixed_variable_payments` · `due_date`/`source_id` ·
carregador canónico · ligação de T11/T14/T15 a dados reais · T12 · T13 · T16.

**ZERO** alterações a `payments.ts`, `invoices.ts`, `daily-billing.ts`,
`src/domain/*`, `supabase/`, `scripts/` — verificado no diff.

**Nenhuma capacidade de escrita nova.** O que mudou foi **quem** dispara a que
já existia.

---

## 1. 🔴 Porque isto é o PR A e não o Financeiro V2 inteiro

Ao preparar a implementação, verificou-se que **nenhum ficheiro fora de testes
importa `src/domain/reports` ou `src/domain/dashboard`**. Não existe carregador
entre a base e o pipeline canónico — a "fronteira" do diagrama da arquitectura
nunca foi construída.

E a fonte actual do Resumo (`getFinancialDashboard`) dá
`currentMonthRevenue · currentMonthCosts · currentMonthMargin · pendingRevenue ·
monthly · byClient`. Ou seja, **hoje**:

| KPI da especificação | Existe na fonte? |
|---|---|
| Faturado | parcial — é faturado **bruto, com IVA e com rascunhos** |
| Recebido | ❌ **não existe** |
| Custos | ⚠️ é **só a folha** — exclui despesas, infla a margem |
| Margem | ⚠️ herda o erro dos dois lados |
| Em aberto | ❌ **não existe** |
| Série **diária** | ❌ só existe mensal |

> Não havia caminho de "renomear". Pôr a etiqueta **Custos** sobre um número que
> é só a folha seria exactamente a mentira que a auditoria da T15 documentou.

Por isso este PR **mantém os KPIs legados com os nomes legados**. Não se põe
vocabulário canónico sobre semântica legada. A casca fica pronta a receber.

---

## 2. Navegação — de dois sistemas para um

**Antes:** sete entradas na barra lateral **e** sete cartões de atalho no
Resumo. Dois caminhos para os mesmos destinos, que podiam discordar sobre o que
estava activo.

**Agora:**
- barra lateral: **um** item `Financeiro`;
- dentro do módulo: barra persistente com as sete vistas.

```
Resumo · Pagamentos · Contas · Fluxo de Caixa · Cobranças ·
Folha de Pagamento · Conciliação
```

Desktop numa linha; sem espaço, scroll horizontal discreto. No telemóvel a mesma
barra — **sem menu duplicado**.

**Nenhuma rota foi criada, apagada ou movida.** Cobranças e Folha de Pagamento
continuam fora de `/financeiro`: mudá-las por simetria de URL partiria ligações
e favoritos.

### ⚠️ Relatórios — uma entrada que ia ficar órfã

`/dashboard/relatorios` estava **dentro do grupo Financeiro** na barra lateral,
mas não é uma das sete vistas (dá horas, absentismo e serviços, além de
receita). Colapsar o grupo sem a promover deixá-la-ia sem entrada nenhuma.

**Foi promovida a item de topo da barra lateral.**

### Vocabulário

Mantido: `Pagamentos` · `Contas` · `Fluxo de Caixa` · `Cobranças` ·
`Folha de Pagamento` · `Conciliação`. Não se trocou "Cobranças" por "Faturas"
nem "Folha de Pagamento" por "Salários" — é o vocabulário de quem usa o produto
todos os dias.

---

## 3. Período — a URL é a fonte de verdade

`?mes=YYYY-MM`, resolvido por **um** helper: `src/lib/finance-period.ts`.

Sair do Resumo em Agosto e clicar em Fluxo de Caixa mantém Agosto. Acabou o
"Resumo em Agosto, Contas no mês corrente, Folha noutro".

| Regra | |
|---|---|
| Entrada inválida | degrada para o mês corrente. Nunca lança, nunca escreve |
| Mês por omissão | `todayInLisbon()`, **num só sítio** — não `new Date()` por página |
| Limites | 2020–2100, defensivos |
| Trocar de mês | `router.replace` — só muda a rota |

**As cinco páginas que decidiam o período pelo relógio deixaram de o fazer.** A
guarda `CLOCK_FOR_PERIOD` (da T15) baixou de `4/2/2/1/2` para **zero** em todas —
e fica a zero, por isso um `new Date().getMonth()` novo numa página financeira
faz o teste falhar.

---

## 4. 🔴 O render — o que é verdade e o que não é

```
NAVEGAÇÃO E VISUALIZAÇÃO SÃO READ-ONLY.
ESCRITA SÓ APÓS ACÇÃO EXPLÍCITA DO UTILIZADOR.
```

> ⚠️ **Correcção a uma afirmação anterior desta PR.** Uma versão inicial deste
> documento dizia que *"as sete vistas são read-only ao navegar"*. **É falso.**
>
> O cliquet do orçamento de escrita, ao ser reescrito, apanhou que
> `getPayments` chama `ensureMonth`, que faz `.insert(rows)` — **abrir um mês
> em Pagamentos gera os pagamentos fixos desse mês**, clonados do mês anterior
> mais recente.
>
> O correcto é:
>
> - a casca nova **não introduz** nenhuma mutação;
> - **seis** vistas usam o período global e são read-only ao navegar;
> - **Pagamentos tem auto-write anterior a esta PR**, agora explicitamente
>   inventariado;
> - esta PR **não o amplia** — pelo contrário, isola-o (§4.2);
> - a correcção definitiva está bloqueada pela E0.

`folha-pagamento/page.tsx` chamava `ensurePayrollCalculated` **durante o
render** — que delega em `runPayrollCalculation` e faz `.upsert(payroll_records)`
(`payroll.ts:201`). **Abrir a página gravava.**

Com navegação por abas, isso passaria a poder acontecer só por clicar numa aba
ou mudar de mês.

**Agora:** a página lê `getPayrollRecords` e, quando faltam registos, mostra um
aviso explícito:

> *Nenhuma folha calculada para Agosto 2026.*
> *Abrir esta página não calcula nada. Usa "Recalcular folha" quando quiseres gerar.*
> `[ Recalcular folha ]`

`calculateAndSavePayroll` passou a ser o **único** gatilho, accionado pelo botão
que já existia.

**O motor não foi tocado:** `runPayrollCalculation`, `calculateAndSavePayroll`,
`approvePayrollRecords`, `markPayrollPaid` e `adjustPayrollRecord` estão como
estavam. Nenhuma fórmula, nenhuma tabela.

### 4.2 🔴 Pagamentos — isolada do período global

A Folha pôde ser corrigida porque bastava retirar o gatilho. Em Pagamentos a
correcção vive dentro de `payments.ts` — `BLOQUEADO_INCIDENTE_FINANCEIRO`, o
próprio ficheiro sob diagnóstico. Mexer-lhe antes da evidência seria escrever
por cima do que se está a medir.

O período global tornaria o gatilho trivial: passar de Agosto para Setembro em
qualquer vista e clicar em Pagamentos materializaria Setembro, e cada clique nas
setas `‹ ›` faria o mesmo. **Esta PR criaria uma exposição que não existia.**

Regra temporária:

> **Pagamentos não participa no período global** até à E0 e à correcção de
> `getPayments`/`ensureMonth`.

Em concreto:
- a navegação do módulo leva Pagamentos **sem** `?mes`;
- a casca **não desenha** seletor nem setas nessa vista;
- o cabeçalho diz apenas *"Período gerido pela própria vista"*;
- o **seletor legado** da própria vista fica como estava — não é desta PR, e
  removê-lo tiraria a única forma de navegar meses ali.

### Período global por vista

```
Resumo ............... habilitado
Pagamentos ........... ISOLADO / BLOCKED_FINANCIAL_INCIDENT
Contas ............... habilitado
Fluxo de Caixa ....... habilitado
Cobranças ............ habilitado
Folha de Pagamento ... habilitado
Conciliação .......... habilitado
```

### 4.3 O cliquet que apanhou isto

`src/__tests__/financeiro-v2-write-budget.test.ts` — determinístico, **sem
git**. A versão anterior comparava com o ramo base e falhava no CI (checkout
com profundidade 1), pelo que o invariante nunca correu onde interessa.

`AUTO_WRITE_ON_RENDER_ALLOWED` tem **exactamente uma** excepção
(`getPayments` em `pagamentos/page.tsx`), sem wildcard e sem allowlist
genérica. Um teste falha se aparecer uma segunda.

---

## 5. Removido — e porque não se perdeu nada

| O quê | Onde | Natureza |
|---|---|---|
| **7 cartões de atalho** | Resumo (`financial-dashboard-client.tsx:463-547`) | `<Link>` — navegação pura |
| **Botão `Atualizar`** | Resumo | relia `getOperationalSummary`; o seletor recarrega |
| **`Ver cobranças →` / `Ver folha →`** | Contas | `<Link>` |
| **Formulário de mês local** | Folha | substituído pelo seletor do módulo |

Todos eram navegação ou releitura. **Nenhuma acção de escrita foi removida.**

Como consequência, `data`/`error` no Resumo deixaram de ter cópia em estado
local: existiam porque o botão os reescrevia no cliente. Sem ele, a página é
renderizada no servidor para o período da URL. Uma cópia que ninguém actualiza
seria apenas uma forma de o ecrã ficar desactualizado em silêncio ao mudar de
mês.

---

## 6. O que **não** mudou

**Pagamentos** — `BLOQUEADO_INCIDENTE_FINANCEIRO`. A vista entrou na casca; as
acções (adicionar, guardar, eliminar, estado, anexos) estão exactamente como
estavam. Mudar de aba ou de mês não altera persistência.

**Contas · Fluxo de Caixa · Cobranças · Conciliação** — nenhuma action alterada.
`getAccountsData` continua a ler o que lia; a integração do período nessa vista
fica para o PR B, porque mudá-la agora seria mudar semântica.

**Cobrança diária** continua ancorada em **hoje**, não no período do módulo: é
uma vista operacional do dia. (Passou a usar `todayInLisbon()` em vez de
`new Date()`, que é a correcção de fuso já aplicada ao resto da aplicação.)

---

## 7. Testes

**23 novos** em `src/__tests__/financeiro-v2-shell.test.ts`, todos offline:

*Período* — lê `YYYY-MM`; 13 entradas inválidas degradam para o mês corrente sem
lançar; preserva outros parâmetros da query e não duplica o `mes`; atravessa o
ano; respeita limites; fevereiro bissexto; formata em português; usa
`todayInLisbon` e não `new Date()`.

*Uma só navegação* — as sete vistas usam a casca e o helper; nenhuma reinventa o
mês; a barra lateral não tem entradas duplicadas; Relatórios não ficou órfã; os
atalhos e o `Atualizar` desapareceram.

*🔴 Read-only* — **nenhuma das sete páginas chama uma action que escreve**
(lista explícita, incluindo as que escrevem por delegação:
`ensurePayrollCalculated`, `calculateAndSavePayroll`, `recalcSuggestions`);
nenhuma faz mutação directa; a Folha diz que falta calcular em vez de calcular;
o cálculo continua a existir como acção; a navegação é feita de `<Link>`; o
seletor só faz `router.replace`.

*Orçamento* — capacidade de mutação não aumentou, contada base contra head.

### Contagens, separadas como devem ser

```
MUTATION_CAPABILITY_COUNT   before = N   after = N     (inalterada)
AUTO_WRITE_ON_RENDER        before = 1   after = 0     (a Folha)
```

Dizer que "desapareceu uma mutação" seria errado: a capacidade continua lá,
accionada pelo botão. O que desapareceu foi o **gatilho automático**.

---

## 8. Riscos que ficam registados

**`PARTIAL_WRITE_RISK`** — `markPayrollPaid` escreve em `payroll_records` **e**
`cash_flow_entries` sem transação (`payroll.ts:462,500`). Não corrigido: exige
atomicidade, que é frente própria.

**Contas × Fluxo de Caixa** — partilham as três mesmas actions e os mesmos
`cash_flow_entries`. A regra estrutural fica escrita: *mesmo período + mesma
fonte = mesmo total base*. O teste de coerência entre os dois ecrãs só é
possível depois de ambos consumirem o mesmo período, o que acontece no PR B.

---

## 9. Bloqueios

```
FINANCEIRO_V2_PR_A = independente da E0     ← este PR
FINANCEIRO_V2_PR_B = bloqueado pela E0
```

O PR B constrói a fronteira, liga o pipeline e só aí entram os cinco KPIs
canónicos, o gráfico diário, o Top clientes e o Resumo do período — com
`BEFORE × AFTER` **por ecrã**, conforme `FINANCEIRO-CANONICAL-PIPELINE.md` §8.

Continuam fora: meta mensal (sem fonte), feed de atividade (sem fonte canónica),
`import-contratos-5` (`ARCHIVE_CANDIDATE`), `send-password-recovery`
(`IRREVERSIBLE_MESSAGE_GUARD`).
