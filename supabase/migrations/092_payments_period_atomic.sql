-- ============================================================================
-- 092 — pagamentos fixos e variáveis dentro do protocolo de período
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- O que falta hoje, exactamente
-- ---------------------------------------------------------------------------
--
-- Este domínio tem os dois defeitos ao mesmo tempo, e é o que o torna o pior:
--
--   · `mark_payment_paid` (079) e `unmark_payment_paid` (081) CHAMAM
--     `is_financial_period_open` lá dentro. Parece protegido e não está: a
--     função lê «aberto» e escreve, mas nunca adquire o recurso que o fecho
--     adquire. As duas transações não se vêem, e a pergunta é respondida sobre
--     um estado que pode deixar de ser verdade na linha seguinte;
--
--   · `createPayment` (INSERT directo), `update_payment_atomic` (088) e
--     `delete_payment_atomic` (082) não perguntam sequer.
--
-- Um `FOR UPDATE` sobre o pagamento não substitui nada disto. Serializa dois
-- writers do mesmo pagamento; não serializa contra o fecho, que não toca nessa
-- linha nenhuma.
--
-- ---------------------------------------------------------------------------
-- 🔴 Quantos períodos toca um pagamento
-- ---------------------------------------------------------------------------
--
-- Mais do que a competência, e é aí que a intuição falha:
--
--   · `period_year`/`period_month` — a competência, que é o mês a que o
--     pagamento pertence, e que muda quando o vencimento muda;
--   · a data do movimento de caixa que vai NASCER (`p_paid_on`), que é o dia
--     em que o dinheiro sai e pode ser outro mês;
--   · a data do movimento de caixa que JÁ EXISTE e vai ser reescrito ou
--     apagado — a 079 move a data de um movimento pendente para o dia do
--     pagamento, e a 081 devolve-a ao `prestate_date` da 080. Nos dois casos o
--     mês de onde a linha sai é tão afectado como o mês para onde vai;
--   · no `update`, a competência ANTIGA e a NOVA.
--
-- Até TRÊS meses numa operação. É por isso que este ficheiro usa o protocolo de
-- N períodos da 090 e não o par.
--
-- ---------------------------------------------------------------------------
-- 🔴 Linhas primeiro, períodos depois — a ordem da 090
-- ---------------------------------------------------------------------------
--
-- Todas estas funções trancam linhas (`FOR UPDATE`) antes de adquirir os locks
-- de período, pela convenção que a 090 fixa. A razão prática é esta: as datas
-- que decidem os períodos estão nas linhas — a competência no pagamento, a
-- data actual no movimento, o `prestate_date` na proveniência. Ler antes de as
-- trancar daria um conjunto que podia mudar debaixo dos pés.
--
-- Por isso os `SELECT ... FOR UPDATE` que a 079 e a 081 já faziam SOBEM: passam
-- a acontecer antes do bloco de período em vez de depois. A ordem entre eles
-- não muda — pagamento, movimento, proveniência — e é a mesma nas duas
-- funções, que é o que impede um ciclo entre elas.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade — EXPAND FIRST
-- ---------------------------------------------------------------------------
--
-- Todas as assinaturas existentes ficam EXACTAMENTE como estavam. Toda a
-- lógica de negócio da 079, 080, 081, 082 e 088 é preservada à letra: as
-- guardas de conciliação, a proveniência que falha fechado, a idempotência, o
-- caminho do conflito da F14-A, o bloqueio de valor sobre pagamento pago ou
-- ligado, e a competência derivada do vencimento na 088.
--
-- O que muda é o comportamento com o mês FECHADO — que passa a ser recusa
-- também onde antes não era, e passa a ser recusa NÃO CORRÍVEL por uma corrida
-- onde antes era. Em produção `financial_periods` está vazia, portanto todos os
-- meses estão abertos e nenhuma chamada existente muda de resultado.
--
-- `create_payment_atomic` e `set_payment_status_atomic` são NOVAS: hoje esses
-- dois caminhos escrevem directamente da server action, sem passar pela base.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_periods_open_locked_many', 'p_company_id uuid, p_keys integer[]'),
      ('financial_period_lock_key',                 'p_year integer, p_month integer'),
      ('mark_payment_paid',                         'p_company_id uuid, p_payment_id uuid, p_paid_on date'),
      ('unmark_payment_paid',                       'p_company_id uuid, p_payment_id uuid'),
      ('update_payment_atomic',                     'p_company_id uuid, p_payment_id uuid, p_patch jsonb'),
      ('delete_payment_atomic',                     'p_company_id uuid, p_payment_id uuid'),
      ('assert_payment_cashflow_link',              'p_mov cash_flow_entries, p_pag fixed_variable_payments, p_company_id uuid, p_payment_id uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENTS_PERIOD_092_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;

  IF to_regclass('public.payment_cashflow_provenance') IS NULL THEN
    RAISE EXCEPTION 'PAYMENTS_PERIOD_092_PRECONDITION_FAILED: tabela payment_cashflow_provenance ausente';
  END IF;
END
$precondicoes$;

-- ─── 1. Criar pagamento, sob o lock da competência ──────────────────────────
--
-- NOVA. Hoje `createPayment` faz um INSERT directo da server action, sem
-- guarda nenhuma: um pagamento entra num mês fechado sem que nada o impeça. E
-- como `status = 'pendente'` é BLOQUEADOR de fecho, o mesmo INSERT numa corrida
-- com o fecho pode fazer o mês fechar com um pendente que o checklist não viu.
--
-- 🔴 `sort_order` passa a ser calculado aqui dentro. A action lia o máximo numa
--    viagem e inseria noutra — duas criações simultâneas do mesmo `kind` davam
--    o mesmo número. Dentro da transação, e depois do lock da competência, o
--    cálculo é estável.
CREATE OR REPLACE FUNCTION public.create_payment_atomic(
  p_company_id          uuid,
  p_kind                text,
  p_description         text,
  p_amount              numeric,
  p_due_date            date,
  p_period_year         integer,
  p_period_month        integer,
  p_expense_category_id uuid DEFAULT NULL,
  p_direct_debit        boolean DEFAULT false,
  p_notes               text DEFAULT NULL,
  p_actor               uuid DEFAULT NULL
)
RETURNS TABLE (payment_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id    uuid;
  v_ordem integer;
BEGIN
  IF p_company_id IS NULL OR p_kind IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'PAYMENT_DESCRIPTION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  IF p_amount IS NOT NULL AND p_amount < 0 THEN
    RAISE EXCEPTION 'PAYMENT_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF p_period_year IS NULL OR p_period_month IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  -- A competência é o único período que a criação toca: o pagamento nasce
  -- `pendente` e nenhum movimento de caixa é criado aqui.
  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(p_period_year, p_period_month)
  ]);

  SELECT COALESCE(max(sort_order), 0) + 1 INTO v_ordem
    FROM public.fixed_variable_payments
   WHERE company_id = p_company_id AND kind = p_kind;

  INSERT INTO public.fixed_variable_payments (
    company_id, kind, description, amount, due_date, expense_category_id,
    direct_debit, status, recurring, period_year, period_month, notes,
    sort_order, created_by
  ) VALUES (
    p_company_id, p_kind, btrim(p_description), p_amount, p_due_date,
    p_expense_category_id, COALESCE(p_direct_debit, false), 'pendente',
    p_kind = 'fixo', p_period_year, p_period_month, p_notes,
    v_ordem, p_actor
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id;
END;
$fn$;

-- ─── 2. Editar pagamento, com a competência ANTIGA e a NOVA protegidas ──────
--
-- `CREATE OR REPLACE` da função da 088. Preserva tudo: a lista fechada de
-- campos editáveis, o `FOR UPDATE`, a recusa de mudar o valor de um pagamento
-- pago ou já ligado a caixa, e a regra da 088 de que mudar o vencimento move a
-- competência.
--
-- 🔴 Mover a competência de Julho para Agosto altera os DOIS meses. Validar só
--    o destino deixava um caminho para esvaziar um mês fechado por
--    arrastamento — o pagamento sai de lá e o mês fechado muda de conteúdo sem
--    ninguém lhe ter tocado directamente.
--
--    O movimento de caixa ligado não entra no conjunto: esta função não lhe
--    toca, e o mês dele não muda de conteúdo. Alargar o lock a ele recusaria
--    edições legítimas — corrigir a descrição de um pagamento cujo dinheiro
--    saiu num mês já fechado é uma operação que tem de continuar a passar.
CREATE OR REPLACE FUNCTION public.update_payment_atomic(
  p_company_id uuid,
  p_payment_id uuid,
  p_patch jsonb
)
RETURNS TABLE (payment_id uuid, valor_alterou boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag public.fixed_variable_payments%ROWTYPE;
  v_mov uuid;
  v_proibidas text[];
  v_novo_valor numeric;
  v_muda_valor boolean := false;
  v_venc date;
  v_ano integer;
  v_mes integer;
BEGIN
  SELECT array_agg(k) INTO v_proibidas
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('description', 'amount', 'due_date', 'expense_category_id', 'direct_debit', 'notes');
  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_pag FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;

  IF p_patch ? 'amount' THEN
    v_novo_valor := (p_patch->>'amount')::numeric;
    IF v_novo_valor IS NOT NULL AND v_novo_valor < 0 THEN
      RAISE EXCEPTION 'PAYMENT_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    v_muda_valor := v_novo_valor IS DISTINCT FROM v_pag.amount;
  END IF;

  IF v_muda_valor THEN
    IF v_pag.status = 'pago' THEN
      RAISE EXCEPTION 'PAYMENT_ALREADY_PAID' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT c.id INTO v_mov FROM public.cash_flow_entries c
     WHERE c.company_id = p_company_id AND c.reference_type = 'fixed_variable_payment'
       AND c.reference_id = p_payment_id LIMIT 1;
    IF v_mov IS NOT NULL THEN
      RAISE EXCEPTION 'PAYMENT_LINKED_TO_CASHFLOW' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  v_ano := v_pag.period_year;
  v_mes := v_pag.period_month;
  IF (p_patch ? 'due_date')
     AND (p_patch->>'due_date') IS NOT NULL
     AND (p_patch->>'due_date')::date IS DISTINCT FROM v_pag.due_date THEN
    v_venc := (p_patch->>'due_date')::date;
    v_ano := EXTRACT(YEAR FROM v_venc)::integer;
    v_mes := EXTRACT(MONTH FROM v_venc)::integer;
  END IF;

  -- 🔴 Os dois meses, antes de qualquer escrita. Origem e destino iguais dão um
  --    lock lógico só — quem trata disso é a primitiva da 090.
  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(v_pag.period_year, v_pag.period_month),
    public.financial_period_lock_key(v_ano, v_mes)
  ]);

  UPDATE public.fixed_variable_payments SET
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
    amount = CASE WHEN p_patch ? 'amount' THEN (p_patch->>'amount')::numeric ELSE amount END,
    due_date = CASE WHEN p_patch ? 'due_date' THEN (p_patch->>'due_date')::date ELSE due_date END,
    expense_category_id = CASE WHEN p_patch ? 'expense_category_id' THEN (p_patch->>'expense_category_id')::uuid ELSE expense_category_id END,
    direct_debit = CASE WHEN p_patch ? 'direct_debit' THEN (p_patch->>'direct_debit')::boolean ELSE direct_debit END,
    notes = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
    period_year = v_ano, period_month = v_mes, updated_at = now()
   WHERE id = p_payment_id AND company_id = p_company_id;
  RETURN QUERY SELECT p_payment_id, v_muda_valor;
