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

### Bloco 2.8 — Avisos a Clientes (SMS + Email)

**Referência visual:** ServiSync → modal "Notificar Clientes" (bell icon na barra do calendário)

---

#### Parte A — Botão "Avisos" no calendário

**O que faz:**
- Ícone de sino 🔔 na barra de navegação do calendário com badge de contagem (quantos pendentes)
- Clique abre modal **"Notificar Clientes"** com:
  - Tabs: **Hoje** / **Amanhã** / **Próximos 3 dias**
  - Tabela com colunas: checkbox · **Estado** (badge Pendente/Enviado) · **Cliente** · **Data da Intervenção** · **Método** (SMS/Email) · **Contacto** (nº telemóvel ou email)
  - Checkboxes individuais + "Selecionar todos"
  - Botão **"Enviar"** — envia para todos os selecionados com estado Pendente
  - Nota informativa no rodapé do modal
  - Botão "Cancelar"

**Comportamento:**
- Só aparecem clientes com notificação ativa (`notification_enabled = true` na tabela `clients`)
- Cada serviço tem no máximo 1 notificação por tipo por dia (não enviar duplicados)
- Após enviar: estado muda para **Enviado** + timestamp registado
- O badge do sino decrementa à medida que se enviam

---

#### Parte B — Aba "Comunicação" na ficha do cliente

**Localização:** `/dashboard/clientes/[id]` → nova tab "Comunicação"

**O que mostra:**
- Toggle: notificações ativas/desativas para este cliente
- Método preferido: SMS / Email / Ambos
- Campo: número de telemóvel para SMS (pode ser diferente do contacto principal)
- Campo: email para notificações (pode ser diferente do email de faturação)
- **Histórico de avisos enviados:** tabela com data, tipo (serviço), método, estado (enviado/falhou), conteúdo da mensagem
- Botão **"Enviar aviso agora"** para o próximo serviço deste cliente

---

#### Implementação técnica

**Nova tabela: `client_notifications`**
```sql
id            uuid PK
company_id    uuid FK companies
service_id    uuid FK services
client_id     uuid FK clients
method        enum('sms', 'email')
status        enum('pendente', 'enviado', 'falhou')
sent_at       timestamptz nullable
message_body  text
error_message text nullable
created_at    timestamptz
```

**Colunas novas em `clients`:**
```sql
notification_enabled   boolean default false
notification_method    enum('sms','email','both') default 'sms'
notification_phone     varchar(20) nullable   -- pode diferir de contact_phone
notification_email     varchar(255) nullable  -- pode diferir de contact_email
```

**Providers de envio:**
- **Email:** Resend (já planeado em Fase 6) — `resend.emails.send()`
- **SMS:** [Twilio](https://www.twilio.com) ou [Link Mobility PT](https://www.linkmobility.com) — avaliar custo/país PT
  - Alternativa mais barata: [Vonage](https://www.vonage.com) (têm cobertura PT)
  - Custo estimado SMS PT: ~€0.04–0.07 por SMS

**Templates de mensagem (configuráveis em Configurações da empresa)**

> Variáveis disponíveis: `[NOME]` `[DIA_SEMANA]` `[DATA]` `[HORA]` `[MORADA]` `[TELEFONE_EMPRESA]`

**Template SMS** (≤ 160 chars, sem acentos — compatível com todos os gateways):
```
Mo Limpezas: Ola [NOME], lembramos a sua limpeza amanha [DIA_SEMANA] as [HORA]
em [MORADA]. Para cancelar ou reagendar: [TELEFONE_EMPRESA]. Obrigado!
```
*Valor padrão de [TELEFONE_EMPRESA]: 925 780 509*

**Template WhatsApp** (suporta markdown Bold/Italic, emojis, sem limite de chars):
```
Olá [NOME] 👋

A *Mó Limpezas Lda* recorda-lhe o serviço agendado:

📅 Amanhã, [DIA_SEMANA] [DATA]
🕐 [HORA]
📍 [MORADA]

Caso não necessite do serviço ou queira reagendar, contacte-nos:
📞 [TELEFONE_EMPRESA]

Obrigado pela confiança! 🌿
```

**Template Email** — assunto + corpo HTML:
```
Assunto: Lembrete — Limpeza amanhã às [HORA] | Mó Limpezas Lda

Corpo: logo da empresa + mesmo conteúdo do WhatsApp formatado em HTML
       + botão CTA "Ligar agora" → tel:[TELEFONE_EMPRESA]
       + rodapé com morada da empresa
```

**Notas de implementação dos templates:**
- Templates guardados em `company_settings.notification_templates` (JSONB)
- Editor de template em Configurações → Comunicação
- Preview em tempo real com dados de exemplo ao editar
- Se o template SMS ultrapassar 160 chars → aviso automático no editor

**Template Email:** HTML simples com logo + info do serviço + link de confirmação opcional

**Server actions a criar:**
- `app/actions/notifications.ts`
  - `getPendingNotifications(companyId, date)` — lista pendentes
  - `sendNotification(notificationId)` — envia 1
  - `sendBulkNotifications(ids[])` — envia vários
  - `markNotificationSent(id)` — actualiza estado

**Componentes a criar:**
- `src/app/(dashboard)/dashboard/calendario/_components/notifications-modal.tsx`
- `src/app/(dashboard)/dashboard/clientes/[id]/_components/communication-tab.tsx`
- Badge no sino em `calendar-view.tsx` (query count de pendentes)

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
