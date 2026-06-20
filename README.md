# Escala — Plataforma de Gestão Mó Limpezas

Plataforma de gestão operacional para empresa de limpeza: agendamento, equipas, folha de pagamento, faturação e app mobile PWA.

**Stack:** Next.js 16 · TypeScript · Tailwind · shadcn/ui · Supabase · Mapbox · Vercel

---

## Deploy em Produção

### 1. Supabase

1. Cria um projeto em [supabase.com](https://supabase.com)
2. Aplica as migrations por ordem no SQL Editor:
   ```
   supabase/migrations/001_companies.sql
   supabase/migrations/002_profiles.sql
   supabase/migrations/003_clients_locations.sql
   supabase/migrations/004_teams.sql
   supabase/migrations/005_contracts.sql
   supabase/migrations/006_services.sql
   supabase/migrations/007_timesheets_absences.sql
   supabase/migrations/008_financial.sql
   supabase/migrations/009_notifications.sql
   supabase/migrations/010_views.sql
   supabase/migrations/011_conflict_detection.sql
   supabase/migrations/012_teams_vehicle.sql
   supabase/migrations/013_client_notifications.sql
   supabase/migrations/014_fix_rls_recursion.sql
   supabase/migrations/015_fix_trigger_resilient.sql
   supabase/migrations/016_vehicles.sql
   supabase/migrations/017_collaborator_documents.sql
   supabase/migrations/018_financial_practical.sql
   supabase/migrations/019_payroll.sql
   supabase/migrations/020_public_holidays.sql
   supabase/migrations/021_collaborator_documents_visibility.sql
   supabase/migrations/022_email_logs.sql
   supabase/migrations/023_fix_collaborator_documents_mime_types.sql
   supabase/migrations/024_timesheet_client_event_id.sql
   supabase/migrations/025_timesheet_performance_indexes.sql
   supabase/migrations/026_audit_logs.sql
   supabase/migrations/027_service_photos.sql
   supabase/migrations/028_growth_indexes.sql
   supabase/migrations/029_background_jobs.sql
   supabase/migrations/20260608_new_features.sql
   supabase/migrations/20260609_kanban_columns.sql
   supabase/migrations/20260609_profiles_hourly_rate.sql
   supabase/migrations/20260609_timesheet_limits.sql
   ```
3. Cria o primeiro utilizador (admin) manualmente em Authentication → Users
4. Copia o `project URL` e as chaves `anon` e `service_role`

### 2. Resend (emails transacionais)

1. Cria conta em [resend.com](https://resend.com)
2. Verifica o domínio `molimpezas.pt` (DNS)
3. Copia a API key

### 3. Mapbox

1. Cria conta em [mapbox.com](https://mapbox.com)
2. Copia o `Default public token`

### 4. Web Push (VAPID)

Gera as chaves VAPID:
```bash
npx web-push generate-vapid-keys
```

### 5. Vercel

1. Importa o repositório GitHub em [vercel.com](https://vercel.com)
2. Define as variáveis de ambiente (Settings → Environment Variables):

| Variável | Valor |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Chave anon do Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service_role do Supabase |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Token público do Mapbox |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Chave pública VAPID |
| `VAPID_PRIVATE_KEY` | Chave privada VAPID |
| `NEXT_PUBLIC_APP_URL` | URL de produção (ex: `https://escala.molimpezas.pt`) |
| `CRON_SECRET` | String aleatória longa para proteger os crons |
| `RESEND_API_KEY` | API key do Resend |
| `RESEND_FROM_EMAIL` | Ex: `Mó Limpezas <noreply@molimpezas.pt>` |
| `COMPANY_PHONE` | Telefone da empresa para templates |

3. Em Supabase → Authentication → URL Configuration:
   - **Site URL:** `https://escala.molimpezas.pt`
   - **Redirect URLs:** `https://escala.molimpezas.pt/**`

4. Faz deploy — os crons do `vercel.json` são ativados automaticamente

---

## Desenvolvimento Local

```bash
# Instalar dependências
npm install

# Copiar variáveis de ambiente
cp .env.example .env.local
# Preencher .env.local com as credenciais

# Iniciar servidor de desenvolvimento
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000).

---

## Crons Automáticos (Vercel)

| Cron | Schedule | Descrição |
|------|----------|-----------|
| `/api/cron/generate-services` | `0 6 25 * *` | Gera serviços do mês seguinte (dia 25 de cada mês) |
| `/api/keep-alive` | `0 8 * * *` | Ping diário para evitar hibernação do Supabase |

Os crons requerem o header `x-cron-secret` com o valor de `CRON_SECRET`.

---

## Documentacao Operacional

- [Mapa e GPS operacional](planning/docs/10-mapa-gps.md)
