# CLAUDE.md — Plataforma Escala (Mó Limpezas)

Lê este ficheiro no início de CADA sessão antes de fazer qualquer coisa.

---

## O Projeto

**Nome:** Escala — plataforma de gestão operacional para empresa de limpeza
**Empresa cliente:** Mó Limpezas (Portugal)
**Repositório GitHub:** github.com/ShadowShtr/mo-limpezas
**Stack:** Next.js 15 + TypeScript + Tailwind + shadcn/ui + Supabase + Mapbox + PWA

---

## Onde Está Tudo

| O quê | Onde |
|-------|------|
| Todas as decisões tomadas | `planning/docs/08-decisions-log.md` |
| Base de dados (schema completo) | `planning/docs/03-database-schema.md` |
| Funcionalidades detalhadas | `planning/docs/01-features.md` |
| Sistema de design (cores, componentes) | `planning/docs/09-design-system.md` |
| Stack tecnológica justificada | `planning/docs/02-tech-stack.md` |
| Roadmap por fases | `planning/docs/05-roadmap.md` |
| Módulo financeiro | `planning/docs/07-financial-module.md` |

---

## Decisões Chave (resumo para não ler tudo)

- **Multi-tenancy:** `company_id` em todas as tabelas
- **Cor:** verde `#16A34A` (Tailwind green-600)
- **Fonte:** Inter
- **Ícones:** Lucide
- **Calendário:** construído do zero com CSS Grid + dnd-kit (sem FullCalendar)
- **Mobile:** PWA em `/app/*` — mesmo Next.js, layout diferente
- **Equipa:** unidade indivisível — vão sempre todas juntas
- **Clock-in/out:** GPS, só avisa se longe (nunca bloqueia)
- **Contratos Fixos:** secção separada do calendário, equipa diferente por dia
- **Salário:** mesmo valor hora para todos, configurável globalmente
- **Sub. alimentação:** transferência no salário, `dias × €9,60` configurável
- **Faturação:** por serviço, IVA 23%, contabilista emite a fatura legal
- **Notificações:** Web Push (principal) + email (fallback)

---

## ⚡ PRÓXIMA TASK A EXECUTAR

**Próxima task de código:** `[6.6] COMMIT final + deploy produção`

---

## 📍 PONTO DE PARAGEM — 2026-06-05

**Última sessão completou:**
- [6.5] Testes com dados reais — revisão estática completa
  - `src/types/database.ts` — Insert types de `services` e `timesheets` com todos os campos opcionais; `push_subscriptions` já tipado
  - `src/app/actions/payroll.ts`, `invoices.ts`, `reports.ts`, `notifications.ts` — removidos `as any` em queries `company_settings` e `push_subscriptions`
  - `service-create-sheet.tsx`, `api/app/timesheet/route.ts` — removidos `as any` nos inserts
  - Build e TypeScript 100% limpos

**Último commit:** `[6.5]` — github.com/ShadowShtr/mo-limpezas

**Migrations pendentes (aplicar no Supabase antes de testar):**
- `supabase/migrations/011_conflict_detection.sql`
- `supabase/migrations/012_teams_vehicle.sql`
- `supabase/migrations/013_client_notifications.sql`
- `supabase/migrations/016_vehicles.sql`

**Config necessária antes de testar emails:**
- Criar conta em resend.com + obter API key
- Verificar domínio `molimpezas.pt` no Resend (ou usar `onboarding@resend.dev` em dev)
- Preencher `.env.local` com `RESEND_API_KEY` e `RESEND_FROM_EMAIL`

**A seguir: FASE 6 — [6.6] COMMIT final + deploy produção**

---

## Lista Completa de Tasks

