-- ============================================================
-- MIGRATION 015: Tornar o trigger handle_new_user resiliente
-- e garantir que a inserção de profiles funciona para admins
-- ============================================================

-- 1. Recriar o trigger com EXCEPTION handler para não bloquear
--    a criação do auth user se o INSERT no profile falhar
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_company_id UUID;
  v_role       TEXT;
  v_full_name  TEXT;
BEGIN
  v_company_id := (NEW.raw_user_meta_data->>'company_id')::UUID;
  v_role       := COALESCE(NEW.raw_user_meta_data->>'role', 'colaborador');
  v_full_name  := COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email);

  IF v_company_id IS NOT NULL THEN
    INSERT INTO public.profiles (id, company_id, full_name, email, role)
    VALUES (NEW.id, v_company_id, v_full_name, NEW.email, v_role)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Não bloquear criação do utilizador se o profile falhar.
    -- O server action fará upsert a seguir.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. Política de INSERT explícita para admins/gestores poderem
--    criar profiles de outros (necessário para createColaborador)
DROP POLICY IF EXISTS "profiles_insert_admin" ON profiles;

CREATE POLICY "profiles_insert_admin" ON profiles
  FOR INSERT WITH CHECK (
    -- O próprio utilizador pode inserir o seu próprio profile
    id = auth.uid()
    -- OU um admin/gestor da mesma empresa pode criar profiles
    OR (
      company_id = get_my_company_id()
      AND get_my_role() IN ('admin', 'gestor')
    )
  );

-- 3. Política de INSERT para o trigger (corre como postgres, bypassa RLS)
--    Garantir que o service_role também pode inserir
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
