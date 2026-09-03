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
-- Compatibilidade — EXPAND FIRST
-- ---------------------------------------------------------------------------
--
-- `create_invoice_with_items` mantém a assinatura EXACTA e toda a lógica da
-- 072: a recusa de fatura sem linhas, o lock do número, o `service_id` nas
-- linhas (é por ele que `getUnbilledServices` sabe o que já foi facturado) e a
-- verificação de que todas as linhas entraram.
--
-- `set_invoice_status_atomic` e `delete_invoice_atomic` são NOVAS: hoje esses
-- dois caminhos vivem na server action.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_period_dates_open_locked', 'p_company_id uuid, p_dates date[]'),
      ('create_invoice_with_items',                 'p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb')
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
END
$precondicoes$;

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
--      · `p_paid_on` — a data do movimento que nasce;
--      · a data do movimento que JÁ existe e vai ser removido, que foi criada
--        noutro dia e pode ser outro mês.
--
--    Tudo montado antes do primeiro lock, como a 090 exige.
CREATE OR REPLACE FUNCTION public.set_invoice_status_atomic(
  p_company_id     uuid,
  p_invoice_id     uuid,
  p_status         text,
  p_paid_on        date DEFAULT NULL,
  p_payment_method text DEFAULT NULL,
  p_actor          uuid DEFAULT NULL
)
RETURNS TABLE (invoice_id uuid, cash_entry_id uuid, movimentos_removidos int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_inv        public.invoices%ROWTYPE;
  v_datas_mov  date[];
  v_datas      date[];
  v_entrada    uuid;
  v_removidos  int := 0;
  v_data_caixa date;
  v_cliente    text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado') THEN
    RAISE EXCEPTION 'INVOICE_STATUS_INVALID: %', p_status USING ERRCODE = 'check_violation';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- A data do movimento que nasce. Por omissão, hoje em Lisboa — que é o que a
  -- action usa. Passá-la explicitamente serve os ensaios e a reposição de
  -- histórico; não muda o comportamento de quem não a passa.
  v_data_caixa := COALESCE(p_paid_on, (now() AT TIME ZONE 'Europe/Lisbon')::date);

  -- Os movimentos que já existem para esta fatura, lidos sob o `FOR UPDATE` da
  -- fatura. A premissa é a mesma da 091: todo o writer destes movimentos passa
  -- primeiro por esta linha — é esta função, e mais nenhuma, que os cria e
  -- apaga.
  SELECT array_agg(c.date) INTO v_datas_mov
    FROM public.cash_flow_entries c
   WHERE c.company_id     = p_company_id
     AND c.reference_type = 'invoice'
     AND c.reference_id   = p_invoice_id;

  v_datas := ARRAY[v_inv.invoice_date, v_inv.period_start, v_inv.period_end]
             || COALESCE(v_datas_mov, ARRAY[]::date[]);

  -- HOJE só entra quando hoje recebe alguma coisa — a mesma regra da 091.
  IF p_status = 'pago' AND v_inv.total IS NOT NULL AND v_inv.total > 0 THEN
    v_datas := v_datas || v_data_caixa;
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, v_datas);

  IF p_status = 'pago' THEN
    UPDATE public.invoices
       SET status = 'pago',
           -- 🔴 `COALESCE` e não `now()`: repetir a operação não pode reescrever
           --    a data em que a fatura foi paga da primeira vez.
           paid_at = COALESCE(paid_at, now()),
           payment_method = p_payment_method,
           updated_at = now()
     WHERE id = p_invoice_id AND company_id = p_company_id;

    IF v_inv.total IS NOT NULL AND v_inv.total > 0 THEN
      SELECT c.name INTO v_cliente FROM public.clients c WHERE c.id = v_inv.client_id;

      INSERT INTO public.cash_flow_entries (
        company_id, type, amount, description, category, date,
        reference_id, reference_type, status
      ) VALUES (
        p_company_id, 'entrada', v_inv.total,
        'Fatura ' || v_inv.invoice_number || ' - ' || COALESCE(v_cliente, 'Cliente'),
        'faturacao', v_data_caixa,
        p_invoice_id, 'invoice', 'confirmado'
      )
      -- O índice único da 024 é PARCIAL, e o `ON CONFLICT` tem de repetir a
      -- condição para o Postgres o inferir como árbitro.
      ON CONFLICT (company_id, reference_type, reference_id)
        WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
      DO NOTHING
      RETURNING id INTO v_entrada;

      IF v_entrada IS NULL THEN
        -- Já existia. A action fazia exactamente isto — não duplicava — e o
        -- movimento existente fica como está: a data dele é a do dia em que o
        -- dinheiro entrou, e reescrevê-la mudaria o mês onde o valor conta.
        SELECT c.id INTO v_entrada
          FROM public.cash_flow_entries c
         WHERE c.company_id     = p_company_id
           AND c.reference_type = 'invoice'
           AND c.reference_id   = p_invoice_id;
      END IF;
    END IF;

  ELSE
    UPDATE public.invoices
       SET status = p_status,
           paid_at = NULL,
           payment_method = NULL,
           updated_at = now()
     WHERE id = p_invoice_id AND company_id = p_company_id;

    -- Os meses destes movimentos já vêm trancados de cima.
    DELETE FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'invoice'
       AND reference_id = p_invoice_id;
    GET DIAGNOSTICS v_removidos = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT p_invoice_id, v_entrada, v_removidos;
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
REVOKE ALL PRIVILEGES ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, text, date, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.delete_invoice_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_invoice_with_items(uuid, uuid, text, int, date, date, date, date, numeric, numeric, numeric, numeric, jsonb) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, text, date, text, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.delete_invoice_atomic(uuid, uuid, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('create_invoice_with_items', 'p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb'),
      ('set_invoice_status_atomic', 'p_company_id uuid, p_invoice_id uuid, p_status text, p_paid_on date, p_payment_method text, p_actor uuid'),
      ('delete_invoice_atomic',     'p_company_id uuid, p_invoice_id uuid, p_actor uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
        AND NOT p.prosecdef
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICES_PERIOD_094_POSTSTATE_FAILED: em falta ou com assinatura/segurança errada %', v_faltam;
  END IF;
END
$posestado$;
