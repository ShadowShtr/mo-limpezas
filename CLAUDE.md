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

**Próxima task:** Aplicar migration 021 no Supabase (via Management API ou `npx supabase db query --linked`). Criar bucket `collaborator-documents` no Supabase Storage (50MB limite, PDF+imagem). Depois: verificar domínio `molimpezas.pt` no Resend.

---

## 📍 PONTO DE PARAGEM — 2026-06-15 (sessão 4)

**Última sessão completou — 3 funcionalidades grandes**

### Testes Concorrentes (✅ FEITO)
- `src/__tests__/clockin-concurrent.test.ts` — 30 testes novos, total: 250 passando
- 8 blocos: isolamento de dados, guard `actual_start`, transição `concluido`, cálculos de duração, `parsePastTimestamp`, janela horária 8h00, isolamento entre serviços, double clock-in
- Cobre o cenário real: 35 funcionárias a dar clock-in/out às 8h em simultâneo

### Glassmorphism (✅ FEITO)
- `globals.css`: gradient de fundo verde→branco→azul subtil + variáveis `--glass-*`
- Sidebar, header, mobile-header, app-header, bottom-nav: `backdrop-filter blur(14px)` + `bg rgba(255,255,255,0.82/0.92)`
- KPI cards dashboard + cards perfil app com glass effect

### Sistema de Documentos (✅ FEITO — MIGRATION PENDENTE)
- **Migration 021** — `supabase/migrations/021_documents_enhanced.sql` — AINDA NÃO APLICADA
  - Adiciona: `visible_to_collaborator`, `notes`, `expires_at`, `archived_at`, `uploaded_by_role`
  - Categoria `avaria` adicionada
  - Funções SQL: `get_documents_to_archive()`, `archive_expired_documents()`
- **Bucket Storage**: `collaborator-documents` — CRIAR NO SUPABASE (50MB, PDF+imagem)
- **Admin**: `documento-section.tsx` atualizado — upload com visibilidade, notas, categoria avaria, aviso de expiração
- **App mobile**: `/app/perfil` — secção de documentos colapsável: folhas de salário + reportar avaria com câmara
- **Cron** `/api/cron/archive-documents` — dia 1 de cada mês às 02:00 — arquiva manifesto JSON organizado por funcionária → apaga do storage

### ⚠️ PENDENTE PARA FUNCIONAR
1. Aplicar migration 021 no Supabase
2. Criar bucket `collaborator-documents` no Storage (Supabase Dashboard → Storage → New Bucket)
3. Limites por empresa: ~150 MB/3meses (35 func × 5 docs × 1MB) — Free tier OK

---

## 📍 PONTO DE PARAGEM — 2026-06-09 (sessão 3)

**Última sessão completou — Módulo Financeiro: Visual + Dados + Folha de Pagamento**

### Kanban de Tarefas — Fix Visual (✅ FEITO)
- **Problema:** Colunas sem container próprio, cards encostados às paredes, contagem transbordar
- **Fix:** `src/app/(dashboard)/dashboard/tarefas/_components/tasks-client.tsx`
  - Cada coluna agora tem `flex flex-col bg-[var(--color-background)] rounded-xl border ... min-h-[300px]`
  - Header branco separado do body por `border-b`, com border-left colorida (âmbar/azul/verde)
  - Body com `p-3` — cards respiram dentro da coluna
  - Empty state com borda tracejada centrada

### Contas a Pagar e a Receber — Fix + Expansão (✅ FEITO)
- **Bug corrigido:** Query Supabase ambígua em `getAccountsData` (`payroll_records` tem FK `collaborator_id` E `approved_by` ambas para `profiles`). Fix: `.select("profiles!collaborator_id(full_name)")`
- **Ficheiro:** `src/app/actions/cash-flow.ts`

