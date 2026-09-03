-- ============================================================================
-- 094 — faturas dentro do protocolo de período
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- 🔴 Qual é a data económica de uma fatura — e porque é que são DUAS
-- ---------------------------------------------------------------------------
--
-- Este ficheiro não inventa contabilidade nenhuma. Limita-se a usar as duas
-- datas a que o sistema JÁ dá significado, e a reparar o facto de cada writer
-- olhar só para uma delas:
--
--   · `invoice_date` — a data de EMISSÃO do documento. É o que
--     `updateInvoiceStatus` e `deleteInvoice` já usam hoje como data
--     autoritativa, e está certo: um documento emitido em Setembro pertence a
--     Setembro;
--
--   · `period_start`/`period_end` — o PERÍODO FACTURADO, o trabalho que a
--     fatura cobra. É por esta data — e não por `invoice_date` — que
--     `financial_period_blockers` e `getFinancialCloseChecklist` contam as
--     faturas em rascunho. Uma fatura em rascunho de Julho impede Julho de
--     fechar, mesmo tendo sido emitida em Setembro.
--
-- As duas coexistem hoje e as duas estão certas, cada uma para a sua pergunta.
-- O que não está certo é uma mutação proteger uma e ignorar a outra:
--
--     gerar uma fatura muda o que Julho tem por facturar (bloqueador) E
--     acrescenta um documento a Setembro (emissão).
--
-- Portanto os dois meses entram no conjunto. Nas mais das vezes é o mesmo mês
-- — a geração normal corre no mês a que respeita — e o protocolo da 090
-- deduplica: um lock lógico só.
--
-- ---------------------------------------------------------------------------
-- 🔴 O lock do NÚMERO e o lock do PERÍODO são dois recursos diferentes
-- ---------------------------------------------------------------------------
--
-- A 072 já adquire um advisory lock para serializar a atribuição do número:
--
--     pg_advisory_xact_lock(hashtext(company || ':' || year))     ← UM argumento
--
-- e o protocolo de período usa a forma de dois:
--
--     pg_advisory_xact_lock(hashtext(company), year * 100 + month)
--
-- No PostgreSQL estes são espaços SEPARADOS — a forma de um argumento e a de
-- dois nunca colidem, mesmo que os números coincidam. Não há aqui risco de um
-- bloquear o outro por acidente.
--
-- O que HÁ é risco de ordem. Se uma transação adquirisse o número antes do
-- período e outra o contrário, voltava a haver ciclo. A regra que este ficheiro
-- segue, e que fica escrita para quem acrescentar writers:
--
--     PERÍODOS primeiro, sempre. Qualquer outro advisory lock vem depois.
--
-- E é possível fazê-lo aqui porque `p_invoice_date` e `p_period_start` são
-- PARÂMETROS: o conjunto de períodos é conhecido antes de tudo o resto, sem
-- precisar de ler linha nenhuma.
--
-- ---------------------------------------------------------------------------
-- O que falta hoje, exactamente
-- ---------------------------------------------------------------------------
--
--   · `generateInvoices` chama `create_invoice_with_items` sem guarda nenhuma
--     de período — `NO_GUARD`;
--   · `updateInvoiceStatus` e `deleteInvoice` têm guarda na server action, uma
--     viagem antes da escrita — `RACY`.
--
-- E `updateInvoiceStatus` é pior do que isso: faz o UPDATE da fatura numa
-- viagem e o INSERT/DELETE do movimento de caixa noutra. Não é só o período que
-- não é atómico — a fatura e o caixa também não. Uma falha entre as duas deixa
-- a fatura `pago` sem movimento, ou um movimento de uma fatura que voltou a
-- pendente.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade — adoptar a identidade exacta do prestate externo
-- ---------------------------------------------------------------------------
--
-- `create_invoice_with_items` mantém a assinatura EXACTA e toda a lógica da
-- 072: a recusa de fatura sem linhas, o lock do número, o `service_id` nas
-- linhas (é por ele que `getUnbilledServices` sabe o que já foi facturado) e a
-- verificação de que todas as linhas entraram.
--
-- `set_invoice_status_atomic` existe como drift órfão na produção. A 094 adopta
-- a mesma identidade, não cria uma segunda assinatura, e reconstrói o corpo
-- contra os contratos canónicos da 078.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_period_dates_open_locked', 'p_company_id uuid, p_dates date[]'),
      ('create_invoice_with_items',                 'p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb'),
      ('lock_domain_mutation',                      'p_company_id uuid, p_mutation_id uuid'),
      ('find_or_conflict_domain_mutation',          'p_company_id uuid, p_mutation_id uuid, p_operation text, p_request_hash text'),
      ('complete_domain_mutation',                  'p_company_id uuid, p_mutation_id uuid, p_domain text, p_operation text, p_request_hash text, p_status text, p_result jsonb, p_entity_id uuid'),
      ('record_company_change_event',               'p_company_id uuid, p_mutation_id uuid, p_domain text, p_event_type text, p_entity_ids uuid[], p_scopes text[], p_affected_from date, p_affected_to date, p_payload jsonb')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;

  IF to_regclass('public.invoice_items') IS NULL THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: tabela invoice_items ausente';
  END IF;

  IF to_regclass('public.domain_mutations') IS NULL
     OR to_regclass('public.company_change_events') IS NULL
     OR to_regclass('public.bank_reconciliation_matches') IS NULL THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: fundações de mutation/evento ou reconciliação ausentes';
  END IF;

  IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: pgcrypto.digest(bytea,text) ausente';
  END IF;

  IF to_regclass('public.cash_flow_entries_reference_unique') IS NULL THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: índice único de referência do caixa ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices'
       AND column_name = 'revision' AND data_type = 'integer' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: invoices.revision integer NOT NULL ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name IN ('id', 'company_id', 'role')
     GROUP BY table_name
     HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: guard de empresa/actor incompleto';
  END IF;
