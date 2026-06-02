# Registo de Decisões — Sessão de Discussão

> Decisões tomadas na sessão de planeamento detalhado. Estas complementam e refinam os docs anteriores.

---

## Produto e Identidade

| Decisão | Escolha | Raciocínio |
|---------|---------|------------|
| Nome do produto | **Escala** | Nome português, duplo significado (horário de trabalho + escalar), funciona como marca independente da Mó Limpezas |
| Cor principal | **Verde `#16A34A`** (Tailwind green-600) | Associado a limpeza/frescura. Sidebar: green-700. Backgrounds: green-50. |
| Âmbito | Mó Limpezas agora, SaaS depois | `company_id` em todas as tabelas desde o início — multi-tenancy gratuito quando escalar |

---

## Colaboradores e Contratos

| Decisão | Escolha |
|---------|---------|
| Tipo de vínculo | Contrato de trabalho (funcionários) |
| Estrutura salarial | Mesmo valor hora para todos — campo global configurável pelo admin |
| Fórmula salário | `horas_trabalhadas × valor_hora` |
| Sub. alimentação | Transferência no salário — `dias_trabalhados × €9,60` (configurável) |
| Sub. férias/natal | **A decidir** — recomendação: padrão PT (junho + novembro). Sistema avisa em maio e outubro. |
| Horas extra | **A definir** — se há acréscimo percentual além do contratado |
| SS e IRS | O contabilista trata — sistema só fornece valores brutos e horas |

---

## Faturação e Financeiro

| Decisão | Escolha |
|---------|---------|
| Tipo de cobrança | Por serviço individual (não mensal consolidada) |
| Fatura legal | Contabilista emite — sistema gera documento de cobrança (PDF + CSV) |
| IVA | 23% fixo (comércio/escritórios) |
| Software contabilidade | Sem integração — só exportação de ficheiros |
| Extrato cliente | PDF gerado automaticamente com lista de serviços do mês + total |

---

## Calendário e Agendamento

| Decisão | Escolha |
|---------|---------|
| Estrutura | **Contratos Fixos** (padrões recorrentes) + **Serviços Pontuais** (direto no calendário) |
| Equipa | Unidade indivisível — vão sempre todos juntos |
| Reforços | Colaboradores avulso adicionados por serviço específico se necessário |
| Preço | `duração × preço_hora_local × (membros_equipa + reforços)` |
| Edição no calendário | Afeta **sempre só aquela ocorrência**. Para mudar padrão: ir a Contratos Fixos. |
| Geração automática | Edge Function no dia 25 gera ocorrências do mês seguinte |

---

## App do Colaborador

| Decisão | Escolha |
|---------|---------|
| Importância | **Core desde o início** — não é fase opcional |
| Rotina diária | 2–3 locais/dia com deslocamentos entre eles |
| Escala | Base fixa com alterações frequentes → notificações de mudança são críticas |
| Funcionalidade principal | Relógio de ponto digital: Registar Entrada (GPS) + Registar Saída (GPS) |
| Fim de serviço | Só clock-out — sem checklists nem fotos obrigatórias |
| Clock-out esquecido | Gestor fecha manualmente no painel com a hora correta |

---

## Operações

| Decisão | Escolha |
|---------|---------|
| Validação GPS clock-in | Só avisa se fora do raio — nunca bloqueia |
| Notificações | Push na app (principal) + Email (fallback automático) |
| Substituição de ausentes | Gestor escolhe da lista de sugestões → substituto notificado diretamente |
| Sem substituto | Serviço marcado "sem cobertura" + alerta ao gestor |
| Painel tempo real | Lista de estado + mapa com posição do último clock-in, lado a lado |

---

## Relatórios (todos com exportação PDF + Excel/CSV)

1. **Horas por colaborador no mês** — base para salário e ocupação %
2. **Receita por cliente no mês** — identificar clientes mais rentáveis
3. **Absentismo por colaborador** — faltas, tipo, justificadas vs injustificadas
4. **Serviços concluídos vs cancelados** — taxa de execução
5. **Extrato mensal por cliente** — PDF para enviar com a cobrança (lista de serviços + total)

---

## Migração de Dados

- User tem listas em Excel/WhatsApp
- Fase 6 inclui importação por CSV: colaboradores, clientes e locais em lote

---

## Perguntas Ainda em Aberto

1. Sub. férias/natal: junho/novembro (padrão PT) ou diluído mensalmente?
2. Horas extra: existe acréscimo percentual?
