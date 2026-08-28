-- ============================================================================
-- ROLLBACK da 083 — repõe a superfície de autorização anterior
-- ============================================================================
--
-- 🔴 ROLLBACK_083_REOPENS_KNOWN_SECURITY_BUG = YES
--
--    Correr isto devolve a base ao estado em que uma colaboradora autenticada
--    consegue, por UPDATE directo:
--
--        payment.status = 'pago'
--        payment.paid_at = now()
--        cash_flow_entries criados = 0
--
--    O defeito está provado em PostgreSQL 17 real, não é hipotético. Este
--    ficheiro existe para o ensaio de rollback ser honesto — repor o prestate
--    exacto de policies e grants — e **não** para ser corrido em produção por
--    rotina. Qualquer rollback em produção exige decisão e autorização
--    próprias, com consciência de que reabre este buraco.
--
--    Não é `ROLLBACK_BLOCKED`: é reversível. É `ROLLBACK_UNSAFE_BY_DESIGN`.
--
-- Ordem: nada depende desta migration, por isso o rollback é isolado.
-- ============================================================================

BEGIN;

-- ─── 1. Repor a policy `FOR ALL` da 037, tal como estava ────────────────────
DROP POLICY IF EXISTS "payments_manager_select" ON public.fixed_variable_payments;

DROP POLICY IF EXISTS "company members manage fixed variable payments"
  ON public.fixed_variable_payments;
CREATE POLICY "company members manage fixed variable payments"
  ON public.fixed_variable_payments
  USING (company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid()));

-- ─── 2. Repor os grants de tabela ───────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fixed_variable_payments TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fixed_variable_payments TO authenticated;

-- ─── 3. Repor o EXECUTE das RPCs de mutação ─────────────────────────────────
GRANT EXECUTE ON FUNCTION public.mark_payment_paid(uuid, uuid, date) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.unmark_payment_paid(uuid, uuid) TO PUBLIC;

-- ─── 4. Repor o EXECUTE dos helpers ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.assert_payment_cashflow_link(public.cash_flow_entries, public.fixed_variable_payments, uuid, uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_financial_period_open(uuid, integer, integer) TO PUBLIC;

COMMIT;
