-- ============================================================
-- MIGRATION 052: Anexo (fatura/recibo) em Pagamentos Fixos/Variáveis
--
-- Pedido do dono: na edição de um pagamento, poder anexar a fatura/recibo
-- correspondente. Ficheiro guardado no bucket privado "payment-attachments"
-- (criado automaticamente pela action, mesmo padrão de collaborator-documents).
-- ============================================================

ALTER TABLE fixed_variable_payments
  ADD COLUMN IF NOT EXISTS attachment_url  TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_size INTEGER,
  ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
