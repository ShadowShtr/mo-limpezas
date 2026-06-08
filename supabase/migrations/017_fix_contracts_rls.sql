-- ============================================================
-- MIGRATION 017: Fix RLS de contracts
-- A migração 014 corrigiu outras tabelas mas esqueceu contracts.
-- A policy original usava subquery recursiva em profiles.
-- Solução: usar get_my_company_id() e get_my_role() como as restantes tabelas.
-- ============================================================

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company contracts"              ON contracts;
DROP POLICY IF EXISTS "colaboradores see own contracts" ON contracts;

CREATE POLICY "contracts_select" ON contracts
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY "contracts_manage" ON contracts
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );
