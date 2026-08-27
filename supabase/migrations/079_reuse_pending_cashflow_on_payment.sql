-- ============================================================================
-- 079 — Marcar um pagamento como pago reutiliza o movimento pendente que já
--       existe, em vez de o deixar preso em `pendente`
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Preparada para revisão e ensaiada em base descartável
--    (`npm run rehearse:079`). Não aplicar em produção sem autorização
--    explícita e isolada — ver REGRA ZERO em `AGENTS.md`.
--
-- ⚠️ ALTERAÇÃO DE FUNÇÃO, E MAIS NADA. Esta migration não faz `UPDATE` nem
--    `INSERT` nem `DELETE` em nenhuma tabela. Não migra as 6 obrigações
--    pendentes, não toca nas 29 linhas da #78, não cria pagamentos. Aplicá-la
--    não muda um único byte de dados — muda o que acontece **da próxima vez**
--    que alguém marcar um pagamento como pago.
--
-- ---------------------------------------------------------------------------
-- O buraco que isto fecha
-- ---------------------------------------------------------------------------
--
-- A 073 termina o `INSERT` do movimento de caixa com:
--
--     ON CONFLICT (company_id, reference_type, reference_id) ... DO NOTHING
--
-- Isso resolveu o problema que existia na altura — repetir a operação não
-- podia criar um segundo movimento — e continua a resolvê-lo. Mas assume uma
-- coisa que deixou de ser verdade: que o único movimento que pode colidir é um
-- movimento **que a própria RPC criou**, logo já `confirmado`.
--
-- Passa a ser possível existir um movimento ligado a um pagamento **antes** de
-- esse pagamento ser pago. É exactamente o desenho da reparação das 6
-- obrigações que hoje vivem em `cash_flow_entries` como saídas pendentes: em
-- vez de criar um movimento novo (o que duplicaria a despesa no Fluxo de
-- Caixa), a reparação liga o movimento que já lá está ao pagamento novo, e
-- ele fica `pendente` até o dinheiro sair mesmo.
--
-- Com a 073 sozinha, o que acontecia a seguir era isto:
--
--     pagamento  →  pago          ✅
--     movimento  →  pendente      ❌  fica assim para sempre
--
-- O `DO NOTHING` disparava, a RPC devolvia o id do movimento existente, e
-- ninguém via erro nenhum. No ecrã: um pagamento pago cujo dinheiro nunca
-- saiu. A divergência silenciosa outra vez, do outro lado.
--
-- ---------------------------------------------------------------------------
-- A regra nova
-- ---------------------------------------------------------------------------
--
--   não existe movimento ligado   → cria-o `confirmado`   (igual à 073)
--   existe e está `pendente`      → **converte-o**, mesma linha, mesmo id
--   existe e está `confirmado`    → não faz nada          (igual à 073)
--
-- O que **nunca** acontece é haver duas linhas para a mesma ocorrência
-- económica. Isso já era garantido pelo índice único da 024 e continua a ser:
-- esta migration não relaxa nenhuma restrição.
--
-- ---------------------------------------------------------------------------
-- Porque é que os guardas são precisos
-- ---------------------------------------------------------------------------
--
-- «Encontrei uma linha com este `reference_id`» não é o mesmo que «encontrei a
-- linha certa». `reference_id` é um `uuid` **sem chave estrangeira** — nada na
-- base impede que aponte para outra coisa, ou que a linha tenha sido editada à
-- mão para um valor diferente do pagamento.
--
-- Reutilizar uma linha assim seria transformar um movimento estranho num
-- pagamento confirmado, com o valor errado, e sem deixar rasto. Por isso,
-- antes de reutilizar, confirma-se `type`, `amount` e o próprio vínculo. Se
-- alguma coisa não bate certo a função **levanta excepção** e a transacção
-- inteira é revertida — o pagamento não fica pago, o movimento não é tocado, e
-- alguém tem de ir ver porquê. Falhar fechado é a única resposta honesta
-- quando os dados contradizem o modelo.
--
-- ---------------------------------------------------------------------------
-- O que se manteve de propósito
-- ---------------------------------------------------------------------------
--
-- · **A assinatura.** `RETURNS TABLE (payment_id, cash_entry_id,
--   ja_estava_pago)` fica igual — `src/lib/finance-rpc/payment-cashflow.ts` lê
--   estes três nomes. Mudar a assinatura obrigaria a `DROP FUNCTION`, e um
--   `DROP` no meio de uma migration deixa uma janela em que a aplicação em
--   produção chama uma função que não existe.
--
-- · **`ja_estava_pago` continua a querer dizer «não mudou nada»**, que é o que
--   o cliente usa para decidir a mensagem. Converter um movimento pendente
--   mudou alguma coisa, portanto devolve `false`.
--
-- · **`unmark_payment_paid` não é tocada.** Continua a apagar o movimento com
--   esta origem. Depois da reparação das 6 isso passa a ter uma consequência
--   nova — desmarcar apagaria o movimento legado que foi religado, em vez de o
--   devolver a `pendente` — e essa é uma decisão de negócio separada, com o
--   seu próprio gate. Escrevê-la aqui por antecipação seria alargar o âmbito
--   de uma migration que se quer estreita. Fica registado como pendente, não
--   como esquecido.
-- ============================================================================

