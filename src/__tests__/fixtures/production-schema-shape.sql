-- GERADO por scripts/dump-production-rls-baseline.mjs — NÃO EDITAR À MÃO.
-- Forma do schema de produção: tabelas, chaves, RLS e políticas. Sem dados.
-- É a fidelidade que faltava: o baseline escrito à mão conhecia 3 das 6
-- políticas de `profiles` e 2 das 8 de `timesheets`.

CREATE TABLE public._migrations (
  name text NOT NULL,
  checksum text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name)
);
CREATE TABLE public.absences (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  absence_type text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  notes text,
  document_url text,
  replaced_by uuid,
  approved_by uuid,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.app_notice_reads (
  profile_id uuid NOT NULL,
  notice_key text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, notice_key)
);
CREATE TABLE public.app_notice_targets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL,
  company_id uuid,
  profile_id uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.app_notices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  notice_key text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  audience text NOT NULL DEFAULT 'all'::text,
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.attachments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  parent_type text NOT NULL,
  parent_id uuid NOT NULL,
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,
  original_name text NOT NULL,
  mime_type text,
  size_bytes int8,
  client_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL DEFAULT 'timesheet'::text,
  entity_id text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.background_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  type text NOT NULL,
  status text NOT NULL DEFAULT 'running'::text,
  company_id uuid,
  cursor int4 NOT NULL DEFAULT 0,
  total int4 NOT NULL DEFAULT 0,
  processed int4 NOT NULL DEFAULT 0,
  failed int4 NOT NULL DEFAULT 0,
  last_error text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  job_key text,
  PRIMARY KEY (id)
);
CREATE TABLE public.bank_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  bank_name text NOT NULL,
  account_name text NOT NULL,
  iban_last4 text,
  currency text NOT NULL DEFAULT 'EUR'::text,
  is_active bool NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.bank_reconciliation_matches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  cash_flow_entry_id uuid,
  match_score int4 NOT NULL DEFAULT 0,
  match_reason text,
  status text NOT NULL DEFAULT 'suggested'::text,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.bank_statement_imports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  bank_account_id uuid,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  total_rows int4 NOT NULL DEFAULT 0,
  imported_rows int4 NOT NULL DEFAULT 0,
  duplicate_rows int4 NOT NULL DEFAULT 0,
  error_message text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (id)
);
CREATE TABLE public.bank_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  bank_account_id uuid,
  statement_import_id uuid,
  transaction_date date NOT NULL,
  value_date date,
  description text NOT NULL DEFAULT ''::text,
  counterparty_name text,
  reference text,
  amount numeric(12,2) NOT NULL,
  direction text NOT NULL,
  currency text NOT NULL DEFAULT 'EUR'::text,
  raw_data jsonb,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_row_index int4,
  bank_account_key uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.building_cards (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  weekday text NOT NULL,
  name text NOT NULL,
  address text,
  team_id uuid,
  sort_order int4 NOT NULL DEFAULT 0,
  monthly_value numeric,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.cash_flow_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  type text NOT NULL,
  amount numeric(10,2) NOT NULL,
  description text NOT NULL,
  category text DEFAULT 'outro'::text,
  date date NOT NULL,
  reference_id uuid,
  reference_type text,
  status text NOT NULL DEFAULT 'confirmado'::text,
  notes text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  expense_category_id uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.client_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  client_id uuid NOT NULL,
  service_id uuid,
  method text NOT NULL DEFAULT 'email'::text,
  status text NOT NULL DEFAULT 'enviado'::text,
  sent_at timestamptz DEFAULT now(),
  message_body text,
  contact_used text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.clients (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  name text NOT NULL,
  nif text,
  email text,
  phone text,
  address text,
  type text DEFAULT 'empresa'::text,
  notes text,
  status text DEFAULT 'ativo'::text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  notification_enabled bool DEFAULT false,
  notification_method text DEFAULT 'email'::text,
  notification_phone text,
  notification_email text,
  vat_exempt bool NOT NULL DEFAULT false,
  revision int4 NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
CREATE TABLE public.collaborator_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_size int4,
  mime_type text,
  category text NOT NULL DEFAULT 'outro'::text,
  uploaded_by uuid,
  created_at timestamptz DEFAULT now(),
  visible_to_collaborator bool NOT NULL DEFAULT false,
  notes text,
  expires_at timestamptz DEFAULT (now() + '3 mons'::interval),
  archived_at timestamptz,
  uploaded_by_role text DEFAULT 'gestor'::text,
  PRIMARY KEY (id)
);
CREATE TABLE public.collaborator_ride_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  team_id uuid NOT NULL,
  date date NOT NULL,
  assigned_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.companies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  logo_url text,
  active bool DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.company_change_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  sequence int8 NOT NULL,
  mutation_id uuid NOT NULL,
  domain text NOT NULL,
  event_type text NOT NULL,
  entity_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  affected_range tstzrange,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.company_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  hourly_rate numeric(8,2) DEFAULT 8.00,
  meal_allowance_day numeric(6,2) DEFAULT 9.60,
  overtime_rate_pct numeric(5,2) DEFAULT 25.00,
  vacation_days_year int4 DEFAULT 22,
  vat_rate numeric(5,2) DEFAULT 23.00,
  invoice_prefix text DEFAULT 'F'::text,
  gps_radius_meters int4 DEFAULT 200,
  timezone text DEFAULT 'Europe/Lisbon'::text,
  primary_color text DEFAULT '#16A34A'::text,
  currency text DEFAULT 'EUR'::text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  checkin_before_minutes int4 NOT NULL DEFAULT 40,
  checkout_after_minutes int4 NOT NULL DEFAULT 60,
  kanban_columns jsonb DEFAULT '[{"id": "pendente", "name": "Pendente", "color": "amber"}, {"id": "em_curso", "name": "Em Curso", "color": "blue"}, {"id": "concluido", "name": "Concluído", "color": "green"}]'::jsonb,
  PRIMARY KEY (id)
);
CREATE TABLE public.contracts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid NOT NULL,
  name text,
  frequency text NOT NULL,
  interval_days int4 DEFAULT 1,
  weekdays int4[],
  month_day int4,
  month_week int4,
  month_weekday int4,
  schedule_days jsonb NOT NULL DEFAULT '[]'::jsonb,
  starts_on date NOT NULL,
  ends_on date,
  status text DEFAULT 'ativo'::text,
  notes text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  cleaning_type text,
  payment_status text,
  upholstery_type text,
  upholstery_notes text,
  upholstery_units int4,
  upholstery_unit_price numeric(10,2),
  num_people int4,
  fixed_price numeric(10,2),
  apply_vat bool NOT NULL DEFAULT false,
  fixed_monthly bool NOT NULL DEFAULT false,
  excluded_dates date[] NOT NULL DEFAULT '{}'::date[],
  revision int4 NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
