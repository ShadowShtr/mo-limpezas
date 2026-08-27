-- ============================================================================
-- ROLLBACK PROVISIONAL — políticas de profiles voltam ao auth.uid() (PHASE C)
-- ============================================================================
--
-- 🔴 NÃO APLICADO. Repõe `profiles_select` e `profiles_update_own` na forma
--    que a 014 e a 069 deixaram.
--
-- Não leva guarda, e é deliberado: recriar uma política não perde dados, e as
-- duas formas decidem exactamente o mesmo enquanto cada perfil tiver uma conta
-- — que é o que o backfill do EXPAND garante.
--
-- 🔴 Se já existirem pessoas **sem** conta, este rollback continua a correr,
--    mas o significado muda: essas pessoas deixam de conseguir ver o próprio
--    perfil por `id = auth.uid()`, porque não têm sessão nenhuma. Não é perda
--    de dados nem falha de isolamento — é a consequência de voltar a um modelo
--    onde elas não podiam existir. Quem reverter isto deve reverter também o
--    EXPAND, e esse tem guarda.
-- ============================================================================

BEGIN;

-- ─── get_my_company_id() e get_my_role() — a forma da 014 ───────────────────
--
-- 🔴 Reverter isto reabre o buraco que a PHASE C fechou: um token forjado com
--    o `id` de uma pessoa sem conta volta a devolver a empresa dela, e com ela
--    a leitura de todos os colegas.
--
--    Só é aceitável reverter em conjunto com o EXPAND — sem ele não existem
--    pessoas sem conta, e as duas formas voltam a ser equivalentes. O rollback
--    do EXPAND tem a guarda que o garante.
CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1;
$$;

-- ─── profiles_select — a forma da 014 ───────────────────────────────────────
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (
    id = auth.uid()                          -- o próprio utilizador
    OR company_id = get_my_company_id()      -- colegas da mesma empresa
  );

-- ─── profiles_update_own — a forma da 069 ───────────────────────────────────
--
-- Com o `WITH CHECK` explícito, que é a razão de ser da 069. Reverter para a
-- forma da 014 — sem `WITH CHECK` — reabriria a escalada de privilégios.
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND company_id = public.get_my_company_id()
  );

COMMIT;
