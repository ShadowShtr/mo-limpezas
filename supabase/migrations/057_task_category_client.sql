-- ============================================================
-- MIGRATION 057: Categoria + Cliente nas Tarefas de Gestão
--
-- Pedido do dono: no modal "Nova tarefa" do Kanban, poder escolher uma
-- categoria (Orçamento/Serviço/Assistência/Comercial/Viatura, com ícone) e
-- associar a tarefa a um cliente existente, além do responsável já existente.
-- ============================================================

ALTER TABLE management_tasks
  ADD COLUMN IF NOT EXISTS category  TEXT
    CHECK (category IN ('orcamento', 'servico', 'assistencia', 'comercial', 'viatura')),
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_management_tasks_client_id ON management_tasks(client_id);