CREATE TABLE public.daily_clocks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  work_date date NOT NULL,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  lunch_start_at timestamptz,
  lunch_end_at timestamptz,
  clock_in_lat float8,
  clock_in_lng float8,
  clock_out_lat float8,
  clock_out_lng float8,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.data_history (
  id int8 NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  op text NOT NULL,
  old_data jsonb NOT NULL,
  new_data jsonb,
  actor uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  company_id uuid,
  changed_fields text[],
  PRIMARY KEY (id)
);
CREATE TABLE public.domain_mutations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  mutation_id uuid NOT NULL,
  domain text NOT NULL,
  status text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.expense_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  color_token text,
  icon text,
  active bool NOT NULL DEFAULT true,
  sort_order int4 NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.financial_periods (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  year int2 NOT NULL,
  month int2 NOT NULL,
  status text NOT NULL DEFAULT 'open'::text,
  closed_at timestamptz,
  closed_by uuid,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.fixed_variable_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  kind text NOT NULL,
  description text NOT NULL,
  amount numeric(10,2),
  due_date date,
  direct_debit bool,
  status text NOT NULL DEFAULT 'pendente'::text,
  recurring bool NOT NULL DEFAULT false,
  period_year int4 NOT NULL,
  period_month int4 NOT NULL,
  paid_at timestamptz,
  notes text,
  sort_order int4 DEFAULT 0,
  source_id uuid,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  attachment_url text,
  attachment_name text,
  attachment_size int4,
  attachment_mime text,
  expense_category_id uuid,
  PRIMARY KEY (id)
);
CREATE TABLE public.invoice_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  service_id uuid,
  description text NOT NULL,
  quantity numeric(8,2) NOT NULL DEFAULT 1,
  unit_price numeric(8,2) NOT NULL DEFAULT 0,
  total numeric(10,2) NOT NULL DEFAULT 0,
  sort_order int4 DEFAULT 0,
  revision int4 NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
