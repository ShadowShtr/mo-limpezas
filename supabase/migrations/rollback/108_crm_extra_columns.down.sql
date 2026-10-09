-- Apenas depois de repor o código anterior e exportar a organização das colunas.
DROP FUNCTION IF EXISTS public.move_crm_lead_board_atomic(uuid,uuid,uuid,text,uuid,uuid,text,text,text);
ALTER TABLE public.crm_leads DROP COLUMN extra_column_id;
DROP TABLE public.crm_board_columns;
