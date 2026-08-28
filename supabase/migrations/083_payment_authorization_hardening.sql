-- ============================================================================
-- 083 — mutação de pagamento só pelo caminho canónico
-- ============================================================================
-- Achado (prova em PostgreSQL 17 descartável, 2026-08-28):
--
--     authenticated + role='colaboradora'
--       → UPDATE public.fixed_variable_payments SET status='pago', paid_at=now()
--       → 1 linha afectada, persistida
--       → cash_flow_entries criados: 0
--
-- Ou seja: o pagamento fica pago e o dinheiro nunca sai do fluxo de caixa. É
-- exactamente a dessincronização que a onda 077→081 existe para impedir — mas
-- por uma via que não passa pela RPC e por isso nenhuma das suas garantias se
-- aplica.
--
-- 🔴 A causa é uma assimetria histórica, não um esquecimento pontual:
--
--     · a 033 endureceu `cash_flow_entries` com role **e** `WITH CHECK`;
--     · a 037, posterior, criou `fixed_variable_payments` com uma policy
--       `FOR ALL` sem role e **sem `WITH CHECK`**.
--
--    O `role IN ('admin','gestor')` existe apenas na Server Action. Quem falar
--    directamente com a base não passa por ela.
--
-- 🔴 A invariante desta migration NÃO é «colaboradora não escreve». É:
--
--     PAYMENT_MUTATION_CANONICAL_PATH_ONLY = YES
--
--    Um admin ou gestor autenticado também consegue produzir a mesma
--    divergência se puder escrever directamente — mudar `status` sem gerar
--    movimento é a mesma mentira, venha de quem vier. Por isso o DML directo
--    fecha para **todos** os papéis autenticados, incluindo admin/gestor. A
--    escrita legítima entra por `setPaymentStatus` → `requireProfile` →
--    service-role → `mark_payment_paid`/`unmark_payment_paid`.
--
-- Auditoria repo-wide feita antes de decidir (ver PR): todos os consumidores de
-- `fixed_variable_payments` em `src/` são Server Actions ou `src/lib` a usar o
-- cliente service-role; a PWA `/app` não tem Financeiro nem Pagamentos; o único
-- ficheiro de browser que menciona a tabela fá-lo num comentário, e o seu canal
-- Realtime subscreve `services`, não esta tabela. Não há caller autenticado
-- legítimo a perder acesso.
--
-- ── Defesa em profundidade: duas camadas independentes ─────────────────────
--
--    A. RLS      — nenhuma policy autoriza INSERT/UPDATE/DELETE a authenticated;
--                  o SELECT fica restrito a admin/gestor da própria empresa.
--    B. GRANTS   — INSERT/UPDATE/DELETE revogados de PUBLIC/anon/authenticated.
--
--    As duas provam-se separadamente nos testes. Um teste que passe só porque
--    o grant bloqueou aquilo que a policy devia bloquear (ou o inverso) não
--    prova esta migration.
--
-- ── O que esta migration NÃO faz ───────────────────────────────────────────
--
--    Não trata de concorrência nem de TOCTOU: isso é a 082 (F14-D, PR #108),
--    e copiá-la para aqui criaria uma segunda arquitectura para o mesmo
--    problema. 083 = AUTORIZAÇÃO. 082 = ATOMICIDADE/CONCORRÊNCIA.
-- ============================================================================

-- ─── 1. fixed_variable_payments — leitura só para gestão da própria empresa ──
--
-- A policy da 037 era `FOR ALL` e servia leitura e escrita ao mesmo tempo. Sai
-- inteira: substituí-la por uma de leitura é o ponto da mudança, e mantê-la
-- deixaria a porta de escrita aberta por baixo da nova.
DROP POLICY IF EXISTS "company members manage fixed variable payments"
  ON public.fixed_variable_payments;

-- 🔴 O papel resolve-se por `public.get_my_role()` (014), não por
--    `(SELECT role FROM profiles WHERE id = auth.uid())`. As duas formas
--    parecem equivalentes e não são: a subconsulta corre com os privilégios de
--    quem chama, e `authenticated` não tem `SELECT` em `profiles` — a policy
--    rebentaria com «permission denied for table profiles» em vez de decidir.
--    `get_my_role()` é `SECURITY DEFINER` e lê `profiles` sob o dono, que é
--    exactamente o que estas guardas precisam. Medido em PostgreSQL 17.
DROP POLICY IF EXISTS "payments_manager_select" ON public.fixed_variable_payments;

-- ─── 1b. Estado de policies desconhecido = FAIL_CLOSED ──────────────────────
--
-- 🔴 Esta migration conhece exactamente duas policies nesta tabela:
--
--        "company members manage fixed variable payments"   (037)
--        "payments_manager_select"                          (esta migration)
--
--    Ambas acabaram de ser removidas acima. Se sobrar QUALQUER outra, então a
--    base não está no estado que esta migration assume: alguém criou uma
--    policy fora do versionamento, ou uma migration futura chegou primeiro.
--
--    Nesse caso a conclusão «nenhuma policy autoriza escrita a authenticated»
--    deixa de estar provada — a policy desconhecida pode ser `FOR ALL` e
--    reabrir exactamente o buraco que a 083 fecha, por baixo da nova.
--
--    A resposta é parar, não limpar:
--
--        UNKNOWN_POLICY_STATE = FAIL_CLOSED
--
--    Apagar uma policy que não conhecemos seria destruir intenção alheia sem a
--    ler; prosseguir seria declarar uma garantia que não medimos. Quem
--    encontrar este erro tem de olhar para a policy, decidir, e versionar a
--    decisão. O RAISE aborta a transação da migration — nada desta migration
--    fica aplicado pela metade.
DO $drift$
DECLARE
  restantes text;
  n integer;
BEGIN
  SELECT count(*), string_agg(policyname, ', ' ORDER BY policyname)
    INTO n, restantes
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'fixed_variable_payments';

  IF n > 0 THEN
    RAISE EXCEPTION
      '083_UNEXPECTED_PAYMENT_POLICY_STATE: % policy(s) inesperada(s) em public.fixed_variable_payments: %',
      n, restantes
      USING HINT = 'A 083 nao apaga policies que nao conhece. Inspeccionar, decidir e versionar a decisao antes de reaplicar.';
  END IF;
END
$drift$;

CREATE POLICY "payments_manager_select"
  ON public.fixed_variable_payments
  FOR SELECT
  USING (
    company_id = public.get_my_company_id()
    AND public.get_my_role() IN ('admin', 'gestor')
  );

-- 🔴 Nenhuma policy de INSERT/UPDATE/DELETE é criada, e isso é deliberado.
--    Sem policy permissiva para a operação, o RLS nega — o modo de falha certo.
--    O `service_role` é BYPASSRLS e continua a escrever pelo caminho canónico.

ALTER TABLE public.fixed_variable_payments ENABLE ROW LEVEL SECURITY;

-- ─── 2. Grants de tabela — a segunda camada ─────────────────────────────────
--
-- O SELECT de `authenticated` fica: quem decide as linhas é a policy acima.
-- Privilégio de tabela e policy são coisas diferentes, e ambas têm de estar
-- certas.
-- 🔴 Revogar `SELECT, INSERT, UPDATE, DELETE` não fecha a tabela. Um
--    privilégio de TABLE em PostgreSQL inclui também:
--
--        TRUNCATE     — apaga todas as linhas da tabela
--        REFERENCES   — cria FK contra ela
--        TRIGGER      — instala trigger sobre ela
--
--    Enumerar as quatro operações de DML deixava as outras três por medir: se
--    alguma existisse em produção — herdada, ou dada por engano — sobrevivia a
--    esta migration, e a conclusão «authenticated = SOMENTE SELECT» seria
--    falsa. Um TRUNCATE concedido a `authenticated` apagava a tabela de
--    pagamentos inteira sem passar por policy nenhuma: RLS **não se aplica a
--    TRUNCATE**. REFERENCES e TRIGGER também não são filtráveis por RLS.
--
--    Por isso a estratégia é fechar tudo e reabrir só o que se justifica, em
--    vez de enumerar o que se tira: `REVOKE ALL PRIVILEGES` não depende de
--    sabermos de antemão o que lá estava.
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM authenticated;

-- `authenticated` recebe SELECT e mais nada. Quem decide as LINHAS é a policy
-- `payments_manager_select` acima; o privilégio só decide se a operação é
-- sequer possível. Não recebe INSERT/UPDATE/DELETE — a escrita entra pelo
-- caminho canónico — nem TRUNCATE/REFERENCES/TRIGGER.
GRANT SELECT ON TABLE public.fixed_variable_payments TO authenticated;

-- `anon` não recebe privilégio nenhum de tabela: não há caminho legítimo em
-- que um visitante não autenticado toque em pagamentos. O `REVOKE ALL` acima
-- é a totalidade da sua ACL, e o teste prova-o pelo catálogo.

-- `service_role` recebe exactamente o DML que o caminho canónico usa, e não
-- `GRANT ALL`: TRUNCATE/REFERENCES/TRIGGER não são usados por nenhuma Server
-- Action nem por nenhuma RPC, e concedê-los alargava a superfície sem
-- necessidade demonstrada. Se um dia forem precisos, entram por GRANT nomeado
-- e justificado.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fixed_variable_payments TO service_role;

-- ─── 3. RPCs de mutação — service_role apenas ───────────────────────────────
--
-- São `SECURITY INVOKER`: sem esta revogação, qualquer autenticado podia
-- chamá-las directamente e saltar `requireProfile`.
REVOKE EXECUTE ON FUNCTION public.mark_payment_paid(uuid, uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_payment_paid(uuid, uuid, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mark_payment_paid(uuid, uuid, date) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_payment_paid(uuid, uuid, date) TO service_role;

REVOKE EXECUTE ON FUNCTION public.unmark_payment_paid(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unmark_payment_paid(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.unmark_payment_paid(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.unmark_payment_paid(uuid, uuid) TO service_role;

-- ─── 4. Helpers — revogados por prova de callers, não por precaução ─────────
--
-- `assert_payment_cashflow_link`: invocado apenas por `mark_payment_paid` e
--   `unmark_payment_paid` (079 e 081). Zero callers em `src/`, zero em
--   policies, e nenhum nas branches abertas #98/#101/#108/#109. É helper
--   interno da cadeia canónica → service_role apenas.
--
-- `is_financial_period_open`: read-only. Invocado pelas funções SQL 073/079/081.
--   A guarda da aplicação (`assertFinancialPeriodOpen`) **não** chama esta
--   função — lê a tabela `financial_periods` directamente pelo service-role.
--   As menções em `src/` são comentários. Nenhum caller autenticado → também
--   service_role apenas.
--
-- Se aparecer um caller autenticado legítimo no futuro, a resposta é um GRANT
-- nomeado e justificado, não reabrir a porta a `PUBLIC`.
REVOKE EXECUTE ON FUNCTION public.assert_payment_cashflow_link(public.cash_flow_entries, public.fixed_variable_payments, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assert_payment_cashflow_link(public.cash_flow_entries, public.fixed_variable_payments, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.assert_payment_cashflow_link(public.cash_flow_entries, public.fixed_variable_payments, uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.assert_payment_cashflow_link(public.cash_flow_entries, public.fixed_variable_payments, uuid, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.is_financial_period_open(uuid, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_financial_period_open(uuid, integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_financial_period_open(uuid, integer, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.is_financial_period_open(uuid, integer, integer) TO service_role;

COMMENT ON POLICY "payments_manager_select" ON public.fixed_variable_payments IS
  'Leitura de pagamentos para admin/gestor da própria empresa. A escrita não '
  'tem policy: entra por Server Action → service-role → mark/unmark, para que '
  'estado do pagamento e movimento de caixa nunca possam divergir.';
