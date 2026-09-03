-- ============================================================================
-- PRESTATE FINANCEIRO CANÓNICO — o overlay do shadow, num sítio só
-- ============================================================================
--
-- 🔴 Porque é que este ficheiro existe, e o que ele admite.
--
--    `fixtures/production-schema-shape.sql` é um dump READ-ONLY da forma real
--    de produção, e traz TABELAS, COLUNAS, CHAVES PRIMÁRIAS E ESTRANGEIRAS,
--    RLS e POLÍTICAS. Não traz:
--
--      · constraints CHECK;
--      · índices (únicos ou não);
--      · funções;
--      · tabelas criadas depois da leitura que o gerou.
--
--    Chamar-lhe «paridade com produção» sem dizer isto seria uma afirmação
--    falsa: a stack 090..097 depende de várias dessas coisas, e sem elas as
--    precondições recusam — com razão. O que faltava era o palco, não a
--    migration.
--
--    Este ficheiro é esse palco. Uma fonte só, versionada, em vez de `ALTER
--    TABLE` espalhados por cada suite — que foi como isto começou, e é assim
--    que duas suites acabam a ensaiar mundos diferentes sem ninguém dar por
--    isso.
--
-- ---------------------------------------------------------------------------
-- O contrato deste ficheiro
-- ---------------------------------------------------------------------------
--
--    PRODUCTION_SHADOW_BASE_SCOPE
--      = tabelas + colunas + PK/FK + RLS + políticas
--        (de `production-schema-shape.sql`, leitura read-only da base real)
--
--    PRODUCTION_SHADOW_OVERLAY
--      = este ficheiro: constraints, índices e tabelas pós-dump de que a
--        stack 090..097 depende, cada um com a migration de origem nomeada
--
--    Tudo o que aqui está TEM de existir em produção. Cada bloco nomeia a
--    migration que o criou, e cada um foi VERIFICADO por leitura read-only da
--    base real em 2026-09-03. Um bloco que não passe nessa verificação é um
--    bloco que este ficheiro inventou — e aí o ensaio deixa de valer.
--
--    Verificado nessa leitura, e a bater:
--      financial_periods_unique       UNIQUE (company_id, year, month)
--      cash_flow_entries_reference_unique  índice parcial, como abaixo
--      cash_flow_entries_reference_type_check  com 'manual_charge' na lista
--      uq_bank_match_pair             (bank_transaction_id, cash_flow_entry_id)
--      payment_cashflow_provenance    presente
--      is_financial_period_open       (uuid, integer, integer)
--
--    PAYROLL_UNIQUE_EFFECT = PRESENT: leitura read-only confirmou em produção
--    a constraint abaixo. A origem/migration que a criou continua UNKNOWN;
--    o overlay apenas reproduz o prestate observado.
-- ============================================================================

-- ─── 024 / 075 — a identidade única dos movimentos com origem ───────────────
--
-- O índice é PARCIAL, e é isso que obriga cada `ON CONFLICT` a repetir a
-- condição para o Postgres o inferir como árbitro. Sem ele, todas as RPCs que
-- reutilizam um movimento falham com 42P10.
ALTER TABLE public.cash_flow_entries
  DROP CONSTRAINT IF EXISTS cash_flow_entries_reference_type_check;
--
-- 🔴 `manual_charge` faz parte da lista, e não fazia quando este overlay foi
--    escrito. Uma leitura read-only de produção (2026-09-03) devolveu:
--
--      CHECK (reference_type IS NULL OR reference_type = ANY (ARRAY[
--        'invoice', 'payroll', 'service_payment', 'fixed_variable_payment',
--        'manual_charge']))
--
--    A 086 acrescentou-o. O overlay tinha ficado na versão da 075 — e um
--    prestate que descreve um passado é um ensaio que responde a outra
--    pergunta: os movimentos das cobranças avulsas seriam recusados aqui e
--    passariam lá.
ALTER TABLE public.cash_flow_entries
  ADD CONSTRAINT cash_flow_entries_reference_type_check
  CHECK (
    reference_type IS NULL
    OR reference_type IN ('invoice', 'payroll', 'service_payment',
                          'fixed_variable_payment', 'manual_charge')
  );

CREATE UNIQUE INDEX IF NOT EXISTS cash_flow_entries_reference_unique
  ON public.cash_flow_entries (company_id, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

-- ─── 071 — o UNIQUE de `financial_periods` ──────────────────────────────────
--
-- É o árbitro do `ON CONFLICT` de `close_financial_period_atomic`. Sem ele:
-- «there is no unique or exclusion constraint matching the ON CONFLICT
-- specification».
ALTER TABLE public.financial_periods
  DROP CONSTRAINT IF EXISTS financial_periods_unique;
ALTER TABLE public.financial_periods
  ADD CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month);

-- ─── 043 — o par único da conciliação ───────────────────────────────────────
--
-- Árbitro do `ON CONFLICT` de `manual_bank_match_atomic` (095).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_match_pair
  ON public.bank_reconciliation_matches (bank_transaction_id, cash_flow_entry_id);

-- ─── 080 — a proveniência dos movimentos de pagamento ───────────────────────
--
-- 🔴 Criada DEPOIS da leitura que gerou o dump da forma, e por isso ausente
--    dele. A 092 exige-a como precondição, e com razão: é ela que separa «este
--    movimento foi criado pelo mark» de «este movimento já cá estava», e é
--    dessa distinção que depende o `unmark` não apagar histórico alheio.
--
--    `ON DELETE RESTRICT` e não `CASCADE`, tal como a 080 a define: a
--    proveniência não pode desaparecer em silêncio por alguém ter apagado a
--    linha que ela existe para proteger.
CREATE TABLE IF NOT EXISTS public.payment_cashflow_provenance (
  cash_flow_entry_id  uuid PRIMARY KEY
                        REFERENCES public.cash_flow_entries(id) ON DELETE RESTRICT,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  payment_id          uuid NOT NULL
                        REFERENCES public.fixed_variable_payments(id) ON DELETE RESTRICT,
  origin              text NOT NULL
                        CHECK (origin IN ('created_by_mark', 'adopted_existing')),
  prestate_date                date,
  prestate_expense_category_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_cashflow_provenance_adopted_needs_prestate
    CHECK (origin <> 'adopted_existing' OR prestate_date IS NOT NULL),
  CONSTRAINT payment_cashflow_provenance_created_has_no_prestate
    CHECK (origin <> 'created_by_mark'
           OR (prestate_date IS NULL AND prestate_expense_category_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_cashflow_provenance_payment
  ON public.payment_cashflow_provenance(company_id, payment_id);

ALTER TABLE public.payment_cashflow_provenance ENABLE ROW LEVEL SECURITY;

-- ─── 008 — o CHECK do mês nas tabelas de competência ────────────────────────
--
-- `period_month BETWEEN 1 AND 12`. O protocolo recusa meses fora do intervalo
-- antes de chegar à tabela, mas a garantia é da tabela — e uma invariante que
-- só vive noutro sítio deixa de valer quando esse sítio muda.
DO $$
BEGIN
  ALTER TABLE public.payroll_records
    ADD CONSTRAINT payroll_records_period_month_check
    CHECK (period_month BETWEEN 1 AND 12);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE public.payroll_records
  ADD CONSTRAINT payroll_records_company_id_collaborator_id_period_year_period_month_key
  UNIQUE (company_id, collaborator_id, period_year, period_month);
