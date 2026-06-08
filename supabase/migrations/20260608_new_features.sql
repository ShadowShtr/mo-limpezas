-- =====================================================================
-- Migração: Funcionalidades novas (2026-06-08)
-- Correr no Supabase Dashboard > SQL Editor
-- =====================================================================

-- 1. Locais com preço fixo
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS fixed_price numeric(10,2),
  ADD COLUMN IF NOT EXISTS pricing_type text NOT NULL DEFAULT 'hourly'
    CHECK (pricing_type IN ('hourly', 'fixed'));

-- 2. Forma de pagamento em faturas
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_method text
    CHECK (payment_method IN ('transferencia','mbway','cheque','numerario','debito_direto','outro'));

-- 3. Clientes isentos de IVA
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS vat_exempt boolean NOT NULL DEFAULT false;

-- 4. Fluxo de caixa
CREATE TABLE IF NOT EXISTS cash_flow_entries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('entrada', 'saida')),
  amount numeric(10,2) NOT NULL,
  description text NOT NULL,
  category text DEFAULT 'outro'
    CHECK (category IN ('faturacao', 'salario', 'despesa', 'fornecedor', 'outro')),
  date date NOT NULL,
  reference_id uuid,
  reference_type text CHECK (reference_type IN ('invoice', 'payroll')),
  status text NOT NULL DEFAULT 'confirmado'
    CHECK (status IN ('pendente', 'confirmado')),
  notes text,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_flow_company_date ON cash_flow_entries(company_id, date DESC);

-- Activar RLS para cash_flow_entries
ALTER TABLE cash_flow_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company members can manage cash flow" ON cash_flow_entries
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

-- 5. Documentos de colaboradores
CREATE TABLE IF NOT EXISTS collaborator_documents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collaborator_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_size integer,
  mime_type text,
  category text NOT NULL DEFAULT 'outro'
    CHECK (category IN ('contrato', 'recibo_salario', 'identificacao', 'outro')),
  uploaded_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collab_docs_collaborator ON collaborator_documents(collaborator_id);

-- Activar RLS para collaborator_documents
ALTER TABLE collaborator_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company members can manage collaborator docs" ON collaborator_documents
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

-- 6. Tarefas de gestão
CREATE TABLE IF NOT EXISTS management_tasks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'em_curso', 'concluido')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal', 'urgente')),
  assigned_to uuid REFERENCES profiles(id),
  created_by uuid REFERENCES profiles(id),
  due_date date,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mgmt_tasks_company_status ON management_tasks(company_id, status);

-- Activar RLS para management_tasks
ALTER TABLE management_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company members can manage tasks" ON management_tasks
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));
