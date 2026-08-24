# Financeiro — Pagamentos como fonte única operacional

> Planeamento aprovado em 2026-08-24. **Não implementado ainda.**
>
> Este documento existe para que outro PC/agente consiga continuar sem depender do chat.
>
> Antes de qualquer trabalho: ler `AGENTS.md`, `docs/HANDOFF-2026-08-24.md` e `docs/FINANCEIRO-PENDENTE.md`.

---

## 0. 🚨 AVISO CRÍTICO

Esta frente toca a área financeira e não pode repetir incidentes de duplicação, auto-lançamento ou estado divergente.

Não executar nesta frente:

- repair histórico;
- backfill;
- migration 070;
- reaplicação de 074/075;
- SQL de produção sem autorização;
- alterações em pagamentos reais para teste.

A implementação deve nascer de uma branch própria a partir de `master` atualizado:

```text
feat/finance-payments-single-source
```

A branch de repair não é base desta feature.

---

## 1. Problema de produto

Hoje o utilizador encontra o mesmo conceito em dois lugares:

```text
Financeiro → Contas → Despesas pendentes
Financeiro → Pagamentos
```

Existe feedback de que são praticamente a mesma coisa em locais separados.

Sintoma principal:

```text
Despesas pendentes
→ Marcar como pago
→ item some
→ não fica claro onde foi parar
```

Isto é um problema de arquitetura e rastreabilidade, não apenas de layout.

---

## 2. Decisão

```text
PAGAMENTOS = única área operacional de contas a pagar
```

Contas deixa de possuir uma segunda fila mutável e um segundo caminho de `Marcar como pago`.

Fluxo canónico:

```text
OBRIGAÇÃO
→ PAGAMENTO
→ MOVIMENTO DE CAIXA
→ CONCILIAÇÃO
```

Cada obrigação deve possuir:

- uma identidade;
- um estado;
- um caminho de pagamento;
- no máximo um movimento origin-linked;
- uma trajetória auditável.

---

## 3. Referências de desenho de sistemas maduros

O princípio adotado é o mesmo encontrado em sistemas financeiros consolidados:

- uma conta a pagar é liquidada pelo fluxo da própria obrigação, não criando uma segunda despesa paralela;
- o pagamento gera/associa o efeito de caixa;
- a conciliação bancária é uma etapa posterior de confirmação;
- retries reutilizam a mesma identidade/idempotency key.

Não copiar interfaces externas. Usar apenas os princípios de integridade e rastreabilidade.

---

## 4. Primeiro passo obrigatório — auditoria factual do `master`

Antes de alterar UI, responder com evidência:

```text
CURRENT_MASTER =

CONTAS_PENDING_SOURCE =
CONTAS_PENDING_QUERY =
CONTAS_MARK_PAID_ACTION =
CONTAS_MARK_PAID_WRITES =
CONTAS_MARK_PAID_EFFECT =

PAYMENTS_SOURCE =
PAYMENTS_MARK_PAID_ACTION =
PAYMENTS_RPC =

DUPLICATED_CONCEPTS =
DUPLICATED_MUTATIONS =

CATEGORY_CURRENT_SOURCE =
CATEGORY_CURRENT_UI =
CATEGORY_PAYMENT_FIELD =

BANK_RECONCILIATION_SOURCE =
BANK_RECONCILIATION_MODEL =
PAYMENT_TO_BANK_TRACE_POSSIBLE =

PAID_PAYMENT_CURRENT_DESTINATION =
PENDING_EXPENSE_DISAPPEAR_ROOT_CAUSE =

DIRECT_PAYMENT_STATUS_WRITERS =
FIXED_PAYMENT_CASHFLOW_WRITERS =

AUTO_WRITE_ON_RENDER =
LEGACY_MATERIALIZATION_REACHABLE =

SCHEMA_SUFFICIENT =
NEW_MIGRATION_REQUIRED =

PROPOSED_REMOVALS =
PROPOSED_MOVES =
PROPOSED_NEW_COMPONENTS =

PRODUCTION_WRITES = 0
BACKFILL = 0
070_APPLIED = NO
```

