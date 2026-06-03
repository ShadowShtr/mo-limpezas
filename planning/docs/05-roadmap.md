# Roadmap de Desenvolvimento

## Estratégia Geral

Desenvolvimento em fases incrementais — cada fase entrega valor utilizável, mesmo antes de o projeto estar completo.

**Princípio:** Nunca esperar que tudo esteja pronto para começar a usar. Após a Fase 2, já é possível usar o sistema para agendar.

---

## Fase 0 — Planeamento ← AQUI ESTAMOS

**Objetivo:** Ter tudo documentado antes de escrever uma linha de código.

| Tarefa | Estado |
|--------|--------|
| Definir funcionalidades | ✅ Feito |
| Escolher stack tecnológica | ✅ Feito |
| Esquema da base de dados (draft) | ✅ Feito |
| Custos documentados | ✅ Feito |
| Wireframes aprovados | ⏳ Pendente |
| Módulo financeiro detalhado | ⏳ Pendente (aguarda respostas do user) |
| Responder perguntas abertas | ⏳ Pendente |

**Bloqueador:** Respostas do user sobre módulo financeiro (ver README.md → Perguntas em Aberto)

---

## Fase 1 — Fundação

**Duração estimada:** 2–3 semanas  
**Resultado:** Sistema funciona, podes fazer login, criar colaboradores e clientes.

### Tarefas

**Setup inicial:**
- [ ] Criar repositório `mo-limpezas` no GitHub
- [ ] Inicializar projeto Next.js 15 + TypeScript
- [ ] Configurar Tailwind CSS + shadcn/ui
- [ ] Configurar Supabase (projeto, variáveis de ambiente)
- [ ] Deploy inicial no Vercel (CI/CD automático)

**Base de dados:**
- [ ] Criar todas as tabelas (schema do doc 03)
- [ ] Configurar RLS policies
- [ ] Criar seed data para testes (colaboradores, clientes, locais fictícios)

**Autenticação:**
- [ ] Login admin/gestor (email + password)
- [ ] Login colaborador (email + magic link)
- [ ] Middleware de proteção de rotas por role
- [ ] Página de perfil

**CRUD base:**
- [ ] Gestão de Colaboradores (lista, criar, editar, arquivar)
- [ ] Gestão de Clientes (lista, criar, editar)
- [ ] Gestão de Locais (lista, criar, editar, mapa pin)
- [ ] Gestão de Equipas (criar, adicionar/remover membros)

**Layout:**
- [ ] Sidebar de navegação (como ServiSync)
- [ ] Header com utilizador logado
- [ ] Layout responsivo (funciona em mobile)

---

## Fase 2 — Calendário e Agendamento

**Duração estimada:** 3–4 semanas  
**Resultado:** Podes criar e gerir toda a escala de trabalho.

### Tarefas

- [ ] Integrar FullCalendar com vista semanal
- [ ] Mostrar colunas por equipa
- [ ] Criar serviço ao clicar numa célula (formulário rápido)
- [ ] Formulário completo de serviço (todos os campos)
- [ ] Cálculo automático de preço
- [ ] Drag & drop para reagendar
- [ ] Serviços recorrentes (formulário + lógica de geração)
- [ ] Editar "só esta ocorrência" vs "todas as futuras"
- [ ] Cores por estado (agendado, em curso, concluído)
- [ ] Filtros: por equipa, por local, por data
- [ ] Alerta de conflito de horário

**Job automático (Supabase Edge Function):**
- [ ] Gerar ocorrências do mês seguinte automaticamente
- [ ] Correr dia 25 de cada mês

### Bloco 2.6 — Modal de Alocação de Equipas a Viaturas

**Referência visual:** ServiSync → botão "Equipas" na barra do calendário → modal

**O que faz:**
- Botão **"Equipas"** na barra de navegação do calendário (ao lado de "Novo serviço")
- Abre um modal com duas colunas:
  - **Esquerda — ALOCADAS:** lista de equipas com os seus membros (tags coloridas) e dropdown de viatura (Opel / Corsa / Berlingo / próprio / etc.)
  - **Direita — DISPONÍVEL:** colaboradoras sem equipa atribuída para aquele dia
  - **Direita (baixo) — AUSENTES:** colaboradoras com falta/férias registada + horário
