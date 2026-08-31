-- ============================================================================
-- 086 — cobrança avulsa, e o dinheiro da cobrança numa só transação
-- ============================================================================
--
-- Esta migration é FUNDAÇÃO. Não muda nenhum ecrã: cria a entidade e as
-- transações que a interface vai passar a usar, e fecha dois buracos de
-- atomicidade que já existem hoje.
--
-- ── 1. Porque é que a cobrança avulsa é uma tabela nova ────────────────────
--
--    Duas alternativas foram medidas e rejeitadas:
--
--    · `invoice_items` com `service_id = NULL` — não identifica nada. O
--      `generateInvoices` já usa `service_id = NULL` para as linhas sintéticas
--      de preço fixo e de avença mensal, e a leitura de produção mostra
--      32 de 32 itens sem serviço. Usar essa ausência como marca de «avulsa»
--      seria construir semântica sobre um campo que já significa outra coisa.
--      Além disso `invoice_id` é NOT NULL: toda a linha teria de nascer presa
--      a uma fatura que pode não existir.
--
--    · um `services` fictício — representaria dinheiro com trabalho. Entraria
--      no calendário, na escala, no mapa, nas equipas, nos relatórios
--      operacionais e no realtime de `services`. Criar trabalho a fingir para
--      registar uma cobrança é mentir a toda a operação para agradar ao
--      financeiro.
--
--    Uma cobrança avulsa é uma obrigação de cliente — um recebível. Não é um
--    serviço, não é um movimento de caixa, não é uma fatura. Passa a ter
--    tabela própria.
--
-- ── 2. Porque é que as RPCs atómicas existem ───────────────────────────────
--
-- 🔴 `setServicePayment` NÃO é atómico hoje. Faz:
--
--        UPDATE services  (payment_status, paid_amount, paid_at)   ← commit
--        …
--        INSERT/UPDATE/DELETE cash_flow_entries                    ← depois
--
--    Se a segunda falhar, o serviço fica marcado como recebido e o caixa fica
--    no estado anterior. Para quem clicou, «recebeu»; para o Fluxo de Caixa,
--    não entrou dinheiro nenhum. É exactamente a dessincronização que a onda
--    077→085 existe para impedir, num sítio onde ainda não tinha sido fechada.
--
--    A partir daqui, estado da cobrança e movimento de caixa são um só acto.
--
-- ── 3. Porque é que apagar um serviço pago passa a ser recusado ────────────
--
-- 🔴 `cash_flow_entries.reference_id` é polimórfico e não tem FK para
--    `services`. A `delete_calendar_service_safe` (062) protege os
--    `excluded_dates`, o contrato e o histórico — mas não olha para o caixa.
--    Apagar um serviço com recebimento deixaria um movimento de caixa a
--    apontar para uma linha que já não existe.
--
--    Produção hoje: ORPHAN_SERVICE_PAYMENT_CASHFLOWS = 0. Não há nada a
--    reparar — há um zero a preservar por construção, antes de a interface
--    ganhar um botão «Excluir» que o poderia quebrar pela primeira vez.
--
--    A resposta não é apagar o dinheiro em silêncio: é recusar, e dizer à
--    pessoa para remover o recebimento primeiro — pela acção canónica, que
--    desfaz os dois lados na mesma transação.
--
-- ── O que esta migration NÃO faz ───────────────────────────────────────────
--
--    · não altera nenhum ecrã;
--    · não liga `manual_charges` a `invoice_items`. O modelo de faturas não
--      tem alocação parcial suficiente para converter um recebimento de
--      cobrança avulsa em pagamento de fatura sem arriscar contar o mesmo
--      dinheiro duas vezes. Uma cobrança avulsa é uma cobrança financeira
--      independente, e não um documento legal. A integração, se for desejada,
--      é uma extensão explícita e posterior;
--    · não repara dados: não há dados a reparar.
-- ============================================================================

