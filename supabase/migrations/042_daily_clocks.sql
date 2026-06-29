-- 042 — Ponto geral diário (entrada/saída + almoço)
-- O que conta para a folha é o ponto GERAL (entrada→saída). Os pontos por
-- serviço (timesheets) passam a ser apenas informativos. O almoço é registado
-- mas NÃO é descontado (decisão do dono).
-- Uma linha por colaboradora por dia.

CREATE TABLE IF NOT EXISTS daily_clocks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
  work_date       DATE NOT NULL,
  clock_in_at     TIMESTAMPTZ,
  clock_out_at    TIMESTAMPTZ,
  lunch_start_at  TIMESTAMPTZ,
  lunch_end_at    TIMESTAMPTZ,
  clock_in_lat    DOUBLE PRECISION,
  clock_in_lng    DOUBLE PRECISION,
  clock_out_lat   DOUBLE PRECISION,
  clock_out_lng   DOUBLE PRECISION,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company_id, collaborator_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_clocks_company_date
  ON daily_clocks (company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_daily_clocks_collab_date
  ON daily_clocks (collaborator_id, work_date);

ALTER TABLE daily_clocks ENABLE ROW LEVEL SECURITY;

-- Colaboradora gere o seu próprio ponto.
DO $$ BEGIN
  CREATE POLICY daily_clocks_own ON daily_clocks
    FOR ALL
    USING (collaborator_id = auth.uid())
    WITH CHECK (collaborator_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Gestores/admin veem o ponto de toda a empresa.
DO $$ BEGIN
  CREATE POLICY daily_clocks_manager_select ON daily_clocks
    FOR SELECT
    USING (company_id = get_my_company_id() AND get_my_role() IN ('admin', 'gestor'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
