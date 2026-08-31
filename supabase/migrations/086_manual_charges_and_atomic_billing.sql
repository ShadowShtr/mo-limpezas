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
-- ── 1b. O que ela É, por decisão do proprietário ───────────────────────────
--
--    Na interface chama-se **nota de cobrança** (ou «cobrança avulsa»). O nome
--    técnico `manual_charges` fica; o vocabulário de quem a usa é outro.
--
--        MANUAL_CHARGE           = FIRST_CLASS_RECEIVABLE
--        SERVICE_REQUIRED        = NO
--        INVOICE_REQUIRED        = NO
--        CUSTOMER_LINK_REQUIRED  = YES
--        COMPANY_LINK_REQUIRED   = YES
--        REPORTABLE              = YES
--
-- 🔴 REPORTABLE = YES não é um detalhe, e vale a pena dizê-lo aqui para que
--    ninguém leia a secção «o que esta migration NÃO faz» ao contrário.
--
--    Uma nota de cobrança **entra** no acompanhamento de Cobranças, e há-de
--    entrar nos relatórios financeiros e nos relatórios por cliente — mesmo
--    sem serviço nenhum por trás. Não participar de `invoice_items` não é
--    ficar de fora dos relatórios: é não ser um documento fiscal.
--
--    O contrato de leitura, quando a Fase 2 o construir, é por ORIGEM:
--
--        billing item · type = service
--                     · type = manual_charge
--
--    As duas somam para «quanto foi cobrado», «quanto foi recebido»,
--    pendentes, por cliente e por período — e o relatório continua a poder
--    responder «quanto veio de serviços?» e «quanto veio de notas de
--    cobrança?» separadamente. A proveniência conserva-se sempre.
--
-- 🔴 E NUNCA se converte uma nota de cobrança num serviço só para a fazer
--    aparecer num relatório. Era essa a alternativa rejeitada acima, e o
--    motivo não muda por o pedido vir do lado dos relatórios.
--
--    `service_id` não existe nesta tabela, e não é esquecimento: a existência
--    da nota não depende de serviço. Uma referência opcional a `services`, se
--    algum dia for desejada, é PROVENIÊNCIA separada — e tem de provar, antes
--    de existir, que não produz dupla cobrança (pagamento de serviço mais
--    recebimento de nota para a mesma obrigação).
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
--      dinheiro duas vezes. Uma nota de cobrança é uma cobrança financeira
--      independente e **reportável**, e não um documento legal. A integração,
--      se for desejada, é uma extensão explícita e posterior, e tem de provar
--      que não contabiliza o mesmo recebimento duas vezes.
--
--      🔴 Ficar fora de `invoice_items` NÃO é ficar fora dos relatórios —
--         ver a secção 1b. É a única leitura errada possível deste parágrafo,
--         e está aqui dita ao contrário de propósito;
--    · não repara dados: não há dados a reparar.
-- ============================================================================

