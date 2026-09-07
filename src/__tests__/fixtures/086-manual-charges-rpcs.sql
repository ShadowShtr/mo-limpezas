-- GERADO de supabase/migrations/086_manual_charges_and_atomic_billing.sql
-- As RPCs de cobrancas avulsas COMO ESTAO EM PRODUCAO (sem guarda de periodo).
-- E sobre estas que o CREATE OR REPLACE da 091 actua. Nao editar a mao:
-- regenerar com scripts/gen-086-fixture.mjs.

CREATE OR REPLACE FUNCTION public.set_manual_charge_payment_atomic(
  p_company_id  uuid,
  p_charge_id   uuid,
  p_status      text,
  p_paid_amount numeric DEFAULT NULL,
  p_actor       uuid DEFAULT NULL
)
RETURNS TABLE (charge_id uuid, cash_amount numeric)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_chg      public.manual_charges%ROWTYPE;
  v_vat      numeric := 23;
  v_total    numeric := 0;
  v_recebido numeric := 0;
BEGIN
  IF p_status NOT IN ('nao_informado', 'sinal_50', 'pago_total') THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_STATUS_INVALID: %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_paid_amount IS NOT NULL AND p_paid_amount < 0 THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_AMOUNT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Estado e valor têm de dizer a mesma coisa. O raciocínio inteiro está na
  --    RPC de serviço, secção 6 — a nota de cobrança segue a mesma regra porque
  --    partilha o mesmo vocabulário de estados de propósito.
  IF p_status = 'nao_informado' AND COALESCE(p_paid_amount, 0) > 0 THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_STATUS_AMOUNT_INCOHERENT: nao_informado com valor %', p_paid_amount
      USING ERRCODE = 'check_violation',
            HINT = 'Um valor recebido exige um estado de recebimento (sinal_50 ou pago_total).';
  END IF;

  IF p_status <> 'nao_informado' AND p_paid_amount IS NOT NULL AND p_paid_amount = 0 THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_STATUS_AMOUNT_INCOHERENT: % com valor zero', p_status
      USING ERRCODE = 'check_violation',
            HINT = 'Para retirar o recebimento, use o estado nao_informado.';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT * INTO v_chg
    FROM public.manual_charges
   WHERE id = p_charge_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- Uma cobrança anulada não recebe dinheiro.
  IF v_chg.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_VOIDED'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Esta cobranca foi anulada e nao aceita recebimentos.';
  END IF;

  IF p_paid_amount IS NOT NULL THEN
    v_recebido := p_paid_amount;
  ELSIF p_status IN ('sinal_50', 'pago_total') THEN
    SELECT COALESCE(vat_rate, 23) INTO v_vat
      FROM public.company_settings WHERE company_id = p_company_id;
    v_vat := COALESCE(v_vat, 23);

    v_total    := v_chg.amount * (CASE WHEN v_chg.apply_vat THEN 1 + v_vat / 100 ELSE 1 END);
    v_recebido := CASE WHEN p_status = 'pago_total' THEN v_total ELSE v_total / 2 END;
    v_recebido := round(v_recebido, 2);
  END IF;

  -- A coerência sobre o valor derivado. Aqui o `CHECK amount > 0` da tabela já
  -- garante um total positivo, portanto esta guarda nunca deve disparar por
  -- dados — fica porque a garantia é da tabela e não desta função, e uma
  -- invariante que só vive noutro sítio deixa de valer quando esse sítio muda.
  IF p_status <> 'nao_informado' AND v_recebido <= 0 THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_STATUS_AMOUNT_INCOHERENT: % sem valor a receber', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.manual_charges
     SET payment_status = p_status,
         -- `nao_informado` significa «sem dinheiro» — ver a nota na RPC de serviço.
         paid_amount    = CASE WHEN p_status = 'nao_informado' THEN NULL ELSE p_paid_amount END,
         paid_at        = CASE WHEN p_status = 'nao_informado' THEN NULL ELSE now() END,
         updated_at     = now()
   WHERE id = p_charge_id AND company_id = p_company_id;

  IF v_recebido > 0 THEN
    INSERT INTO public.cash_flow_entries (
      company_id, type, amount, description, category, date,
      reference_id, reference_type, status
    ) VALUES (
      p_company_id, 'entrada', v_recebido,
      'Cobrança avulsa: ' || v_chg.description,
      'faturacao',
      (now() AT TIME ZONE 'Europe/Lisbon')::date,
      p_charge_id, 'manual_charge', 'confirmado'
    )
    -- 🔴 O índice único da 024 é PARCIAL (`WHERE reference_type IS NOT NULL
    --    AND reference_id IS NOT NULL`), e o Postgres só o infere como árbitro
    --    se o `ON CONFLICT` repetir a mesma condição. Sem ela: 42P10, «there
    --    is no unique or exclusion constraint matching the ON CONFLICT
    --    specification». A 073 já tinha documentado esta armadilha.
    ON CONFLICT (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
    DO UPDATE SET amount = EXCLUDED.amount,
                  date   = EXCLUDED.date,
                  status = 'confirmado';
  ELSE
    DELETE FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'manual_charge'
       AND reference_id = p_charge_id;
  END IF;

  RETURN QUERY SELECT p_charge_id, v_recebido;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.void_manual_charge_atomic(
  p_company_id uuid,
  p_charge_id  uuid,
  p_actor      uuid
)
RETURNS TABLE (charge_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_chg  public.manual_charges%ROWTYPE;
  v_caixa integer;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT * INTO v_chg
    FROM public.manual_charges
   WHERE id = p_charge_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO v_caixa
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'manual_charge'
     AND reference_id = p_charge_id;

  IF v_chg.payment_status <> 'nao_informado'
     OR COALESCE(v_chg.paid_amount, 0) > 0
     OR v_caixa > 0 THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_HAS_PAYMENT'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Esta cobranca tem um recebimento registado. Remova o recebimento antes de a anular.';
  END IF;

  UPDATE public.manual_charges
     SET voided_at = now(), voided_by = p_actor, updated_at = now()
   WHERE id = p_charge_id AND company_id = p_company_id;

  RETURN QUERY SELECT p_charge_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.update_manual_charge_atomic(
  p_company_id uuid,
  p_charge_id  uuid,
  p_patch      jsonb,
  p_actor      uuid DEFAULT NULL
)
RETURNS TABLE (charge_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_chg       public.manual_charges%ROWTYPE;
  v_proibidas text[];
  v_mexe_dinheiro boolean;
  v_tem_caixa     boolean;
  v_tem_dinheiro  boolean;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT array_agg(k) INTO v_proibidas
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('description', 'charge_date', 'amount', 'apply_vat', 'notes', 'client_id');

  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_chg
    FROM public.manual_charges
   WHERE id = p_charge_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_chg.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_VOIDED'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Esta cobranca foi anulada e nao pode ser editada.';
  END IF;

  -- 🔴 «Tem dinheiro» são TRÊS sinais, não dois.
  --
  --    A versão anterior olhava só para `payment_status` e `paid_amount`. Um
  --    movimento de caixa com estado local limpo — que é precisamente o que uma
  --    escrita parcial deixa para trás, e o que a `void_manual_charge_atomic`
  --    já verificava — passava despercebido. O caixa é a terceira testemunha, e
  --    é a única que fala de dinheiro que já saiu do mundo desta tabela.
  SELECT EXISTS (
    SELECT 1 FROM public.cash_flow_entries c
     WHERE c.company_id     = p_company_id
       AND c.reference_type = 'manual_charge'
       AND c.reference_id   = p_charge_id
  ) INTO v_tem_caixa;

  v_tem_dinheiro := v_chg.payment_status <> 'nao_informado'
                    OR COALESCE(v_chg.paid_amount, 0) > 0
                    OR v_tem_caixa;

  v_mexe_dinheiro := (p_patch ? 'amount') OR (p_patch ? 'apply_vat');

  IF v_mexe_dinheiro AND v_tem_dinheiro THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_PAID_AMOUNT_LOCKED'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Remova o recebimento antes de alterar o valor desta cobranca.';
  END IF;

  -- 🔴 `client_id` é PROVENIÊNCIA, e não um campo editável como outro qualquer.
  --
  --    Mudá-lo depois do recebimento reatribui dinheiro histórico a outro
  --    cliente: o movimento de caixa já entrou, o extrato do cliente antigo
  --    perde-o e o do novo ganha uma entrada que nunca lhe pertenceu. Nenhum
  --    dos dois extratos passa a estar certo, e nada no sistema regista que a
  --    troca aconteceu.
  --
  --    Não se resolve reescrevendo o movimento: o dinheiro foi recebido de
  --    alguém, e essa é a informação. Quem se enganou no cliente remove o
  --    recebimento, corrige, e volta a marcar — o mesmo caminho do valor.
  IF (p_patch ? 'client_id')
     AND (p_patch->>'client_id') IS DISTINCT FROM v_chg.client_id::text
     AND v_tem_dinheiro THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_CLIENT_LOCKED'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Esta cobranca ja tem recebimento. Remova-o antes de mudar o cliente.';
  END IF;

  UPDATE public.manual_charges
     SET description = COALESCE(p_patch->>'description', description),
         charge_date = COALESCE((p_patch->>'charge_date')::date, charge_date),
         amount      = COALESCE((p_patch->>'amount')::numeric, amount),
         apply_vat   = COALESCE((p_patch->>'apply_vat')::boolean, apply_vat),
         notes       = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
         client_id   = COALESCE((p_patch->>'client_id')::uuid, client_id),
         updated_at  = now()
   WHERE id = p_charge_id AND company_id = p_company_id;

  RETURN QUERY SELECT p_charge_id;
END;
$fn$;
