# Módulo Financeiro — Especificação

> ⚠️ **RASCUNHO** — Este documento está incompleto. Aguarda respostas do user sobre as regras de negócio específicas.

---

## O que o módulo cobre

1. **Faturação a Clientes** — Geração de faturas com base nos serviços concluídos
2. **Folha de Pagamento** — Cálculo e fechamento mensal de salários
3. **Dashboard Financeiro** — Visão geral de receitas, custos e margem

---

## 1. Faturação a Clientes

### Fluxo Base

```
Serviços concluídos no mês
          ↓
Agrupar por cliente
          ↓
Gerar rascunho de fatura
          ↓
Gestor revê e ajusta (se necessário)
          ↓
Marcar como "pendente" (enviada ao cliente)
          ↓
Marcar como "pago" quando receber
```

### Cálculo por serviço

```
valor_servico = duração_horas × preço_hora × nº_colaboradores
```

Se houver `manual_override` no serviço: usa esse valor em vez da fórmula.

### Estrutura da Fatura

```
Fatura #F2024/001
Data: 31/01/2024
Cliente: [Nome do Cliente]

Serviços prestados em Janeiro 2024:

01/01 - Limpeza Edifício A - 2h × 2 pess. × €15/h = €60,00
08/01 - Limpeza Edifício A - 2h × 2 pess. × €15/h = €60,00
...

Subtotal:     €480,00
IVA 23%:       €110,40
Total:         €590,40
```

### Perguntas em aberto sobre faturação:

- [ ] A empresa emite faturas formais? (com NIF, assinatura digital, etc.)
- [ ] Qual a taxa de IVA? (serviços de limpeza em PT: geralmente 23% ou 6% se for habitação)
- [ ] Precisam de integração com software de contabilidade (Moloni, InvoiceXpress)?
- [ ] Ou basta exportar PDF + CSV para enviar ao contabilista?
- [ ] Faturas mensais por cliente, ou por serviço individual?
- [ ] Existe desconto por volume (ex: cliente com 10 locais tem desconto)?

---

## 2. Folha de Pagamento

### Fórmula Base (a confirmar com user)

```
salário_bruto = horas_trabalhadas × valor_hora
deduções_faltas = horas_falta_injustificada × valor_hora
subsídio_alimentação = dias_trabalhados × valor_diário   (se aplicável)

salário_liquido = salário_bruto - deduções_faltas + subsídio_alimentação + ajustes_manuais
```

> **Nota:** Esta fórmula NÃO inclui IRS, Segurança Social ou outros descontos legais obrigatórios. Esses cálculos são da responsabilidade do contabilista. A plataforma fornece as horas e os valores brutos.

### Fechamento Mensal

1. Gestor abre o fechamento do mês (ex: Janeiro 2024)
2. Sistema calcula automaticamente para cada colaborador:
   - Horas trabalhadas (via timesheets)
   - Horas de falta
   - Salário calculado
3. Gestor pode ajustar manualmente (ex: adicionar subsídio, corrigir uma ausência)
4. Gestor aprova o fechamento
5. Sistema gera PDF individual por colaborador (pode ser enviado por email)
6. Gestor marca como "pago" quando a transferência é feita

### Perguntas em aberto sobre salários:

- [ ] Como é calculado o salário base? (€/hora × horas trabalhadas? Ou salário fixo mensal?)
- [ ] Existe subsídio de alimentação? (Quanto por dia trabalhado?)
- [ ] Horas extra têm acréscimo? (Ex: 25% acima do valor/hora normal?)
- [ ] Faltas injustificadas = desconto de 100% das horas, ou mais?
- [ ] Existe pagamento de férias em dobro (subsídio de férias)?
- [ ] Os colaboradores são trabalhadores independentes (recibos verdes) ou funcionários?
  - Esta distinção muda completamente os descontos obrigatórios

---

## 3. Dashboard Financeiro

### KPIs Principais

```
┌─────────────────┬─────────────────┬─────────────────┐
│  RECEITA        │  CUSTOS         │  MARGEM BRUTA   │
│  €12.450        │  €7.200         │  €5.250 (42%)   │
│  ↑ 8% vs mês   │  ↑ 3% vs mês   │  ↑ 5% vs mês   │
│  anterior       │  anterior       │  anterior       │
└─────────────────┴─────────────────┴─────────────────┘
```

### Gráficos

- **Receita vs Custos** (barras, últimos 12 meses)
- **Receita por Cliente** (pizza ou barras horizontais)
- **Margem por Serviço** (identificar serviços deficitários)

### Projeção do Mês

Com base nos serviços já agendados para o resto do mês:
```
Faturado até hoje:     €8.200
Agendado até fim mês:  €4.250
Projeção total:       €12.450
```

---

## Perguntas em Aberto (resumo)

Para completar este documento, o user precisa responder:

### Sobre Faturação
1. Emitem faturas formais com assinatura digital? (SAF-T, etc.)
2. Qual a taxa de IVA aplicável?
3. Precisam de integração com software de contabilidade?
4. Faturas são mensais (todas as limpezas do mês num documento) ou por serviço?

### Sobre Salários
5. Contrato de trabalho (SS + IRS obrigatórios) ou recibos verdes?
6. Salário por hora ou salário fixo mensal?
7. Existe subsídio alimentação? Quanto por dia?
8. Horas extra têm acréscimo percentual?

### Sobre Geral
9. Quantos colaboradores atualmente?
10. Quantos clientes/locais atualmente?
11. Volume de faturação mensal aproximado? (para dimensionar bem o sistema)

---

## O que NÃO vamos fazer (por limitações legais/técnicas)

- **Não calculamos IRS nem Segurança Social** — isso é responsabilidade do contabilista e depende da situação específica de cada colaborador. Fornecemos os dados brutos.
- **Não emitimos faturas com validação AT** (Autoridade Tributária) — para isso seria necessário certificação de software (processo burocrático). Alternativa: exportar para Moloni/InvoiceXpress que já têm certificação.
- **Não fazemos transferências bancárias** — apenas registamos que foi pago.
