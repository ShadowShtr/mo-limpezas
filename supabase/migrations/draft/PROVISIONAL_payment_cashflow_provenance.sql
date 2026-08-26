-- ============================================================================
-- PROVISIONAL — proveniência do movimento de caixa de um pagamento (F14-B)
-- ============================================================================
--
-- 🔴 NÃO APLICADA. E **sem número atribuído**, de propósito: vive em
--    `supabase/migrations/draft/` e não em `supabase/migrations/`, para que
--    nenhum runner a apanhe por engano.
--
--    MIGRATION_NUMBER_FINAL = UNASSIGNED
--
--    O número só se atribui quando a 077/078/079 estiverem reconciliadas. Hoje
--    a TASK 01A diz que produção tem 4 dos 9 objectos da 078 com origem não
--    provada, e que o ledger não conhece a 077, a 078 nem a 079. Escolher aqui
--    um «080» seria fingir que a sequência é conhecida.
--
-- ---------------------------------------------------------------------------
-- O que isto fecha
-- ---------------------------------------------------------------------------
--
-- `unmark_payment_paid` apaga o movimento com a origem do pagamento:
--
--     DELETE FROM public.cash_flow_entries
--      WHERE company_id = ... AND reference_type = 'fixed_variable_payment'
--        AND reference_id = p_payment_id;
--
-- Enquanto o único movimento com aquela origem era um movimento que a própria
-- RPC tinha criado, apagá-lo devolvia a base ao estado anterior. Depois da
-- reparação das 6 deixa de ser verdade: o movimento com aquela origem passa a
-- poder ser um movimento **legado**, que existia antes do pagamento e que a
-- reparação se limitou a ligar. Apagá-lo destrói histórico financeiro que
-- ninguém pediu para apagar.
--
-- E há um segundo andar: `bank_reconciliation_matches.cash_flow_entry_id` é
-- `ON DELETE CASCADE`. Se o movimento estiver conciliado, o `DELETE` leva a
-- correspondência à frente e deixa a `bank_transactions` marcada como
-- reconciliada contra uma linha que já não existe. Apaga a prova e mente sobre
-- o resultado.
--
-- ---------------------------------------------------------------------------
-- Porquê uma tabela, e não uma coluna
-- ---------------------------------------------------------------------------
--
-- A auditoria (ponto 8 do mandato) percorreu tudo o que já existe:
-- `reference_type`/`reference_id` dizem **o quê**, não **quem criou** — são
-- idênticos nos dois casos; `created_by` é nulo no legado; `created_at`,
-- `date`, `notes` e semelhança são heurísticas, e uma heurística sobre dinheiro
-- é um palpite com consequências. As tabelas da 078 (`domain_mutations`,
-- `company_change_events`) são idempotência de pedido e log de eventos, não
-- proveniência de linha — e assentar nelas seria construir por cima de um drift
-- por resolver.
--
--     PROVENANCE_EXISTING_MECHANISM_FOUND = NO
--     SCHEMA_OR_PROTOCOL_GAP = YES
--
-- Uma coluna `was_adopted boolean` responderia «foi adoptada?» e mais nada. O
-- `unmark` não precisa só de saber que foi adoptada: precisa de saber **ao que
-- voltar**. O `mark` altera três campos do movimento —
--
--     status                → 'confirmado'   (derivável: adoptada ⇒ era 'pendente')
--     date                  → p_paid_on      (NÃO derivável: a data legada perde-se)
--     expense_category_id   → COALESCE(...)  (NÃO derivável: a antiga perde-se)
--
-- — e dois deles não se reconstroem a partir de nada. A informação tem de ser
-- guardada no momento em que ainda existe. Uma tabela dedicada guarda-a uma vez,
-- com chave estrangeira, sem alargar `cash_flow_entries` com colunas que só
-- fazem sentido para um caminho.
--
-- Guarda-se o que não se deriva, e só isso: `status` fica de fora porque é
-- sempre `pendente` no caminho de adopção, e uma cópia a mais é mais uma coisa
-- que pode divergir da verdade.
--
-- ---------------------------------------------------------------------------
-- O que isto NÃO faz
-- ---------------------------------------------------------------------------
--
--  · não escreve uma única linha de dados — cria uma tabela vazia e substitui
--    duas funções. `MIGRATION_DATA_WRITES = 0`;
--  · não inventa proveniência para o histórico. Um movimento sem linha nesta
--    tabela é tratado como criado pelo `mark`, que é o que era verdade antes
--    de a reparação existir. Não se adivinha o passado;
--  · não altera `mark_payment_paid` no que toca ao F14-A — o helper
--    `assert_payment_cashflow_link` continua a valer para os dois caminhos;
--  · não implementa reversão de conciliação. Não existe mecanismo canónico de
--    reversal neste repositório, e inventar um a meio de uma correcção de
--    perda de dados seria trocar um risco por outro. Falha fechado.
-- ============================================================================

