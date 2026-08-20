# Financeiro — o que está aberto

> Estado a 2026-08-20. Duas frentes **paradas em gate**, por decisão, à espera
> de autorização. Nenhuma delas tem trabalho por fazer do lado técnico: têm
> decisões por tomar.

---

## 1. Repair histórico dos movimentos de caixa — PREPARADO, NÃO EXECUTADO

### O que aconteceu

Entre a migration 049 e a 073 havia uma incompatibilidade: a RPC
`mark_payment_paid()` escrevia `reference_type = 'fixed_variable_payment'` e o
CHECK de `cash_flow_entries` não permitia esse valor. A transacção inteira era
revertida — o pagamento ficava pendente e nenhum movimento nascia.

A **075** corrigiu o CHECK a 2026-08-19, e desde então marcar um pagamento como
pago funciona. Mas os pagamentos que ficaram `pago` **antes** disso continuam
sem o movimento de caixa correspondente.

### Estado actual (produção, 2026-08-20)

```
ALREADY_LINKED             =  4  ·  €   322,41
NO_PAID_AT_MANUAL_REVIEW   = 14  ·  € 3.245,03
POSSIBLE_MANUAL_DUPLICATE  = 18  ·  € 3.529,32
STRONG_REPAIR_CANDIDATE    = 21  ·  € 4.477,36
──────────────────────────────────────────────
TOTAL (status = 'pago')    = 57  ·  €11.574,12
```

A aritmética fecha: 21 + 18 + 14 + 4 = 57.

### 🔴 O achado que mudou a lista

A fotografia anterior falava em **37 candidatos fortes** e 2 ambíguos. Está
obsoleta, e não por passagem de tempo.

A primeira versão do gate anti-duplicação usava uma janela de **±7 dias** entre
`paid_at` e a data do movimento manual. Devolveu **zero conflitos em 39
candidatos** — parecia um resultado excelente e estava cega.

Os lançamentos manuais reais estão a **−13, −21, −33, −54 e −69 dias** do
`paid_at`. Alguém lança a despesa à mão muito antes de marcar o pagamento como
pago, e uma janela calibrada para «mesmo dia» não vê nada disso.

Com a janela alargada para 90 dias e comparação de descrição normalizada, **18
pagamentos saíram** da reparação automática. São **€3.529,32** que teriam sido
duplicados no fluxo de caixa — dinheiro contado duas vezes, invisível até
alguém fechar o mês.

> Só foi encontrado porque a revisão exigiu revalidar os dois casos ambíguos em
> vez de os aceitar como resolvidos.

### Porque os 21 são seguros

Passaram a verificação mais forte possível para esta classe de risco:
**nenhum tem lançamento manual do mesmo valor na empresa, em data nenhuma**,
sem janela temporal. As 21 linhas vieram com `manual_id = NULL`.

Todos têm `paid_at`, período financeiro aberto e nenhum movimento de origem.

### O que está pronto

`scripts/repair-fixed-variable-payment-cashflow.mjs`

- **lista fechada embutida** — não descobre candidatos sozinho; um script que
  procura o que reparar no momento de escrever pode encontrar coisas
  diferentes das que alguém aprovou;
- **dry-run por omissão**; escreve só com `--apply`;
- recusa executar se a lista não somar o total declarado — alterar a lista sem
  actualizar o total é a forma mais provável de alguém acrescentar uma linha
  sem revisão;
- revalida cada linha com `FOR UPDATE`: status, valor, data, ausência de
  ligação, ausência de manual, período aberto;
- **tudo ou nada** — uma linha recusada aborta o lote;
- rollback por **ID exacto**, nunca por valor/data/descrição: apagar por
  semelhança levaria à frente lançamentos manuais.

22 testes contra Postgres real, incluindo o caso dos 54 dias e as fronteiras de
data civil `Europe/Lisbon`.

### 🔴 Decisões abertas

**a) Executar o repair dos 21 (€4.477,36)?** Precisa de autorização explícita.
Antes disso pode correr-se o dry-run contra produção — lê e revalida sem
escrever.

**b) Os 18 com possível duplicado precisam de revisão humana, um a um.** Cada
um tem um manual do mesmo valor algures. Alguns serão duplicados reais; outros,
coincidência de montante — «Vitor - Assistente Virtual» €150 cruza com «Garagem
2» e «sergiane - hras», despesas sem relação nenhuma.

**c) Os 14 sem `paid_at` (€3.245,03).** Inventar a data seria inventar o facto.
Não usar `created_at`, `due_date` nem o primeiro/último dia do período como
substituto.

**d) Os 21 não têm categoria de despesa.** `expense_category_id` é `NULL` em
todos, e a 073 copia o que lá está. Os movimentos vão nascer em «Sem
categoria» — €4.477,36 por classificar. É fiel ao pagamento, mas vale decidir
se se classifica antes ou depois.

