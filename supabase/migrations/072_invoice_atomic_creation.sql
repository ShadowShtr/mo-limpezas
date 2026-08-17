-- ============================================================================
-- 072 — Criação atómica de faturas, e um número que não se repete
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Preparada para revisão, e ensaiada em base descartável
--    (`npm run rehearse:071`, que também cobre esta).
--
-- Posterior à 071, como decidido: a numeração e a transaccionalidade entram
-- depois de a 071 estar ensaiada e revertida com sucesso.
--
-- ---------------------------------------------------------------------------
-- O que está errado hoje
-- ---------------------------------------------------------------------------
--
--  1. **Nada impede dois números iguais.** `nextInvoiceNumber` deriva do maior
--     número usado, o que resolve a reutilização depois de apagar — mas duas
--     execuções simultâneas lêem o mesmo máximo e escolhem o mesmo número.
--     Uma verificação em JavaScript perde sempre a corrida contra dois pedidos
--     ao mesmo tempo.
--
--  2. **O cabeçalho e as linhas são dois pedidos.** Se as linhas falharem, a
--     aplicação compensa apagando o cabeçalho — o que funciona, mas depende de
--     a compensação correr. Se o processo morrer entre os dois, fica um
--     documento sem linhas: subtotal e total certos, zero itens, e com o ar de
--     uma fatura normal na lista.
--
-- Ambos se resolvem na base, e só na base.
-- ============================================================================

BEGIN;

-- ─── 1. Um número, uma fatura ───────────────────────────────────────────────
--
-- A rede de segurança. Mesmo que a aplicação escolha mal, a base recusa.

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_number_per_company
  ON public.invoices (company_id, invoice_number);

-- ─── 2. 🔴 Duplicados de geração — e porque é que o índice é PARCIAL ────────
--
-- A pergunta era se devia existir `UNIQUE(company_id, client_id, period_start,
-- period_end)`. **Não deve, assim.** Bloquearia casos legítimos:
--
--   · uma fatura cancelada e refeita para o mesmo período;
--   · uma fatura suplementar por trabalho extra do mesmo mês.
--
-- Os dois acontecem, e nenhum é um erro.
--
-- O que **é** sempre um erro é gerar duas vezes o mesmo rascunho automático
-- para o mesmo cliente e período — foi por isso que o código tem a guarda
-- `existingClientIds`, que duas execuções simultâneas atravessam à vontade.
--
-- Daí o índice ser parcial, `WHERE status = 'rascunho'`: apanha exactamente a
-- geração acidental, e não toca em nada do que é legítimo. Uma segunda fatura
-- deliberada para o mesmo período é emitida (`pendente`), não rascunho, e
-- passa sem obstáculo.

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_draft_per_client_period
  ON public.invoices (company_id, client_id, period_start, period_end)
  WHERE status = 'rascunho';

-- ─── 3. Criação atómica ─────────────────────────────────────────────────────
--
-- Uma função plpgsql corre dentro de **uma** transacção. Ou entram o cabeçalho
-- e todas as linhas, ou não entra nada — sem compensação, sem janela entre os
-- dois pedidos, e sem depender de o processo sobreviver.
--
-- O número é atribuído aqui dentro, protegido por um lock consultivo por
-- empresa e ano. Duas gerações simultâneas serializam-se no lock em vez de
-- lerem o mesmo máximo: a segunda espera, e depois vê o número que a primeira
-- gravou.
--
-- 🔴 O lock é `xact`: liberta-se sozinho no fim da transacção, mesmo que esta
--    aborte. Um lock de sessão ficaria pendurado num erro e trancava a
--    faturação da empresa até alguém reparar.

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

COMMENT ON FUNCTION public.create_invoice_with_items IS
  'Cria a fatura e as linhas numa só transacção. O número é atribuído sob '
  'lock consultivo por empresa/ano — duas gerações simultâneas serializam-se '
  'em vez de escolherem o mesmo número.';

COMMIT;

-- ============================================================================
-- O que esta migration NÃO faz
-- ============================================================================
--
--  · não altera nenhuma fatura existente;
--  · não renumera nada;
--  · não impede uma segunda fatura **emitida** para o mesmo cliente e período,
--    porque isso é legítimo;
--  · não toca em `cash_flow_entries` — pagamento → caixa é a 073;
--  · não inventa `service_id` para linhas de avença: essas cobrem um contrato,
--    não uma visita, e marcar um serviço como faturado por elas seria mentir
--    ao `getUnbilledServices`;
--  · não semeia nada.
--
-- ⚠️ Antes de aplicar: se já existirem dois números iguais na base, o índice
--    único falha a ser criado. É o comportamento desejado — a migration recusa
--    e obriga a resolver o duplicado, em vez de o esconder. Verificar com:
--
--      SELECT company_id, invoice_number, count(*)
--        FROM invoices GROUP BY 1,2 HAVING count(*) > 1;
-- ============================================================================