Não assumir que Contas e Pagamentos usam a mesma tabela só porque parecem iguais.

---

## 5. Investigar o bug «marca pago e some»

Reproduzir por código/testes:

```text
Contas
→ Despesas pendentes
→ Marcar como pago
```

Documentar:

### Antes

- tabela;
- linha;
- status;
- filtros que a exibem.

### Ação

- action chamada;
- RPC chamada;
- `UPDATE`;
- `INSERT`;
- `DELETE`;
- invalidação/cache.

### Depois

Determinar se:

- apenas muda status;
- deixa de passar no filtro;
- cria cash-flow;
- cria payment;
- é apagado;
- falha com erro engolido;
- fica órfão.

Não corrigir por tentativa.

---

## 6. Estrutura final de Pagamentos

Uma única página simples:

```text
Pagamentos
Tudo o que a empresa tem para pagar e o histórico do pago

[ Pendentes ] [ Vencidos ] [ Pagos ] [ Todos ]

Categoria [ Todas ▼ ]
Período   [ Ago 2026 ]
Pesquisa  [ ... ]
```

KPIs/resumo:

```text
Pendentes
Vencidos
Pagos no mês
Sem categoria
```

Se houver anomalia:

```text
⚠ 2 pagamentos precisam de atenção
```

Nunca esconder problemas de integridade.

---

## 7. O que sai de Contas

Remover como superfície operacional duplicada:

- tabela mutável de Despesas pendentes;
- botão próprio `Marcar como pago`;
- edição paralela da mesma obrigação;
- action concorrente com Pagamentos.

Contas pode manter somente um resumo read-only:

```text
Despesas pendentes
12 · € 2.430,00
[ Ver em Pagamentos → ]
```

Link sugerido:

```text
/financeiro/pagamentos?status=pendente
```

Não manter duas listas completas com o mesmo conceito.

---

## 8. Categorias passam a viver em Pagamentos

Usar o campo canónico existente:

```text
expense_category_id
```

Na criação/edição:

```text
Categoria da despesa
[ Fornecedores ▼ ]
```

No filtro:

```text
Categoria
[ Todas ▼ ]
```

Não criar campos paralelos de categoria sem necessidade factual.

---

## 9. Regra já existente na 073 — preservar

O fluxo autoritativo já deve transportar:

```text
payment.expense_category_id
→ mark_payment_paid()
→ cash_flow_entries.expense_category_id
```

Não recriar isto no browser.

Nunca fazer:

```text
UPDATE payment
+
INSERT cashflow
```

na UI.

Sempre:

```text
UI
→ Server Action
→ RPC canónica
→ transação
→ snapshot autoritativo
```

---

## 10. Pagamento não desaparece — muda de estado

Fluxo esperado:

```text
Pendente
→ Marcar como pago
→ status = pago
→ cash-flow origin-linked = 1
→ confirmação visível
```

Mensagem possível:

```text
✓ Pagamento registado
Saída de 41,38 € criada no Fluxo de Caixa.

[ Ver em Pagos ]
[ Ver movimento ]
```

Se o filtro atual for `Pendentes`, a linha pode sair da lista, mas só depois da UI indicar para onde foi.

---

## 11. Aba Pagos

Cada linha deve conseguir mostrar, quando disponível:

- descrição;
- categoria;
- valor;
- vencimento;
- pago em;
- origem;
- movimento de caixa;
- estado da conciliação.

Exemplo:

```text
Água - ATL
Fornecedores
41,38 €
Pago 19/08/2026
↗ Movimento de caixa
Aguardando conciliação
```

Pago nunca significa removido do histórico.

---

## 12. Rastreabilidade

Detalhe do payment:

```text
ORIGEM
Criado manualmente
20 ago · 09:12

↓
VENCIMENTO
25 ago 2026

↓
PAGAMENTO
Pago em 24 ago 2026

↓
CAIXA
Saída de 189,40 €
[ Abrir movimento ]

↓
BANCO
Aguardando conciliação
```

Só mostrar estados comprováveis pelos dados.

Não inventar `Conciliado` se o schema/read model não consegue provar.

---

## 13. Identidade financeira

Preservar:

```text
cash_flow_entries.reference_type = 'fixed_variable_payment'
cash_flow_entries.reference_id   = payment.id
```

E a unicidade equivalente a:

```text
UNIQUE(company_id, reference_type, reference_id)
```

Uma obrigação pode gerar no máximo um movimento de origem.

Nunca relacionar automaticamente no runtime por:

```text
descrição + valor + data parecida
```

Semelhança serve apenas para diagnóstico histórico conservador, não identidade operacional.

---

## 14. Uma única implementação de marcar pago

Caminho permitido:

```text
mark_payment_paid()
```

Semântica esperada:

```text
lock payment
→ validar empresa
→ validar valor
→ validar período
→ atualizar payment
→ inserir/reutilizar cash-flow origin-linked
→ devolver cash_entry_id
→ commit
```

Não criar um segundo `markPendingExpensePaid()` com semântica paralela.

Meta:

```text
VISIBLE_MARK_PAID_IMPLEMENTATIONS = 1
```

---

## 15. Guards permanentes

CI deve falhar se reaparecer:

```text
.from('fixed_variable_payments').update({ status: 'pago' })
```

fora do caminho autorizado.

Também impedir `INSERT` manual de:

```text
reference_type = 'fixed_variable_payment'
```

fora do módulo/RPC canónico.

Metas:

```text
PAYMENT_STATUS_DIRECT_WRITE_OUTSIDE_CANONICAL = 0
FIXED_PAYMENT_CASHFLOW_DIRECT_INSERT = 0
```

---

## 16. Resposta autoritativa

A UI não deve assumir sucesso a partir de estado local.

Depois da mutation, obter algo equivalente a:

```ts
{
  payment: {
    id,
    status,
    paid_at
  },
  cashFlow: {
    id,
    amount,
    date
  }
}
```

ou fazer refetch autoritativo imediatamente.

---

## 17. Postconditions financeiras

Depois de marcar pago, validar:

```text
payment.status = pago
payment.paid_at != null
origin-linked cashflows = EXACTLY 1
cashflow.amount = payment.amount
cashflow.expense_category_id = payment.expense_category_id
cashflow.type = saida
cashflow.status = confirmado
```

Se a postcondition falhar, não devolver sucesso silencioso.

---

## 18. Read-model de integridade

Classificar, sem corrigir automaticamente:

```text
PAID_WITHOUT_CASHFLOW
PENDING_WITH_CASHFLOW
MULTIPLE_ORIGIN_CASHFLOW
PAID_WITHOUT_PAID_AT
AMOUNT_MISMATCH
CATEGORY_MISMATCH
DATE_MISMATCH
ORPHAN_FIXED_PAYMENT_CASHFLOW
```

UI administrativa:

```text
⚠ Integridade financeira
2 registos precisam de revisão.
[ Ver detalhes ]
```

---

## 19. Erro de query nunca é zero

Proibição:

```ts
data ?? []
amount ?? 0
```

quando a fonte falhou.

Mostrar:

```text
Indisponível
```

ou erro adequado.

Meta:

```text
FINANCIAL_QUERY_ERROR_AS_ZERO = 0
```

---

## 20. Pago não é editado como pendente

Campos com efeito económico como valor, categoria e data de pagamento não podem mudar silenciosamente depois de pago.

Fluxo preferido:

```text
Pago
→ Reabrir pagamento
→ unmark_payment_paid()
→ editar
→ marcar pago novamente
```

