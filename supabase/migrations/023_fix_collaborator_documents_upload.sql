-- ============================================================
-- Migration 023 — Corrige upload de relatórios de avaria
-- ============================================================
-- O sistema usa profiles.role = 'colaborador'. A migration 022 criou
-- a policy de storage com 'colaboradora', bloqueando uploads diretos.
-- Também remove restrições de MIME para aceitar HEIC/HEIF de telemóveis.
-- ============================================================

UPDATE storage.buckets
SET
  public = false,
  file_size_limit = 52428800,
  allowed_mime_types = NULL
WHERE id = 'collaborator-documents';

DROP POLICY IF EXISTS "colaboradoras upload avarias storage" ON storage.objects;

CREATE POLICY "colaboradores upload avarias storage"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'collaborator-documents'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'colaborador'
    )
  );