```
BACKFILL = 0    PRODUCTION_WRITES = 0
branch: chore/repair-historical-cashflow
```

---

## 2. Pagamentos como fonte única — PLANEADO, NÃO INICIADO

### O problema

O mesmo conceito financeiro está exposto em dois sítios com dois caminhos de
mutação:

```
Financeiro → Contas → Despesas pendentes  → botão «Marcar como pago»
Financeiro → Pagamentos                   → botão «Marcar como pago»
```

Sintoma relatado: marcar como pago numa das superfícies e o registo
**desaparecer**, sem se perceber para onde foi.

### A decisão

**Pagamentos passa a ser a única área operacional** para tudo o que a empresa
tem a pagar. Contas deixa de ter uma segunda fila editável.

```
OBRIGAÇÃO → PAGAMENTO → MOVIMENTO DE CAIXA → CONCILIAÇÃO
```

Uma obrigação tem **uma** identidade, **um** estado, **um** caminho para ser
paga, **no máximo um** movimento de caixa ligado, e uma trajectória auditável.

### Porque não é preciso inventar um motor novo

A 073 já faz o essencial: pagamento → saída de caixa numa transacção única,
identidade por `(company_id, reference_type, reference_id)`, idempotente, e já
transporta `expense_category_id` do pagamento para o movimento.

O que falta não é motor — é **obrigar toda a interface a passar por ele**.

### Três brechas que o plano fecha, e que a interface sozinha não resolve

**Timeout depois do COMMIT.** A RPC pode ter gravado e o cliente perder a
resposta. Nunca recriar o movimento à mão: refazer a leitura autoritativa e
decidir com o que o servidor diz. O estado local não é fonte de verdade.

**Editar valor ou categoria depois de pago.** Alterar `payment.amount` sem
tocar no movimento cria divergência silenciosa entre as duas metades da mesma
despesa. O caminho seguro é reabrir → editar → pagar de novo.

**Dois administradores a pagar a mesma linha.** O servidor é idempotente; o
segundo recebe o estado autoritativo («já estava pago»), nunca um segundo
movimento.

### Fases previstas

```
A  auditoria factual + testes que reproduzem o desaparecimento
B  read model canónico (PayableView)
C  Pagamentos recebe categorias, filtros, aba Pagos, rastreabilidade, integridade
D  Contas perde a mutação duplicada — fica com um resumo read-only que liga
E  guards permanentes:
     VISIBLE_MARK_PAID_IMPLEMENTATIONS = 1
     PAYMENT_STATUS_DIRECT_WRITE_OUTSIDE_CANONICAL = 0
     FIXED_PAYMENT_CASHFLOW_DIRECT_INSERT = 0
     AUTO_WRITE_ON_RENDER = 0
     FINANCIAL_QUERY_ERROR_AS_ZERO = 0
F  CI + Preview, parar antes de produção se houver migration
```

### 🔴 Perguntas a responder na auditoria, antes de tocar em UI

- «Despesas pendentes» e Pagamentos usam a **mesma tabela**? O conceito visual
  está duplicado; falta saber se o armazenamento também.
- O que acontece exactamente ao registo quando se marca pago em Contas? Muda
  estado, é apagado, deixa de passar num filtro, ou o erro é engolido?
- Existem despesas pendentes legítimas **sem** `payment` correspondente? Se
  existirem, não podem ser apagadas nem escondidas.

### Regra que não pode ser relaxada

`ensureMonth` e `shiftDate` continuam em quarentena. Abrir uma página, mudar de
mês ou recarregar **nunca** cria pagamentos. Já houve incidente em que uma
leitura gerava escrita.

```
NEW_MIGRATION = a decidir depois da auditoria — preferência por NÃO
BACKFILL desta frente = 0
branch prevista: feat/finance-payments-single-source
```

---

## 3. Fora de âmbito, intocado

| | |
|---|---|
| **Migration 070** | `PENDING`. Não aplicar, não fazer baseline, não reconciliar. É uma decisão de segurança independente. |
| **Smoke de outros admins** | `NOT_PROVEN`. Confirmar que MONICA, Letícia e Jessica não veem o painel de avisos. Não bloqueia nada. |
| **Anexos** | `#63` em produção, smoke autenticado `NOT_PROVEN`. Não reabrir. |

---

## Ligações

- `scripts/repair-fixed-variable-payment-cashflow.mjs` — o repair preparado
- `src/__tests__/repair-historical-cashflow.test.ts` — 22 testes
- `supabase/migrations/073_payment_to_cashflow.sql` — a semântica autoritativa
- `supabase/migrations/075_cash_flow_fixed_variable_payment_reference.sql` — a correcção do CHECK
- `AGENTS.md` — REGRA ZERO