END
$precondicoes$;

-- ─── 🔴 A identidade órfã que uma leitura de produção encontrou ─────────────
--
-- `set_invoice_status_atomic` não é nova na BASE. É uma RPC órfã que a 094
-- adopta pela identidade exacta, substituindo o corpo stale.
--
-- Uma leitura read-only de produção (2026-09-03) encontrou lá uma função com
-- este nome e outra assinatura:
--
--     set_invoice_status_atomic(
--       p_invoice_id uuid, p_company_id uuid, p_actor uuid, p_status text,
--       p_payment_method text, p_mutation_id uuid, p_expected_revision integer
--     ) RETURNS jsonb  —  SECURITY DEFINER
--
-- A origem histórica exacta continua desconhecida. O contrato de produção usa
-- `public.domain_mutations` para idempotência e `invoices.revision` para o
-- bloqueio optimista.
--
-- 🔴 O que aconteceria sem esta guarda, e é o pior desfecho possível:
--
--    O PostgreSQL não substituiria nada. Assinaturas diferentes dão uma
--    SOBRECARGA — passariam a existir DUAS funções com o mesmo nome. O runtime
--    continuaria a chamar a antiga, sem protecção de período, e o ecrã diria
--    que a migration correu bem. Uma segunda verdade sobre a mesma operação, e
--    silenciosa.
--
DO $colisao$
DECLARE
  v_total integer;
  v_assinatura text;
  v_retorno text;
  v_definer boolean;
BEGIN
  SELECT count(*) INTO v_total
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'set_invoice_status_atomic';

  IF v_total > 1 THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_UNEXPECTED_OVERLOAD: existem % assinaturas de set_invoice_status_atomic', v_total;
  END IF;

  IF v_total = 1 THEN
    SELECT pg_get_function_identity_arguments(p.oid),
           pg_get_function_result(p.oid), p.prosecdef
      INTO v_assinatura, v_retorno, v_definer
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'set_invoice_status_atomic';

    IF v_assinatura <> 'p_invoice_id uuid, p_company_id uuid, p_actor uuid, p_status text, p_payment_method text, p_mutation_id uuid, p_expected_revision integer'
       OR v_retorno <> 'jsonb'
       OR NOT v_definer THEN
      RAISE EXCEPTION 'INVOICES_PERIOD_094_UNEXPECTED_PRESTATE: set_invoice_status_atomic = %, returns %, security_definer=%',
        v_assinatura, v_retorno, v_definer;
    END IF;

    -- A função é substituída pela mesma identidade; não fica overload.
    EXECUTE 'DROP FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer)';
  END IF;
END
$colisao$;