-- BEGIN; removido: a transacao autoritativa e a do runner de migrations
-- (scripts/lib/migration-runner-core.mjs: BEGIN -> SQL -> INSERT _migrations -> COMMIT).
-- Um COMMIT interno fecharia essa transacao cedo e separaria o efeito de schema
-- da provenance no ledger: uma falha do INSERT deixaria o schema aplicado sem
-- linha no ledger. Ver docs/handoffs/ e migration-runner-core.mjs.

-- ─── Invariantes do vínculo pagamento → movimento ──────────────────────────
--
-- 🔴 F14-A. Um único sítio, chamado pelos **dois** caminhos que podem terminar
--    a reutilizar uma linha que esta transacção não criou:
--
--      · a linha já existia quando a função a leu   (`IF FOUND`);
--      · a linha apareceu de outra ligação e o `INSERT ... ON CONFLICT`
--        embateu nela                                (`DO NOTHING` → releitura).
--
--    Antes, só o primeiro caminho validava. O segundo lia o `id` e aceitava o
--    que lá estivesse — e a PR #85 mostrou, em PostgreSQL real, o que passava.
--    Duas cópias da mesma regra divergem; uma função não pode divergir de si
--    própria. Qualquer invariante novo entra aqui e passa a valer nos dois.
--
--    Falha fechado: levanta excepção e a transacção inteira reverte. O
--    pagamento não fica pago e o movimento não é tocado.
-- 🔴 Os parâmetros são os **tipos compostos** das tabelas, não `%ROWTYPE`:
--    `%ROWTYPE` só é válido em `DECLARE`, nunca numa assinatura. O nome da
--    tabela vale como tipo e aceita a variável `%ROWTYPE` de quem chama.
CREATE OR REPLACE FUNCTION public.assert_payment_cashflow_link(
  p_mov        public.cash_flow_entries,
  p_pag        public.fixed_variable_payments,
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
AS $guard$
BEGIN
  -- Identidade: empresa e vínculo. Uma linha de outra empresa, ou ligada a
  -- outro pagamento, nunca é reutilizada.
  IF p_mov.company_id IS DISTINCT FROM p_company_id
     OR p_mov.reference_type IS DISTINCT FROM 'fixed_variable_payment'
     OR p_mov.reference_id IS DISTINCT FROM p_payment_id THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_MISMATCH'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Sentido económico: pagar é sempre uma saída. Uma entrada com esta origem
  -- inverteria o sinal do dinheiro.
  IF p_mov.type IS DISTINCT FROM 'saida' THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_TYPE_MISMATCH'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Um valor diferente não se ajusta em silêncio. Ou alguém editou o movimento
  -- à mão, ou o pagamento mudou de valor depois de ligado — nos dois casos,
  -- confirmar a saída pelo valor errado é pior do que parar.
  IF p_mov.amount IS DISTINCT FROM p_pag.amount THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_AMOUNT_MISMATCH'
      USING ERRCODE = 'data_exception';
  END IF;

  -- O CHECK da tabela só permite `pendente`/`confirmado`. Outra coisa quer
  -- dizer que o modelo mudou e esta função não sabe o que fazer.
  IF p_mov.status IS NULL OR p_mov.status NOT IN ('pendente', 'confirmado') THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_STATUS_UNEXPECTED'
      USING ERRCODE = 'data_exception';
  END IF;
END;
$guard$;

COMMENT ON FUNCTION public.assert_payment_cashflow_link IS
  'Invariantes que um movimento de caixa tem de cumprir para ser reutilizado '
  'por mark_payment_paid: mesma empresa, mesmo vínculo, saída, valor igual ao '
  'do pagamento e estado conhecido. Chamada pelos dois caminhos de '
  'reutilização — o que lê a linha antes do INSERT e o que a encontra depois '
  'de um conflito. Falha fechado.';

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
  v_entrada    uuid;
  v_sem_efeito boolean := false;
BEGIN
  -- 🔴 `FOR UPDATE`: tranca a linha do pagamento até ao fim da transacção.
  --    Dois pedidos simultâneos para o mesmo pagamento serializam-se aqui, e
  --    o segundo vê o estado que o primeiro deixou. É esta tranca — e não o
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

  IF NOT public.is_financial_period_open(p_company_id, v_pag.period_year, v_pag.period_month) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_CLOSED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.fixed_variable_payments
     SET status  = 'pago',
         paid_at = COALESCE(paid_at, p_paid_on::timestamptz)
   WHERE id = p_payment_id;

  -- ─── Já existe movimento ligado a este pagamento? ────────────────────────
  --
  -- 🔴 O `company_id` está na condição, não num `IF` a seguir. Uma linha de
  --    outra empresa nunca chega a ser vista aqui — não há ramo nenhum onde
  --    ela pudesse ser reutilizada por engano.
  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'fixed_variable_payment'
     AND reference_id = p_payment_id
   FOR UPDATE;

  IF FOUND THEN
    -- ── Guardas. Nenhuma linha é reutilizada sem provar que é a linha certa.
    --    A regra vive em `assert_payment_cashflow_link` e é a mesma que o
    --    caminho do conflito aplica — ver F14-A mais abaixo.
    PERFORM public.assert_payment_cashflow_link(v_mov, v_pag, p_company_id, p_payment_id);

    IF v_mov.status = 'pendente' THEN
      -- 🔴 A mesma linha. O `id` não muda, e é isso que preserva o histórico
      --    do movimento legado: `created_at`, `notes`, quem o criou.
      --
      --    `date` passa a ser a data efectiva do pagamento. A data antiga era
      --    a do registo da factura; deixá-la aqui diria que o dinheiro saiu
      --    num dia em que não saiu, e o mês fecharia com o valor no sítio
      --    errado.
      --
      --    `expense_category_id` só é actualizado quando o pagamento **tem**
      --    categoria. Apagar a que lá está por o pagamento não ter nenhuma
      --    seria destruir informação sem ganhar nada: para um movimento
      --    ligado, quem manda na leitura é sempre o pagamento
      --    (`src/domain/finance-v2/effective-expense-category.ts`), portanto o
      --    snapshot nunca contradiz o ecrã.
      UPDATE public.cash_flow_entries
         SET status = 'confirmado',
             date   = p_paid_on,
             expense_category_id = COALESCE(v_pag.expense_category_id, expense_category_id)
       WHERE id = v_mov.id;

    ELSIF v_mov.status = 'confirmado' THEN
      -- Idempotência: repetir a operação não mexe em nada.
      v_sem_efeito := true;

    ELSE
      -- O CHECK da tabela só permite `pendente`/`confirmado`. Se aparecer
      -- outra coisa, o modelo mudou e esta função não sabe o que fazer.
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

    IF v_entrada IS NULL THEN
      -- 🔴 F14-A. O `DO NOTHING` disparou: outra ligação inseriu a linha entre
      --    o `SELECT ... FOR UPDATE` e este `INSERT`.
      --
      --    A versão anterior desta função relia aqui **apenas o `id`** e
      --    devolvia-o, com o comentário de que isto «não pode acontecer para o
      --    mesmo pagamento porque a tranca acima impede-o». O comentário estava
      --    errado, e a PR #85 provou-o em PostgreSQL real: a tranca serializa
      --    duas chamadas **à RPC**, mas não impede um `INSERT` directo de
      --    outra ligação sobre a mesma identidade única. Era possível terminar
      --    com `type = entrada` numa saída, com um valor que não é o do
      --    pagamento, e com o movimento em `pendente` enquanto o pagamento
      --    ficava `pago`.
      --
      --    A linha que vem de fora não merece mais confiança do que a que já cá
      --    estava. Relê-se **completa**, com `FOR UPDATE` — quem a inseriu
      --    pode ainda não ter feito COMMIT — e passa exactamente pelos mesmos
      --    invariantes do caminho de reutilização, pela mesma função.
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

      -- Sobreviveu aos guardas: é economicamente a mesma ocorrência. Segue a
      -- mesma regra do caminho de reutilização.
      IF v_mov.status = 'pendente' THEN
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

COMMENT ON FUNCTION public.mark_payment_paid IS
  'Marca o pagamento como pago e garante um único movimento de caixa com a '
  'origem (company, fixed_variable_payment, payment_id): cria-o se não '
  'existir, converte-o de pendente para confirmado se já existir, e não faz '
  'nada se já estiver confirmado. Recusa reutilizar um movimento cujo tipo ou '
  'valor não corresponda ao pagamento.';

-- COMMIT; removido pelo mesmo motivo: quem faz COMMIT e o runner.

-- ============================================================================
-- O que esta migration NÃO faz
-- ============================================================================
--
--  · não escreve em `cash_flow_entries` nem em `fixed_variable_payments` —
--    `MIGRATION_DATA_WRITES = 0` fora da definição da função;
--  · não cria, liga nem move as 6 obrigações pendentes;
--  · não toca nas 29 linhas de competência divergente da #78;
--  · não altera `unmark_payment_paid`, `is_financial_period_open`, o índice da
--    024 nem o CHECK da 075;
--  · não desbloqueia a 070.
--
-- O rollback técnico desta migration vive em
-- `supabase/migrations/rollback/079_reuse_pending_cashflow_on_payment.down.sql`
-- e repõe, palavra por palavra, a definição que a 073 deixou. É ensaiado em
-- base descartável pelo `npm run rehearse:079` — não é um comentário que
-- alguém escreveu e nunca correu.
-- ============================================================================