CREATE TABLE public.invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  client_id uuid NOT NULL,
  invoice_number text NOT NULL,
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  period_start date,
  period_end date,
  subtotal numeric(10,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2) DEFAULT 23,
  vat_amount numeric(10,2) DEFAULT 0,
  total numeric(10,2) NOT NULL DEFAULT 0,
  status text DEFAULT 'rascunho'::text,
  paid_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  payment_method text,
  revision int4 NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
CREATE TABLE public.locations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  client_id uuid NOT NULL,
  name text NOT NULL,
  address text NOT NULL,
  lat numeric(10,7),
  lng numeric(10,7),
  access_code text,
  instructions text,
  service_type text DEFAULT 'limpeza_regular'::text,
  area_sqm numeric(8,2),
  hourly_rate numeric(8,2),
  gps_radius_m int4 DEFAULT 200,
  active bool DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  fixed_price numeric(10,2),
  pricing_type text NOT NULL DEFAULT 'hourly'::text,
  has_key bool NOT NULL DEFAULT false,
  key_label text,
  revision int4 NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
CREATE TABLE public.management_tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  title text NOT NULL,
  body text,
  status text NOT NULL DEFAULT 'pendente'::text,
  priority text NOT NULL DEFAULT 'normal'::text,
  assigned_to uuid,
  created_by uuid,
  due_date date,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  category text,
  client_id uuid,
  attachment_url text,
  attachment_name text,
  attachment_size int4,
  attachment_mime text,
  PRIMARY KEY (id)
);
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  data jsonb,
  read_at timestamptz,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.payroll_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  period_year int4 NOT NULL,
  period_month int4 NOT NULL,
  contracted_hours numeric(6,2),
  worked_hours numeric(6,2) DEFAULT 0,
  overtime_hours numeric(6,2) DEFAULT 0,
  absence_hours numeric(6,2) DEFAULT 0,
  days_worked int4 DEFAULT 0,
  hourly_rate numeric(8,2),
  gross_salary numeric(10,2) DEFAULT 0,
  meal_allowance numeric(10,2) DEFAULT 0,
  overtime_bonus numeric(10,2) DEFAULT 0,
  absence_deductions numeric(10,2) DEFAULT 0,
  other_deductions numeric(10,2) DEFAULT 0,
  other_additions numeric(10,2) DEFAULT 0,
  net_salary numeric(10,2) DEFAULT 0,
  status text DEFAULT 'rascunho'::text,
  notes text,
  approved_by uuid,
  paid_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.platform_admins (
  profile_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  note text,
  PRIMARY KEY (profile_id)
);
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  full_name text NOT NULL,
  phone text,
  email text,
  nif text,
  iban text,
  avatar_url text,
  role text NOT NULL DEFAULT 'colaborador'::text,
  contracted_hours_month numeric(6,2) DEFAULT 168,
  contract_start date,
  contract_end date,
  vacation_balance numeric(6,2) DEFAULT 22,
  skills text[] DEFAULT '{}'::text[],
  availability jsonb DEFAULT '{"fri": true, "mon": true, "sat": false, "sun": false, "thu": true, "tue": true, "wed": true}'::jsonb,
  status text DEFAULT 'ativo'::text,
  invited_at timestamptz,
  invite_accepted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  hourly_rate numeric(8,2) DEFAULT NULL::numeric,
  PRIMARY KEY (id)
);
CREATE TABLE public.push_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  user_agent text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.service_photos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  service_id uuid NOT NULL,
  collaborator_id uuid,
  storage_path text NOT NULL,
  kind text NOT NULL DEFAULT 'durante'::text,
  status text NOT NULL DEFAULT 'pending'::text,
  original_size_bytes int8,
  compressed_size_bytes int8,
  mime_type text,
  width int4,
  height int4,
  client_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  PRIMARY KEY (id)
);
CREATE TABLE public.service_price_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL,
  old_value numeric(10,2),
  new_value numeric(10,2),
  changed_by uuid,
  reason text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.service_reinforcements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE public.services (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid NOT NULL,
  team_id uuid,
  contract_id uuid,
  reference_number text NOT NULL,
  scheduled_start timestamptz NOT NULL,
  scheduled_end timestamptz NOT NULL,
  hourly_rate numeric(8,2),
  calculated_value numeric(10,2),
  manual_value numeric(10,2),
  discount_pct numeric(5,2) DEFAULT 0,
  status text DEFAULT 'agendado'::text,
  actual_start timestamptz,
  actual_end timestamptz,
  is_exception bool DEFAULT false,
  original_date date,
  notes text,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  cancel_type text,
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  is_late_cancel bool DEFAULT false,
  cleaning_type text,
  payment_status text,
  upholstery_type text,
  upholstery_notes text,
  upholstery_units int4,
  upholstery_unit_price numeric(10,2),
  num_people int4 NOT NULL DEFAULT 1,
  apply_vat bool NOT NULL DEFAULT true,
  paid_amount numeric(10,2),
  paid_at timestamptz,
  contract_synced_at timestamptz,
  revision int4 NOT NULL DEFAULT 1,
  override_fields text[] NOT NULL DEFAULT '{}'::text[],
  PRIMARY KEY (id)
);
CREATE TABLE public.team_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  joined_at date DEFAULT CURRENT_DATE,
  left_at date,
  revision int4 NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