Evita divergência entre payment e cash-flow.

---

## 21. Delete de pago

Proibir delete direto de payment pago com cash-flow ligado.

Mensagem sugerida:

```text
Este pagamento já gerou um movimento de caixa.
Reabra o pagamento antes de o eliminar.
```

Meta:

```text
PAYMENT_PAID_DIRECT_DELETE = 0
```

---

## 22. Desmarcar como pago

Preservar semântica da 073:

```text
unmark_payment_paid()
```

Remove somente o movimento com:

```text
reference_type='fixed_variable_payment'
reference_id=payment.id
```

Movimento manual gémeo por valor/data/descrição deve sobreviver.

Teste obrigatório.

---

## 23. Período fechado

Período fechado deve negar:

- marcar pago;
- desmarcar pago;
- alterar efeito económico.

Não abrir período automaticamente.

Nenhuma UI alternativa pode contornar a regra.

---

## 24. Categoria depois de pago

Não permitir:

```text
payment.category = A
cashflow.category = B
```

Preferência:

```text
reabrir → editar → pagar novamente
```

Só criar uma RPC específica para recategorizar pago se surgir necessidade real e aprovada.

---

## 25. Pendente vs pago nas métricas

Uma despesa paga existe em `payment` e em `cash_flow_entries`, mas isso não significa duas despesas.

Para `Pendente / previsto`:

```text
payments pendentes
```

Para `Custo realizado / caixa`:

```text
cash-flow confirmado
```

Não somar payment pago + cash-flow do mesmo payment no mesmo KPI.

Meta:

```text
PAID_PAYMENT_DOUBLE_COUNT = 0
```

---

## 26. Despesa paga imediatamente

Auditar este caso antes de forçar tudo a nascer pendente.

Dois conceitos podem coexistir:

```text
A) obrigação: recebo agora, pago depois → Pagamentos
B) despesa imediata: paga na hora → Fluxo de Caixa / transação direta
```

B nunca pode ser usado para liquidar uma obrigação A já existente.

---

## 27. Legado de Contas

Antes de retirar `Despesas pendentes`, inventariar read-only os registros reais.

Se todos estão em `fixed_variable_payments`, consolidar é simples.

Se houver pendências legítimas sem payment:

```text
LEGACY_PENDING_ONLY
```

Não apagar nem esconder.

Opções, por ordem:

1. read model unificado com origem identificada;
2. migração controlada para fonte canónica;
3. compatibilidade temporária read-only.

Não criar migration antes de saber qual cenário existe.

---

## 28. Read model canónico

Criar conceito de domínio, por exemplo:

```ts
type PayableView = {
  id: string
  originType: string
  description: string
  amount: Money
  categoryId: string | null
  dueDate: string | null
  status: 'pendente' | 'pago'
  paidAt: string | null
  cashFlowId: string | null
  reconciliationState: string | null
  integrityState: string
}
```

A UI consome o domínio, não a estrutura física da tabela.

---

## 29. Não renomear schema por estética

`fixed_variable_payments` é um nome imperfeito, mas já tem dados e integração.

Não criar tabela `payables` apenas porque o nome é melhor.

Preferir:

```text
domínio canónico novo
sobre schema existente
```

Migration somente se houver lacuna factual.

---

## 30. Relançamentos / auto-write

Regra permanente:

```text
GET / RENDER / RELOAD nunca cria pagamentos
```

Metas:

```text
AUTO_WRITE_ON_RENDER = 0
```

Abrir página:

```text
0 INSERT
0 UPDATE
0 DELETE
```

Mudar mês:

```text
0 INSERT
0 UPDATE
0 DELETE
```

Dashboard reminder:

```text
0 payment writes
```

---

## 31. `ensureMonth` e `shiftDate`

Continuam em quarentena.

Não reativar durante esta frente.

A implementação antiga já demonstrou não modelar corretamente periodicidade trimestral e outras recorrências.

