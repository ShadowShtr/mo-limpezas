-- 034_rls_servicos_clientes_locais.sql
-- RLS preciso por serviço: colaboradora só vê o que é dela.
-- Resolve TODO 01 (DB layer), 02, 03, 07, 08.

-- ─── 1. Helper SECURITY DEFINER ───────────────────────────────────────────────
-- Verifica se o utilizador atual pode aceder ao serviço.
-- SECURITY DEFINER evita recursão RLS quando policies invocam esta função.
CREATE OR REPLACE FUNCTION can_access_service(p_service_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   services s
    INNER  JOIN profiles p ON p.id = auth.uid() AND p.company_id = s.company_id
    WHERE  s.id = p_service_id
    AND (
      -- Membro ativo da equipa do serviço
      EXISTS (
        SELECT 1 FROM team_members tm
        WHERE  tm.team_id       = s.team_id
        AND    tm.collaborator_id = auth.uid()
        AND   (tm.left_at IS NULL OR tm.left_at > NOW())
      )
      -- Ou reforço designado para este serviço
      OR EXISTS (
        SELECT 1 FROM service_reinforcements sr
        WHERE  sr.service_id     = s.id
        AND    sr.collaborator_id = auth.uid()
      )
    )
  )
$$;

-- ─── 2. services RLS ──────────────────────────────────────────────────────────
-- Antes: "services_select" (todos da empresa) + "services_collaborator_view"
-- (junção redundante). Resultado: qualquer colaboradora via qualquer serviço.
DROP POLICY IF EXISTS "services_select"           ON services;
DROP POLICY IF EXISTS "services_collaborator_view" ON services;

-- Admin/gestor: já têm acesso via "services_manage" (FOR ALL, inclui SELECT).
-- Colaboradoras: apenas serviços atribuídos.
CREATE POLICY "services_collaborator_select" ON services
  FOR SELECT
  USING (can_access_service(id));

-- ─── 3. clients RLS ───────────────────────────────────────────────────────────
-- Antes: "clients_select" (todos da empresa sem restrição de role).
-- Admin/gestor: já têm acesso via "clients_manage" (FOR ALL).
DROP POLICY IF EXISTS "clients_select" ON clients;

CREATE POLICY "clients_collaborator_select" ON clients
  FOR SELECT
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) NOT IN ('admin', 'gestor')
    AND EXISTS (
      SELECT 1
      FROM   locations l
      INNER  JOIN services s ON s.location_id = l.id
      WHERE  l.client_id = clients.id
      AND    can_access_service(s.id)
    )
  );

-- ─── 4. locations RLS ─────────────────────────────────────────────────────────
-- Antes: "locations_select" (todos da empresa).
-- Admin/gestor: já têm acesso via "locations_manage" (FOR ALL).
DROP POLICY IF EXISTS "locations_select" ON locations;

CREATE POLICY "locations_collaborator_select" ON locations
  FOR SELECT
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) NOT IN ('admin', 'gestor')
    AND EXISTS (
      SELECT 1 FROM services s
      WHERE  s.location_id = locations.id
      AND    can_access_service(s.id)
    )
  );

-- ─── 5. service_photos.collaborator_id — corrigir NOT NULL + ON DELETE SET NULL ─
-- A migration 027 definiu a FK como ON DELETE SET NULL mas a coluna como NOT NULL,
-- o que é uma contradição: o SET NULL nunca poderia executar sem violar o NOT NULL.
ALTER TABLE service_photos
  ALTER COLUMN collaborator_id DROP NOT NULL;

-- ─── 6. background_jobs — remover policy aberta ───────────────────────────────
-- USING (true) WITH CHECK (true) permite a qualquer utilizador autenticado
-- escrever em background_jobs. As escritas são feitas exclusivamente pelo
-- service role (admin client), que contorna RLS — a policy é desnecessária.
DROP POLICY IF EXISTS "background_jobs_service_write" ON background_jobs;