- **Novo: Secção de Despesas Pendentes**
  - `getAccountsData` agora retorna também `expenses: PendingExpense[]` — saídas manuais `cash_flow_entries` com `status="pendente"` e `reference_type IS NULL`
  - `src/app/(dashboard)/dashboard/financeiro/contas/_components/contas-client.tsx` reescrito:
    - **3 KPI cards:** A Receber (verde) / A Pagar Salários (vermelho) / A Pagar Despesas (âmbar)
    - **Tabela "Despesas Pendentes":** data, descrição, categoria, valor, botão "Pago" (→ `updateCashFlowEntry status=confirmado`) + eliminar
    - **Sheet "Registar despesa":** campos descrição, valor, categoria (despesa/fornecedor/avaria), data, notas → `createCashFlowEntry(type="saida", status="pendente")`

### Cobranças — Serviços Por Faturar (✅ FEITO)
- **Nova função:** `getUnbilledServices(companyId)` em `src/app/actions/invoices.ts`
  - Busca serviços `status=concluido` dos últimos 60 dias
  - Cruza com `invoice_items.service_id` para excluir os já faturados
  - Retorna: id, reference_number, client_name, location_name, scheduled_start, actual_end, value
- **UI em Cobranças** (`src/app/(dashboard)/dashboard/cobrancas/_components/invoices-client.tsx`):
  - Banner âmbar "N serviços por faturar" com lista de cliente/local/data/valor
  - Botão "Gerar cobranças" tem contador âmbar com número de pendentes
  - Ao clicar "Gerar cobranças" → `generateInvoices()` cria faturas para todos → banner desaparece

### Folha de Pagamento — Totalmente Editável (✅ FEITO)
- **Expandido `PayrollAdjust`** em `src/app/actions/payroll.ts`:
  - Novos campos: `worked_hours`, `overtime_hours`, `absence_hours`, `absence_deductions`, `days_worked`
  - `adjustPayrollRecord` recalcula `gross_salary`, `meal_allowance`, `overtime_bonus` e `net_salary` automaticamente
- **Sheet reescrita** `src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-edit-sheet.tsx`:
  - **Secção "Correções de Horas":** horas trabalhadas, horas extra, dias trabalhados, horas de falta, descontos por falta (€)
  - **Secção "Ajustes Manuais":** acréscimos € + descontos €
  - Preview do líquido **atualizado em tempo real** com fórmula visível

### Fluxo de Caixa — Problema pendente (✅ RESOLVIDO — 2026-06-09)
- Migrations `20260608_new_features.sql` e `20260609_timesheet_limits.sql` aplicadas via `npx supabase db query --linked`
- Tabelas criadas: `cash_flow_entries`, `collaborator_documents`, `management_tasks`
- Colunas adicionadas em `company_settings`: `checkin_before_minutes`, `checkout_after_minutes`
- Migrations 011, 012, 013 também aplicadas nesta sessão

---

## 📍 PONTO DE PARAGEM — 2026-06-08 (sessão 2)

**Última sessão completou — Correções de produção + Cancelamentos + Notificações**

### Migrations aplicadas via Supabase Management API (✅ FEITAS)
- **018** — RLS recursion fix: `get_service_company_id()` SECURITY DEFINER + políticas corretas
- **019** — Colunas de cancelamento em `services`: `cancel_type`, `cancel_reason`, `cancelled_at`, `cancelled_by`, `is_late_cancel`
- **020** — View `services_full` recriada com `client_phone` e `client_email`
- Migrations 011, 012, 013, 016 — **APLICADAS** (011/012/013 em 2026-06-09, 016 já estava)

### Funcionalidade de Cancelamentos (✅ IMPLEMENTADA)
- `src/app/actions/cancellations.ts` — server action `cancelService()`: detecta cancelamento tardio (<24h), actualiza status + campos cancel_*, notifica equipa via push
- `src/lib/cancel-types.ts` — **NOVO** ficheiro separado com `CancelType` e `CANCEL_TYPE_LABELS` (fora de "use server" — Next.js 15 não permite exportar objetos de ficheiros "use server")
- Painel de cancelamento no `service-detail-sheet.tsx`: pills de motivo, textarea livre, toggle notificar equipa, botão wa.me para avisar cliente

### Bug Crítico Corrigido — "use server" exportando objeto
- **Erro:** `Error: A "use server" file can only export async functions, found object`
- **Causa:** `cancellations.ts` exportava `CANCEL_TYPE_LABELS` (objeto) de ficheiro com `"use server"` — bloqueava TODAS as notificações no calendário
- **Fix:** Movido para `src/lib/cancel-types.ts` sem diretiva "use server"