CREATE TABLE public.teams (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  name text NOT NULL,
  color text DEFAULT '#16A34A'::text,
  leader_id uuid,
  active bool DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  vehicle varchar(50),
  revision int4 NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
CREATE TABLE public.timesheets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  company_id uuid NOT NULL,
  clock_in_at timestamptz,
  clock_in_lat numeric(10,7),
  clock_in_lng numeric(10,7),
  clock_in_distance_m int4,
  clock_out_at timestamptz,
  clock_out_lat numeric(10,7),
  clock_out_lng numeric(10,7),
  duration_minutes int4,
  location_warning bool DEFAULT false,
  closed_by_manager bool DEFAULT false,
  manager_note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  client_event_id uuid,
  manual_checkin bool NOT NULL DEFAULT false,
  gps_accuracy_m int4,
  manual_checkout bool NOT NULL DEFAULT false,
  clock_out_distance_m int4,
  clock_out_accuracy_m int4,
  clock_out_location_warning bool NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);
CREATE TABLE public.vacation_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  collaborator_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  days_count int4,
  status text DEFAULT 'pendente'::text,
  notes text,
  rejection_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.vehicle_allocations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  team_id uuid NOT NULL,
  driver_id uuid,
  date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE TABLE public.vehicles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  model varchar(100) NOT NULL,
  plate varchar(20) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ativo'::character varying,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