### FASE 1 — Fundação
- [x] PRÉ-REQUISITO: .env.local preenchido com credenciais Supabase
- [x] PRÉ-REQUISITO: Migrations aplicadas + seed (companies, clients, locations, teams)
- [x] [1.1] Reorganizar repo: mover planning docs para pasta planning/
- [x] [1.1] Inicializar Next.js 15 + TypeScript na raiz
- [x] [1.1] Instalar Tailwind v4 + shadcn/ui (tema verde #16A34A)
- [x] [1.1] Instalar Supabase client + criar lib/supabase/
- [x] [1.1] Criar .env.local + .gitignore + .env.example
- [x] [1.2] Migration 001: companies + company_settings
- [x] [1.2] Migration 002: profiles + auth trigger
- [x] [1.2] Migration 003: clients + locations
- [x] [1.2] Migration 004: teams + team_members
- [x] [1.2] Migration 005: contracts (schedule_days JSONB por dia)
- [x] [1.2] Migration 006: services + reinforcements + price_audit
- [x] [1.2] Migration 007: timesheets + absences + vacation_requests
- [x] [1.2] Migration 008: invoices + invoice_items + payroll_records
- [x] [1.2] Migration 009: notifications + push_subscriptions
- [x] [1.2] Migration 010: views (services_full, monthly_hours, teams_with_members)
- [x] [1.2] RLS policies em todas as tabelas (incluídas nas migrations)
- [x] [1.2] Seed.sql: 1 empresa, 3 equipas, 5 clientes, 6 locais
- [x] [1.3] Página /login + recuperação de password
- [x] [1.3] Magic link colaboradoras + fluxo de convite (inviteCollaborator action)
- [x] [1.3] Middleware Next.js: proteger rotas por role
- [x] [1.3] Ecrã onboarding colaboradora (boas-vindas + instalar PWA)
- [x] [1.4] Dashboard operacional: visão do dia (KPIs + serviços + alertas)
- [x] [1.4] Centro de notificações (sino no header com Realtime)
- [x] [1.4] Sidebar + Header
- [x] [1.4] Layout dashboard + loading skeletons + 404
- [x] [1.5] Página /colaboradores: tabela + pesquisa + filtros + paginação
- [x] [1.5] Sheet criar/editar colaborador + gestão de skills + enviar convite
- [x] [1.5] Detalhe colaborador: histórico de presenças + saldo férias editável
- [x] [1.6] Página /clientes: tabela + sheet criar/editar
- [x] [1.7] Página /locais: tabela + sheet com geocoding (Nominatim)
- [x] [1.8] Página /equipas: grid de cards + sheet com selector de membros
- [x] [1.8] COMMIT Fase 1

### FASE 2 — Calendário
- [x] [2.1] Página /contratos: lista + criar/editar + preview ocorrências
- [x] [2.2] Instalar dnd-kit + date-fns
- [x] [2.2] Calendário CSS Grid: colunas por equipa × linhas por hora
- [x] [2.2] Blocos coloridos por estado + navegação semanal
- [x] [2.3] Criar serviço pontual (clique em célula)
- [x] [2.3] Painel lateral de detalhe do serviço
- [x] [2.3] Gestão de estado: cancelar, falta, corrigir clock-out
- [x] [2.4] Drag & drop reagendar + mudar equipa
- [x] [2.4] Deteção de conflito de horário
- [x] [2.5] Edge Function: gerar ocorrências dia 25
- [x] [2.5] COMMIT Fase 2
- [x] [2.6] Modal de alocação de equipas a viaturas (botão "Equipas" no calendário)
- [x] [2.7] Vista de lista do calendário (toggle tabela/calendário)
- [x] [2.8] Botão "Avisos" no calendário — modal Notificar Clientes (SMS + Email)
- [x] [2.8] Aba "Comunicação" na ficha do cliente (histórico + enviar aviso)

### FASE 3 — App Mobile (PWA)
- [x] [3.1] Layout /app/* + bottom navigation + deteção mobile
- [x] [3.2] Ecrã Home: serviços do dia
- [x] [3.2] Ecrã detalhe do serviço + botão Navegar
- [x] [3.2] Ecrã escala semanal + perfil
- [x] [3.3] Clock-in com GPS
- [x] [3.3] Clock-out com GPS
- [x] [3.3] Painel tempo real (Supabase Realtime)
- [x] [3.4] PWA: manifest + service worker
- [x] [3.4] Web Push: VAPID + notificações
- [x] [3.4] Google Calendar API
- [x] [3.4] COMMIT Fase 3

### FASE 4 — Operações
- [x] [4.1] Registo de faltas + motor de substituição
- [x] [4.2] ~~Mapa de férias~~ — removido a pedido (faltas integradas na ficha do colaborador)
- [x] [4.3] Mapa Mapbox + rotas otimizadas
- [x] [4.4] Relatórios: horas, absentismo, receita, serviços
- [x] [4.4] Extrato PDF por cliente + exportação CSV
- [x] [4.5] Gestão de viaturas + alocação diária no modal "Equipas"
- [x] [4.4] COMMIT Fase 4

### FASE 5 — Financeiro
- [x] [5.1] Folha de pagamento + PDF
- [x] [5.2] Documento de cobrança + PDF + CSV
- [x] [5.3] Dashboard financeiro: KPIs + gráficos + projeção
- [x] [5.3] COMMIT Fase 5

### FASE 6 — Produção
- [x] [6.1] Importação CSV (colaboradoras, clientes, locais)
- [x] [6.2] Emails transacionais (Resend)
- [x] [6.3] Anti-hibernação Supabase
- [x] [6.4] Página de Configurações
- [x] [6.5] Testes com dados reais
- [ ] [6.6] COMMIT final + deploy produção ✅

---

## Como Trabalhar em Cada Sessão

1. Abre o Claude Code nesta pasta
2. Claude lê este ficheiro automaticamente
3. Diz: **"próxima task"** — Claude executa a primeira [ ] da lista acima
4. Quando terminar, Claude marca `[x]` e atualiza "PRÓXIMA TASK" no topo
5. Commit + push
6. Fecha e volta quando quiseres

---

## Regras para o Claude

- Seguir o design system de `planning/docs/09-design-system.md` em tudo
- Verde `#16A34A` como cor primária, nunca outra
- Fonte Inter em todo o projeto
- Ícones sempre Lucide
- Commits em português, descritivos
- Nunca pular tasks — executar por ordem
- Após cada task: marcar `[x]` neste ficheiro + commit
