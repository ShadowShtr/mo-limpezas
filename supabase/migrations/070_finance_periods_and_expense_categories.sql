-- ============================================================================
-- 070 — Fechamento mensal, categorias de despesa e identidade de origem
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Preparada para revisão.
--
-- Suporta três das cinco mecânicas pedidas pela gestão. As outras duas —
-- despesas por categoria e histórico do cliente — **não precisam de migration
-- nenhuma**: `cash_flow_entries.category` e as faturas já existem, e já estão
-- ligadas ao Financeiro V2.
--
-- ---------------------------------------------------------------------------
-- Auditoria feita antes de escrever isto
-- ---------------------------------------------------------------------------
--
--   cash_flow_entries.category                  ✅ existe (fornecedor,
--                                                  despesa, salario, outro)
--   cash_flow_entries.reference_type/_id        ✅ existe, já usado com
--                                                  'service_payment'
--   fixed_variable_payments.paid_at / status    ✅ existem
--   fixed_variable_payments  categoria          ❌ não existe
--   expense_categories                          ❌ não existe
--   financial_periods                           ❌ não existe
--   UNIQUE(company, reference_type, reference_id) ❌ não existe
--
-- A última é a mais importante: é o que torna «marcar como pago» idempotente
-- **na base**, e não apenas na aplicação. Um duplo clique, um retry de rede ou
-- dois separadores abertos deixam de conseguir criar duas saídas para o mesmo
-- pagamento — a base recusa a segunda.
-- ============================================================================

BEGIN;

-- ─── 1. Categorias de despesa, por empresa ──────────────────────────────────
--
-- Configuráveis de propósito. Um enum no código obrigaria a um deploy para
-- acrescentar "Portagens" ou "Uniformes", e a lista de categorias de uma
-- empresa de limpeza muda mais depressa do que o software.

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Guardado normalizado para o UNIQUE não deixar entrar "Combustível" e
  -- "combustivel" como categorias diferentes.
  normalized_name text NOT NULL,
  color_token  text,
  icon         text,
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_categories_unique_per_company UNIQUE (company_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_expense_categories_company
  ON public.expense_categories (company_id, active, sort_order);

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY expense_categories_read ON public.expense_categories
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid())
  );

CREATE POLICY expense_categories_write ON public.expense_categories
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'gestor')
    )
  );

-- ─── 2. Categoria nas despesas e nos pagamentos fixos ───────────────────────
--
-- 🔴 Nullable, e assim fica.
--
-- As 444 linhas de caixa que já existem não têm categoria estruturada, e
-- **não se adivinha**: inferir "Galp" → combustível por texto seria fabricar
-- contabilidade a partir de descrições escritas à pressa. Ficam a `null`, a
-- interface mostra «Sem categoria» e há um alerta a contá-las.
--
-- A obrigatoriedade para despesas **novas** é validada na aplicação, não por
-- NOT NULL — um NOT NULL aqui obrigaria a inventar categoria para o histórico.

ALTER TABLE public.cash_flow_entries
  ADD COLUMN IF NOT EXISTS expense_category_id uuid
  REFERENCES public.expense_categories(id) ON DELETE SET NULL;

ALTER TABLE public.fixed_variable_payments
  ADD COLUMN IF NOT EXISTS expense_category_id uuid
  REFERENCES public.expense_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_flow_category
  ON public.cash_flow_entries (company_id, expense_category_id, date);

-- ─── 3. 🔴 Idempotência de origem ───────────────────────────────────────────
--
-- Uma ocorrência económica, um movimento. Marcar um pagamento como pago cria
-- **uma** saída de caixa; clicar outra vez não cria a segunda.
--
-- A garantia é da base, não da aplicação. Uma verificação em JavaScript perde
-- a corrida contra dois pedidos concorrentes — este índice não perde.
--
-- Parcial de propósito: `reference_type IS NULL` em 439 das 444 linhas
-- actuais, e um UNIQUE total rejeitaria a segunda despesa manual sem origem.

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_flow_origin
  ON public.cash_flow_entries (company_id, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

-- ─── 4. Fechamento mensal ───────────────────────────────────────────────────
--
-- Estado + auditoria, e mais nada. **Não** é uma cópia dos números para uma
-- tabela paralela: um snapshot cego duplicaria a verdade e as duas cópias
-- divergiriam à primeira correcção retroactiva.

CREATE TABLE IF NOT EXISTS public.financial_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year          smallint NOT NULL,
  month         smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES public.profiles(id),
  reopened_at   timestamptz,
  reopened_by   uuid REFERENCES public.profiles(id),
  -- Reabrir um mês fechado exige motivo. Sem ele não se sabe, seis meses
  -- depois, porque é que os números de Agosto mudaram.
  reopen_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month),
  CONSTRAINT financial_periods_reopen_needs_reason
    CHECK (reopened_at IS NULL OR (reopen_reason IS NOT NULL AND length(trim(reopen_reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_financial_periods_lookup
  ON public.financial_periods (company_id, year, month, status);

ALTER TABLE public.financial_periods ENABLE ROW LEVEL SECURITY;

-- Leitura company-wide: o dashboard mostra o estado do mês a quem o abre.
CREATE POLICY financial_periods_read ON public.financial_periods
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid())
  );

-- Fechar e reabrir são actos de gestão.
CREATE POLICY financial_periods_write ON public.financial_periods
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'gestor')
    )
  );

COMMIT;

-- ============================================================================
-- O que esta migration NÃO faz, de propósito
-- ============================================================================
--
--  · não classifica retroactivamente nenhuma das 444 despesas existentes;
--  · não fecha nenhum período — todos nascem abertos por ausência de linha;
--  · não semeia categorias: a lista inicial é decisão da empresa, e um seed
--    imposto criaria categorias que ninguém pediu e que depois ninguém apaga;
--  · não toca em `due_date` nem em `source_id`;
--  · não altera `fixed_variable_payments` além da coluna nova.
-- ============================================================================