-- ─── 0. Precondições — fail-closed antes de sobrescrever o que já existe ────
--
-- 🔴 Esta migration não cria só coisas novas: substitui um CHECK que já está em
--    produção e faz `CREATE OR REPLACE` de uma função da 062. Sobrescrever é
--    seguro exactamente enquanto o que lá está for o que julgamos que está.
--
--    UNKNOWN_STATE = FAIL_CLOSED. Nada é alterado antes destas guardas passarem,
--    e nenhuma delas «normaliza» o que encontra: divergência levanta, não corrige.
--
-- 🔴 Cada guarda aceita DOIS estados: o prestate e o poststate desta própria
--    migration. Sem isso, reaplicar a 086 — que tem de ser idempotente — falharia
--    na segunda vez por ter funcionado na primeira. Qualquer terceiro estado é
--    drift e para tudo.
DO $precondicoes$
DECLARE
  v_tipos      text[];
  v_idx        text;
  v_oid        oid;
  v_n          integer;
  v_secdef     boolean;
  v_config     text[];
  v_args       text;
  v_grantees   text[];
  v_cols       text[];
  v_constraints text[];
  v_triggers   text[];
  v_policies   text[];
  v_acl_bad    text[];
  r_helper     record;
  r_rpc        record;
  r_encontrada record;
  c_cols_086   constant text[] := ARRAY[
    'amount:numeric(10,2):not_null:(sem_default)',
    'apply_vat:boolean:not_null:true',
    'charge_date:date:not_null:(sem_default)',
    'client_id:uuid:not_null:(sem_default)',
    'company_id:uuid:not_null:(sem_default)',
    'created_at:timestamp with time zone:not_null:now()',
    'created_by:uuid:nullable:(sem_default)',
    'description:text:not_null:(sem_default)',
    'id:uuid:not_null:gen_random_uuid()',
    'notes:text:nullable:(sem_default)',
    'paid_amount:numeric(10,2):nullable:(sem_default)',
    'paid_at:timestamp with time zone:nullable:(sem_default)',
    'payment_status:text:not_null:''nao_informado''::text',
    'updated_at:timestamp with time zone:not_null:now()',
    'voided_at:timestamp with time zone:nullable:(sem_default)',
    'voided_by:uuid:nullable:(sem_default)'
  ];
  c_constraints_086 constant text[] := ARRAY[
    'manual_charges_amount_positivo:c:CHECK ((amount > (0)::numeric))',
    'manual_charges_client_id_fkey:f:FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT',
    'manual_charges_client_mesma_empresa:f:FOREIGN KEY (client_id, company_id) REFERENCES clients(id, company_id) ON DELETE RESTRICT',
    'manual_charges_company_id_fkey:f:FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE',
    'manual_charges_created_by_fkey:f:FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL',
    'manual_charges_paid_amount_nao_negativo:c:CHECK (((paid_amount IS NULL) OR (paid_amount >= (0)::numeric)))',
    'manual_charges_payment_status_check:c:CHECK ((payment_status = ANY (ARRAY[''nao_informado''::text, ''sinal_50''::text, ''pago_total''::text])))',
    'manual_charges_pkey:p:PRIMARY KEY (id)',
    'manual_charges_void_coerente:c:CHECK (((voided_at IS NULL) = (voided_by IS NULL)))',
    'manual_charges_voided_by_fkey:f:FOREIGN KEY (voided_by) REFERENCES profiles(id) ON DELETE SET NULL'
  ];
  c_prestate   constant text[] :=
    ARRAY['fixed_variable_payment', 'invoice', 'payroll', 'service_payment'];
  c_poststate  constant text[] :=
    ARRAY['fixed_variable_payment', 'invoice', 'manual_charge', 'payroll', 'service_payment'];