- Botão "Refazer" para recalcular sugestões de alocação
- Botão "+" junto a ALOCADAS para criar uma equipa temporária ad-hoc
- Guardar: persiste as viaturas na tabela `teams` (campo `vehicle`) e as ausências já vêm da tabela `absences`

**Dados necessários:**
- Adicionar coluna `vehicle varchar(50)` à tabela `teams`
- Query: colaboradoras disponíveis = profiles da empresa sem ausência no dia
- Query: ausentes = absences WHERE absence_date = selected_date

**Componentes a criar:**
- `src/app/(dashboard)/dashboard/calendario/_components/team-allocation-modal.tsx`
- Botão "Equipas" em `calendar-view.tsx` na barra de navegação

---

### Bloco 2.7 — Vista de Lista do Calendário

**Referência visual:** ServiSync → página "Supervisão" com tabela de presenças do dia

**O que faz:**
- Toggle entre **vista calendário** (atual) e **vista lista** na barra do calendário
- Filtros no topo: Data, Equipas (multi-select), Supervisores
- Tabela com colunas:
  - **NI** — número interno do colaborador
  - **Colaborador** — nome (link para detalhe)
  - **Abs.** — ícone de câmara/checkin (botão para abrir registo de ponto)
  - **Iníc. Prev. / Fim Prev.** — horário agendado do serviço
  - **→** — botão para propagar hora real (preencher início/fim real com o agendado)
  - **Início Real / Fim Real** — campos editáveis com timepicker + ícone de relógio
  - **Equipa** — badge colorida
  - **#Serviço** — referência do serviço (link para detalhe)
  - **Cliente** — nome + tipo de serviço + localidade
  - **NI Serv.** — número interno do serviço
- Botões: **Exportar** (CSV) e **Guardar** (salva edições de hora real em batch)
- Linhas com fundo colorido por equipa (igual ao ServiSync)

**Dados necessários:**
- Join: services × timesheets × profiles × teams × locations
- Server action para guardar edições em batch de `clock_in_at` / `clock_out_at`

**Componentes a criar:**
- `src/app/(dashboard)/dashboard/calendario/_components/calendar-list-view.tsx`
- `src/app/(dashboard)/dashboard/calendario/_components/list-row.tsx`
- Toggle de vista em `calendar-view.tsx`
- Server action: `app/actions/timesheets.ts` → `saveTimesheetBatch()`

---

## Fase 3 — App do Colaborador (PWA)

**Duração estimada:** 2–3 semanas  
**Resultado:** Colaboradores veem a sua escala no telemóvel e fazem registo de ponto.

### Tarefas