---

## 32. Recorrência futura

Se no futuro houver geração automática de pagamentos fixos, exigir explicitamente:

- regra de recorrência;
- data âncora;
- intervalo;
- identidade da ocorrência;
- idempotency key.

Retry não duplica.

Refresh não gera.

Nunca inferir recorrência apenas porque existia no mês anterior.

---

## 33. Detector de duplicados

Além da constraint de cash-flow, criar diagnóstico read-only para payments potencialmente duplicados.

Sinais possíveis:

```text
same company
same source identity
same occurrence
same amount
```

Nunca auto-delete.

Meta:

```text
DUPLICATE_AUTO_DELETE = 0
```

---

## 34. Double click / retry

UI desabilita botão enquanto request corre, mas segurança não depende disso.

Servidor deve continuar idempotente.

Testar:

- double click;
- duas requests simultâneas;
- retry de rede;
- reload após timeout.

Resultado:

```text
PAYMENT_STATUS = pago
ORIGIN_CASHFLOW_COUNT = 1
```

---

## 35. Timeout depois do commit

Cenário:

```text
RPC COMMITA
→ cliente perde a resposta
```

Não recriar cash-flow.

Fazer refetch autoritativo.

Se:

```text
payment pago + 1 cash-flow
```

mostrar sucesso recuperado.

Se:

```text
payment pendente + 0 cash-flow
```

permitir retry.

---

## 36. Concorrência entre utilizadores

A e B abrem o mesmo payment.

A paga.

B tenta pagar com ecrã desatualizado.

Servidor deve responder com estado autoritativo e manter:

```text
cash-flow count = 1
```

Nunca segundo movimento.

---

## 37. Cache e realtime

Mutação financeira deve invalidar de forma coordenada:

- Pagamentos;
- Fluxo de Caixa;
- Dashboard financeiro;
- resumo de Contas;
- visões por categoria.

Realtime, quando usado:

```text
evento = gatilho de refetch
```

Não usar payload realtime como verdade financeira final.

---

## 38. Auditoria

Registar eventos relevantes:

```text
payment.created
payment.updated
payment.marked_paid
payment.unmarked_paid
payment.delete_attempt
payment.deleted
payment.category_changed
```

No mark paid incluir metadados mínimos e seguros:

```text
payment_id
cash_entry_id
before_status
after_status
```

---

## 39. Origem visível

Badge de origem apenas quando comprovável:

```text
Manual
Fixo
Variável
Recorrente
Importado
Legado
```

Não inferir `Recorrente` pela descrição.

Se incerto, `Legado` é melhor que uma afirmação falsa.

---

## 40. Anexos

Anexos permanecem ligados ao payment.

Marcar pago, reabrir ou editar categoria não toca anexos.

Não reabrir o incidente de attachments nesta frente.

---

## 41. UX final desejada

```text
┌────────────────────────────────────────────────────────────┐
│ Pagamentos                                                 │
│ Tudo o que a empresa tem para pagar e o histórico do pago │
│                                                            │
│ [Pendentes 12] [Vencidos 3] [Pagos 28] [Todos]           │
│                                                            │
│ Categoria [Todas ▼]   Período [Ago 2026]   🔍 Pesquisar   │
├────────────────────────────────────────────────────────────┤
│ Água - ATL                      41,38 €    Pago ✓          │
│ Fornecedores · pago 19 ago · Caixa ↗                       │
├────────────────────────────────────────────────────────────┤
│ ENDESA                           83,12 €    Pendente        │
│ Energia · vence 28 ago                              [Pagar] │
└────────────────────────────────────────────────────────────┘
```

A pessoa não deve abrir três páginas para entender uma despesa.

---

## 42. Testes mínimos obrigatórios