-- ─── 1. Criar a fatura, sob o lock da emissão E do período facturado ────────
--
-- `CREATE OR REPLACE` da função da 072, com tudo o que ela fazia preservado.
CREATE OR REPLACE FUNCTION public.create_invoice_with_items(
  p_company_id   uuid,
  p_client_id    uuid,
  p_prefix       text,
  p_year         int,
  p_invoice_date date,
  p_due_date     date,
  p_period_start date,
  p_period_end   date,
  p_subtotal     numeric,
  p_vat_rate     numeric,
  p_vat_amount   numeric,
  p_total        numeric,
  p_items        jsonb
)
RETURNS TABLE (invoice_id uuid, invoice_number text)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_maior   int;
  v_numero  text;
  v_id      uuid;
  v_itens   int;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Uma fatura sem linhas é um documento a zero que parece emitido.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Os períodos ANTES do lock do número, e antes de qualquer escrita.
  --
  --    Emissão e período facturado. `p_period_start`/`p_period_end` podem vir a
  --    NULL — o protocolo descarta datas nulas — e nesse caso resta a emissão,
  --    que é obrigatória na tabela. Quando caem todos no mesmo mês, é um lock
  --    lógico só.
  PERFORM public.assert_financial_period_dates_open_locked(
    p_company_id, ARRAY[p_invoice_date, p_period_start, p_period_end]
  );

  -- Serializa a atribuição do número por empresa e ano.
  --
  -- 🔴 Espaço de lock diferente do do período: esta é a forma de UM argumento,
  --    a do período é a de dois, e no PostgreSQL nunca colidem.
  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':' || p_year::text));

  -- 🔴 Alias obrigatório: `invoice_number` é ao mesmo tempo coluna desta
  --    tabela e parâmetro de saída da função, e o plpgsql resolve a favor do
  --    parâmetro. Sem o `i.`, isto rebenta com «column reference is
  --    ambiguous» — apanhado pelo ensaio, que é para isso que ele serve.
  SELECT COALESCE(MAX((regexp_match(i.invoice_number, '/(\d+)$'))[1]::int), 0)
    INTO v_maior
    FROM public.invoices i
   WHERE i.company_id = p_company_id
     AND i.invoice_number LIKE p_prefix || p_year || '/%';

  v_numero := p_prefix || p_year || '/' || lpad((v_maior + 1)::text, 3, '0');

  INSERT INTO public.invoices (
    company_id, client_id, invoice_number, invoice_date, due_date,
    period_start, period_end, subtotal, vat_rate, vat_amount, total, status
  ) VALUES (
    p_company_id, p_client_id, v_numero, p_invoice_date, p_due_date,
    p_period_start, p_period_end, p_subtotal, p_vat_rate, p_vat_amount, p_total, 'rascunho'
  )
  RETURNING id INTO v_id;

  -- ───────────────────────────────────────────────────────────────────────────
  -- 🔴 `service_id` tem de vir, e a razão não é óbvia
  --
  -- É por esta coluna que `getUnbilledServices` sabe o que já foi faturado:
  -- cruza os serviços concluídos com os `invoice_items` que os referenciam.
  --
  -- Uma primeira versão desta função esquecia-a. O efeito seria discreto e
  -- caro: as faturas nasciam certas, mas os serviços que elas cobravam
  -- continuavam a aparecer como «por faturar» — e alguém acabaria por os
  -- faturar outra vez, ao cliente.
  --
  -- É opcional porque nem toda a linha vem de um serviço. As linhas sintéticas
  -- de avença mensal e de preço fixo cobrem um contrato, não uma visita, e
  -- ficam a `NULL` de propósito: inventar-lhes um `service_id` marcaria como
  -- faturado um serviço que aquela linha não cobre.
  -- ───────────────────────────────────────────────────────────────────────────
  INSERT INTO public.invoice_items (
    invoice_id, service_id, description, quantity, unit_price, total, sort_order
  )
  SELECT
    v_id,
    NULLIF(item->>'service_id', '')::uuid,
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'total')::numeric,
    COALESCE((item->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_itens = ROW_COUNT;
  IF v_itens <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'Gravadas % linhas de %.', v_itens, jsonb_array_length(p_items)
      USING ERRCODE = 'data_exception';
  END IF;

  RETURN QUERY SELECT v_id, v_numero;
END;
$$;

-- ─── 2. Mudar o estado da fatura E o caixa, na mesma transação ──────────────
--
-- NOVA, e substitui um caminho que hoje são DUAS viagens da server action:
-- primeiro o UPDATE da fatura, depois o INSERT ou o DELETE do movimento de
-- caixa. Uma falha entre as duas deixa a fatura `pago` sem movimento — ou um
-- movimento a existir para uma fatura que voltou a pendente. Não é só o período
-- que não era atómico.
--
-- Preserva exactamente o que a action faz:
--
--   · `pago`  → grava `paid_at` (o que já lá estava, se já estava pago) e
--     `payment_method`, e cria o movimento de entrada — uma vez só, pelo índice
--     único parcial da 024, e apenas se o total for um valor de caixa válido;
--   · qualquer outro estado → limpa `paid_at`/`payment_method` e remove o
--     movimento ligado.
--
-- 🔴 Os períodos são até QUATRO, e o quarto é o que a versão da action não
--    podia sequer ver:
--
--      · `invoice_date` — a emissão;
--      · `period_start`/`period_end` — o período facturado, que é por onde a
--        fatura conta como bloqueador de fecho;
--      · a data corrente — a data do movimento que nasce;
--      · a data do movimento que JÁ existe e vai ser removido, que foi criada
--        noutro dia e pode ser outro mês.
--
--    Tudo montado antes do primeiro lock, como a 090 exige.
CREATE OR REPLACE FUNCTION public.set_invoice_status_atomic(
  p_invoice_id     uuid,
  p_company_id     uuid,
  p_actor          uuid,
  p_status         text,
  p_payment_method text,
  p_mutation_id    uuid,
  p_expected_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_existing       jsonb;
  v_request_hash   text;
  v_before         jsonb;
  v_invoice        jsonb;
  v_result         jsonb;
  v_event          jsonb;
  v_inv            public.invoices%ROWTYPE;
  v_cash           public.cash_flow_entries%ROWTYPE;
  v_cash_found     boolean := false;
  v_invoice_changed boolean;
  v_cash_changed   boolean := false;
  v_client_name    text;
  v_cash_date      date;
  v_affected_from  date;
  v_affected_to    date;
BEGIN
  IF p_invoice_id IS NULL OR p_company_id IS NULL OR p_actor IS NULL
     OR p_status IS NULL OR p_mutation_id IS NULL OR p_expected_revision IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_actor
       AND company_id = p_company_id
       AND role IN ('admin', 'gestor')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN_ACTOR');
  END IF;

  -- O recibo é trancado antes de ler ou escrever o domínio. Um retry exacto
  -- devolve o resultado guardado; a mesma mutation_id com outra intenção falha.
  PERFORM public.lock_domain_mutation(p_company_id, p_mutation_id);
  v_request_hash := encode(public.digest(convert_to(jsonb_build_object(
    'operation', 'set_invoice_status_atomic',
    'invoice_id', p_invoice_id,
    'company_id', p_company_id,
    'status', p_status,
    'payment_method', p_payment_method,
    'expected_revision', p_expected_revision
  )::text, 'UTF8'), 'sha256'::text), 'hex');

  v_existing := public.find_or_conflict_domain_mutation(
    p_company_id, p_mutation_id, 'set_invoice_status_atomic', v_request_hash
  );
  IF v_existing IS NOT NULL THEN
    IF COALESCE((v_existing->>'replay')::boolean, false) THEN
      RETURN COALESCE(v_existing->'result', '{}'::jsonb) || jsonb_build_object('replay', true);
    END IF;
    RETURN v_existing;
  END IF;

  IF p_status NOT IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado') THEN
    v_result := jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    PERFORM public.complete_domain_mutation(
      p_company_id, p_mutation_id, 'billing', 'set_invoice_status_atomic',
      v_request_hash, 'rejected', v_result, p_invoice_id
    );
    RETURN v_result;
  END IF;

  -- A linha da fatura é o primeiro lock do writer. Só depois se descobre o
  -- movimento e se adquire o conjunto completo de períodos pela 090.
  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    PERFORM public.complete_domain_mutation(
      p_company_id, p_mutation_id, 'billing', 'set_invoice_status_atomic',
      v_request_hash, 'rejected', v_result, p_invoice_id
    );
    RETURN v_result;
  END IF;

  IF v_inv.revision <> p_expected_revision THEN
    v_result := jsonb_build_object(
      'ok', false, 'code', 'REVISION_CONFLICT',
      'current_revision', v_inv.revision, 'expected_revision', p_expected_revision
    );
    PERFORM public.complete_domain_mutation(
      p_company_id, p_mutation_id, 'billing', 'set_invoice_status_atomic',
      v_request_hash, 'rejected', v_result, p_invoice_id
    );
    RETURN v_result;
  END IF;

  SELECT * INTO v_cash
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'invoice'
     AND reference_id = p_invoice_id
   FOR UPDATE;
  v_cash_found := FOUND;

  IF v_cash_found THEN
    IF v_cash.type IS DISTINCT FROM 'entrada'
       OR v_cash.amount IS DISTINCT FROM v_inv.total
       OR v_cash.status IS DISTINCT FROM 'confirmado' THEN
      v_result := jsonb_build_object('ok', false, 'code', 'CASHFLOW_INVOICE_MISMATCH');
      PERFORM public.complete_domain_mutation(
        p_company_id, p_mutation_id, 'billing', 'set_invoice_status_atomic',
        v_request_hash, 'rejected', v_result, p_invoice_id
      );
      RETURN v_result;
    END IF;
    v_cash_date := v_cash.date;
  ELSIF p_status = 'pago' AND COALESCE(v_inv.total, 0) > 0 THEN
    v_cash_date := (now() AT TIME ZONE 'Europe/Lisbon')::date;
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(
    p_company_id,
    ARRAY[v_inv.invoice_date, v_inv.period_start, v_inv.period_end, v_cash_date]
  );

  IF p_status <> 'pago' AND v_cash_found AND EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
     WHERE m.company_id = p_company_id
       AND m.cash_flow_entry_id = v_cash.id
       AND m.status IN ('confirmed', 'reconciled')
  ) THEN
    v_result := jsonb_build_object('ok', false, 'code', 'RECONCILED_CASHFLOW');
    PERFORM public.complete_domain_mutation(
      p_company_id, p_mutation_id, 'billing', 'set_invoice_status_atomic',
      v_request_hash, 'rejected', v_result, p_invoice_id
    );
    RETURN v_result;
  END IF;

  v_before := to_jsonb(v_inv);
  v_invoice_changed := v_inv.status IS DISTINCT FROM p_status
    OR (p_status = 'pago' AND v_inv.payment_method IS DISTINCT FROM p_payment_method)
    OR (p_status <> 'pago' AND (v_inv.paid_at IS NOT NULL OR v_inv.payment_method IS NOT NULL));

  IF v_invoice_changed THEN
    UPDATE public.invoices
       SET status = p_status,
           paid_at = CASE WHEN p_status = 'pago' THEN COALESCE(v_inv.paid_at, now()) ELSE NULL END,
           payment_method = CASE WHEN p_status = 'pago' THEN p_payment_method ELSE NULL END,
           revision = v_inv.revision + 1,
           updated_at = now()
     WHERE id = p_invoice_id AND company_id = p_company_id AND revision = p_expected_revision
     RETURNING * INTO v_inv;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_UPDATE_FAILED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_status = 'pago' AND COALESCE(v_inv.total, 0) > 0 AND NOT v_cash_found THEN
    SELECT name INTO v_client_name
      FROM public.clients
     WHERE id = v_inv.client_id AND company_id = p_company_id;

    INSERT INTO public.cash_flow_entries (
      company_id, type, amount, description, category, date,
      reference_id, reference_type, status, created_by
    ) VALUES (
      p_company_id, 'entrada', v_inv.total,
      'Fatura ' || v_inv.invoice_number || ' - ' || COALESCE(v_client_name, 'Cliente'),
      'faturacao', v_cash_date, p_invoice_id, 'invoice', 'confirmado', p_actor
    ) RETURNING * INTO v_cash;
    v_cash_found := true;
    v_cash_changed := true;
  ELSIF p_status <> 'pago' AND v_cash_found THEN
    DELETE FROM public.cash_flow_entries
     WHERE id = v_cash.id AND company_id = p_company_id;
    v_cash_found := false;
    v_cash_changed := true;
  END IF;

  v_invoice := to_jsonb(v_inv);
  IF v_invoice_changed OR v_cash_changed THEN
    SELECT min(d), max(d) INTO v_affected_from, v_affected_to
      FROM unnest(ARRAY[v_inv.invoice_date, v_inv.period_start, v_inv.period_end, v_cash_date]) AS dates(d)
     WHERE d IS NOT NULL;

    v_event := public.record_company_change_event(
      p_company_id, p_mutation_id, 'billing', 'invoice_status_changed',
      ARRAY[p_invoice_id], ARRAY['cobrancas', 'financeiro', 'clientes', 'relatorios', 'conciliacao'],
      v_affected_from, v_affected_to,
      jsonb_build_object('invoice', v_invoice,
        'cash_flow_entry', CASE WHEN v_cash_found THEN to_jsonb(v_cash) ELSE NULL END)
    );

    INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
    VALUES (
      p_company_id, p_actor, 'invoice_status_changed', 'invoice', p_invoice_id::text,
      jsonb_build_object('before', v_before, 'after', v_invoice,
        'cash_flow_entry', CASE WHEN v_cash_found THEN to_jsonb(v_cash) ELSE NULL END,
        'mutation_id', p_mutation_id)
    );
  END IF;

  v_result := jsonb_build_object(
    'ok', true, 'code', 'OK', 'mutation_id', p_mutation_id,
    'invoice', v_invoice,
    'cash_flow_entry', CASE WHEN v_cash_found THEN to_jsonb(v_cash) ELSE NULL END,
    'event', v_event,
    'no_change', NOT (v_invoice_changed OR v_cash_changed)
  );

  PERFORM public.complete_domain_mutation(
    p_company_id, p_mutation_id, 'billing', 'set_invoice_status_atomic',
    v_request_hash, 'succeeded', v_result, p_invoice_id
  );
  RETURN v_result;
END;
$fn$;

-- ─── 3. Apagar um rascunho, sob os mesmos períodos ──────────────────────────
--
-- NOVA. Preserva a regra da action: só RASCUNHOS se apagam, e apagar o que já
-- não existe é sucesso e não erro.
--
-- 🔴 Apagar um rascunho muda o que o mês tem por facturar — é um dos quatro
--    bloqueadores do fecho, contado por `period_start`. Por isso o período
--    facturado entra no conjunto tanto como a emissão.
CREATE OR REPLACE FUNCTION public.delete_invoice_atomic(
  p_company_id uuid,
  p_invoice_id uuid,
  p_actor      uuid DEFAULT NULL
)
RETURNS TABLE (invoice_id uuid, apagados int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_inv      public.invoices%ROWTYPE;
  v_apagados int;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Já não existe. Apagar o que não existe é sucesso, não erro — é o que a
    -- action já respondia.
    RETURN QUERY SELECT p_invoice_id, 0;
    RETURN;
  END IF;

  IF v_inv.status <> 'rascunho' THEN
    RAISE EXCEPTION 'INVOICE_NOT_DRAFT'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Só faturas em rascunho podem ser eliminadas.';
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(
    p_company_id, ARRAY[v_inv.invoice_date, v_inv.period_start, v_inv.period_end]
  );

  DELETE FROM public.invoices
   WHERE id = p_invoice_id AND company_id = p_company_id AND status = 'rascunho';
  GET DIAGNOSTICS v_apagados = ROW_COUNT;

  RETURN QUERY SELECT p_invoice_id, v_apagados;
END;
$fn$;

-- ─── Superfície ─────────────────────────────────────────────────────────────
REVOKE ALL PRIVILEGES ON FUNCTION public.create_invoice_with_items(uuid, uuid, text, int, date, date, date, date, numeric, numeric, numeric, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.delete_invoice_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_invoice_with_items(uuid, uuid, text, int, date, date, date, date, numeric, numeric, numeric, numeric, jsonb) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.delete_invoice_atomic(uuid, uuid, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('create_invoice_with_items', 'p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb', false),
      ('set_invoice_status_atomic', 'p_invoice_id uuid, p_company_id uuid, p_actor uuid, p_status text, p_payment_method text, p_mutation_id uuid, p_expected_revision integer', true),
      ('delete_invoice_atomic',     'p_company_id uuid, p_invoice_id uuid, p_actor uuid', false)
    ) AS esperado(nome, assinatura, security_definer)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
         AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
         AND p.prosecdef = esperado.security_definer
    );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_POSTSTATE_FAILED: em falta ou com assinatura/segurança errada %', v_faltam;
  END IF;
END
$posestado$;
