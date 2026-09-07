-- ============================================================================
-- 091 — cobranças avulsas dentro do protocolo de período
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- O que falta hoje, exactamente
-- ---------------------------------------------------------------------------
--
-- A 086 deu ao domínio das cobranças avulsas RPCs atómicas de verdade: cada
-- uma tranca a linha com `FOR UPDATE`, valida o estado do negócio e escreve o
-- par cobrança+caixa na mesma transação. O que nenhuma delas faz é olhar para
-- o **período financeiro**.
--
-- Resultado: com o mês fechado, uma cobrança avulsa entra na mesma. Não há
-- guarda na action (o runtime das cobranças ainda vive na PR #127) e não há
-- guarda na base. É o writer com menos protecção de todo o financeiro.
--
-- ---------------------------------------------------------------------------
-- Porque é que a guarda entra AQUI e não na action
-- ---------------------------------------------------------------------------
--
-- Pôr `assertFinancialPeriodOpen()` na server action antes de chamar a RPC
-- devolve o defeito que a 090 existe para fechar:
--
--     action: CHECK_OPEN  →  (outra sessão fecha o mês)  →  RPC: WRITE
--
-- A verificação e a escrita ficariam em transações diferentes. Dentro da RPC,
-- o lock e a escrita partilham a transação, e o mês não pode fechar entre um e
-- outro — que é a definição do problema resolvido.
--
-- ---------------------------------------------------------------------------
-- 🔴 Até TRÊS datas, e não uma
-- ---------------------------------------------------------------------------
--
-- A tentação é assumir `payment date == charge date`. Não é o que a 086 faz:
--
--   · a cobrança tem `charge_date` — a data do facto;
--   · o recebimento cria o movimento de caixa com
--     `(now() AT TIME ZONE 'Europe/Lisbon')::date` — a data em que o dinheiro
--     entrou.
--
-- Uma cobrança de Julho recebida em Agosto move dinheiro em Agosto. E retirar
-- esse recebimento em Setembro apaga um movimento de Agosto a partir de
-- Setembro: um TERCEIRO mês entra em jogo, e só se descobre depois de olhar
-- para o caixa que já lá está.
--
-- Por isso `set_manual_charge_payment_atomic` não bloqueia um par: monta o
-- conjunto completo de datas da operação e entrega-o de uma vez ao protocolo
-- de N períodos da 090, que ordena, deduplica e adquire tudo antes de validar.
-- Datas que caiam no mesmo mês dão um lock lógico só.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade — EXPAND FIRST
-- ---------------------------------------------------------------------------
--
-- Todas as assinaturas existentes ficam **exactamente** como estavam. Nenhum
-- parâmetro novo, nenhum parâmetro obrigatório novo, nenhuma renomeação. O
-- código publicado hoje continua a chamar estas funções da mesma maneira.
--
-- O que muda é o comportamento com o mês FECHADO — que hoje é «escreve» e
-- passa a ser «recusa». Em produção `financial_periods` está vazia, portanto
-- todos os meses estão abertos e nenhuma chamada existente muda de resultado.
--
-- `create_manual_charge_atomic` é NOVA. Não substitui nada: hoje não existe
-- caminho de criação nenhum na base, e a criação é o único ponto do ciclo de
-- vida que ficaria de fora do protocolo.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  -- A fundação da 090 e as RPCs da 086 que esta migration substitui. Uma
  -- delas em falta e o `CREATE OR REPLACE` abaixo criaria uma função nova em
  -- vez de substituir a existente — passando a haver duas verdades sobre a
  -- mesma operação.
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_period_open_locked',       'p_company_id uuid, p_year integer, p_month integer'),
      ('assert_financial_periods_open_locked_pair', 'p_company_id uuid, p_year_a integer, p_month_a integer, p_year_b integer, p_month_b integer'),
      ('assert_financial_periods_open_locked_many', 'p_company_id uuid, p_keys integer[]'),
      ('assert_financial_period_dates_open_locked', 'p_company_id uuid, p_dates date[]'),
      ('set_manual_charge_payment_atomic',          'p_company_id uuid, p_charge_id uuid, p_status text, p_paid_amount numeric, p_actor uuid'),
      ('update_manual_charge_atomic',               'p_company_id uuid, p_charge_id uuid, p_patch jsonb, p_actor uuid'),
      ('void_manual_charge_atomic',                 'p_company_id uuid, p_charge_id uuid, p_actor uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGES_PERIOD_091_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;

  IF to_regclass('public.manual_charges') IS NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGES_PERIOD_091_PRECONDITION_FAILED: tabela manual_charges ausente';
  END IF;

  -- `clients` entra nas precondições porque a validação de empresa do cliente
  -- passa a viver aqui: sem a tabela, a guarda não existiria e a função
  -- escreveria na mesma.
  IF to_regclass('public.clients') IS NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGES_PERIOD_091_PRECONDITION_FAILED: tabela clients ausente';
  END IF;
END
$precondicoes$;

-- ─── 1. Criar cobrança avulsa, sob o lock do período ────────────────────────
--
-- Nova. Hoje a criação não passa pela base — e uma cobrança criada com o mês
-- fechado é dinheiro a entrar num mês encerrado.
--
-- Preserva o vocabulário da tabela: `company_id`, `client_id`, `charge_date`,
-- `description`, `amount`, `apply_vat`, `notes`, e a proveniência em
-- `created_by`. O estado de recebimento nasce sempre `nao_informado` — criar e
-- receber são dois actos, e juntá-los aqui daria um caminho para registar
-- dinheiro sem passar pela RPC de recebimento, que é quem trata do caixa.
CREATE OR REPLACE FUNCTION public.create_manual_charge_atomic(
  p_company_id  uuid,
  p_client_id   uuid,
  p_charge_date date,
  p_description text,
  p_amount      numeric,
  p_apply_vat   boolean DEFAULT true,
  p_notes       text DEFAULT NULL,
  p_actor       uuid DEFAULT NULL
)
RETURNS TABLE (charge_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_client_id IS NULL OR p_charge_date IS NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_DESCRIPTION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  -- O `CHECK amount > 0` da tabela também recusa, mas com uma mensagem de
  -- constraint. Aqui a recusa tem nome próprio, como as outras da 086.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 O cliente TEM de ser da empresa — e quem responde por isso é esta
  --    função, não o RLS.
  --
  --    Esta RPC é chamada pelo `createAdminClient()`, ou seja pelo
  --    `service_role`, que passa por cima de qualquer política. Uma validação
  --    que só exista em RLS não é validação nenhuma neste caminho. E a guarda
  --    na server action — «o cliente pertence ao profile.company_id» — continua
  --    a ser certa, mas é a guarda de UM chamador: qualquer outro que apareça,
  --    ou um `p_company_id` trocado por engano, escreveria uma cobrança de uma
  --    empresa contra o cliente de outra, com o extracto do cliente errado a
  --    passar a incluir dinheiro que nunca foi dele.
  --
  --    A chave estrangeira de `manual_charges.client_id` garante que o cliente
  --    EXISTE. Não garante que seja desta empresa — é essa a diferença que esta
  --    verificação fecha, e é a razão de ela viver na base.
  IF NOT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = p_client_id AND c.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_CLIENT_FOREIGN'
      USING ERRCODE = 'raise_exception',
            HINT = 'O cliente indicado nao pertence a esta empresa.';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  -- 🔴 O lock primeiro, e sobre o período da DATA DA COBRANÇA. Uma cobrança
  --    lançada hoje com data de Julho pertence a Julho, e é Julho que tem de
  --    estar aberto — não o mês em que alguém carregou no botão.
  PERFORM public.assert_financial_period_open_locked(
    p_company_id,
    EXTRACT(YEAR  FROM p_charge_date)::integer,
    EXTRACT(MONTH FROM p_charge_date)::integer
  );

  INSERT INTO public.manual_charges (
    company_id, client_id, charge_date, description, amount, apply_vat, notes, created_by
  ) VALUES (
    p_company_id, p_client_id, p_charge_date, btrim(p_description), p_amount,
    COALESCE(p_apply_vat, true), p_notes, p_actor
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id;
END;
$fn$;

-- ─── 2. Editar cobrança avulsa, com os dois períodos protegidos ─────────────
--
-- `CREATE OR REPLACE` da função da 086. Preserva TUDO o que ela já fazia —
-- campos editáveis, `FOR UPDATE`, recusa sobre cobrança anulada, as três
-- testemunhas de «tem dinheiro», o bloqueio de `amount`/`apply_vat` e o de
-- `client_id` como proveniência — e acrescenta uma coisa só: o período.
--
-- 🔴 Mover `charge_date` de Julho para Agosto altera os dois meses. Os dois
--    têm de estar abertos, e os dois têm de estar trancados antes da escrita.
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
  v_data_nova date;
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

  -- 🔴 O período, antes de qualquer escrita e depois de saber a data actual.
  --
  --    A data nova só se conhece com a linha na mão: um patch sem
  --    `charge_date` mantém a que lá está. Origem e destino iguais dão um
  --    lock só — `lock_financial_periods_pair` trata desse caso.
  v_data_nova := COALESCE((p_patch->>'charge_date')::date, v_chg.charge_date);

  PERFORM public.assert_financial_periods_open_locked_pair(
    p_company_id,
    EXTRACT(YEAR  FROM v_chg.charge_date)::integer,
    EXTRACT(MONTH FROM v_chg.charge_date)::integer,
    EXTRACT(YEAR  FROM v_data_nova)::integer,
    EXTRACT(MONTH FROM v_data_nova)::integer
  );

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
  IF (p_patch ? 'client_id')
     AND (p_patch->>'client_id') IS DISTINCT FROM v_chg.client_id::text
     AND v_tem_dinheiro THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_CLIENT_LOCKED'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Esta cobranca ja tem recebimento. Remova-o antes de mudar o cliente.';
  END IF;

  -- A mesma regra da criação: um `client_id` novo tem de ser desta empresa.
  -- Sem isto, a edição seria a porta que a criação fechou.
  IF (p_patch ? 'client_id')
     AND (p_patch->>'client_id') IS DISTINCT FROM v_chg.client_id::text
     AND NOT EXISTS (
       SELECT 1 FROM public.clients c
        WHERE c.id = (p_patch->>'client_id')::uuid AND c.company_id = p_company_id
     ) THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_CLIENT_FOREIGN'
      USING ERRCODE = 'raise_exception',
            HINT = 'O cliente indicado nao pertence a esta empresa.';
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

-- ─── 3. Recebimento, com TODOS os períodos que a operação toca ──────────────
--
-- `CREATE OR REPLACE` da função da 086, preservando toda a lógica de estados,
-- de coerência estado/valor, do IVA por `company_settings`, do `ON CONFLICT`
-- parcial da 024 e da remoção do movimento quando o recebimento é retirado.
--
-- ---------------------------------------------------------------------------
-- 🔴 Três períodos, não dois — e todos conhecidos ANTES do primeiro lock
-- ---------------------------------------------------------------------------
--
-- As datas economicamente relevantes desta operação são até três:
--
--   · `charge_date` — o mês do facto;
--   · a data de HOJE em Lisboa — o mês em que o dinheiro entra, e só quando
--     de facto vai entrar um movimento;
--   · a data de CADA movimento de caixa que já existe ligado a esta cobrança,
--     que foi criado noutro dia e pode ser um TERCEIRO mês.
--
-- A versão anterior desta função bloqueava o par (cobrança + hoje) e só
-- DEPOIS, dentro do ramo que remove o recebimento, descobria e bloqueava o mês
-- do movimento antigo. Isso é adquirir um subconjunto antes de conhecer o
-- conjunto — precisamente o que reintroduz o deadlock:
--
--     T1 tem Julho, Agosto  →  descobre Setembro  →  pede Setembro
--     T2 tem Agosto, Julho  →  descobre Setembro  →  pede Setembro
--
-- Aqui o conjunto inteiro é montado primeiro e entregue de uma vez a
-- `assert_financial_period_dates_open_locked`, que ordena, deduplica e adquire
-- tudo por ordem canónica antes de validar seja o que for.
--
-- ---------------------------------------------------------------------------
-- 🔴 Ler `cash_flow_entries` ANTES do lock de período é seguro — e porquê
-- ---------------------------------------------------------------------------
--
-- A premissa não é «ninguém escreve ali»: é que todo o writer dos movimentos
-- de caixa ligados a esta cobrança passa primeiro por
-- `SELECT ... FROM manual_charges ... FOR UPDATE` sobre a MESMA linha. São
-- três, e são todos deste ficheiro: esta função, `update_manual_charge_atomic`
-- e `void_manual_charge_atomic`. Enquanto esta transação segura a linha,
-- nenhum deles chega a ler, quanto mais a escrever.
--
-- Logo, a lista de datas lida sob o lock de linha é a lista que ainda vai
-- existir quando os locks de período forem adquiridos. E, mesmo que a premissa
-- viesse a partir-se por um writer novo, o DELETE final é o mesmo predicado do
-- SELECT: um movimento que aparecesse depois seria apagado sem o seu mês estar
-- trancado, e é essa a razão de a premissa ter de ser mantida por quem
-- acrescentar writers — não uma nota de conveniência.
--
-- Nenhuma escrita acontece antes de todos os períodos estarem trancados e
-- validados.
--
-- ---------------------------------------------------------------------------
-- 🔴 HOJE só entra no conjunto quando HOJE recebe alguma coisa
-- ---------------------------------------------------------------------------
--
-- Retirar um recebimento não escreve nada com a data de hoje: apaga movimentos
-- que têm datas próprias. Trancar o mês corrente nesse caso não protegeria
-- nada e recusaria uma operação legítima — não se pode corrigir um recebimento
-- errado só porque o mês corrente já fechou. O valor a receber é conhecido
-- antes de qualquer lock, portanto a decisão é exacta e não uma aproximação.
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
  v_data_caixa date := (now() AT TIME ZONE 'Europe/Lisbon')::date;
  v_datas_caixa date[];
  v_datas date[];
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

  -- Uma cobrança anulada não recebe dinheiro. Recusar aqui — antes dos locks de
  -- período — evita serializar meses para depois não fazer nada.
  IF v_chg.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGE_VOIDED'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Esta cobranca foi anulada e nao aceita recebimentos.';
  END IF;

  -- ── O valor, calculado antes dos locks ────────────────────────────────────
  --
  -- Não é optimização: é o que torna exacta a decisão de incluir, ou não, o mês
  -- corrente no conjunto de períodos. Nada disto escreve.
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

  -- ── O conjunto COMPLETO de períodos, e só depois os locks ─────────────────
  --
  -- Lido sob o `FOR UPDATE` da cobrança, pelas razões acima.
  SELECT array_agg(c.date) INTO v_datas_caixa
    FROM public.cash_flow_entries c
   WHERE c.company_id     = p_company_id
     AND c.reference_type = 'manual_charge'
     AND c.reference_id   = p_charge_id;

  v_datas := ARRAY[v_chg.charge_date] || COALESCE(v_datas_caixa, ARRAY[]::date[]);

  IF v_recebido > 0 THEN
    v_datas := v_datas || v_data_caixa;
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, v_datas);

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
      v_data_caixa,
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
    -- Os meses destes movimentos já vêm trancados de cima, junto com todos os
    -- outros. Não há aquisição de lock a partir daqui.
    DELETE FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'manual_charge'
       AND reference_id = p_charge_id;
  END IF;

  RETURN QUERY SELECT p_charge_id, v_recebido;
END;
$fn$;

-- ─── 4. Anular, sob o lock do período da cobrança ───────────────────────────
--
-- `CREATE OR REPLACE` da função da 086, preservando a regra de que anular não
-- é apagar e de que uma cobrança com recebimento não se anula em silêncio.
--
-- Anular só toca na própria cobrança — a 086 já garante que não há caixa
-- associado quando chega aqui — por isso um período só: o da `charge_date`.
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

  -- O período da cobrança, antes de a marcar como anulada.
  PERFORM public.assert_financial_period_open_locked(
    p_company_id,
    EXTRACT(YEAR  FROM v_chg.charge_date)::integer,
    EXTRACT(MONTH FROM v_chg.charge_date)::integer
  );

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

-- ─── Superfície ─────────────────────────────────────────────────────────────
--
-- A mesma da 086 para as funções substituídas — `CREATE OR REPLACE` preserva
-- os grants existentes, mas repeti-los aqui torna a superfície legível neste
-- ficheiro em vez de obrigar a ir procurá-la noutro.
REVOKE ALL PRIVILEGES ON FUNCTION public.create_manual_charge_atomic(uuid, uuid, date, text, numeric, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.update_manual_charge_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.set_manual_charge_payment_atomic(uuid, uuid, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.void_manual_charge_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_manual_charge_atomic(uuid, uuid, date, text, numeric, boolean, text, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.update_manual_charge_atomic(uuid, uuid, jsonb, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.set_manual_charge_payment_atomic(uuid, uuid, text, numeric, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.void_manual_charge_atomic(uuid, uuid, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('create_manual_charge_atomic',      'p_company_id uuid, p_client_id uuid, p_charge_date date, p_description text, p_amount numeric, p_apply_vat boolean, p_notes text, p_actor uuid'),
      ('update_manual_charge_atomic',      'p_company_id uuid, p_charge_id uuid, p_patch jsonb, p_actor uuid'),
      ('set_manual_charge_payment_atomic', 'p_company_id uuid, p_charge_id uuid, p_status text, p_paid_amount numeric, p_actor uuid'),
      ('void_manual_charge_atomic',        'p_company_id uuid, p_charge_id uuid, p_actor uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
        AND NOT p.prosecdef
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'MANUAL_CHARGES_PERIOD_091_POSTSTATE_FAILED: em falta ou com assinatura/segurança errada %', v_faltam;
  END IF;
END
$posestado$;