END;
$fn$;

-- ─── 3. Marcar como pago, com competência, dia do pagamento e movimento ─────
--
-- `CREATE OR REPLACE` da função da 079. Preserva TUDO: o `FOR UPDATE` que faz
-- duas chamadas concorrentes darem um só movimento, `assert_payment_cashflow_
-- link` como única regra de reutilização, a reutilização do movimento pendente
-- pela MESMA linha (`id` preservado, e com ele `created_at`, `notes` e autor),
-- a idempotência sobre `confirmado`, o `ON CONFLICT` com o predicado parcial da
-- 024, o caminho da F14-A quando o `DO NOTHING` dispara, e a proveniência da
-- 080 escrita nos dois ramos.
--
-- 🔴 O que muda é o conjunto de períodos, e ele tem TRÊS elementos possíveis:
--
--      · a competência do pagamento;
--      · `p_paid_on`, o dia em que o dinheiro sai;
--      · a data ACTUAL do movimento pendente que vai ser reutilizado — porque
--        a função move-lhe a `date` para `p_paid_on`, e um movimento que sai de
--        Julho para Agosto muda os dois meses.
--
--    A versão anterior olhava só para a competência. Um movimento pendente
--    datado de um mês fechado podia ser arrastado para fora dele sem que nada
--    reclamasse.
--
-- 🔴 E a ordem: a linha do pagamento e a do movimento são trancadas ANTES do
--    bloco de período, porque é delas que saem as datas. A 090 fixa esta ordem
--    para todo o sistema.
CREATE OR REPLACE FUNCTION public.mark_payment_paid(
  p_company_id uuid,
  p_payment_id uuid,
  p_paid_on    date
)
RETURNS TABLE (payment_id uuid, cash_entry_id uuid, ja_estava_pago boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag        public.fixed_variable_payments%ROWTYPE;
  v_mov        public.cash_flow_entries%ROWTYPE;
  v_tem_mov    boolean := false;
  v_entrada    uuid;
  v_sem_efeito boolean := false;
  v_protegidos integer[];
BEGIN
  IF p_paid_on IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_PAID_ON_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 `FOR UPDATE`: tranca a linha do pagamento até ao fim da transacção.
  --    Dois pedidos simultâneos para o mesmo pagamento serializam-se aqui, e o
  --    segundo vê o estado que o primeiro deixou. É esta tranca — e não o
  --    índice único — que faz duas chamadas concorrentes darem um só
  --    movimento; o índice é a rede por baixo.
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento inexistente ou de outra empresa.'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_pag.amount IS NULL OR v_pag.amount <= 0 THEN
    RAISE EXCEPTION 'Um pagamento sem valor não pode gerar um movimento de caixa.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Esta leitura SUBIU. Na 081 acontecia depois de marcar o pagamento como
  --    pago; aqui tem de vir antes do bloco de período, porque é dela que sai o
  --    terceiro mês do conjunto — a data ACTUAL do movimento que vai ser
  --    reutilizado. A tranca de linha é a mesma, e a ordem em relação à linha
  --    do pagamento também: pagamento primeiro, movimento depois.
  --
  -- 🔴 O `company_id` está na condição, não num `IF` a seguir. Uma linha de
  --    outra empresa nunca chega a ser vista aqui.
  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'fixed_variable_payment'
     AND reference_id = p_payment_id
   FOR UPDATE;
  v_tem_mov := FOUND;

  -- ─── Todos os períodos, de uma vez e em ordem canónica ───────────────────
  --
  -- Competência + dia do pagamento + mês de onde o movimento existente sai.
  v_protegidos :=
    ARRAY[public.financial_period_lock_key(v_pag.period_year, v_pag.period_month)]
    || public.financial_period_lock_keys(
         ARRAY[p_paid_on, CASE WHEN v_tem_mov THEN v_mov.date ELSE NULL END]::date[]
       );

  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, v_protegidos);

  UPDATE public.fixed_variable_payments
     SET status  = 'pago',
         paid_at = COALESCE(paid_at, p_paid_on::timestamptz)
   WHERE id = p_payment_id;

  IF v_tem_mov THEN
    PERFORM public.assert_payment_cashflow_link(v_mov, v_pag, p_company_id, p_payment_id);

    IF v_mov.status = 'pendente' THEN
      -- 🔴 A proveniência escreve-se **antes** do UPDATE, enquanto o prestate
      --    ainda está na linha. Depois do UPDATE a data antiga já não existe
      --    em lado nenhum, e não há como a recuperar.
      --
      --    `ON CONFLICT DO NOTHING`: se já houver registo, é de um ciclo
      --    anterior (mark → unmark → mark). O primeiro prestate é o que vale —
      --    é o estado legado verdadeiro. Sobrescrevê-lo com o que o `unmark`
      --    acabou de restaurar seria guardar uma cópia da cópia.
      INSERT INTO public.payment_cashflow_provenance (
        cash_flow_entry_id, company_id, payment_id, origin,
        prestate_date, prestate_expense_category_id
      ) VALUES (
        v_mov.id, p_company_id, p_payment_id, 'adopted_existing',
        v_mov.date, v_mov.expense_category_id
      )
      ON CONFLICT (cash_flow_entry_id) DO NOTHING;

      -- 🔴 A mesma linha. O `id` não muda, e é isso que preserva o histórico
      --    do movimento legado: `created_at`, `notes`, quem o criou.
      --
      --    `date` passa a ser a data efectiva do pagamento — e é por isso que o
      --    mês ANTIGO desta linha faz parte do conjunto trancado acima.
      --
      --    `expense_category_id` só é actualizado quando o pagamento **tem**
      --    categoria. Apagar a que lá está por o pagamento não ter nenhuma
      --    seria destruir informação sem ganhar nada.
      UPDATE public.cash_flow_entries
         SET status = 'confirmado',
             date   = p_paid_on,
             expense_category_id = COALESCE(v_pag.expense_category_id, expense_category_id)
       WHERE id = v_mov.id;

    ELSIF v_mov.status = 'confirmado' THEN
      -- 🔴 Idempotência, e **nenhuma** proveniência escrita aqui.
      --
      --    Um movimento já confirmado e sem registo pode ter sido criado pelo
      --    `mark` ou adoptado e já confirmado — daqui não se distingue.
      --    Inventar um dos dois seria fabricar uma prova. Fica desconhecido, e
      --    o `unmark` recusa-o mais tarde por isso mesmo.
      v_sem_efeito := true;

    ELSE
      RAISE EXCEPTION 'CASHFLOW_LINK_STATUS_UNEXPECTED'
        USING ERRCODE = 'data_exception';
    END IF;

    v_entrada := v_mov.id;

  ELSE
    INSERT INTO public.cash_flow_entries (
      company_id, type, amount, description, category, date,
      reference_type, reference_id, status, expense_category_id
    ) VALUES (
      p_company_id, 'saida', v_pag.amount,
      v_pag.description, 'despesa', p_paid_on,
      'fixed_variable_payment', p_payment_id, 'confirmado', v_pag.expense_category_id
    )
    -- 🔴 O predicado tem de vir. O índice da 024 é **parcial** e o Postgres só
    --    o infere se o `ON CONFLICT` repetir a mesma condição.
    ON CONFLICT (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
      DO NOTHING
    RETURNING id INTO v_entrada;

    IF v_entrada IS NOT NULL THEN
      -- Criado por esta chamada. Não há prestate: antes disto não existia.
      INSERT INTO public.payment_cashflow_provenance (
        cash_flow_entry_id, company_id, payment_id, origin
      ) VALUES (
        v_entrada, p_company_id, p_payment_id, 'created_by_mark'
      )
      ON CONFLICT (cash_flow_entry_id) DO NOTHING;

    ELSE
      -- 🔴 F14-A. O `DO NOTHING` disparou: outra ligação inseriu a linha entre
      --    o `SELECT ... FOR UPDATE` e este `INSERT`. A tranca serializa duas
      --    chamadas à RPC, mas não impede um INSERT directo de outra ligação
      --    sobre a mesma identidade única — a PR #85 provou-o em PostgreSQL
      --    real.
      --
      --    A linha que vem de fora não merece mais confiança do que a que já cá
      --    estava. Relê-se **completa**, com `FOR UPDATE`, e passa exactamente
      --    pelos mesmos invariantes, pela mesma função.
      SELECT * INTO v_mov
        FROM public.cash_flow_entries c
       WHERE c.company_id = p_company_id
         AND c.reference_type = 'fixed_variable_payment'
         AND c.reference_id = p_payment_id
       FOR UPDATE;

      IF NOT FOUND THEN
        -- O `DO NOTHING` disparou mas não há linha nenhuma: quem a inseriu
        -- reverteu. Não há nada para adoptar, e não se inventa um movimento.
        RAISE EXCEPTION 'CASHFLOW_LINK_VANISHED'
          USING ERRCODE = 'data_exception';
      END IF;

      PERFORM public.assert_payment_cashflow_link(v_mov, v_pag, p_company_id, p_payment_id);

      -- 🔴 Esta linha não existia quando o conjunto de períodos foi montado,
      --    portanto o mês dela pode não estar trancado. Adquirir um lock agora
      --    seria adquiri-lo fora da ordem canónica — o defeito que a 090
      --    existe para fechar, e que não se resolve fazendo-o «só desta vez».
      --
      --    Ou o mês dela já está no conjunto protegido, ou a operação inteira
      --    recua. Recuar é seguro e honesto: a transacção não escreveu nada que
      --    sobreviva, e quem repetir monta o conjunto já com esta linha dentro.
      IF NOT (public.financial_period_lock_key(
                EXTRACT(YEAR  FROM v_mov.date)::integer,
                EXTRACT(MONTH FROM v_mov.date)::integer
              ) = ANY (v_protegidos)) THEN
        RAISE EXCEPTION 'PAYMENT_CASHFLOW_RACE_UNPROTECTED_PERIOD'
          USING ERRCODE = 'serialization_failure',
                HINT = 'Um movimento apareceu noutro mês durante a operação. Repita.';
      END IF;

      IF v_mov.status = 'pendente' THEN
        -- 🔴 A linha veio de outra ligação: esta transacção não a criou. É
        --    adopção, e o prestate é o que ela traz.
        INSERT INTO public.payment_cashflow_provenance (
          cash_flow_entry_id, company_id, payment_id, origin,
          prestate_date, prestate_expense_category_id
        ) VALUES (
          v_mov.id, p_company_id, p_payment_id, 'adopted_existing',
          v_mov.date, v_mov.expense_category_id
        )
        ON CONFLICT (cash_flow_entry_id) DO NOTHING;

        UPDATE public.cash_flow_entries
           SET status = 'confirmado',
               date   = p_paid_on,
               expense_category_id = COALESCE(v_pag.expense_category_id, expense_category_id)
         WHERE id = v_mov.id;
      ELSIF v_mov.status = 'confirmado' THEN
        v_sem_efeito := true;
      ELSE
        RAISE EXCEPTION 'CASHFLOW_LINK_STATUS_UNEXPECTED'
          USING ERRCODE = 'data_exception';
      END IF;

      v_entrada := v_mov.id;
    END IF;
  END IF;

  RETURN QUERY SELECT p_payment_id, v_entrada, v_sem_efeito;
END;
$fn$;

-- ─── 4. Desmarcar, com o mês do movimento E o mês para onde ele volta ───────
--
-- `CREATE OR REPLACE` da função da 081. Preserva TUDO: a recusa sobre
-- movimento conciliado (a correspondência é `ON DELETE CASCADE` e apagá-la
-- destruiria a prova), a proveniência que FALHA FECHADO quando é desconhecida,
-- a restauração do `prestate` para `adopted_existing` sem nunca apagar a linha,
-- e o `DELETE` da proveniência antes do movimento por causa do `RESTRICT`.
--
-- 🔴 Os períodos são até três, e o terceiro é o menos óbvio: para um movimento
--    `adopted_existing`, a função devolve-lhe `date = prestate_date`. Isso é um
--    movimento a SAIR do mês em que está e a VOLTAR ao mês de onde veio. Os
--    dois meses mudam de conteúdo, e os dois têm de estar abertos.
CREATE OR REPLACE FUNCTION public.unmark_payment_paid(
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS TABLE (payment_id uuid, movimentos_removidos int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag        public.fixed_variable_payments%ROWTYPE;
  v_mov        public.cash_flow_entries%ROWTYPE;
  v_tem_mov    boolean := false;
  v_prov       public.payment_cashflow_provenance%ROWTYPE;
  v_tem_prov   boolean := false;
  v_removidos  int := 0;
  v_conciliado int;
BEGIN
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento inexistente ou de outra empresa.'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 🔴 `FOR UPDATE` no movimento: sem isto, um `unmark` concorrente e uma
  --    conciliação a acontecer ao mesmo tempo podiam cruzar-se entre a leitura
  --    e a escrita. Duas chamadas simultâneas serializam-se aqui.
  --
  --    E, como na 079, esta leitura vem ANTES do bloco de período: é dela e da
  --    proveniência que saem as datas do conjunto.
  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'fixed_variable_payment'
     AND reference_id = p_payment_id
   FOR UPDATE;
  v_tem_mov := FOUND;

  IF v_tem_mov THEN
    SELECT * INTO v_prov
      FROM public.payment_cashflow_provenance
     WHERE cash_flow_entry_id = v_mov.id
     FOR UPDATE;
    v_tem_prov := FOUND;
  END IF;

  -- ─── Todos os períodos, de uma vez ───────────────────────────────────────
  --
  -- Competência, o mês onde o movimento está, e — quando ele vai ser
  -- restaurado — o mês para onde volta.
  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id,
    ARRAY[public.financial_period_lock_key(v_pag.period_year, v_pag.period_month)]
    || public.financial_period_lock_keys(ARRAY[
         CASE WHEN v_tem_mov THEN v_mov.date ELSE NULL END,
         CASE WHEN v_tem_prov AND v_prov.origin = 'adopted_existing'
              THEN v_prov.prestate_date ELSE NULL END
       ]::date[])
  );

  IF v_tem_mov THEN
    -- ── Conciliação: falha fechado, antes de tocar em nada ─────────────────
    --
    -- `bank_reconciliation_matches.cash_flow_entry_id` é `ON DELETE CASCADE`.
    -- Apagar o movimento levaria a correspondência à frente e deixaria a
    -- transacção bancária marcada como reconciliada contra uma linha que já
    -- não existe: apagava a prova e mentia sobre o resultado.
    --
    -- Reverter uma conciliação é uma operação com significado próprio e não
    -- existe mecanismo canónico para isso neste repositório. Inventar um aqui
    -- seria trocar um risco por outro. Quem quiser desmarcar desfaz primeiro a
    -- conciliação, conscientemente.
    SELECT count(*) INTO v_conciliado
      FROM public.bank_reconciliation_matches m
     WHERE m.cash_flow_entry_id = v_mov.id
       AND m.status <> 'rejected';

    IF v_conciliado > 0 THEN
      RAISE EXCEPTION 'UNMARK_BLOCKED_RECONCILED_CASHFLOW'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NOT v_tem_prov THEN
      -- 🔴 Proveniência desconhecida. **Falha fechado.**
      --
      --    A ausência de registo não prova que o movimento foi criado pelo
      --    `mark`: prova apenas que ninguém sabe. Para as linhas anteriores a
      --    esta infraestrutura as duas hipóteses continuam abertas, e uma
      --    delas é «já cá estava». Apagar sobre essa dúvida é exactamente o
      --    risco que a 081 existe para fechar.
      RAISE EXCEPTION 'UNMARK_BLOCKED_UNKNOWN_CASHFLOW_PROVENANCE'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF v_prov.origin = 'adopted_existing' THEN
      -- 🔴 O movimento já cá estava. Desmarcar devolve-o ao que era —
      --    mesma linha, mesmo `id`, mesmo histórico. Nunca `DELETE`.
      --
      --    A proveniência **fica**: se o pagamento voltar a ser marcado, o
      --    movimento é adoptado outra vez, e o prestate original continua a
      --    ser o estado legado verdadeiro.
      UPDATE public.cash_flow_entries
         SET status = 'pendente',
             date   = v_prov.prestate_date,
             expense_category_id = v_prov.prestate_expense_category_id
       WHERE id = v_mov.id;

      v_removidos := 0;

    ELSIF v_prov.origin = 'created_by_mark' THEN
      -- Foi o `mark` que o criou; desfazer é fazê-lo desaparecer. Não havia
      -- nada antes, portanto não há nada para restaurar.
      --
      -- 🔴 A proveniência sai primeiro. A chave estrangeira é `RESTRICT`, de
      --    propósito: ninguém apaga um movimento com origem registada sem
      --    passar por aqui.
      DELETE FROM public.payment_cashflow_provenance
       WHERE cash_flow_entry_id = v_mov.id;

      DELETE FROM public.cash_flow_entries
       WHERE id = v_mov.id;
      GET DIAGNOSTICS v_removidos = ROW_COUNT;

    ELSE
      -- O CHECK da tabela só permite os dois valores acima. Outra coisa quer
      -- dizer que o modelo mudou e esta função não sabe o que fazer.
      RAISE EXCEPTION 'UNMARK_BLOCKED_UNKNOWN_CASHFLOW_PROVENANCE'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  UPDATE public.fixed_variable_payments
     SET status = 'pendente', paid_at = NULL
   WHERE id = p_payment_id;

  RETURN QUERY SELECT p_payment_id, v_removidos;
END;
$fn$;

-- ─── 5. Apagar, sob o lock da competência ───────────────────────────────────
--
-- `CREATE OR REPLACE` da função da 082. Preserva a idempotência sobre o que já
-- não existe, a recusa sobre pagamento pago e a recusa sobre pagamento ligado a
-- caixa. Como um pagamento ligado nunca chega ao `DELETE`, o único período
-- envolvido é a competência.
CREATE OR REPLACE FUNCTION public.delete_payment_atomic(
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS TABLE (payment_id uuid, apagados int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag      public.fixed_variable_payments%ROWTYPE;
  v_mov      uuid;
  v_apagados int;
BEGIN
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Já não existe. Apagar o que não existe é sucesso, não erro.
    RETURN QUERY SELECT p_payment_id, 0;
    RETURN;
  END IF;

  IF v_pag.status = 'pago' THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_PAID'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT c.id INTO v_mov
    FROM public.cash_flow_entries c
   WHERE c.company_id = p_company_id
     AND c.reference_type = 'fixed_variable_payment'
     AND c.reference_id = p_payment_id
   LIMIT 1;

  IF v_mov IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_LINKED_TO_CASHFLOW'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(v_pag.period_year, v_pag.period_month)
  ]);

  DELETE FROM public.fixed_variable_payments WHERE id = p_payment_id;
  GET DIAGNOSTICS v_apagados = ROW_COUNT;

  RETURN QUERY SELECT p_payment_id, v_apagados;
END;
$fn$;

-- ─── 6. Outros estados, sob o lock da competência ───────────────────────────
--
-- NOVA. `setPaymentStatus` trata `pago` e `pendente` pelas RPCs acima, mas
-- qualquer outro estado — `cancelado` — é hoje um UPDATE directo da action, sem
-- guarda nenhuma.
--
-- Não é inofensivo: `status = 'pendente'` é um dos quatro BLOQUEADORES do
-- fecho. Cancelar um pagamento pendente REMOVE um bloqueador, e fazê-lo numa
-- corrida com o fecho faz o mês fechar por causa de uma mudança que o checklist
-- não chegou a ver.
--
-- 🔴 `pago` e `pendente` não passam por aqui de propósito. Esses dois estados
--    têm consequências no caixa e as RPCs que os tratam sabem quais; aceitá-los
--    aqui daria um segundo caminho para mudar o estado sem tocar no movimento,
--    e um pagamento `pago` sem movimento é precisamente o tipo de incoerência
--    que este domínio inteiro existe para não ter.
CREATE OR REPLACE FUNCTION public.set_payment_status_atomic(
  p_company_id uuid,
  p_payment_id uuid,
  p_status     text,
  p_actor      uuid DEFAULT NULL
)
RETURNS TABLE (payment_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pag public.fixed_variable_payments%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status IN ('pago', 'pendente') THEN
    RAISE EXCEPTION 'PAYMENT_STATUS_NOT_HANDLED_HERE: %', p_status
      USING ERRCODE = 'check_violation',
            HINT = 'Use mark_payment_paid / unmark_payment_paid: esses estados mexem no caixa.';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(v_pag.period_year, v_pag.period_month)
  ]);

  UPDATE public.fixed_variable_payments
     SET status = p_status, updated_at = now()
   WHERE id = p_payment_id AND company_id = p_company_id;

  RETURN QUERY SELECT p_payment_id;
END;
$fn$;

-- ─── Superfície ─────────────────────────────────────────────────────────────
--
-- A mesma da 079/081/082/088 para as funções substituídas — `CREATE OR REPLACE`
-- preserva os grants existentes, mas repeti-los aqui torna a superfície legível
-- neste ficheiro em vez de obrigar a ir procurá-la a quatro migrations.
REVOKE ALL PRIVILEGES ON FUNCTION public.create_payment_atomic(uuid, text, text, numeric, date, integer, integer, uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.update_payment_atomic(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.mark_payment_paid(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.unmark_payment_paid(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.delete_payment_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.set_payment_status_atomic(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_payment_atomic(uuid, text, text, numeric, date, integer, integer, uuid, boolean, text, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.update_payment_atomic(uuid, uuid, jsonb) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.mark_payment_paid(uuid, uuid, date) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.unmark_payment_paid(uuid, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.delete_payment_atomic(uuid, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.set_payment_status_atomic(uuid, uuid, text, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('create_payment_atomic',     'p_company_id uuid, p_kind text, p_description text, p_amount numeric, p_due_date date, p_period_year integer, p_period_month integer, p_expense_category_id uuid, p_direct_debit boolean, p_notes text, p_actor uuid'),
      ('update_payment_atomic',     'p_company_id uuid, p_payment_id uuid, p_patch jsonb'),
      ('mark_payment_paid',         'p_company_id uuid, p_payment_id uuid, p_paid_on date'),
      ('unmark_payment_paid',       'p_company_id uuid, p_payment_id uuid'),
      ('delete_payment_atomic',     'p_company_id uuid, p_payment_id uuid'),
      ('set_payment_status_atomic', 'p_company_id uuid, p_payment_id uuid, p_status text, p_actor uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
        AND NOT p.prosecdef
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENTS_PERIOD_092_POSTSTATE_FAILED: em falta ou com assinatura/segurança errada %', v_faltam;
  END IF;
END
$posestado$;