BEGIN
  -- 0a. O CHECK de `reference_type` é o que a 075 deixou (ou já o desta).
  --
  -- Compara-se o CONJUNTO de literais aceites, não o texto do constraint: o
  -- `pg_get_constraintdef` reformata, e uma guarda que dependesse do formato
  -- ficaria vermelha por uma diferença de espaços em vez de por uma diferença
  -- de significado.
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}')
    INTO v_tipos
    FROM pg_constraint c
    CROSS JOIN LATERAL
      regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.cash_flow_entries'::regclass
     AND c.conname  = 'cash_flow_entries_reference_type_check';

  IF v_tipos <> c_prestate AND v_tipos <> c_poststate THEN
    RAISE EXCEPTION
      '086_UNEXPECTED_CASHFLOW_REFERENCE_TYPE_STATE: aceites = %, esperado % (prestate) ou % (já aplicada)',
      v_tipos, c_prestate, c_poststate;
  END IF;

  -- 0b. O índice parcial da 024 tem de estar lá, e com o predicado exacto.
  --
  -- 🔴 Não é decoração: as duas RPCs desta migration usam-no como árbitro do
  --    `ON CONFLICT`. Sem ele — ou com outro predicado — o `INSERT` rebenta com
  --    42P10 em runtime, num caminho de dinheiro, e não aqui.
  -- 🔴 `to_regclass`, e não `::regclass`. O cast levanta «relation does not
  --    exist» quando o índice falta — e a guarda passaria a falhar com um erro
  --    cru do PostgreSQL em vez do nome que diz o que se passa. Fecha nos dois
  --    casos, mas só um deles é legível para quem estiver a aplicar isto.
  SELECT pg_get_indexdef(i.indexrelid) INTO v_idx
    FROM pg_index i
   WHERE i.indrelid   = 'public.cash_flow_entries'::regclass
     AND i.indexrelid = to_regclass('public.cash_flow_entries_reference_unique');

  IF v_idx IS NULL
     OR v_idx NOT LIKE '%UNIQUE%'
     OR v_idx NOT LIKE '%(company_id, reference_type, reference_id)%'
     OR v_idx NOT LIKE '%reference_type IS NOT NULL%'
     OR v_idx NOT LIKE '%reference_id IS NOT NULL%' THEN
    RAISE EXCEPTION
      '086_UNEXPECTED_CASHFLOW_REFERENCE_INDEX_STATE: %', coalesce(v_idx, '(ausente)');
  END IF;

  -- 0c. `delete_calendar_service_safe` é a da 062 (ou já a desta).
  --
  -- Uma segunda sobrecarga com o mesmo nome significa que o `CREATE OR REPLACE`
  -- abaixo deixaria a outra viva, e o caminho canónico passaria a depender de
  -- qual delas o PostgREST resolve.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_calendar_service_safe';

  IF v_n <> 1 THEN
    RAISE EXCEPTION
      '086_UNEXPECTED_DELETE_SERVICE_STATE: % sobrecargas de delete_calendar_service_safe, esperado 1', v_n;
  END IF;

  SELECT p.oid, p.prosecdef, p.proconfig
    INTO v_oid, v_secdef, v_config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_calendar_service_safe';

  -- 🔴 Os TIPOS dos argumentos, vindos de `proargtypes` — não
  --    `pg_get_function_identity_arguments`, que devolve também os NOMES dos
  --    parâmetros («p_service_id uuid, p_scope text, …»). A guarda com essa
  --    função comparava nomes contra tipos e recusava a assinatura correcta,
  --    o que é o pior modo de falha possível numa precondição: fecha o caminho
  --    certo e obriga quem a lê a duvidar da base em vez do teste.
  SELECT string_agg(format_type(t, NULL), ', ' ORDER BY ord)
    INTO v_args
    FROM pg_proc p, unnest(p.proargtypes) WITH ORDINALITY AS a(t, ord)
   WHERE p.oid = v_oid;

  IF v_args IS DISTINCT FROM 'uuid, text, uuid, uuid' THEN
    RAISE EXCEPTION
      '086_UNEXPECTED_DELETE_SERVICE_STATE: argumentos = (%), esperado (uuid, text, uuid, uuid)',
      coalesce(v_args, '(nenhum)');
  END IF;

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION
      '086_UNEXPECTED_DELETE_SERVICE_STATE: nao e SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public' = ANY(v_config)) THEN
    RAISE EXCEPTION
      '086_UNEXPECTED_DELETE_SERVICE_STATE: search_path = %, esperado search_path=public',
      coalesce(array_to_string(v_config, ','), '(nenhum)');
  END IF;

  -- 0d. ACL: ninguém com EXECUTE fora do conjunto que esta migration controla.
  --
  -- 🔴 O `CREATE OR REPLACE` **preserva** o ACL existente. A secção 11 revoga de
  --    PUBLIC/anon/authenticated e concede a service_role — mas não sabe nada de
  --    um papel que alguém tenha concedido à mão. Esse sobreviveria à migration
  --    em silêncio, que é a definição de drift normalizado sem se dar por ele.
  --
  --    A guarda não exige que os papéis conhecidos estejam concedidos (a secção
  --    11 decide isso). Exige que não haja nenhum desconhecido.
  SELECT coalesce(array_agg(DISTINCT grantee ORDER BY grantee), '{}')
    INTO v_grantees
    FROM (
      SELECT coalesce(nullif((a).grantee::regrole::text, '-'), 'PUBLIC') AS grantee
        FROM (SELECT aclexplode(proacl) AS a FROM pg_proc WHERE oid = v_oid) x
       WHERE (a).privilege_type = 'EXECUTE'
    ) g
   WHERE grantee NOT IN ('PUBLIC', 'anon', 'authenticated', 'service_role',
                         current_user, 'postgres');

  IF v_grantees <> '{}'::text[] THEN
    RAISE EXCEPTION
      '086_UNEXPECTED_DELETE_SERVICE_STATE: EXECUTE concedido a papel desconhecido: %',
      array_to_string(v_grantees, ', ');
  END IF;

  -- 0e. Os helpers de que o DDL abaixo depende.
  --
  -- 🔴 A 086 pendura um trigger em `fn_capture_history` e escreve uma policy
  --    sobre `get_my_company_id`/`get_my_role`. Se algum deles faltar — ou
  --    devolver outra coisa — o objecto criado por esta migration nasce a
  --    apontar para nada, e só se descobre em runtime.
  --
  --    Verifica-se a forma mínima indispensável (existe, e devolve o tipo de
  --    que dependemos), e nada mais. Isto não é uma auditoria do esquema: é a
  --    lista curta do que ESTA migration consome.
  FOR r_helper IN
    SELECT * FROM (VALUES
      ('fn_capture_history',  'trigger'),
      ('get_my_company_id',   'uuid'),
      ('get_my_role',         'text')
    ) AS h(nome, retorno)
  LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = r_helper.nome
       AND format_type(p.prorettype, NULL) = r_helper.retorno;

    IF v_n < 1 THEN
      RAISE EXCEPTION
        '086_MISSING_DEPENDENCY: public.%() com retorno % não existe — a 086 depende dela',
        r_helper.nome, r_helper.retorno;
    END IF;
  END LOOP;

  -- 0f. `manual_charges` — ausente, ou exactamente a desta migration.
  --
  -- 🔴 `CREATE TABLE IF NOT EXISTS` é silencioso por desenho: se já existir uma
  --    tabela com este nome e OUTRA forma, a migration segue em frente, o
  --    `ALTER`/`GRANT`/policy aplicam-se por cima, e passa a haver uma
  --    `manual_charges` que não é a nossa a servir de origem a movimentos de
  --    caixa. Produção hoje não a tem (medido); esta guarda existe para o caso
  --    de alguém a criar entretanto.
  --
  --    Compara-se a semântica que sobreviveria ao `IF NOT EXISTS`: colunas
  --    com nullability/defaults, constraints, trigger, RLS/policies e ACL.
  --    UNKNOWN_STATE = FAIL_CLOSED.
  IF to_regclass('public.manual_charges') IS NOT NULL THEN
    SELECT coalesce(array_agg(
             a.attname || ':' ||
             format_type(a.atttypid, a.atttypmod) || ':' ||
             CASE WHEN a.attnotnull THEN 'not_null' ELSE 'nullable' END || ':' ||
             coalesce(pg_get_expr(d.adbin, d.adrelid), '(sem_default)')
             ORDER BY a.attname), '{}')
      INTO v_cols
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.manual_charges'::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF v_cols <> c_cols_086 THEN
      RAISE EXCEPTION
        '086_UNEXPECTED_MANUAL_CHARGES_STATE: colunas/nullability/defaults = %',
        array_to_string(v_cols, ', ');
    END IF;

    SELECT coalesce(array_agg(conname || ':' || contype::text || ':' || pg_get_constraintdef(oid)
                              ORDER BY conname), '{}')
      INTO v_constraints
      FROM pg_constraint
     WHERE conrelid = 'public.manual_charges'::regclass;

    IF v_constraints <> c_constraints_086 THEN
      RAISE EXCEPTION
        '086_UNEXPECTED_MANUAL_CHARGES_STATE: constraints = %',
        array_to_string(v_constraints, ' | ');
    END IF;

    SELECT coalesce(array_agg(t.tgname || ':' || t.tgenabled::text || ':' ||
                              pg_get_triggerdef(t.oid) ORDER BY t.tgname), '{}')
      INTO v_triggers
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.manual_charges'::regclass
       AND NOT t.tgisinternal;

    IF v_triggers <> ARRAY[
      'trg_history:O:CREATE TRIGGER trg_history AFTER DELETE OR UPDATE ON public.manual_charges FOR EACH ROW EXECUTE FUNCTION fn_capture_history()'
    ] THEN
      RAISE EXCEPTION
        '086_UNEXPECTED_MANUAL_CHARGES_STATE: triggers = %',
        array_to_string(v_triggers, ' | ');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE oid = 'public.manual_charges'::regclass
         AND relrowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION
        '086_UNEXPECTED_MANUAL_CHARGES_STATE: RLS nao esta activo';
    END IF;

    SELECT coalesce(array_agg(policyname || ':' || cmd || ':' || permissive || ':' ||
                              array_to_string(roles, ',') || ':' || qual
                              ORDER BY policyname), '{}')
      INTO v_policies
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'manual_charges';

    IF array_length(v_policies, 1) IS DISTINCT FROM 1
       OR v_policies[1] NOT LIKE 'manual_charges_manager_select:SELECT:PERMISSIVE:%'
       OR v_policies[1] NOT LIKE '%:public:%'
       OR v_policies[1] NOT LIKE '%company_id%'
       OR v_policies[1] NOT LIKE '%get_my_company_id()%'
       OR v_policies[1] NOT LIKE '%get_my_role()%'
       OR v_policies[1] NOT LIKE '%admin%'
       OR v_policies[1] NOT LIKE '%gestor%' THEN
      RAISE EXCEPTION
        '086_UNEXPECTED_MANUAL_CHARGES_STATE: policies = %',
        array_to_string(v_policies, ' | ');
    END IF;

    SELECT coalesce(array_agg(grantee || ':' || privilege_type ORDER BY grantee, privilege_type), '{}')
      INTO v_acl_bad
      FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name = 'manual_charges'
       AND NOT (
         (grantee = 'authenticated' AND privilege_type = 'SELECT')
         OR (grantee = 'service_role' AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
         OR grantee IN (current_user, 'postgres')
       );

    IF v_acl_bad <> '{}'::text[] THEN
      RAISE EXCEPTION
        '086_UNEXPECTED_MANUAL_CHARGES_STATE: ACL inesperado = %',
        array_to_string(v_acl_bad, ', ');
    END IF;
  END IF;

  -- 0g. As quatro RPCs novas — ausentes, ou exactamente as desta migration.
  --
  -- 🔴 `CREATE OR REPLACE FUNCTION` substitui sem perguntar. Uma função com o
  --    mesmo nome e outra intenção — escrita à mão, ou vinda de um ramo que
  --    nunca foi mesclado — seria sobrescrita em silêncio, e o que lá estava
  --    desaparecia sem rasto.
  --
  --    O reconhecimento é por três sinais estáveis: os TIPOS dos argumentos, o
  --    modo de segurança e o `search_path`, e um marcador no corpo que só esta
  --    família de funções emite. Deliberadamente NÃO se usa o md5 da definição:
  --    mudaria a cada edição da migration, e a guarda passaria a exigir que o
  --    ficheiro nunca mais fosse tocado.
  FOR r_rpc IN
    SELECT * FROM (VALUES
      ('set_service_payment_atomic',       'uuid, uuid, text, numeric, uuid', 'SERVICE_PAYMENT_STATUS_INVALID'),
      ('set_manual_charge_payment_atomic', 'uuid, uuid, text, numeric, uuid', 'MANUAL_CHARGE_STATUS_INVALID'),
      ('void_manual_charge_atomic',        'uuid, uuid, uuid',                'MANUAL_CHARGE_HAS_PAYMENT'),
      ('update_manual_charge_atomic',      'uuid, uuid, jsonb, uuid',         'MANUAL_CHARGE_FIELD_NOT_EDITABLE')
    ) AS f(nome, args, marcador)
  LOOP
    FOR r_encontrada IN
      SELECT p.oid, p.prosecdef, p.proconfig,
             (SELECT string_agg(format_type(t, NULL), ', ' ORDER BY o)
                FROM unnest(p.proargtypes) WITH ORDINALITY AS a(t, o)) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = r_rpc.nome
    LOOP
      IF r_encontrada.args IS DISTINCT FROM r_rpc.args
         OR r_encontrada.prosecdef IS TRUE
         OR r_encontrada.proconfig IS NULL
         OR NOT ('search_path=pg_catalog, public' = ANY(r_encontrada.proconfig))
         OR position(r_rpc.marcador IN pg_get_functiondef(r_encontrada.oid)) = 0 THEN
        RAISE EXCEPTION
          '086_UNEXPECTED_RPC_STATE: public.%(%) existe e não é a desta migration',
          r_rpc.nome, coalesce(r_encontrada.args, '');
      END IF;

      SELECT coalesce(array_agg(DISTINCT grantee ORDER BY grantee), '{}')
        INTO v_grantees
        FROM (
          SELECT coalesce(nullif((a).grantee::regrole::text, '-'), 'PUBLIC') AS grantee
            FROM (SELECT aclexplode(proacl) AS a FROM pg_proc WHERE oid = r_encontrada.oid) x
           WHERE (a).privilege_type = 'EXECUTE'
        ) g
       WHERE grantee NOT IN ('PUBLIC', 'anon', 'authenticated', 'service_role',
                             current_user, 'postgres');

      IF v_grantees <> '{}'::text[] THEN
        RAISE EXCEPTION
          '086_UNEXPECTED_RPC_STATE: public.%(%) tem EXECUTE concedido a papel desconhecido: %',
          r_rpc.nome, coalesce(r_encontrada.args, ''), array_to_string(v_grantees, ', ');
      END IF;
    END LOOP;
  END LOOP;
END
$precondicoes$;

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
  'Nota de cobranca (cobranca avulsa): recebivel de cliente de primeira classe, '
  'sem servico e sem fatura por tras. Nao e servico, nao e movimento de caixa, '
  'nao e documento fiscal — e uma obrigacao financeira independente e '
  'REPORTAVEL: entra nas Cobrancas e nos relatorios financeiros e por cliente, '
  'conservando a origem (type = manual_charge, a par de type = service). '
  'O recebimento entra pelo caixa via set_manual_charge_payment_atomic, com '
  'reference_type = manual_charge. Nunca converter numa linha de services para '
  'a fazer aparecer num relatorio.';

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
         COALESCE(s.payment_status, 'nao_informado') <> 'nao_informado'
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
         COALESCE(s.payment_status, 'nao_informado') <> 'nao_informado'
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
