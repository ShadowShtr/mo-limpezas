-- GERADO de supabase/migrations/072_invoice_atomic_creation.sql por scripts/gen-094-fixture.mjs. Nao editar a mao.
-- A RPC de faturas COMO ESTA EM PRODUCAO (sem guarda de periodo).

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

  -- Serializa a atribuição do número por empresa e ano.
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
