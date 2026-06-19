-- 027_service_photos.sql
-- TASK 01 — Upload direto para Supabase Storage com signed upload URL.
-- Metadata das fotos de serviço (a Vercel nunca recebe o ficheiro).

-- ── 1. Tabela service_photos ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_photos (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_id             UUID        NOT NULL REFERENCES services(id)  ON DELETE CASCADE,
  collaborator_id        UUID        NOT NULL REFERENCES profiles(id)  ON DELETE SET NULL,

  storage_path           TEXT        NOT NULL,
  kind                   TEXT        NOT NULL DEFAULT 'durante'
                         CHECK (kind IN ('antes', 'durante', 'depois', 'avaria', 'outro')),
  status                 TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN (
                           'pending', 'uploading', 'uploaded',
                           'failed', 'deleted', 'review_required'
                         )),

  original_size_bytes    BIGINT,
  compressed_size_bytes  BIGINT,
  mime_type              TEXT,
  width                  INTEGER,
  height                 INTEGER,

  -- Idempotência: o telemóvel reenvia o mesmo client_event_id em retry offline.
  client_event_id        UUID        NOT NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_at            TIMESTAMPTZ,
  failed_at              TIMESTAMPTZ,
  failure_reason         TEXT
);

-- ── 2. Idempotência: 1 foto por client_event_id por empresa ───────────────────
-- Evita duplicação quando o telemóvel reenvia por falha de internet (TASK 09).
CREATE UNIQUE INDEX IF NOT EXISTS service_photos_company_event_uq
  ON service_photos (company_id, client_event_id);

-- ── 3. Índices de leitura (galeria + painel de pendências) — TASK 10/13/15 ────
CREATE INDEX IF NOT EXISTS idx_service_photos_service
  ON service_photos (company_id, service_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_photos_status
  ON service_photos (company_id, status, created_at DESC);

-- ── 4. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE service_photos ENABLE ROW LEVEL SECURITY;

-- Gestor/admin leem as fotos da sua empresa.
CREATE POLICY "service_photos_manager_read"
  ON service_photos FOR SELECT
  USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

-- Colaboradora lê as suas próprias fotos.
CREATE POLICY "service_photos_own_read"
  ON service_photos FOR SELECT
  USING (collaborator_id = auth.uid());

-- Escrita feita sempre via service-role (createAdminClient) no servidor.
CREATE POLICY "service_photos_service_write"
  ON service_photos FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 5. Bucket de storage ──────────────────────────────────────────────────────
-- Privado: leitura só via signed URL gerado no servidor.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'service-photos',
  'service-photos',
  false,
  15728640, -- 15 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO NOTHING;

-- Políticas de storage: cada path começa por `${company_id}/...`.
-- O upload é feito com signed upload URL (token), por isso não dependemos de RLS
-- de storage para escrita; mas restringimos leitura/escrita autenticada à empresa.
CREATE POLICY "service_photos_storage_company_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'service-photos'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM profiles WHERE id = auth.uid()
    )
  );
