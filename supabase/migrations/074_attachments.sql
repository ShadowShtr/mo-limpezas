-- ============================================================
-- MIGRATION 074: Múltiplos anexos por registo
--
-- O problema que resolve: três fluxos guardam UM anexo em colunas na própria
-- linha do registo pai (`attachment_url`, `document_url`, ...). Anexar um
-- segundo ficheiro sobrescreve as colunas — e, no caso dos pagamentos, a
-- action chegava a apagar o ficheiro anterior do storage antes de gravar o
-- novo. Não havia recuperação.
--
-- Esta tabela dá 1:N a esses três fluxos, seguindo o modelo que
-- `service_photos` (027) já provou neste projeto: linha própria por ficheiro,
-- caminho de storage, mime, tamanho, e idempotência por evento do cliente.
--
-- 🔴 NÃO TOCA NAS COLUNAS LEGADAS. `fixed_variable_payments.attachment_*`,
--    `management_tasks.attachment_*` e `absences.document_url` ficam
--    exactamente como estão, com os ficheiros que já lá têm. O runtime lê as
--    duas fontes e apresenta uma lista só. Migrar os valores legados para cá
--    duplicaria anexos na UI — fica para uma ronda separada, se alguma vez
--    fizer sentido.
--
-- Fluxos que JÁ são 1:N e não mudam: service_photos (027),
-- collaborator_documents (20260608), bank_statement_imports (043).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attachments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Polimórfico deliberado: um só padrão para os três fluxos, em vez de três
  -- tabelas quase iguais. O CHECK é a fronteira — `parent_type` nunca aceita
  -- uma string arbitrária vinda do cliente.
  parent_type     text        NOT NULL
                  CHECK (parent_type IN (
                    'fixed_variable_payment',
                    'management_task',
                    'absence'
                  )),
  parent_id       uuid        NOT NULL,

  storage_bucket  text        NOT NULL,
  storage_path    text        NOT NULL,

  original_name   text        NOT NULL,
  mime_type       text,
  size_bytes      bigint      CHECK (size_bytes IS NULL OR size_bytes >= 0),

  -- Idempotência (mesmo princípio de service_photos.client_event_id): o
  -- cliente envia o mesmo valor num retry ou duplo-clique, e o índice único
  -- abaixo transforma a segunda tentativa num conflito em vez de num anexo
  -- duplicado.
  client_event_id text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        REFERENCES profiles(id) ON DELETE SET NULL
);

-- Sem FK real para o pai: `parent_id` aponta para três tabelas diferentes.
-- A integridade é garantida no runtime, que valida sempre
-- (auth → company → parent existe → parent pertence à company).

-- A lista de anexos de um registo — o acesso quente.
CREATE INDEX IF NOT EXISTS idx_attachments_parent
  ON public.attachments (company_id, parent_type, parent_id, created_at);

-- Varrimentos por empresa (limpezas, auditoria).
CREATE INDEX IF NOT EXISTS idx_attachments_company
  ON public.attachments (company_id, created_at);

-- Dois registos nunca podem apontar para o mesmo ficheiro: remover um
-- apagaria o ficheiro do outro.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attachments_storage_object
  ON public.attachments (storage_bucket, storage_path);

-- Idempotência por empresa. Parcial: `client_event_id` é opcional, e vários
-- NULL não podem colidir entre si.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attachments_client_event
  ON public.attachments (company_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

-- ============================================================
-- RLS — mesmo padrão de collaborator_documents e service_photos
-- ============================================================
--
-- Anexos são imutáveis: cria, lê, remove. Não há UPDATE, e por isso não há
-- policy de UPDATE — trocar o `storage_path` de uma linha existente deixaria
-- o ficheiro antigo órfão no bucket sem nada a apontar para ele.

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company members read attachments" ON public.attachments;
CREATE POLICY "company members read attachments" ON public.attachments
  FOR SELECT
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "company members insert attachments" ON public.attachments;
CREATE POLICY "company members insert attachments" ON public.attachments
  FOR INSERT
  WITH CHECK (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "company members delete attachments" ON public.attachments;
CREATE POLICY "company members delete attachments" ON public.attachments
  FOR DELETE
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

COMMENT ON TABLE public.attachments IS
  'Anexos 1:N para pagamentos, tarefas e faltas. As colunas legadas de anexo '
  'único nos registos pai continuam válidas e são lidas em conjunto com esta '
  'tabela — ver docs/ATTACHMENTS-MULTIPLE.md.';
