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

**[PRÉ-REQUISITO]** O user precisa de criar o projeto Supabase e partilhar:
- Project URL
- anon public key
- service_role key

Quando o user fornecer as credenciais, a primeira task de código é:

**[1.1] Reorganizar repo + inicializar Next.js 15**

---

## Lista Completa de Tasks

### FASE 1 — Fundação
- [ ] PRÉ-REQUISITO: Credenciais Supabase
- [ ] [1.1] Reorganizar repo: mover planning docs para pasta planning/
- [ ] [1.1] Inicializar Next.js 15 + TypeScript na raiz
- [ ] [1.1] Instalar Tailwind CSS v4 + shadcn/ui (tema verde #16A34A)
- [ ] [1.1] Instalar Supabase client + criar lib/supabase/
- [ ] [1.1] Criar .env.local + .gitignore + verificar deploy Vercel
- [ ] [1.2] Migration: companies + company_settings
- [ ] [1.2] Migration: profiles (roles, contrato, valor hora, skills)
- [ ] [1.2] Migration: clients + locations
- [ ] [1.2] Migration: teams + team_members
- [ ] [1.2] Migration: contracts (array [{dia, hora, duracao, equipa_id}])
- [ ] [1.2] Migration: services + service_reinforcements + service_price_audit
- [ ] [1.2] Migration: timesheets + absences + vacation_requests
- [ ] [1.2] Migration: invoices + invoice_items + payroll_records
- [ ] [1.2] Migration: notifications + push_subscriptions
- [ ] [1.2] RLS policies por role + trigger criar profile
- [ ] [1.2] Seed.sql: 1 empresa, 3 equipas, 6 colaboradores, 5 clientes, 10 locais
- [ ] [1.3] Página /login + recuperação de password
- [ ] [1.3] Magic link colaboradoras + fluxo de convite por email
- [ ] [1.3] Middleware Next.js: proteger rotas por role
- [ ] [1.3] Ecrã onboarding colaboradora (boas-vindas + instalar PWA)
- [ ] [1.4] Dashboard operacional: visão do dia
- [ ] [1.4] Centro de notificações (sino no header)
- [ ] [1.4] Sidebar + Header
- [ ] [1.4] Layout dashboard + loading skeletons + 404
- [ ] [1.5] Página /colaboradores: tabela + pesquisa + paginação
- [ ] [1.5] Sheet criar/editar colaborador + upload foto + skills
- [ ] [1.5] Detalhe colaborador: histórico + exportação PDF
- [ ] [1.5] Inicialização saldo de férias por colaboradora
- [ ] [1.6] Página /clientes + histórico de serviços
- [ ] [1.7] Página /locais + geocoding + histórico
- [ ] [1.8] Página /equipas + disponibilidade semanal
- [ ] [1.8] COMMIT Fase 1

### FASE 2 — Calendário
- [ ] [2.1] Página /contratos: lista + criar/editar + preview ocorrências
- [ ] [2.2] Instalar dnd-kit + date-fns
- [ ] [2.2] Calendário CSS Grid: colunas por equipa × linhas por hora
- [ ] [2.2] Blocos coloridos por estado + navegação semanal
- [ ] [2.3] Criar serviço pontual (clique em célula)
- [ ] [2.3] Painel lateral de detalhe do serviço
- [ ] [2.3] Gestão de estado: cancelar, falta, corrigir clock-out
- [ ] [2.4] Drag & drop reagendar + mudar equipa
- [ ] [2.4] Deteção de conflito de horário
- [ ] [2.5] Edge Function: gerar ocorrências dia 25
- [ ] [2.5] COMMIT Fase 2

### FASE 3 — App Mobile (PWA)
- [ ] [3.1] Layout /app/* + bottom navigation + deteção mobile
- [ ] [3.2] Ecrã Home: serviços do dia
- [ ] [3.2] Ecrã detalhe do serviço + botão Navegar
- [ ] [3.2] Ecrã escala semanal + perfil
- [ ] [3.3] Clock-in com GPS
- [ ] [3.3] Clock-out com GPS
- [ ] [3.3] Painel tempo real (Supabase Realtime)
- [ ] [3.4] PWA: manifest + service worker
- [ ] [3.4] Web Push: VAPID + notificações
- [ ] [3.4] Google Calendar API
- [ ] [3.4] COMMIT Fase 3

### FASE 4 — Operações
- [ ] [4.1] Registo de faltas + motor de substituição
- [ ] [4.2] Mapa de férias + pedidos + aprovação + alerta simultâneas
- [ ] [4.3] Mapa Mapbox + rotas otimizadas
- [ ] [4.4] Relatórios: horas, absentismo, receita, serviços
- [ ] [4.4] Extrato PDF por cliente + exportação CSV
- [ ] [4.4] COMMIT Fase 4

### FASE 5 — Financeiro
- [ ] [5.1] Folha de pagamento + PDF
- [ ] [5.2] Documento de cobrança + PDF + CSV
- [ ] [5.3] Dashboard financeiro: KPIs + gráficos + projeção
- [ ] [5.3] COMMIT Fase 5

### FASE 6 — Produção
- [ ] [6.1] Importação CSV (colaboradoras, clientes, locais)
- [ ] [6.2] Emails transacionais (Resend)
- [ ] [6.3] Anti-hibernação Supabase
- [ ] [6.4] Página de Configurações
- [ ] [6.5] Testes com dados reais
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