ALTER TABLE absences ADD CONSTRAINT absences_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id);
ALTER TABLE absences ADD CONSTRAINT absences_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE absences ADD CONSTRAINT absences_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE absences ADD CONSTRAINT absences_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE absences ADD CONSTRAINT absences_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES profiles(id);
ALTER TABLE app_notice_reads ADD CONSTRAINT app_notice_reads_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE app_notice_targets ADD CONSTRAINT app_notice_targets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE app_notice_targets ADD CONSTRAINT app_notice_targets_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES app_notices(id) ON DELETE CASCADE;
ALTER TABLE app_notice_targets ADD CONSTRAINT app_notice_targets_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE app_notices ADD CONSTRAINT app_notices_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE attachments ADD CONSTRAINT attachments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE attachments ADD CONSTRAINT attachments_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE bank_reconciliation_matches ADD CONSTRAINT bank_reconciliation_matches_bank_transaction_id_fkey FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;
ALTER TABLE bank_reconciliation_matches ADD CONSTRAINT bank_reconciliation_matches_cash_flow_entry_id_fkey FOREIGN KEY (cash_flow_entry_id) REFERENCES cash_flow_entries(id) ON DELETE CASCADE;
ALTER TABLE bank_reconciliation_matches ADD CONSTRAINT bank_reconciliation_matches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE bank_reconciliation_matches ADD CONSTRAINT bank_reconciliation_matches_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES profiles(id);
ALTER TABLE bank_statement_imports ADD CONSTRAINT bank_statement_imports_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE bank_statement_imports ADD CONSTRAINT bank_statement_imports_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE bank_statement_imports ADD CONSTRAINT bank_statement_imports_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_statement_import_id_fkey FOREIGN KEY (statement_import_id) REFERENCES bank_statement_imports(id) ON DELETE CASCADE;
ALTER TABLE building_cards ADD CONSTRAINT building_cards_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE building_cards ADD CONSTRAINT building_cards_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE building_cards ADD CONSTRAINT building_cards_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE cash_flow_entries ADD CONSTRAINT cash_flow_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE cash_flow_entries ADD CONSTRAINT cash_flow_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE cash_flow_entries ADD CONSTRAINT cash_flow_entries_expense_category_id_fkey FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id) ON DELETE SET NULL;
ALTER TABLE client_notifications ADD CONSTRAINT client_notifications_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE client_notifications ADD CONSTRAINT client_notifications_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE client_notifications ADD CONSTRAINT client_notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE client_notifications ADD CONSTRAINT client_notifications_service_id_fkey FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL;
ALTER TABLE clients ADD CONSTRAINT clients_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE collaborator_documents ADD CONSTRAINT collaborator_documents_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE collaborator_documents ADD CONSTRAINT collaborator_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE collaborator_documents ADD CONSTRAINT collaborator_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);
ALTER TABLE collaborator_ride_assignments ADD CONSTRAINT collaborator_ride_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE collaborator_ride_assignments ADD CONSTRAINT collaborator_ride_assignments_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE collaborator_ride_assignments ADD CONSTRAINT collaborator_ride_assignments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE collaborator_ride_assignments ADD CONSTRAINT collaborator_ride_assignments_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE company_change_events ADD CONSTRAINT company_change_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE company_settings ADD CONSTRAINT company_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE contracts ADD CONSTRAINT contracts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE contracts ADD CONSTRAINT contracts_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE contracts ADD CONSTRAINT contracts_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT;
ALTER TABLE daily_clocks ADD CONSTRAINT daily_clocks_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE daily_clocks ADD CONSTRAINT daily_clocks_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE domain_mutations ADD CONSTRAINT domain_mutations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES profiles(id);
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_reopened_by_fkey FOREIGN KEY (reopened_by) REFERENCES profiles(id);
ALTER TABLE fixed_variable_payments ADD CONSTRAINT fixed_variable_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE fixed_variable_payments ADD CONSTRAINT fixed_variable_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE fixed_variable_payments ADD CONSTRAINT fixed_variable_payments_expense_category_id_fkey FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id) ON DELETE SET NULL;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_service_id_fkey FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE invoices ADD CONSTRAINT invoices_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE locations ADD CONSTRAINT locations_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE locations ADD CONSTRAINT locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE management_tasks ADD CONSTRAINT management_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id);
ALTER TABLE management_tasks ADD CONSTRAINT management_tasks_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE management_tasks ADD CONSTRAINT management_tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE management_tasks ADD CONSTRAINT management_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE notifications ADD CONSTRAINT notifications_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id);
ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE payroll_records ADD CONSTRAINT payroll_records_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE platform_admins ADD CONSTRAINT platform_admins_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE platform_admins ADD CONSTRAINT platform_admins_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE profiles ADD CONSTRAINT profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE service_photos ADD CONSTRAINT service_photos_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE service_photos ADD CONSTRAINT service_photos_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE service_photos ADD CONSTRAINT service_photos_service_id_fkey FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE service_price_audit ADD CONSTRAINT service_price_audit_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES profiles(id);
ALTER TABLE service_price_audit ADD CONSTRAINT service_price_audit_service_id_fkey FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE service_reinforcements ADD CONSTRAINT service_reinforcements_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE service_reinforcements ADD CONSTRAINT service_reinforcements_service_id_fkey FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE services ADD CONSTRAINT services_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES profiles(id);
ALTER TABLE services ADD CONSTRAINT services_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE services ADD CONSTRAINT services_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;
ALTER TABLE services ADD CONSTRAINT services_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE services ADD CONSTRAINT services_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT;
ALTER TABLE services ADD CONSTRAINT services_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE team_members ADD CONSTRAINT team_members_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE team_members ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE teams ADD CONSTRAINT teams_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE teams ADD CONSTRAINT teams_leader_id_fkey FOREIGN KEY (leader_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE timesheets ADD CONSTRAINT timesheets_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE timesheets ADD CONSTRAINT timesheets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE timesheets ADD CONSTRAINT timesheets_service_id_fkey FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE vacation_requests ADD CONSTRAINT vacation_requests_collaborator_id_fkey FOREIGN KEY (collaborator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE vacation_requests ADD CONSTRAINT vacation_requests_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE vacation_requests ADD CONSTRAINT vacation_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id);
ALTER TABLE vehicle_allocations ADD CONSTRAINT vehicle_allocations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE vehicle_allocations ADD CONSTRAINT vehicle_allocations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE vehicle_allocations ADD CONSTRAINT vehicle_allocations_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE vehicle_allocations ADD CONSTRAINT vehicle_allocations_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_reinforcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_notice_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_notice_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.absences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_price_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vacation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.management_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collaborator_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_flow_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixed_variable_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_clocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collaborator_ride_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_reconciliation_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.building_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "absences_manage" ON public.absences AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "absences_manager_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "absences_own_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
CREATE POLICY "read own reads" ON public.app_notice_reads AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = auth.uid()));
CREATE POLICY "company members delete attachments" ON public.attachments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "company members insert attachments" ON public.attachments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "company members read attachments" ON public.attachments AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "audit_logs_admin_read" ON public.audit_logs AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "audit_logs_service_insert" ON public.audit_logs AS PERMISSIVE FOR INSERT TO service_role
  WITH CHECK (true);
