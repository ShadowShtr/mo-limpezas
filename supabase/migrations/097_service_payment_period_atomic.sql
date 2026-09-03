-- ============================================================================
-- 097 — pagamento de serviços dentro do protocolo de período
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- O que falta hoje, exactamente — e são DUAS coisas
-- ---------------------------------------------------------------------------
--
-- 1. `set_service_payment_atomic` (086) é atómica de verdade: tranca o serviço,
--    valida o estado, calcula o valor e escreve o par serviço+caixa na mesma
--    transação. O que ela não faz é olhar para o PERÍODO. Com o mês fechado,
--    um recebimento de serviço entra na mesma.
--
-- 2. O runtime publicado **não a chama**. `setServicePayment`, em
--    `src/app/actions/daily-billing.ts`, faz INSERT/UPDATE/DELETE directos em
--    `cash_flow_entries` e um UPDATE em `services`, em viagens separadas e sem
--    guarda de período nenhuma.
--
-- Esta migration fecha (1). O (2) é da PR de runtime, e fica registado no
-- inventário: `setServicePayment` MUST_CALL = `set_service_payment_atomic`.
-- Aplicar esta migration sem essa substituição protege a RPC e deixa o caminho
-- que a aplicação usa de facto exactamente como está — por isso ela não fecha o
-- writer sozinha, e o inventário só o dá por fechado com as duas metades.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade — EXPAND FIRST
-- ---------------------------------------------------------------------------
--
-- Assinatura EXACTA da 086, e toda a lógica preservada à letra: a coerência
-- entre estado e valor pelos argumentos E pelo valor derivado, o IVA por
-- `company_settings`, a fatia mensal da avença calculada pelo número de serviços
-- do mês, a normalização de `paid_amount`/`paid_at` para NULL em
-- `nao_informado`, e o `ON CONFLICT` com o predicado parcial da 024.
--
-- O que muda é o comportamento com o mês FECHADO — que passa a ser recusa. Em
-- produção `financial_periods` está vazia, portanto nenhuma chamada existente
-- muda de resultado.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_period_dates_open_locked', 'p_company_id uuid, p_dates date[]'),
      ('set_service_payment_atomic',                'p_company_id uuid, p_service_id uuid, p_status text, p_paid_amount numeric, p_actor uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_PAYMENT_097_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;
END
$precondicoes$;

-- ─── Recebimento de serviço, com todos os períodos que toca ─────────────────
--
-- `CREATE OR REPLACE` da função da 086.
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
  v_data_svc   date;
  v_data_caixa date := (now() AT TIME ZONE 'Europe/Lisbon')::date;
  v_datas_caixa date[];
  v_datas      date[];
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

  -- ── O conjunto COMPLETO de períodos, e só depois os locks ─────────────────
  --
  -- 🔴 Até TRÊS meses, pela mesma razão da 091:
  --
  --      · o mês do SERVIÇO — `scheduled_start` em Lisboa, que é a data do
  --        facto e não a data em que alguém carregou no botão;
  --      · o mês de HOJE, mas só quando de facto entra dinheiro hoje. Retirar
  --        um recebimento não escreve nada datado de hoje, e trancar o mês
  --        corrente nesse caso recusaria uma correcção legítima só porque o mês
  --        em que ela é feita já fechou;
  --      · o mês de CADA movimento de caixa já ligado a este serviço, que foi
  --        criado noutro dia e pode ser um terceiro mês. O ramo de receber
  --        reescreve-lhe a data; o de retirar apaga-o. Nos dois casos o mês de
  --        onde ele sai muda de conteúdo.
  --
  --    Ler `cash_flow_entries` antes do lock de período é seguro porque a linha
  --    de `services` já está `FOR UPDATE` e é esta função — a única — que cria e
  --    apaga movimentos com `reference_type = 'service_payment'`. Quem
  --    acrescentar outro writer desse vínculo tem de manter essa premissa.
  v_data_svc := (v_svc.scheduled_start AT TIME ZONE 'Europe/Lisbon')::date;

  SELECT array_agg(c.date) INTO v_datas_caixa
    FROM public.cash_flow_entries c
   WHERE c.company_id     = p_company_id
     AND c.reference_type = 'service_payment'
     AND c.reference_id   = p_service_id;

  v_datas := ARRAY[v_data_svc] || COALESCE(v_datas_caixa, ARRAY[]::date[]);

  IF v_recebido > 0 THEN
    v_datas := v_datas || v_data_caixa;
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, v_datas);

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
      v_data_caixa,
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
    -- Os meses destes movimentos já vêm trancados de cima, junto com todos os
    -- outros. Não há aquisição de lock a partir daqui.
    DELETE FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'service_payment'
       AND reference_id = p_service_id;
  END IF;

  RETURN QUERY SELECT p_service_id, v_recebido;
END;
$fn$;

-- ─── Superfície ─────────────────────────────────────────────────────────────
--
-- A mesma da 086 — `CREATE OR REPLACE` preserva os grants, mas repeti-los aqui
-- torna a superfície legível neste ficheiro.
REVOKE ALL PRIVILEGES ON FUNCTION public.set_service_payment_atomic(uuid, uuid, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_service_payment_atomic(uuid, uuid, text, numeric, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'set_service_payment_atomic'
       AND pg_get_function_identity_arguments(p.oid)
           = 'p_company_id uuid, p_service_id uuid, p_status text, p_paid_amount numeric, p_actor uuid'
       AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION 'SERVICE_PAYMENT_097_POSTSTATE_FAILED: assinatura ou segurança erradas';
  END IF;
END
$posestado$;
