-- ============================================================================
-- 070 - Protege os campos laborais e administrativos de public.profiles
-- ============================================================================
-- Task T04 do plano mestre (docs/PLANO-MESTRE.md, secção 25).
--
-- A migration 069 fechou `company_id` e `role`, e deixou registada, no próprio
-- ficheiro, a pendência que esta resolve:
--
--   "outras colunas sensíveis de profiles (vacation_balance, hourly_rate,
--    status, contracted_hours_month e semelhantes) não têm guarda equivalente
--    contra auto-edição."
--
-- O problema: a policy `profiles_update_own` permite `UPDATE ... WHERE
-- id = auth.uid()`. Sem esta guarda, qualquer conta autenticada podia fazer,
-- diretamente contra a API do Supabase e sem passar por nenhuma Server Action:
--
--   UPDATE profiles SET hourly_rate = 999, vacation_balance = 365,
--                       contracted_hours_month = 1, status = 'ativo'
--   WHERE id = auth.uid();
--
-- Isto é alteração unilateral das próprias condições de trabalho: o valor/hora
-- entra direto no cálculo da folha de pagamento, e o saldo de férias e o
-- estado entram nos fluxos de ausências e de escala.
--
-- Tal como na 069, RLS não serve aqui: USING/WITH CHECK não têm acesso ao
-- valor OLD da linha, e por isso não conseguem exprimir "esta coluna mudou".
-- Só um trigger BEFORE UPDATE, que vê OLD e NEW, é proteção autoritativa.
--
-- Esta migration NÃO altera a 069 nem a sua função: cria função e trigger
-- próprios. Duas razões — a 069 continua reversível de forma independente, e o
-- rollback desta resume-se a dois DROP (ver no fim do ficheiro).
--
-- ---------------------------------------------------------------------------
-- Classificação dos campos (inventário do schema real, não dos tipos)
-- ---------------------------------------------------------------------------
--
-- GERIDOS - só service_role, ou admin/gestor da mesma empresa:
--   hourly_rate              entra direto no cálculo da folha
--   contracted_hours_month   base das horas contratadas e do absentismo
--   contract_start           datas contratuais
--   contract_end
--   vacation_balance         saldo de férias
--   status                   ativo/inativo/suspenso — controla acesso e escala
--   skills                   determina a que serviços a pessoa é atribuída
--   invited_at               estado do processo de convite
--   invite_accepted_at
--
-- JÁ PROTEGIDOS pela 069 (não repetidos aqui, para não haver duas fontes):
--   company_id, role
--
-- PESSOAIS - continuam livres para o próprio, como antes:
--   full_name, phone, email, nif, iban, avatar_url, availability
--
--   `availability` fica de fora deliberadamente: é disponibilidade semanal
--   declarada, não uma condição contratual, e é o único campo desta lista com
--   uma leitura plausível de auto-serviço. Nenhum fluxo o escreve hoje.
--
--   `nif` e `iban` são dados pessoais do próprio e ficam livres, mas são
--   auditados em `updateColaborador` por serem sensíveis.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade com os fluxos existentes
-- ---------------------------------------------------------------------------
--
-- Inventário feito antes de escrever esta migration: TODAS as escritas em
-- `profiles` no código passam por `createAdminClient()` (service role) —
-- `createColaborador`, `updateColaborador`, `updateVacationBalance` e
-- `csv-import`. Não existe, hoje, nenhum caminho de auto-edição de perfil na
-- aplicação: a única utilização client-side de `profiles` é uma leitura no
-- modal de alocação de equipas.
--
-- Consequência: esta guarda não bloqueia nenhum fluxo existente. Fecha um
-- caminho que só era alcançável por chamada direta à API.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_guard_profile_managed_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_changed text[] := ARRAY[]::text[];
BEGIN
  -- Curto-circuito: service_role é o contexto dos fluxos administrativos
  -- server-side, que já validaram o chamador antes de escrever.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate THEN
    v_changed := v_changed || 'hourly_rate';
  END IF;

  IF NEW.contracted_hours_month IS DISTINCT FROM OLD.contracted_hours_month THEN
    v_changed := v_changed || 'contracted_hours_month';
  END IF;

  IF NEW.contract_start IS DISTINCT FROM OLD.contract_start THEN
    v_changed := v_changed || 'contract_start';
  END IF;

  IF NEW.contract_end IS DISTINCT FROM OLD.contract_end THEN
    v_changed := v_changed || 'contract_end';
  END IF;

  IF NEW.vacation_balance IS DISTINCT FROM OLD.vacation_balance THEN
    v_changed := v_changed || 'vacation_balance';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changed := v_changed || 'status';
  END IF;

  IF NEW.skills IS DISTINCT FROM OLD.skills THEN
    v_changed := v_changed || 'skills';
  END IF;

  IF NEW.invited_at IS DISTINCT FROM OLD.invited_at THEN
    v_changed := v_changed || 'invited_at';
  END IF;

  IF NEW.invite_accepted_at IS DISTINCT FROM OLD.invite_accepted_at THEN
    v_changed := v_changed || 'invite_accepted_at';
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- Admin/gestor da MESMA empresa da linha original pode gerir estes campos.
  -- A empresa tem de continuar a mesma: mover a linha entre empresas já é
  -- bloqueado pela 069, e aqui não se abre uma segunda porta para isso.
  IF NOT (
    public.get_my_role() IN ('admin', 'gestor')
    AND public.get_my_company_id() = OLD.company_id
    AND NEW.company_id = OLD.company_id
  ) THEN
    RAISE EXCEPTION
      'PROFILE_MANAGED_FIELD_BLOCKED: alteracao de campos laborais/administrativos (%) exige admin/gestor da propria empresa (ou contexto service_role)',
      array_to_string(v_changed, ', ')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_managed_fields ON public.profiles;
CREATE TRIGGER trg_guard_profile_managed_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_profile_managed_fields();

COMMENT ON FUNCTION public.fn_guard_profile_managed_fields() IS
  'Task T04: impede que um utilizador autenticado altere os proprios campos laborais/administrativos de profiles por acesso direto a API. Complementa 069 (company_id/role).';

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- Reverter esta migration não deixa resíduo e não toca em 069:
--
--   DROP TRIGGER IF EXISTS trg_guard_profile_managed_fields ON public.profiles;
--   DROP FUNCTION IF EXISTS public.fn_guard_profile_managed_fields();
--
-- Nenhuma coluna é criada, alterada ou apagada; nenhum dado é escrito. O
-- rollback repõe exatamente o comportamento anterior.
-- ============================================================================

-- ============================================================================
-- VERIFICAÇÃO ESPERADA DEPOIS DE APLICAR
-- ============================================================================
-- Executável contra uma base descartável por:
--   node scripts/verify-profile-guards.mjs --database-url <url-descartavel>
--
-- 1. colaborador: UPDATE profiles SET hourly_rate = 999 WHERE id = auth.uid()
--    → PROFILE_MANAGED_FIELD_BLOCKED
-- 2. colaborador: UPDATE profiles SET vacation_balance = 365 WHERE id = auth.uid()
--    → PROFILE_MANAGED_FIELD_BLOCKED
-- 3. colaborador: UPDATE profiles SET status = 'ativo' WHERE id = auth.uid()
--    → PROFILE_MANAGED_FIELD_BLOCKED
-- 4. colaborador: UPDATE profiles SET full_name = 'X' WHERE id = auth.uid()
--    → sucede (campo pessoal)
-- 5. admin da empresa A: UPDATE profiles SET hourly_rate = 9 WHERE id = <colega A>
--    → sucede
-- 6. admin da empresa A: UPDATE profiles SET hourly_rate = 9 WHERE id = <alguem da empresa B>
--    → PROFILE_MANAGED_FIELD_BLOCKED (isolamento entre empresas)
-- 7. service_role (updateColaborador): UPDATE profiles SET hourly_rate = ...
--    → sucede, sem alteração de comportamento
-- ============================================================================