1. pending aparece em Pagamentos;
2. marcar pago muda status para pago;
3. cria exatamente 1 cash-flow;
4. pago aparece em Pagos;
5. reload continua pago;
6. categoria propaga ao cash-flow;
7. erro RPC aparece na UI;
8. erro não é tratado como sucesso;
9. double click = 1 movimento;
10. concorrência = 1 movimento;
11. timeout + commit recupera por refetch;
12. unmark remove só origin-linked;
13. movimento manual gémeo sobrevive;
14. editar amount pago = deny;
15. editar categoria pago = deny;
16. delete pago direto = deny;
17. closed period mark = deny;
18. closed period unmark = deny;
19. pago sem cash-flow = alert;
20. pendente com cash-flow = alert;
21. category mismatch = alert;
22. amount mismatch = alert;
23. paid_at missing = alert;
24. query error != zero;
25. Contas não tem mark-paid independente;
26. Contas linka para Pagamentos;
27. render Pagamentos = 0 writes;
28. mudar período = 0 writes;
29. reminder = 0 payment writes;
30. retries de geração não duplicam;
31. payment pago não conta duas vezes em Custos;
32. tenant A não vê/muta tenant B.

---

## 43. Mutation tests obrigatórios

Reintroduzir temporariamente defeitos e exigir falha:

### A

```ts
await action()
reload()
```

sem verificar `result.ok`.

### B

```text
UPDATE status='pago' direto
```

### C

segundo `INSERT` origin-linked.

### D

`getPayments()` chama materialização.

### E

Contas ganha segundo botão de marcar pago.

Guard esperado:

```text
SINGLE_MUTATION_SURFACE = PASS
```

---

## 44. Migration

Não decidir agora que será necessária migration 077.

Primeiro auditar.

Preferência:

```text
NEW_MIGRATION = NO
```

se o desenho couber em:

- `fixed_variable_payments`;
- `cash_flow_entries`;
- `expense_categories`;
- conciliação atual.

Se schema novo for realmente necessário:

- migration separada;
- PGlite;
- checksum;
- parar no gate antes de produção;
- não puxar 070 por arrasto.

---

## 45. Repair histórico é outra operação

Não usar esta feature para:

- criar movimentos dos 21 strong;
- corrigir os 18 possíveis manuais;
- preencher `paid_at` dos 14;
- recategorizar históricos automaticamente.

Meta:

```text
BACKFILL = 0
```

---

## 46. Fases de implementação

```text
FASE A
Auditoria factual + reprodução do bug

FASE B
PayableView / read model canónico

FASE C
Pagamentos recebe categorias, filtros, Pagos, rastreabilidade e integridade

FASE D
Contas perde a mutação duplicada e vira resumo read-only

FASE E
Hardening + guards + mutation tests

FASE F
CI + Preview
```

Se houver migration, parar antes de produção.

---

## 47. Release note futura

Quando a implementação real existir, adicionar release note nova.

Título:

```text
Pagamentos mais claros
```

Mensagem:

```text
Unificámos as despesas em Pagamentos, com categorias e histórico de cada pagamento. Agora é mais fácil acompanhar o que está pendente e o que já foi pago.
```

Não criar durante puro planeamento.

---

## 48. Critério final de produto

A pessoa deve responder olhando uma tela:

```text
O que tenho para pagar? → Pendentes
O que está atrasado?    → Vencidos
O que já paguei?        → Pagos
Qual categoria?         → mesma linha
De onde veio?           → Origem
Quando paguei?          → Pago em
Onde entrou no caixa?   → Movimento vinculado
Já apareceu no banco?   → Conciliação
Houve problema?         → Integridade financeira
```

Se isto exigir abrir Contas + Pagamentos + Fluxo e comparar descrições manualmente, a arquitetura ainda está errada.

---

## 49. Regra final

```text
UMA OBRIGAÇÃO
→ UMA IDENTIDADE
→ UM PAGAMENTO
→ NO MÁXIMO UM MOVIMENTO ORIGIN-LINKED
→ UMA TRAJETÓRIA AUDITÁVEL
```