- [ ] Layout mobile-first (rotas /app/*)
- [ ] Ecrã Home: serviços de hoje
- [ ] Ecrã Escala semanal pessoal
- [ ] Ecrã Detalhe de serviço (morada, instruções, checklist)
- [ ] Botão "Navegar" → abre Google Maps
- [ ] Clock-in com geolocalização
- [ ] Clock-out com geolocalização
- [ ] Validação de proximidade (aviso se longe do local)
- [ ] PWA manifest + service worker (instalável no homescreen)
- [ ] Web Push notifications setup
- [ ] Enviar notificação quando serviço é criado/alterado/cancelado
- [ ] Painel gestão: estado em tempo real de todas as equipas

---

## Fase 4 — Operações Avançadas

**Duração estimada:** 2–3 semanas  
**Resultado:** Gestão completa de pessoas (férias, faltas, substituições) e visualização em mapa.

### Tarefas

**Absentismo:**
- [ ] Registo de faltas (tipo, data, quem registou)
- [ ] Motor de substituição automática (sugestões inteligentes)
- [ ] Impacto na escala (serviço fica sem colaborador → alerta)

**Férias:**
- [ ] Vista anual tipo spreadsheet (mapa de férias)
- [ ] Pedido de férias (colaborador via app)
- [ ] Aprovação pelo gestor
- [ ] Cálculo automático de saldo (dias usados/disponíveis)
- [ ] Alerta de muitas férias simultâneas

**Mapa:**
- [ ] Integrar Mapbox
- [ ] Vista de mapa com pins de serviços do dia
- [ ] Cores por equipa
- [ ] Detalhe ao clicar no pin
- [ ] Cálculo de rota por equipa
- [ ] Estimativa de tempo de deslocamento

**Relatórios:**
- [ ] Relatório por colaborador (horas, ocupação, faltas)
- [ ] Relatório por equipa
- [ ] Relatório por cliente/local
- [ ] Exportação PDF
- [ ] Exportação CSV

---

## Fase 5 — Módulo Financeiro

**Duração estimada:** 3–4 semanas  
**Dependência:** Respostas do user sobre regras de cálculo (ver doc 07)

### Tarefas

**Folha de Pagamento:**
- [ ] Fechamento mensal por colaborador
- [ ] Cálculo automático: horas trabalhadas × valor/hora
- [ ] Descontos: faltas injustificadas
- [ ] Outros ajustes manuais (subsídios, bónus, deduções)
- [ ] Aprovação e marcação como "pago"
- [ ] Exportação PDF por colaborador

**Faturação a Clientes:**
- [ ] Gerar fatura a partir de serviços concluídos no período
- [ ] Agrupar por cliente/mês
- [ ] Numeração automática (F2024/001, F2024/002, ...)
- [ ] Estados: rascunho → pendente → pago
- [ ] Marcação como pago com data
- [ ] Exportação PDF

**Dashboard Financeiro:**
- [ ] Receita do mês (faturas pagas + pendentes)
- [ ] Custos do mês (folha de pagamento)
- [ ] Margem bruta (receita - custos)
- [ ] Gráfico mensal (últimos 12 meses)
- [ ] Projeção do mês com base na escala

---

## Fase 6 — Polishing e Deploy em Produção

**Duração estimada:** 1–2 semanas

### Tarefas

- [ ] Testes com dados reais da Mó Limpezas
- [ ] Ajustes de UX baseados no feedback
- [ ] Migração do domínio (molimpezas.pt → Vercel)
- [ ] Configuração de emails transacionais (Supabase + Resend/SendGrid)
- [ ] Backup automático verificado
- [ ] Documentação de uso para gestores
- [ ] Documentação de uso para colaboradores

---

## Timeline Visual

```
Mês 1        Mês 2        Mês 3        Mês 4        Mês 5
│────────────│────────────│────────────│────────────│
│  Fase 0    │            │            │            │
│  (1-2 sem) │            │            │            │
│────────────│            │            │            │
│  Fase 1    │            │            │            │
│  (2-3 sem) │            │            │            │
│            │────────────│            │            │
│            │  Fase 2    │            │            │
│            │  (3-4 sem) │            │            │
│            │            │────────────│            │
│            │            │  Fase 3    │            │
│            │            │  (2-3 sem) │            │
│            │            │  Fase 4    │            │
│            │            │  (2-3 sem) │────────────│
│            │            │            │  Fase 5    │
│            │            │            │  (3-4 sem) │
│            │            │            │  Fase 6    │
│            │            │            │  (1-2 sem) │
```

**Total: 13–18 semanas** (dependendo do ritmo das sessões)

---

## O que é "uma sessão"?

Cada sessão de trabalho com Claude Code = 1–4 horas.  
Ritmo sugerido: 2–3 sessões por semana para manter momentum sem perder contexto.

---

## Decisões que Bloqueiam Fases

| Decisão | Bloqueia | Deadline sugerido |
|---------|---------|-------------------|
| Responder perguntas financeiras | Fase 5 | Antes de iniciar Fase 4 |
| Comprar domínio | Fase 6 | Qualquer momento |
| Criar conta Supabase | Fase 1 | Antes de começar |
| Criar conta Mapbox | Fase 4 | Antes de começar Fase 4 |
| FullCalendar Premium? | Fase 2 | Início da Fase 2 |