CREATE POLICY "background_jobs_admin_read" ON public.background_jobs AS PERMISSIVE FOR SELECT TO public
  USING (((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text])) AND ((company_id IS NULL) OR (company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))))));
CREATE POLICY "background_jobs_service_write" ON public.background_jobs AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "bank_accounts_admin" ON public.bank_accounts AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "bank_reconciliation_matches_admin" ON public.bank_reconciliation_matches AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "bank_statement_imports_admin" ON public.bank_statement_imports AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "bank_transactions_admin" ON public.bank_transactions AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "building_cards_company_isolation" ON public.building_cards AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "building_cards_delete" ON public.building_cards AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "building_cards_insert" ON public.building_cards AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "building_cards_update" ON public.building_cards AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "cash_flow_admin" ON public.cash_flow_entries AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "managers manage client notifications" ON public.client_notifications AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "clients_collaborator_select" ON public.clients AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM (locations l
     JOIN services s ON ((s.location_id = l.id)))
  WHERE ((l.client_id = clients.id) AND can_access_service(s.id))))));
CREATE POLICY "clients_manage" ON public.clients AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = auth.uid()) AND (category = 'avaria'::text) AND (visible_to_collaborator = true) AND (uploaded_by_role = 'colaboradora'::text)));
CREATE POLICY "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = auth.uid()) AND (visible_to_collaborator = true)));
CREATE POLICY "gestores gerem documentos da empresa" ON public.collaborator_documents AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))))
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))));
CREATE POLICY "collaborator_ride_company_isolation" ON public.collaborator_ride_assignments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "collaborator_ride_delete" ON public.collaborator_ride_assignments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "collaborator_ride_insert" ON public.collaborator_ride_assignments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "collaborator_ride_update" ON public.collaborator_ride_assignments AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "users see own company" ON public.companies AS PERMISSIVE FOR SELECT TO public
  USING ((id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "managers see company change events" ON public.company_change_events AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "company_settings_manage" ON public.company_settings AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = 'admin'::text)));
CREATE POLICY "company_settings_select" ON public.company_settings AS PERMISSIVE FOR SELECT TO public
  USING ((company_id = get_my_company_id()));
CREATE POLICY "contracts_manage" ON public.contracts AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "contracts_manager_select" ON public.contracts AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "daily_clocks_manager_select" ON public.daily_clocks AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "daily_clocks_own" ON public.daily_clocks AS PERMISSIVE FOR ALL TO public
  USING ((collaborator_id = auth.uid()))
  WITH CHECK ((collaborator_id = auth.uid()));
CREATE POLICY "service role domain mutations" ON public.domain_mutations AS PERMISSIVE FOR ALL TO public
  USING (false)
  WITH CHECK (false);