-- ─── 1. manual_charges — a obrigação de cliente ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.manual_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES public.clients(id)   ON DELETE RESTRICT,

  charge_date   date NOT NULL,
  description   text NOT NULL,
  -- O valor da obrigação, sem IVA. `apply_vat` diz se o total leva IVA, tal
  -- como em `services` — para que a Cobrança Diária possa somar as duas
  -- origens sem uma segunda regra de cálculo.
  amount        numeric(10,2) NOT NULL,
  apply_vat     boolean NOT NULL DEFAULT true,

  -- Os mesmos três estados de `services.payment_status`: o Diário mostra as
  -- duas origens lado a lado, e dois vocabulários diferentes obrigariam a
  -- traduzir de um para o outro em cada leitura.
  payment_status text NOT NULL DEFAULT 'nao_informado'
    CHECK (payment_status IN ('nao_informado', 'sinal_50', 'pago_total')),
  paid_amount   numeric(10,2),
  paid_at       timestamptz,

  notes         text,

  -- 🔴 Anular, não apagar. Uma cobrança que já teve recebimento não pode
  --    desaparecer: o movimento de caixa que ela gerou é histórico, e apagar
  --    a origem deixaria o dinheiro sem explicação. `voided_at` retira-a das
  --    listas sem destruir o registo.
  voided_at     timestamptz,
  voided_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT manual_charges_amount_positivo CHECK (amount > 0),
  -- Um valor recebido negativo não é um recebimento.
  CONSTRAINT manual_charges_paid_amount_nao_negativo
    CHECK (paid_amount IS NULL OR paid_amount >= 0),
  -- Anulada exige quem anulou: um registo anulado sem autor é um registo que
  -- ninguém pode explicar depois.
  CONSTRAINT manual_charges_void_coerente
    CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);

COMMENT ON TABLE public.manual_charges IS
  'Cobranca avulsa: obrigacao de cliente sem servico por tras. Nao e servico, '
  'nao e movimento de caixa, nao e fatura. O recebimento entra pelo caixa via '
  'set_manual_charge_payment_atomic, com reference_type = manual_charge.';

CREATE INDEX IF NOT EXISTS idx_manual_charges_company_date
  ON public.manual_charges (company_id, charge_date);
CREATE INDEX IF NOT EXISTS idx_manual_charges_company_client
  ON public.manual_charges (company_id, client_id);
-- O Diário lista por dia e ignora as anuladas: o índice parcial serve
-- exactamente essa consulta.
CREATE INDEX IF NOT EXISTS idx_manual_charges_company_date_ativas
  ON public.manual_charges (company_id, charge_date)
  WHERE voided_at IS NULL;

-- ─── 2. O cliente tem de ser da mesma empresa ───────────────────────────────
--
-- 🔴 Duas FKs para `companies` e `clients` não impedem cruzar empresas: nada
--    obriga o cliente a pertencer à empresa da cobrança. Uma FK composta
--    obriga — e obriga na base, não na aplicação.
CREATE UNIQUE INDEX IF NOT EXISTS clients_id_company_unique
  ON public.clients (id, company_id);

ALTER TABLE public.manual_charges
  DROP CONSTRAINT IF EXISTS manual_charges_client_mesma_empresa;
ALTER TABLE public.manual_charges
  ADD CONSTRAINT manual_charges_client_mesma_empresa
  FOREIGN KEY (client_id, company_id)
  REFERENCES public.clients (id, company_id)
  ON DELETE RESTRICT;

-- ─── 3. Histórico, como nas outras tabelas de negócio ───────────────────────
DROP TRIGGER IF EXISTS trg_history ON public.manual_charges;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.manual_charges
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

-- ─── 4. RLS e ACL — o modelo endurecido pós-084/085 ─────────────────────────
--
-- Leitura para admin/gestor da própria empresa; escrita só pelo caminho
-- canónico (Server Action com service-role → RPC). O browser nunca escreve.
ALTER TABLE public.manual_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manual_charges_manager_select" ON public.manual_charges;
CREATE POLICY "manual_charges_manager_select"
  ON public.manual_charges
  FOR SELECT
  USING (
    company_id = public.get_my_company_id()
    AND public.get_my_role() IN ('admin', 'gestor')
  );

-- Nenhuma policy de INSERT/UPDATE/DELETE, e isso é deliberado: sem policy
-- permissiva, o RLS nega. `service_role` é BYPASSRLS e escreve pelo caminho
-- canónico.
REVOKE ALL PRIVILEGES ON TABLE public.manual_charges FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.manual_charges FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.manual_charges FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.manual_charges FROM service_role;

GRANT SELECT ON TABLE public.manual_charges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manual_charges TO service_role;

-- ─── 5. cash_flow_entries aceita `manual_charge` ────────────────────────────
--
-- Extensão aditiva: todos os valores actuais continuam aceites. O índice único
-- (company_id, reference_type, reference_id) da 024 continua a garantir, sem
-- alteração, no máximo um movimento automático por cobrança.
ALTER TABLE public.cash_flow_entries
  DROP CONSTRAINT IF EXISTS cash_flow_entries_reference_type_check;