### Painel de Notificações no Calendário (✅ IMPLEMENTADO)
- 3 tabs: **WhatsApp** (wa.me link) | **Email** (Resend) | **Equipa** (push)
- WhatsApp: link `wa.me` com mensagem pré-preenchida — abre app do utilizador
- Email: `sendBulkClientNotifications` via Resend
- Equipa: `notifyTeam` via Web Push VAPID

### Server Actions — Padrão Global Try/Catch (✅ IMPLEMENTADO)
- Todas as server actions agora têm wrapper: função pública chama função privada `_fn` em try/catch
- Nunca lançam exceção → cliente recebe sempre `{ ok: false, error: "msg real" }` em vez do erro genérico do Next.js
- Afectou: `notifyTeam`, `sendBulkClientNotifications`, `cancelService`

### Locais — Sheet Reescrita (✅ IMPLEMENTADA)
- Autocomplete de morada via Nominatim (OSM) com debounce 420ms
- Campos estruturados: rua, número, complemento, código postal, cidade
- Lat/lng calculados automaticamente (removidos campos manuais)
- Fecha automaticamente após guardar + `router.refresh()`
- Guard `if (loading) return` para evitar duplo submit

### Emails — Diagnóstico e Fix Temporário
- **Problema:** Domínio `molimpezas.pt` adicionado ao Resend mas DNS records NUNCA foram adicionados ao registar do domínio → STATUS: Failed
- **Erro API:** `403 The molimpezas.pt domain is not verified`
- **Fix temporário aplicado:** `RESEND_FROM_EMAIL` no Vercel alterado para `Mo Limpezas <onboarding@resend.dev>` — emails funcionam agora mas remetente aparece como `onboarding@resend.dev`
- **Para corrigir permanentemente:** Adicionar os registos DNS do Resend no registar do domínio `molimpezas.pt` → clicar Restart no Resend → atualizar `RESEND_FROM_EMAIL` de volta para `Mo Limpezas <noreply@molimpezas.pt>`

### Vercel e Supabase CLI configurados localmente
- `vercel` CLI instalado globalmente + login com conta `shadowshtr`
- `npx supabase` CLI + login com token `sbp_b78fd974755706008439101acdcc53b64875000f` (expira 30 dias — ~2026-07-08)
- Todos os env vars confirmados no Vercel: SUPABASE keys, RESEND, VAPID, MAPBOX, CRON_SECRET, COMPANY_PHONE

### WhatsApp
- Decisão: manter **wa.me** (gratuito, 1 clique manual) — sem API externa
- `src/app/actions/whatsapp.ts` existe com implementação Meta Cloud API (gratuita até 1000 msg/mês) — **não activa**, para uso futuro se necessário
- Botão WhatsApp no cancelamento e no painel de notificações → abre wa.me com mensagem pré-preenchida

---

## 📍 PONTO DE PARAGEM — 2026-06-08 (sessão 1)

**Última sessão completou — Correções críticas de produção:**

### Mapa (map-view.tsx)
- **Bug:** `mapStyle` iniciava como `FALLBACK_STYLE` → a lógica de fallback (`!usingFallbackStyle`) nunca disparava → mapa sempre mostrava "Mapa indisponível"
- **Fix:** Mapa sempre inicia com `MAPBOX_STYLE`; adicionado estado `mapKey` que força remount via `key={mapKey}` quando há erro; `mapTotalFailure` para quando até o fallback falha
- **CSP:** Adicionado `https://*.cartocdn.com` ao `connect-src` e `img-src` em `next.config.ts` (tiles CartoCDN estavam a ser bloqueados no Vercel)

### Equipas — membros não guardavam
- **Bug:** `EquipaSheet` usava o cliente Supabase browser para INSERT em `team_members`. RLS bloqueava silenciosamente. Sem tratamento de erro → sempre mostrava sucesso falso
- **Fix:** Criado `src/app/actions/equipas.ts` — server action com `createAdminClient()` que: verifica auth + role, faz update/insert da equipa, substitui membros, retorna erros tipados
- **Fix:** Página de equipas (`page.tsx`) alterada para usar `admin` client na query à view `teams_with_members` (RLS filtrava membros para arrays vazios)

### RLS recursão infinita em services
- **Bug:** Migration 014 criou novas políticas mas não apagou as originais de 006 (nomes diferentes → `DROP IF EXISTS` nunca as encontrou)
- **Ciclo:** `services` → política "collaborators see own services" → consulta `service_reinforcements` → política "company reinforcements" → consulta `services` → **loop**
- **Fix:** `supabase/migrations/018_fix_services_rls_recursion.sql`

**Migrations ✅ APLICADAS (via Management API nesta sessão):**
- 018 — RLS recursion fix
- 019 — Campos cancelamento
- 020 — services_full com client_phone/email

---

## 📍 PONTO DE PARAGEM — 2026-06-06

**Última sessão completou — Auditoria Interna de Segurança e Qualidade:**

### Segurança
- `next.config.ts` — adicionado **CSP** completo (Mapbox, Supabase, Resend) + **HSTS** (1 ano)
- `src/app/api/seed-demo/route.ts` — bloqueado em `NODE_ENV=production` (403)
- `src/app/api/cron/generate-services/route.ts` — guard contra `CRON_SECRET` vazio
- `src/app/api/keep-alive/route.ts` — guard contra `CRON_SECRET` vazio

### Rate Limiting Anti-Spam/DDoS
- `src/lib/rate-limit.ts` — **NOVO** helper em memória com janelas deslizantes
- `/api/app/timesheet` (POST + PATCH) — máx 10 req/min por utilizador
- `/api/push/send` — máx 20 req/min por empresa
- `auth.ts` — login: 5/min por IP; magic link: 3/min; reset password: 3 em 5min

### Bug Crítico Corrigido
- `src/app/actions/absences.ts` — query de substituição usava `team_id = "placeholder"` (nunca funcionou). Agora faz lookup real via `team_members` para encontrar as equipas do colaborador.

### Validação de Inputs (Zod)
- `src/app/actions/auth.ts` — email RFC + password mínima 6 chars
- `src/app/actions/colaboradores.ts` — nome, email, role, status, horas, skills
- `src/app/actions/settings.ts` — IVA 0-100%, taxa horária, raio GPS 10-50000m
- `src/app/actions/email.ts` — validação RFC de email (substituiu `.includes("@")`)

### UX — Componentes Novos
- `src/components/ui/toast.tsx` — **NOVO** sistema de toast global (`useToast()`)
- `src/components/ui/confirm-dialog.tsx` — **NOVO** dialog de confirmação reutilizável
- `src/app/layout.tsx` — integrado `<ToastProvider>`

### Cálculos Partilhados
- `src/lib/calculations.ts` — **NOVO** módulo com `haversineDistanceM`, `calcServiceValue`, `calcMonthlyGross`, `isValidCoord`
- `/api/app/timesheet/route.ts` — usa `haversineDistanceM` do módulo partilhado

### Testes Automatizados (39 testes, todos a passar)
- `vitest.config.ts` — **NOVO** configuração Vitest
- `src/__tests__/calculations.test.ts` — haversine GPS, valor serviço, salário mensal
- `src/__tests__/rate-limit.test.ts` — limites, reset de janela, isolamento de chaves
- `src/__tests__/validation.test.ts` — coordenadas GPS, edge cases de cálculo
- Executar: `npm test`

**Migrations aplicadas (✅ todas resolvidas em 2026-06-09):**
- `supabase/migrations/011_conflict_detection.sql` ✅
- `supabase/migrations/012_teams_vehicle.sql` ✅
- `supabase/migrations/013_client_notifications.sql` ✅
- `supabase/migrations/016_vehicles.sql` ✅ (já estava)
- `supabase/migrations/20260608_new_features.sql` ✅
- `supabase/migrations/20260609_timesheet_limits.sql` ✅

**Config necessária antes de testar emails:**
- Criar conta em resend.com + obter API key
- Verificar domínio `molimpezas.pt` no Resend
- Preencher `.env.local` com `RESEND_API_KEY` e `RESEND_FROM_EMAIL`

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
- [x] [6.6] COMMIT final + deploy produção ✅

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
