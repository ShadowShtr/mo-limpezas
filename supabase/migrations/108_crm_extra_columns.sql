-- Colunas livres de organização: não são novos estados comerciais.
CREATE TABLE public.crm_board_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  color text NOT NULL DEFAULT 'blue'
    CHECK (color IN ('slate','blue','amber','violet','green','red')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id)
);
CREATE INDEX crm_board_columns_company_created ON public.crm_board_columns(company_id, created_at, id);
ALTER TABLE public.crm_board_columns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_board_columns FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.crm_board_columns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_board_columns TO service_role;
CREATE POLICY crm_board_columns_read ON public.crm_board_columns FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_my_company_id())
    AND (SELECT public.get_my_role()) IN ('admin','gestor'));
CREATE TRIGGER crm_board_columns_updated_at BEFORE UPDATE ON public.crm_board_columns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.crm_leads ADD COLUMN extra_column_id uuid;
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_extra_column_company_fk
  FOREIGN KEY (extra_column_id, company_id) REFERENCES public.crm_board_columns(id, company_id)
  ON DELETE SET NULL (extra_column_id);
CREATE INDEX crm_leads_extra_column ON public.crm_leads(company_id, extra_column_id)
  WHERE extra_column_id IS NOT NULL;

-- A coluna livre nunca altera stage, conversão, datas ou motivos.
-- Sair para um estado comercial usa as regras existentes, na mesma transação.
CREATE FUNCTION public.move_crm_lead_board_atomic(
  p_company_id uuid, p_actor uuid, p_lead_id uuid,
  p_expected_stage text, p_expected_extra_column_id uuid,
  p_extra_column_id uuid, p_stage text,
  p_lost_reason text DEFAULT NULL, p_lost_reason_notes text DEFAULT NULL
) RETURNS TABLE(stage text, extra_column_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_lead public.crm_leads%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=p_actor
    AND p.company_id=p_company_id AND p.role IN ('admin','gestor') AND p.status='ativo') THEN
    RAISE EXCEPTION 'CRM_BOARD_FORBIDDEN' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_expected_stage IS NULL THEN
    RAISE EXCEPTION 'CRM_BOARD_EXPECTED_REQUIRED' USING ERRCODE='check_violation';
  END IF;
  -- A coluna fica trancada antes da lead, como na remoção ON DELETE SET NULL.
  IF p_extra_column_id IS NOT NULL THEN
    PERFORM 1 FROM public.crm_board_columns c WHERE c.id=p_extra_column_id
      AND c.company_id=p_company_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CRM_BOARD_COLUMN_NOT_FOUND' USING ERRCODE='no_data_found';
    END IF;
  END IF;
  SELECT * INTO v_lead FROM public.crm_leads l WHERE l.id=p_lead_id
    AND l.company_id=p_company_id AND l.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE='no_data_found';
  END IF;
  IF v_lead.stage IS DISTINCT FROM p_expected_stage
    OR v_lead.extra_column_id IS DISTINCT FROM p_expected_extra_column_id THEN
    RAISE EXCEPTION 'CRM_BOARD_CONFLICT' USING ERRCODE='check_violation';
  END IF;
  IF p_extra_column_id IS NULL THEN
    IF p_stage IS NULL THEN
      RAISE EXCEPTION 'CRM_BOARD_STAGE_REQUIRED' USING ERRCODE='check_violation';
    END IF;
    IF p_stage IS DISTINCT FROM v_lead.stage THEN
      PERFORM * FROM public.move_crm_lead_stage_atomic(p_company_id,p_lead_id,
        p_expected_stage,p_stage,p_actor,p_lost_reason,p_lost_reason_notes);
    END IF;
  END IF;
  UPDATE public.crm_leads l SET extra_column_id=p_extra_column_id
    WHERE l.id=p_lead_id AND l.company_id=p_company_id;
  RETURN QUERY SELECT l.stage,l.extra_column_id FROM public.crm_leads l
    WHERE l.id=p_lead_id AND l.company_id=p_company_id;
END;
$$;
REVOKE ALL ON FUNCTION public.move_crm_lead_board_atomic(uuid,uuid,uuid,text,uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_crm_lead_board_atomic(uuid,uuid,uuid,text,uuid,uuid,text,text,text)
  TO service_role;