BEGIN;

-- ─── 1. A relação ───────────────────────────────────────────────────────────
--
-- Uma linha por movimento adoptado. `cash_flow_entry_id` é a chave primária:
-- um movimento não pode ter duas proveniências, e a unicidade é estrutural em
-- vez de depender de um índice que alguém possa largar.
--
-- 🔴 `ON DELETE CASCADE` aqui é seguro e é o oposto do cascade que causou o
--    problema: se o movimento desaparecer por um caminho legítimo, o registo de
--    proveniência não tem razão para sobreviver. O cascade perigoso é o de
--    `bank_reconciliation_matches`, e esse não se toca — bloqueia-se antes.
CREATE TABLE IF NOT EXISTS public.payment_cashflow_provenance (
  cash_flow_entry_id  uuid PRIMARY KEY
                        REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payment_id          uuid NOT NULL,
  origin              text NOT NULL
                        CHECK (origin IN ('created_by_mark', 'adopted_existing')),

  -- O prestate. Só o que não se deriva: a data e a categoria que o movimento
  -- tinha antes de o `mark` lhe tocar.
  prestate_date                date,
  prestate_expense_category_id uuid,

  created_at          timestamptz NOT NULL DEFAULT now(),

  -- 🔴 Um registo de adopção sem a data de origem não serve para nada: no
  --    `unmark` não haveria a que voltar. O CHECK impede que exista.
  CONSTRAINT payment_cashflow_provenance_adopted_needs_prestate
    CHECK (origin <> 'adopted_existing' OR prestate_date IS NOT NULL)
);

-- 🔴 A proveniência é por empresa **e** por pagamento. Sem isto, uma linha
--    forjada com o `company_id` de outra empresa podia descrever um movimento
--    desta — B12 do plano de ensaio.
CREATE INDEX IF NOT EXISTS idx_payment_cashflow_provenance_payment
  ON public.payment_cashflow_provenance(company_id, payment_id);

ALTER TABLE public.payment_cashflow_provenance ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.payment_cashflow_provenance IS
  'Diz, para um movimento de caixa ligado a um pagamento, se foi criado por '
  'mark_payment_paid ou se já existia e foi adoptado, e guarda o estado a que '
  'unmark_payment_paid tem de o devolver. Sem isto, desmarcar apaga histórico '
  'financeiro preexistente.';

-- ─── 2. RLS ─────────────────────────────────────────────────────────────────
--
-- O mesmo princípio das outras tabelas financeiras: a linha pertence à empresa
-- do utilizador. As RPC são `SECURITY INVOKER`, portanto correm com estas
-- políticas — o isolamento não depende de a função se portar bem.
DROP POLICY IF EXISTS payment_cashflow_provenance_select ON public.payment_cashflow_provenance;
CREATE POLICY payment_cashflow_provenance_select
  ON public.payment_cashflow_provenance FOR SELECT
  USING (company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS payment_cashflow_provenance_write ON public.payment_cashflow_provenance;
CREATE POLICY payment_cashflow_provenance_write
  ON public.payment_cashflow_provenance FOR ALL
  USING (company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid()));

COMMIT;
