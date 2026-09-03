-- GERADO de supabase/migrations/073_payment_to_cashflow.sql
-- is_financial_period_open COMO ESTA EM PRODUCAO. Nao editar a mao:
-- regenerar com scripts/gen-086-fixture.mjs.

CREATE OR REPLACE FUNCTION public.is_financial_period_open(
  p_company_id uuid,
  p_year       int,
  p_month      int
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.financial_periods fp
     WHERE fp.company_id = p_company_id
       AND fp.year = p_year
       AND fp.month = p_month
       AND fp.status = 'closed'
  );
$$;
