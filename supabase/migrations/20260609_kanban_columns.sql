-- Remove check constraint to allow custom column statuses
ALTER TABLE management_tasks
  DROP CONSTRAINT IF EXISTS management_tasks_status_check;

-- Add kanban_columns config to company_settings
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS kanban_columns jsonb
  DEFAULT '[
    {"id":"pendente","name":"Pendente","color":"amber"},
    {"id":"em_curso","name":"Em Curso","color":"blue"},
    {"id":"concluido","name":"Concluído","color":"green"}
  ]'::jsonb;
