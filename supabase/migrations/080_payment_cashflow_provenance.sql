-- ============================================================================
-- 080 — proveniência do movimento de caixa de um pagamento (F14-B, peça 1/2)
-- ============================================================================
--
-- Esta migração é **só estrutura**: cria a tabela que guarda a proveniência e
-- o prestate. Não define nem substitui função nenhuma. Quem as consome é a
-- 081, que tem de correr depois desta e é revertida antes desta.
--
-- Porquê duas migrações e não uma
-- ---------------------------------------------------------------------------
-- Não é arrumação: é a semântica da reversão. As duas peças têm rollbacks de
-- natureza oposta e não podem partilhar um só.
--
--   · esta (DDL) larga uma tabela — o rollback **destrói dados**, e por isso
--     falha fechado enquanto houver uma única linha de proveniência;
--   · a 081 (funções) faz `CREATE OR REPLACE` — o rollback repõe as definições
--     anteriores e **não destrói nada**.
--
-- Fundidas numa só, reverter o comportamento das funções obrigaria a largar a
-- tabela, ou seja, a apagar o prestate dos movimentos adoptados. Seria preciso
-- destruir histórico para desfazer uma mudança de comportamento — exactamente o
-- risco que esta frente existe para fechar. Separadas, desfazer o comportamento
-- nunca apaga nada, e apagar a estrutura é um acto próprio, explícito e
-- guardado.
--
-- As duas reversões estão amarradas pela ordem, e não só por convenção: o
-- rollback da 080 recusa-se a correr enquanto as funções da 081 estiverem
-- instaladas, e o da 081 recusa-se enquanto houver proveniência registada. Ver
-- os dois ficheiros em `supabase/migrations/rollback/`.
--
--     F14B_MIGRATION_SPLIT = TWO
--     F14B_SPLIT_REASON = ROLLBACK_SEMANTICS_ARE_OPPOSITE
--     MIGRATION_DATA_WRITES = 0
--
-- ---------------------------------------------------------------------------
-- O que isto fecha
-- ---------------------------------------------------------------------------
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
-- Guarda-se o que não se deriva, e só isso. `status` fica de fora **por
-- invariante estrutural**, não por conveniência: `adopted_existing` só é
-- escrito no ramo em que o movimento está `pendente` — nos outros ramos não se
-- escreve proveniência nenhuma. Portanto «adoptado» implica «era pendente», e o
-- `unmark` deriva o estado em vez de o ler de uma cópia que podia divergir. A
-- regra não vive só neste comentário: há testes que tentam criar um registo de
-- adopção a partir de um movimento confirmado e exigem que não aconteça.
--
-- `prestate_expense_category_id` pode legitimamente ser NULL, e isso é
-- informação: o `origin` distingue «capturado, e era NULL» de «não capturado»,
-- porque sem registo nenhum não há `origin` nenhum.
--
-- ---------------------------------------------------------------------------
-- O que isto NÃO faz
-- ---------------------------------------------------------------------------
--
--  · não escreve uma única linha de dados — cria uma tabela vazia;
--  · não substitui função nenhuma. `mark_payment_paid` e `unmark_payment_paid`
--    continuam, depois desta migração, exactamente como a 079 as deixou: a
--    tabela fica lá, vazia e por consumir. É a 081 que as passa a usar. Até ela
--    correr, o comportamento observável do sistema não muda;
--  · não inventa proveniência para o histórico. Um movimento sem linha nesta
--    tabela fica **desconhecido**, e o `unmark` recusa-o. Não se adivinha o
--    passado, e não se apaga sobre uma dúvida;
--  · não toca no F14-A: o helper `assert_payment_cashflow_link` da 079
--    continua intacto e a valer para os dois caminhos;
--  · não implementa reversão de conciliação. Não existe mecanismo canónico de
--    reversal neste repositório, e inventar um a meio de uma correcção de
--    perda de dados seria trocar um risco por outro. Falha fechado.
-- ============================================================================

BEGIN;

-- ─── 1. A relação ───────────────────────────────────────────────────────────
--
-- Uma linha por movimento com origem conhecida. `cash_flow_entry_id` é a chave
-- primária: um movimento não pode ter duas proveniências, e a unicidade é
-- estrutural em vez de depender de um índice que alguém possa largar.
CREATE TABLE IF NOT EXISTS public.payment_cashflow_provenance (
  -- 🔴 `ON DELETE RESTRICT`, não `CASCADE`. A proveniência não pode
  --    desaparecer em silêncio por alguém ter apagado a linha que ela existe
  --    para proteger — seria reabrir o buraco por outro lado. Um movimento com
  --    proveniência registada só se apaga pelo `unmark`, que sabe o que está a
  --    fazer e limpa o registo primeiro. Foi um `CASCADE` mal colocado
  --    (`bank_reconciliation_matches`) que tornou o F14-B destrutivo.
  cash_flow_entry_id  uuid PRIMARY KEY
                        REFERENCES public.cash_flow_entries(id) ON DELETE RESTRICT,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  payment_id          uuid NOT NULL
                        REFERENCES public.fixed_variable_payments(id) ON DELETE RESTRICT,
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
    CHECK (origin <> 'adopted_existing' OR prestate_date IS NOT NULL),

  -- 🔴 O contrato do outro lado, explícito em vez de por omissão: um movimento
  --    criado pelo `mark` não tinha estado nenhum antes de existir, portanto
  --    não pode trazer prestate. Sem isto, uma linha `created_by_mark` com
  --    uma data lá dentro passaria — e ninguém saberia dizer o que ela
  --    significava.
  CONSTRAINT payment_cashflow_provenance_created_has_no_prestate
    CHECK (origin <> 'created_by_mark'
           OR (prestate_date IS NULL AND prestate_expense_category_id IS NULL))
);

-- 🔴 A identidade económica é 1:1. O `cash_flow_entry_id` já é chave primária,
--    portanto um movimento nunca tem duas proveniências. Falta o outro lado: um
--    pagamento não pode ter dois movimentos com proveniência. O índice único da
--    024 sobre `cash_flow_entries` já garante um movimento por pagamento, mas
--    é um índice **parcial** noutra tabela — depender dele daqui seria depender
--    de uma condição que esta tabela não controla.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_cashflow_provenance_payment
  ON public.payment_cashflow_provenance(company_id, payment_id);

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
--
-- 🔴 A identidade resolve-se por `public.get_my_company_id()`, não por
--    `profiles WHERE id = auth.uid()`. O rascunho desta migração é anterior à
--    separação entre pessoa e conta de acesso: desde essa frente, `profiles.id`
--    é um id gerado no servidor e a conta liga-se por `auth_user_id`. A forma
--    antiga casaria apenas com os perfis legados em que os dois ids coincidem e
--    devolveria **vazio** para qualquer colaborador criado depois — negando o
--    acesso em silêncio, que é o modo de falha que aquela frente eliminou nas
--    políticas todas. Escrever uma política nova na forma antiga seria
--    reintroduzir o defeito numa tabela nova.
DROP POLICY IF EXISTS payment_cashflow_provenance_select ON public.payment_cashflow_provenance;
CREATE POLICY payment_cashflow_provenance_select
  ON public.payment_cashflow_provenance FOR SELECT
  USING (company_id = public.get_my_company_id());

DROP POLICY IF EXISTS payment_cashflow_provenance_write ON public.payment_cashflow_provenance;
CREATE POLICY payment_cashflow_provenance_write
  ON public.payment_cashflow_provenance FOR ALL
  USING (company_id = public.get_my_company_id())
  WITH CHECK (company_id = public.get_my_company_id());

COMMIT;
