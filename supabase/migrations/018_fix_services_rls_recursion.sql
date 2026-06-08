-- ============================================================
-- MIGRATION 018: Corrigir recursão infinita nas políticas de services
--
-- Problema:
--   Migration 014 criou novas políticas mas não apagou as originais
--   de migration 006 (nomes diferentes → DROP IF EXISTS não as apanhou).
--   Resultado: 5 políticas em services, incluindo "collaborators see
--   own services" que consulta service_reinforcements, cuja política
--   "company reinforcements" consulta services → ciclo infinito.
--
-- Solução:
--   1. Apagar as políticas antigas de 006 em services e service_reinforcements
--   2. Criar função SECURITY DEFINER para quebrar o ciclo em reinforcements
--   3. Recriar política de reinforcements sem referenciar services directamente
-- ============================================================

-- ── Apagar políticas antigas de migration 006 ────────────────────────────────

DROP POLICY IF EXISTS "managers see company services"    ON services;
DROP POLICY IF EXISTS "collaborators see own services"   ON services;
DROP POLICY IF EXISTS "company reinforcements"           ON service_reinforcements;
DROP POLICY IF EXISTS "managers see price audit"         ON service_price_audit;

-- ── Função SECURITY DEFINER para obter company_id de um serviço ──────────────
-- Necessária para evitar recursão: a política de service_reinforcements
-- não pode consultar services directamente (cria loop). Com SECURITY DEFINER
-- a função corre como superuser e bypassa o RLS.

CREATE OR REPLACE FUNCTION get_service_company_id(p_service_id UUID)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM services WHERE id = p_service_id LIMIT 1;
$$;

-- ── Recriar política de service_reinforcements sem referenciar services ───────

ALTER TABLE service_reinforcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reinforcements_select" ON service_reinforcements
  FOR SELECT USING (
    collaborator_id = auth.uid()
    OR get_service_company_id(service_id) = get_my_company_id()
  );

CREATE POLICY "reinforcements_manage" ON service_reinforcements
  FOR ALL USING (
    get_service_company_id(service_id) = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

-- ── Recriar política de service_price_audit ───────────────────────────────────

ALTER TABLE service_price_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "price_audit_manage" ON service_price_audit
  FOR ALL USING (
    get_service_company_id(service_id) = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );
