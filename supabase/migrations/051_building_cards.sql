-- ============================================================
-- MIGRATION 051: Coluna "Prédios" no calendário
-- Tabela: building_cards
--
-- Coluna independente do calendário, sem horários, sempre a última.
-- Cada card é um prédio (nome + morada em texto livre, sem depender de
-- clients/locations) recorrente num dia da semana fixo, com uma equipa
-- atribuída (só etiqueta — nunca gera services). A ordem dentro do dia
-- é global (sort_order); filtrar por equipa preserva a ordem relativa.
-- ============================================================

CREATE TABLE IF NOT EXISTS building_cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  weekday       TEXT NOT NULL CHECK (weekday IN ('mon','tue','wed','thu','fri','sat','sun')),
  name          TEXT NOT NULL,
  address       TEXT,
  team_id       UUID REFERENCES teams(id) ON DELETE SET NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  monthly_value NUMERIC,
  notes         TEXT,
  created_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS building_cards_company_weekday_order_idx
  ON building_cards (company_id, weekday, sort_order);

-- ── updated_at trigger (função criada na migration 016) ─────────────────────────
DROP TRIGGER IF EXISTS building_cards_updated_at ON building_cards;
CREATE TRIGGER building_cards_updated_at
  BEFORE UPDATE ON building_cards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ─────────────────────────────────────────────────────────────────────────
ALTER TABLE building_cards ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro da empresa (a colaboradora vê os prédios da sua equipa
-- na app móvel, filtrados no código, não na policy).
DROP POLICY IF EXISTS building_cards_company_isolation ON building_cards;
CREATE POLICY building_cards_company_isolation ON building_cards
  USING (company_id IN (
    SELECT company_id FROM profiles WHERE id = auth.uid()
  ));

-- Escrita: apenas admin/gestor da empresa
DROP POLICY IF EXISTS building_cards_insert ON building_cards;
CREATE POLICY building_cards_insert ON building_cards FOR INSERT
  WITH CHECK (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

DROP POLICY IF EXISTS building_cards_update ON building_cards;
CREATE POLICY building_cards_update ON building_cards FOR UPDATE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

DROP POLICY IF EXISTS building_cards_delete ON building_cards;
CREATE POLICY building_cards_delete ON building_cards FOR DELETE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));