CREATE POLICY "expense_categories_read" ON public.expense_categories AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "expense_categories_write" ON public.expense_categories AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "financial_periods_read" ON public.financial_periods AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "financial_periods_write" ON public.financial_periods AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "company members manage fixed variable payments" ON public.fixed_variable_payments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "managers manage invoice items" ON public.invoice_items AS PERMISSIVE FOR ALL TO public
  USING (((( SELECT invoices.company_id
   FROM invoices
  WHERE (invoices.id = invoice_items.invoice_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "managers manage invoices" ON public.invoices AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "locations_collaborator_select" ON public.locations AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM services s
  WHERE ((s.location_id = locations.id) AND can_access_service(s.id))))));
CREATE POLICY "locations_manage" ON public.locations AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "management_tasks_admin" ON public.management_tasks AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "managers create notifications" ON public.notifications AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "users see own notifications" ON public.notifications AS PERMISSIVE FOR ALL TO public
  USING ((user_id = auth.uid()));
CREATE POLICY "collaborators see own payroll" ON public.payroll_records AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
CREATE POLICY "managers manage payroll" ON public.payroll_records AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "read own platform admin row" ON public.platform_admins AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = auth.uid()));
CREATE POLICY "profiles_insert_admin" ON public.profiles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((id = auth.uid()) OR ((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text])))));
CREATE POLICY "profiles_manage_company" ON public.profiles AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "profiles_select" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING (((id = auth.uid()) OR (company_id = get_my_company_id())));
CREATE POLICY "profiles_update_own" ON public.profiles AS PERMISSIVE FOR UPDATE TO public
  USING ((id = auth.uid()))
  WITH CHECK (((id = auth.uid()) AND (company_id = get_my_company_id())));
CREATE POLICY "users see company profiles" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING ((company_id = get_my_company_id()));
CREATE POLICY "users see own profile" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING ((id = auth.uid()));
CREATE POLICY "users manage own push subs" ON public.push_subscriptions AS PERMISSIVE FOR ALL TO public
  USING ((user_id = auth.uid()));
CREATE POLICY "service_photos_manager_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "service_photos_own_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
CREATE POLICY "price_audit_manage" ON public.service_price_audit AS PERMISSIVE FOR ALL TO public
  USING (((get_service_company_id(service_id) = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "reinforcements_manage" ON public.service_reinforcements AS PERMISSIVE FOR ALL TO public
  USING (((get_service_company_id(service_id) = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "reinforcements_select" ON public.service_reinforcements AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = auth.uid()) OR (get_service_company_id(service_id) = get_my_company_id())));
CREATE POLICY "services_collaborator_select" ON public.services AS PERMISSIVE FOR SELECT TO public
  USING (can_access_service(id));
CREATE POLICY "services_manage" ON public.services AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "company team members" ON public.team_members AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT teams.company_id
   FROM teams
  WHERE (teams.id = team_members.team_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "team_members_manage" ON public.team_members AS PERMISSIVE FOR ALL TO public
  USING (((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.company_id = get_my_company_id()))) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "team_members_select" ON public.team_members AS PERMISSIVE FOR SELECT TO public
  USING ((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.company_id = get_my_company_id()))));
CREATE POLICY "company teams" ON public.teams AS PERMISSIVE FOR ALL TO public
  USING ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "teams_manage" ON public.teams AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "teams_select" ON public.teams AS PERMISSIVE FOR SELECT TO public
  USING ((company_id = get_my_company_id()));
CREATE POLICY "collaborators create own timesheets" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = auth.uid()));
CREATE POLICY "collaborators see own timesheets" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
CREATE POLICY "managers see company timesheets" ON public.timesheets AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "timesheets_collaborator_insert" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = auth.uid()));
CREATE POLICY "timesheets_collaborator_update" ON public.timesheets AS PERMISSIVE FOR UPDATE TO public
  USING ((collaborator_id = auth.uid()));
CREATE POLICY "timesheets_manager_manage" ON public.timesheets AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "timesheets_manager_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "timesheets_own_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
CREATE POLICY "vacation_requests_insert" ON public.vacation_requests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = auth.uid()) AND (company_id = get_my_company_id())));
CREATE POLICY "vacation_requests_manage" ON public.vacation_requests AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))));
CREATE POLICY "vacation_requests_select" ON public.vacation_requests AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = auth.uid()) OR ((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text])))));
CREATE POLICY "vehicle_allocations_company_isolation" ON public.vehicle_allocations AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "vehicle_allocations_delete" ON public.vehicle_allocations AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "vehicle_allocations_insert" ON public.vehicle_allocations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "vehicle_allocations_update" ON public.vehicle_allocations AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "vehicles_company_isolation" ON public.vehicles AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
CREATE POLICY "vehicles_delete" ON public.vehicles AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "vehicles_insert" ON public.vehicles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
CREATE POLICY "vehicles_update" ON public.vehicles AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