ALTER TABLE public.cash_flow_entries
  ADD CONSTRAINT cash_flow_entries_reference_type_check
  CHECK (
    reference_type IS NULL
    OR reference_type IN (
      'invoice',                  -- 20260608_new_features
      'payroll',                  -- 20260608_new_features
      'service_payment',          -- 049 (Cobrança Diária)
      'fixed_variable_payment',   -- 075 (Pagamentos fixos/variáveis)
      'manual_charge'             -- 086 (Cobrança avulsa)
    )
  );

-- ─── 6. RPC — pagamento de SERVIÇO, numa só transação ───────────────────────
--
-- 🔴 Substitui a sequência «UPDATE services; depois sincroniza o caixa» por um
--    acto só. O valor recebido é decidido AQUI, com a linha trancada, para que
--    dois cliques simultâneos não produzam dois movimentos.
--
--    A regra do valor replica a que a aplicação já usava, incluindo a fatia de
--    avença mensal (preço fixo ÷ serviços do mês) — não é uma segunda regra: é
--    a mesma, movida para onde a escrita acontece.
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

  UPDATE public.services
     SET payment_status = p_status,
         paid_amount    = p_paid_amount,
         paid_at        = CASE
                            WHEN p_status = 'nao_informado' AND p_paid_amount IS NULL
                            THEN NULL ELSE now()
                          END
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

-- ─── 7. RPC — pagamento de COBRANÇA AVULSA, numa só transação ───────────────
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

  UPDATE public.manual_charges
     SET payment_status = p_status,
         paid_amount    = p_paid_amount,
         paid_at        = CASE
                            WHEN p_status = 'nao_informado' AND p_paid_amount IS NULL
                            THEN NULL ELSE now()
                          END,
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

-- ─── 8. RPC — anular cobrança avulsa, com guarda financeira ─────────────────
--
-- 🔴 Anular não é apagar, e uma cobrança com recebimento não se anula em
--    silêncio: o movimento de caixa que ela gerou ficaria sem origem. Primeiro
--    remove-se o recebimento — que desfaz os dois lados na mesma transação —
--    e só depois se anula.
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

-- ─── 9. RPC — editar cobrança avulsa, fail-closed sobre dinheiro ────────────
--
-- 🔴 Alterar `amount`/`apply_vat` de uma cobrança já recebida recalcularia
--    dinheiro histórico em silêncio. Recusa-se: quem precisa de mudar o valor
--    remove o recebimento, altera, e volta a marcar. Descrição, data e notas
--    continuam editáveis sempre — não movem dinheiro.
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

  v_mexe_dinheiro := (p_patch ? 'amount') OR (p_patch ? 'apply_vat');

  IF v_mexe_dinheiro
     AND (v_chg.payment_status <> 'nao_informado' OR COALESCE(v_chg.paid_amount, 0) > 0) THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_PAID_AMOUNT_LOCKED'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Remova o recebimento antes de alterar o valor desta cobranca.';
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

