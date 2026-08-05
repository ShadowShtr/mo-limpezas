-- ============================================================================
-- 069 - Bloqueia escalada de role e mudança de company_id em public.profiles
-- ============================================================================
-- Achado (relatório de bloqueio de isolamento multiempresa, 2026-08-05):
-- a policy "profiles_update_own" (FOR UPDATE USING (id = auth.uid())) não
-- tinha WITH CHECK explícito. Regra do Postgres: sem WITH CHECK explícito,
-- o USING é reutilizado como CHECK — que só valida id = auth.uid(), nunca
-- verificado contra o valor ANTERIOR das colunas company_id/role. Qualquer
-- conta autenticada, mesmo a de menor privilégio, podia fazer
-- UPDATE profiles SET company_id = <outra empresa>, role = 'admin'
-- WHERE id = auth.uid() e passar — porque `id` não muda, e é a única
-- coisa verificada. Isto é auto-promoção a admin em qualquer empresa cujo
-- UUID o atacante conheça, incluindo a empresa real em produção.
--
-- RLS (USING/WITH CHECK) não tem acesso ao valor OLD da linha — só a
-- proteção autoritativa contra "mudou desde antes" pode vir de um
-- trigger, que tem OLD e NEW. Por isso este ficheiro faz as duas coisas:
--   1. Recria profiles_update_own com WITH CHECK explícito (reforço, não
--      suficiente sozinho);
--   2. Cria um trigger BEFORE UPDATE que é a proteção real.
--
-- Invariantes exigidas (decisão do dono, 2026-08-05):
--   1. authenticated comum nunca muda a própria company_id;
--   2. admin/gestor autenticado TAMBÉM nunca move profiles entre
--      empresas — só um contexto service_role explícito pode;
--   3. troca de role: aceite em contexto service_role, ou quando o ator é
--      admin/gestor da MESMA empresa da linha (e a empresa não mudou);
--   4. colaborador nunca muda o próprio role;
--   5. updateColaborador (server-side, service_role, já validou o
--      chamador antes) continua a funcionar sem alteração;
--   6. updates não sensíveis (full_name, phone, etc.) continuam livres.
--
-- Deteção de service_role: auth.role() lê o claim "role" do JWT
-- (request.jwt.claims), não current_user/session_user — current_user não
-- é fiável aqui (liga sempre pelo mesmo utilizador de pool em alguns
-- setups) e não reflete a chave (anon/authenticated/service_role) com
-- que o pedido chegou à API. auth.role() já existe neste projeto Supabase
-- (schema auth, padrão da plataforma) e é o mesmo mecanismo usado nas
-- policies RLS existentes no resto do schema.
--
-- SECURITY DEFINER não é necessário aqui: a função do trigger só lê
-- auth.role() (SQL puro, sem RLS) e chama get_my_company_id()/
-- get_my_role() (já SECURITY DEFINER, definidas em 014), que já fazem o
-- bypass de RLS necessário para ler o profile do próprio ator. A função
-- do trigger em si corre com os privilégios de quem dispara o UPDATE
-- (SECURITY INVOKER, omitido = padrão), sem elevar nada.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_guard_profile_tenant_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A. company_id: só um contexto service_role explícito pode mudar.
  --    Nem colaborador, nem gestor, nem admin autenticado via JWT normal.
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'PROFILE_COMPANY_CHANGE_BLOCKED: mudanca de company_id so e permitida em contexto service_role'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- B. role: service_role sempre pode. Caso contrário, só admin/gestor
  --    da MESMA empresa da linha original — e só se a empresa continuar
  --    a mesma (redundante com A acima, mantido explícito por clareza e
  --    para não depender da ordem dos blocos).
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
      IF NOT (
        public.get_my_role() IN ('admin', 'gestor')
        AND public.get_my_company_id() = OLD.company_id
        AND NEW.company_id = OLD.company_id
      ) THEN
        RAISE EXCEPTION 'PROFILE_ROLE_ESCALATION_BLOCKED: mudanca de role exige admin/gestor da propria empresa (ou contexto service_role)'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_tenant_role ON public.profiles;
CREATE TRIGGER trg_guard_profile_tenant_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_profile_tenant_role();

-- Reforço na policy (não suficiente sozinho — ver comentário acima; o
-- trigger é a proteção autoritativa porque a policy não vê OLD).
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND company_id = public.get_my_company_id()
  );

-- Fora do escopo desta migration, registado como pendência sem
-- investigação (instrução do dono, 2026-08-05): outras colunas sensíveis
-- de profiles (vacation_balance, hourly_rate, status,
-- contracted_hours_month e semelhantes) não têm guarda equivalente
-- contra auto-edição. Não avaliado aqui.

-- Verificação esperada depois de aplicar:
-- 1. Colaborador autenticado: UPDATE profiles SET role='admin' WHERE id=auth.uid()
--    → PROFILE_ROLE_ESCALATION_BLOCKED.
-- 2. Colaborador autenticado: UPDATE profiles SET company_id=<outra> WHERE id=auth.uid()
--    → PROFILE_COMPANY_CHANGE_BLOCKED.
-- 3. Colaborador autenticado: UPDATE profiles SET full_name='X' WHERE id=auth.uid()
--    → sucede.
-- 4. Admin da empresa A: UPDATE profiles SET role='gestor' WHERE id=<colega da empresa A>
--    → sucede.
-- 5. Admin da empresa A: UPDATE profiles SET company_id=<empresa B> WHERE id=<qualquer>
--    → PROFILE_COMPANY_CHANGE_BLOCKED (mesmo sendo admin).
-- 6. service_role (fluxo updateColaborador): UPDATE profiles SET role=... WHERE id=...
--    → sucede sem alteração de comportamento.
