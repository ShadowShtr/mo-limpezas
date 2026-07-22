-- ============================================================
-- MIGRATION 058: Anexo nas Tarefas de Gestão ("Notas")
--
-- Pedido do dono: poder anexar um ficheiro (ex.: orçamento, comprovativo)
-- a uma tarefa/nota do Kanban de Gestão. Mesmo padrão da migration 052
-- (payment-attachments): bucket privado próprio, download por signed URL.
-- ============================================================

ALTER TABLE management_tasks
  ADD COLUMN IF NOT EXISTS attachment_url  TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_size INTEGER,
  ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
