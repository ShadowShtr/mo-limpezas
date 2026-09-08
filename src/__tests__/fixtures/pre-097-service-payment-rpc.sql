-- GERADO de supabase/migrations/086_manual_charges_and_atomic_billing.sql por scripts/gen-097-fixture.mjs. Nao editar a mao.
-- A RPC de pagamento de servicos COMO ESTA EM PRODUCAO (sem guarda de periodo).

CREATE OR REPLACE FUNCTION public.set_service_payment_atomic(
  p_company_id  uuid,
  p_service_id  uuid,
  p_status      text,
  p_paid_amount numeric DEFAULT NULL,
  p_actor       uuid DEFAULT NULL
)
RETURNS TABLE (service_id uuid, cash_amount numeric)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_svc       public.services%ROWTYPE;
  v_base      numeric := 0;
  v_apply_vat boolean := true;
  v_vat       numeric := 23;
  v_total     numeric := 0;
  v_recebido  numeric := 0;
  v_count     integer;
  v_ym        text;
BEGIN
  IF p_status NOT IN ('nao_informado', 'sinal_50', 'pago_total') THEN
    RAISE EXCEPTION 'SERVICE_PAYMENT_STATUS_INVALID: %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_paid_amount IS NOT NULL AND p_paid_amount < 0 THEN
    RAISE EXCEPTION 'SERVICE_PAYMENT_AMOUNT_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Estado e valor têm de dizer a mesma coisa.
  --
  --    Sem esta guarda a RPC aceitava combinações que deixavam a origem e o
  --    caixa a afirmar coisas contrárias, e nenhuma das duas errada por si só:
  --
  --      `nao_informado` + valor > 0 → nasce movimento de caixa por uma
  --                                    cobrança que o próprio registo diz não
  --                                    ter sido recebida;
  --      `pago_total`    + valor = 0 → o serviço fica marcado como recebido e o
  --                                    ramo do caixa é o de APAGAR. Recebido no
  --                                    ecrã, dinheiro nenhum no Fluxo de Caixa.
  --
  --    É a mesma classe de dessincronização que a onda 077→085 fecha noutros
  --    sítios — aqui entrava pela porta dos argumentos.
  IF p_status = 'nao_informado' AND COALESCE(p_paid_amount, 0) > 0 THEN
    RAISE EXCEPTION 'SERVICE_PAYMENT_STATUS_AMOUNT_INCOHERENT: nao_informado com valor %', p_paid_amount
      USING ERRCODE = 'check_violation',
            HINT = 'Um valor recebido exige um estado de recebimento (sinal_50 ou pago_total).';
  END IF;

  IF p_status <> 'nao_informado' AND p_paid_amount IS NOT NULL AND p_paid_amount = 0 THEN
    RAISE EXCEPTION 'SERVICE_PAYMENT_STATUS_AMOUNT_INCOHERENT: % com valor zero', p_status
      USING ERRCODE = 'check_violation',
            HINT = 'Para retirar o recebimento, use o estado nao_informado.';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT * INTO v_svc
    FROM public.services
   WHERE id = p_service_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SERVICE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- Quanto foi recebido. Um valor explícito manda; caso contrário deriva-se
  -- do total, como os botões 50% / 100% fazem.
  IF p_paid_amount IS NOT NULL THEN
    v_recebido := p_paid_amount;
  ELSIF p_status IN ('sinal_50', 'pago_total') THEN
    SELECT COALESCE(vat_rate, 23) INTO v_vat
      FROM public.company_settings WHERE company_id = p_company_id;
    v_vat := COALESCE(v_vat, 23);

    v_base      := COALESCE(v_svc.manual_value, v_svc.calculated_value, 0);
    v_apply_vat := COALESCE(v_svc.apply_vat, true);

    -- Avença mensal: o valor do serviço é a fatia do mês, não o preço todo.
    IF v_svc.contract_id IS NOT NULL THEN
      DECLARE
        v_fixed_monthly boolean;
        v_fixed_price   numeric;
        v_contract_vat  boolean;
      BEGIN
        SELECT fixed_monthly, fixed_price, apply_vat
          INTO v_fixed_monthly, v_fixed_price, v_contract_vat
          FROM public.contracts
         WHERE id = v_svc.contract_id AND company_id = p_company_id;

        IF COALESCE(v_fixed_monthly, false) THEN
          v_ym := to_char(v_svc.scheduled_start AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM');
          SELECT count(*) INTO v_count
            FROM public.services s
           WHERE s.company_id = p_company_id
             AND s.contract_id = v_svc.contract_id
             AND s.status <> 'cancelado'
             AND to_char(s.scheduled_start AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM') = v_ym;
          v_count     := GREATEST(1, COALESCE(v_count, 1));
          v_base      := round(COALESCE(v_fixed_price, 0) / v_count, 2);
          v_apply_vat := COALESCE(v_contract_vat, false);
        END IF;
      END;
    END IF;

    v_total    := v_base * (CASE WHEN v_apply_vat THEN 1 + v_vat / 100 ELSE 1 END);
    v_recebido := CASE WHEN p_status = 'pago_total' THEN v_total ELSE v_total / 2 END;
    v_recebido := round(v_recebido, 2);
  END IF;

  -- 🔴 A mesma coerência, agora sobre o valor DERIVADO.
  --
  --    A guarda dos argumentos não chega: um serviço sem valor nenhum
  --    (`manual_value` e `calculated_value` a NULL) derivava zero, e
  --    `pago_total` caía outra vez no ramo de apagar o caixa. A incoerência
  --    entrava pela porta dos dados em vez da porta dos argumentos, e o efeito
  --    era exactamente o mesmo.
  IF p_status <> 'nao_informado' AND v_recebido <= 0 THEN
    RAISE EXCEPTION 'SERVICE_PAYMENT_STATUS_AMOUNT_INCOHERENT: % sem valor a receber', p_status
      USING ERRCODE = 'check_violation',
            HINT = 'O serviço não tem valor. Defina o valor antes de registar o recebimento.';
  END IF;

  UPDATE public.services
     SET payment_status = p_status,
         -- 🔴 `nao_informado` significa «sem dinheiro», e o registo tem de o
         --    dizer sozinho. Um `paid_amount = 0` com `paid_at` preenchido é um
         --    recebimento de zero euros: uma terceira leitura possível que não
         --    corresponde a nada. Normaliza-se para NULL.
         paid_amount    = CASE WHEN p_status = 'nao_informado' THEN NULL ELSE p_paid_amount END,
         paid_at        = CASE WHEN p_status = 'nao_informado' THEN NULL ELSE now() END
   WHERE id = p_service_id AND company_id = p_company_id;

  -- O caixa, no MESMO acto.
  IF v_recebido > 0 THEN
    INSERT INTO public.cash_flow_entries (
      company_id, type, amount, description, category, date,
      reference_id, reference_type, status
    ) VALUES (
      p_company_id, 'entrada', v_recebido,
      'Cobrança serviço ' || COALESCE(v_svc.reference_number, p_service_id::text),
      'faturacao',
      (now() AT TIME ZONE 'Europe/Lisbon')::date,
      p_service_id, 'service_payment', 'confirmado'
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
       AND reference_type = 'service_payment'
       AND reference_id = p_service_id;
  END IF;

  RETURN QUERY SELECT p_service_id, v_recebido;
END;
$fn$;