-- ─── 10. delete_calendar_service_safe — guarda financeira ───────────────────
--
-- 🔴 `CREATE OR REPLACE` da função da 062, preservando tudo o que ela já fazia
--    (excluded_dates, contrato, actor, histórico) e acrescentando uma única
--    coisa: recusar quando há dinheiro em jogo.
--
--    Para `scope = 'all'`, a verificação cobre TODAS as ocorrências. Uma só
--    ocorrência paga bloqueia a operação inteira — apagar dezassete e parar na
--    décima oitava seria pior do que não apagar nenhuma.
CREATE OR REPLACE FUNCTION public.delete_calendar_service_safe(
  p_service_id uuid,
  p_scope text,
  p_company_id uuid,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_svc record;
  v_deleted int := 0;
  v_recurring boolean;
  v_date date;
  v_already boolean;
  v_pagas int := 0;
BEGIN
  IF p_scope NOT IN ('single', 'all') THEN
    RAISE EXCEPTION 'scope inválido: %', p_scope;
  END IF;
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;
  SELECT id, contract_id, scheduled_start, location_id
    INTO v_svc
  FROM public.services
  WHERE id = p_service_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Serviço não encontrado (já eliminado ou de outra empresa). Atualize a página.';
  END IF;
  v_recurring := v_svc.contract_id IS NOT NULL;

  -- ── GUARDA FINANCEIRA ────────────────────────────────────────────────────
  --
  -- Antes de qualquer escrita. Um serviço com recebimento registado — pelo
  -- estado, pelo valor, ou por ter movimento de caixa — não se apaga: o
  -- movimento ficaria a apontar para uma linha inexistente.
  IF p_scope = 'all' AND v_svc.contract_id IS NOT NULL THEN
    SELECT count(*) INTO v_pagas
      FROM public.services s
     WHERE s.company_id = p_company_id
       AND s.contract_id = v_svc.contract_id
       AND (
         s.payment_status IS DISTINCT FROM 'nao_informado'
         OR COALESCE(s.paid_amount, 0) > 0
         OR EXISTS (
           SELECT 1 FROM public.cash_flow_entries c
            WHERE c.company_id = p_company_id
              AND c.reference_type = 'service_payment'
              AND c.reference_id = s.id
         )
       );
    IF v_pagas > 0 THEN
      RAISE EXCEPTION
        'SERVICE_DELETE_BLOCKED_BY_PAYMENT: Existem ocorrências com recebimentos registados. Remova-os antes de excluir a recorrência.'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  ELSE
    SELECT count(*) INTO v_pagas
      FROM public.services s
     WHERE s.id = p_service_id
       AND s.company_id = p_company_id
       AND (
         s.payment_status IS DISTINCT FROM 'nao_informado'
         OR COALESCE(s.paid_amount, 0) > 0
         OR EXISTS (
           SELECT 1 FROM public.cash_flow_entries c
            WHERE c.company_id = p_company_id
              AND c.reference_type = 'service_payment'
              AND c.reference_id = s.id
         )
       );
    IF v_pagas > 0 THEN
      RAISE EXCEPTION
        'SERVICE_DELETE_BLOCKED_BY_PAYMENT: Este serviço tem um recebimento registado. Remova o recebimento antes de excluir o serviço.'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  -- ── fim da guarda ────────────────────────────────────────────────────────

  IF p_scope = 'all' AND v_svc.contract_id IS NOT NULL THEN
    UPDATE public.contracts
       SET status = 'cancelado'
     WHERE id = v_svc.contract_id AND company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Não foi possível arquivar a recorrência — nada foi eliminado.';
    END IF;
    DELETE FROM public.services
     WHERE company_id = p_company_id AND contract_id = v_svc.contract_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted = 0 THEN
      RAISE EXCEPTION 'Nada foi eliminado — nenhuma alteração aplicada.';
    END IF;
  ELSE
    IF v_svc.contract_id IS NOT NULL THEN
      v_date := (v_svc.scheduled_start AT TIME ZONE 'Europe/Lisbon')::date;
      SELECT v_date = ANY(COALESCE(excluded_dates, '{}')) INTO v_already
        FROM public.contracts
       WHERE id = v_svc.contract_id AND company_id = p_company_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Contrato da ocorrência não encontrado — nada foi eliminado.';
      END IF;
      IF NOT COALESCE(v_already, false) THEN
        UPDATE public.contracts
           SET excluded_dates = array_append(COALESCE(excluded_dates, '{}'), v_date)
         WHERE id = v_svc.contract_id AND company_id = p_company_id;
      END IF;
    END IF;
    DELETE FROM public.services
     WHERE id = p_service_id AND company_id = p_company_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted = 0 THEN
      RAISE EXCEPTION 'Nada foi eliminado — nenhuma alteração aplicada (rollback total).';
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'recurring', v_recurring,
    'location_id', v_svc.location_id,
    'contract_id', v_svc.contract_id
  );
END;
$$;

-- ─── 11. ACL das funções — service_role apenas ──────────────────────────────
--
-- Todas são invocadas por Server Action com service-role. Nenhuma tem caller
-- autenticado legítimo: expô-las ao browser deixaria alguém marcar
-- recebimentos sem passar pela guarda de papéis da aplicação.
REVOKE ALL PRIVILEGES ON FUNCTION public.set_service_payment_atomic(uuid, uuid, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_service_payment_atomic(uuid, uuid, text, numeric, uuid) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.set_manual_charge_payment_atomic(uuid, uuid, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_manual_charge_payment_atomic(uuid, uuid, text, numeric, uuid) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.void_manual_charge_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.void_manual_charge_atomic(uuid, uuid, uuid) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.update_manual_charge_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.update_manual_charge_atomic(uuid, uuid, jsonb, uuid) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.delete_calendar_service_safe(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_calendar_service_safe(uuid, text, uuid, uuid) TO service_role;
