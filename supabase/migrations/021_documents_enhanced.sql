-- ============================================================
-- Migration 021 — Sistema de Documentos de Funcionárias
-- ============================================================
-- Extende a tabela collaborator_documents com:
--  • visible_to_collaborator (funcionária pode ver o doc no app)
--  • notes (texto livre: descrição de avaria, notas do gestor)
--  • expires_at (retenção de 3 meses; cron apaga após arquivar)
--  • archived_at (marcado quando incluído no arquivo mensal)
--  • uploaded_by_role ('gestor' | 'colaboradora')
-- Adiciona categoria 'avaria' para relatórios de danos.
-- Cria bucket de storage e políticas RLS atualizadas.
-- ============================================================

-- 1. Novos campos na tabela existente
ALTER TABLE collaborator_documents
  ADD COLUMN IF NOT EXISTS visible_to_collaborator boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz DEFAULT (now() + interval '3 months'),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS uploaded_by_role text DEFAULT 'gestor'
    CHECK (uploaded_by_role IN ('gestor', 'colaboradora'));

-- 2. Expandir category para incluir 'avaria'
ALTER TABLE collaborator_documents
  DROP CONSTRAINT IF EXISTS collaborator_documents_category_check;

ALTER TABLE collaborator_documents
  ADD CONSTRAINT collaborator_documents_category_check
  CHECK (category IN ('contrato', 'recibo_salario', 'identificacao', 'avaria', 'outro'));

-- Folhas de salário devem ser visíveis à funcionária por defeito
UPDATE collaborator_documents
  SET visible_to_collaborator = true
  WHERE category = 'recibo_salario';

-- 3. Índices para as queries mais comuns
CREATE INDEX IF NOT EXISTS idx_collab_docs_expires
  ON collaborator_documents(expires_at)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_collab_docs_visible
  ON collaborator_documents(collaborator_id, visible_to_collaborator)
  WHERE visible_to_collaborator = true;

CREATE INDEX IF NOT EXISTS idx_collab_docs_archived
  ON collaborator_documents(company_id, archived_at)
  WHERE archived_at IS NULL;

-- 4. Actualizar RLS (política única anterior → políticas separadas por role)
DROP POLICY IF EXISTS "company members can manage collaborator docs" ON collaborator_documents;

-- Gestores/admins: acesso total a documentos da empresa
CREATE POLICY "gestores gerem documentos da empresa"
  ON collaborator_documents
  FOR ALL
  USING (
    company_id IN (
      SELECT company_id FROM profiles
      WHERE id = auth.uid() AND role IN ('gestor', 'admin')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM profiles
      WHERE id = auth.uid() AND role IN ('gestor', 'admin')
    )
  );

-- Colaboradoras: podem VER os seus documentos visíveis
CREATE POLICY "colaboradoras veem os seus docs visíveis"
  ON collaborator_documents
  FOR SELECT
  USING (
    collaborator_id = auth.uid()
    AND visible_to_collaborator = true
  );

-- Colaboradoras: podem INSERIR apenas relatórios de avaria
CREATE POLICY "colaboradoras submetem relatórios de avaria"
  ON collaborator_documents
  FOR INSERT
  WITH CHECK (
    collaborator_id = auth.uid()
    AND category = 'avaria'
    AND visible_to_collaborator = true
    AND uploaded_by_role = 'colaboradora'
  );

-- 5. Storage bucket e políticas (executar apenas se o bucket não existir)
-- O bucket 'employee-docs' deve ser criado no dashboard do Supabase Storage:
--   Name: employee-docs
--   Public: false
--   File size limit: 52428800  (50 MB)
--   Allowed MIME types: application/pdf, image/jpeg, image/png, image/webp
--
-- Políticas de storage (aplicar no dashboard ou via API):
-- ─── Gestores: upload/download na pasta da empresa ───────────────────────────
-- Bucket: employee-docs
-- Folder pattern: {company_id}/**
-- Policy para INSERT: role IN ('gestor', 'admin')
-- Policy para SELECT: role IN ('gestor', 'admin')
-- Policy para DELETE: role IN ('gestor', 'admin')
--
-- ─── Colaboradoras: download dos seus docs + upload de avarias ───────────────
-- Bucket: employee-docs
-- Folder pattern: {company_id}/colaboradoras/{user.id}/**
-- Policy para SELECT: auth.uid() = collaborator_id column check via collaborator_documents
-- Policy para INSERT: category = 'avaria'
-- ─────────────────────────────────────────────────────────────────────────────

-- 6. Função helper para listar documentos a arquivar (vence em < 7 dias)
CREATE OR REPLACE FUNCTION get_documents_to_archive(p_company_id uuid)
RETURNS TABLE (
  id uuid,
  collaborator_id uuid,
  collaborator_name text,
  file_name text,
  file_url text,
  file_size integer,
  mime_type text,
  category text,
  notes text,
  created_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    d.id,
    d.collaborator_id,
    p.full_name AS collaborator_name,
    d.file_name,
    d.file_url,
    d.file_size,
    d.mime_type,
    d.category,
    d.notes,
    d.created_at,
    d.expires_at
  FROM collaborator_documents d
  JOIN profiles p ON p.id = d.collaborator_id
  WHERE d.company_id = p_company_id
    AND d.expires_at < now() + interval '7 days'
    AND d.archived_at IS NULL
  ORDER BY p.full_name, d.category, d.created_at;
$$;

-- 7. Função para marcar documentos como arquivados e eliminar
CREATE OR REPLACE FUNCTION archive_expired_documents(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Marcar como arquivados
  UPDATE collaborator_documents
  SET archived_at = now()
  WHERE company_id = p_company_id
    AND expires_at < now()
    AND archived_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
