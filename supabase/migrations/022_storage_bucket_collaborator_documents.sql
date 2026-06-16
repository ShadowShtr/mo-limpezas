-- ============================================================
-- Migration 022 — Bucket de storage para documentos de colaboradoras
-- ============================================================
-- Cria o bucket 'collaborator-documents' referenciado no código
-- e configura as políticas de acesso ao storage.
-- O bucket é privado; URLs públicas são geradas pelo admin client.
-- ============================================================

-- 1. Criar o bucket (idempotente)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'collaborator-documents',
  'collaborator-documents',
  true,
  52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- 2. Políticas de storage para gestores/admins
--    Caminho: {company_id}/{user_id}/{filename}

-- Gestores podem fazer upload de qualquer documento da empresa
CREATE POLICY "gestores upload collab docs storage"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'collaborator-documents'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role IN ('gestor', 'admin')
    )
  );

-- Gestores podem ver todos os documentos da empresa
CREATE POLICY "gestores select collab docs storage"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'collaborator-documents'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role IN ('gestor', 'admin')
    )
  );

-- Gestores podem eliminar documentos
CREATE POLICY "gestores delete collab docs storage"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'collaborator-documents'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role IN ('gestor', 'admin')
    )
  );

-- 3. Políticas para colaboradoras
--    Caminho esperado: {company_id}/{user_id}/{filename}
--    (storage.foldername retorna array de segmentos de pasta)

-- Colaboradoras podem fazer upload de avarias na sua própria pasta
CREATE POLICY "colaboradoras upload avarias storage"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'collaborator-documents'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'colaborador'
    )
  );

-- Colaboradoras podem ver os seus próprios ficheiros
CREATE POLICY "colaboradoras select seus docs storage"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'collaborator-documents'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
