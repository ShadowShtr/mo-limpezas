-- ============================================================================
-- PROVISIONAL — identidade: as políticas passam a usar o resolver (PHASE C)
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Vive em `supabase/migrations/draft/`, que o runner não lê.
--    Depende do EXPAND (PHASE A), que tem de correr primeiro.
--
--    MIGRATION_NUMBER_FINAL = UNASSIGNED
--
-- ---------------------------------------------------------------------------
-- O que muda, e porquê só isto
-- ---------------------------------------------------------------------------
--
-- Depois do EXPAND, `profiles.id` deixou de ser necessariamente o id de uma
-- conta: uma pessoa pode existir sem login. Todas as políticas que dizem
-- `id = auth.uid()` continuam **correctas** — o backfill mantém as duas
-- leituras equivalentes para quem já existe — mas deixam de estar a fazer a
-- pergunta certa. Estão a perguntar «este perfil é o id da minha sessão?»
-- quando o que querem saber é «este perfil é o meu?».
--
-- A diferença só aparece no dia em que alguém tiver uma conta cujo id não seja
-- o id do seu perfil, e nessa altura já é tarde para descobrir quais das 125
-- políticas assumiam a igualdade.
--
-- Esta migration trata **as três de `profiles`**. São as mais delicadas —
-- controlam quem se vê e quem se altera a si próprio — e servem de molde às
-- restantes, que migram depois, em lotes com os seus próprios ensaios.
--
--     RLS_POLICIES_MIGRATED_HERE = 3 de 125
--
-- Migrar 88 de uma vez seria repetir, em RLS, o erro de âmbito da #86.
--
-- ---------------------------------------------------------------------------
-- Porque é que o resolver não pode ser usado dentro de `profiles`
-- ---------------------------------------------------------------------------
--
-- 🔴 `get_my_profile_id()` lê `profiles`. Uma política **de** `profiles` que o
--    chamasse voltaria a entrar na mesma tabela — e é isso que a 014 existe
--    para evitar (`infinite recursion detected in policy for relation
--    "profiles"`).
--
--    Não é um problema aqui porque o resolver é `SECURITY DEFINER`: corre com
--    os privilégios de quem o definiu e **não** reentra na RLS da tabela. É a
--    mesma razão por que `get_my_company_id()` já podia ser usada na política
--    de `profiles` desde a 014.
--
--    O que **não** se pode fazer é escrever a subconsulta à mão dentro da
--    política. Foi assim que a recursão nasceu da primeira vez.
-- ============================================================================

BEGIN;

-- ─── 0. get_my_company_id() e get_my_role() passam pelo resolver ────────────
--
-- 🔴 Isto é uma correcção de segurança, não arrumação.
--
--    As duas funções da 014 dizem `WHERE id = auth.uid()`. Enquanto cada
--    perfil tinha uma conta, era a mesma coisa que perguntar «qual é o meu
--    perfil?». Depois do EXPAND deixou de ser: uma pessoa pode existir sem
--    conta, e o seu `id` não corresponde a sessão nenhuma.
--
--    Consequência medida em Postgres real: um token forjado com o `id` de uma
--    pessoa **sem** conta fazia `get_my_company_id()` devolver a empresa dela.
--    Isso dava acesso de leitura a todos os colegas, através da segunda metade
--    da política `profiles_select`. O `get_my_profile_id()` já recusava esse
--    id — mas as funções da 014 não, e eram elas que decidiam.
--
--    Foi um teste com uma pessoa sem conta que o apanhou. Não aparecia antes
--    do EXPAND porque, antes dele, esse cenário não podia existir.
--
--    A correcção é a mesma ideia do resto da fase: perguntar pelo perfil, não
--    pelo id da sessão. `SECURITY DEFINER` mantém-se — é o que evita a
--    recursão que a 014 existe para resolver.
CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$$;

-- ─── 1. profiles_select ─────────────────────────────────────────────────────
--
-- Antes:  id = auth.uid() OR company_id = get_my_company_id()
-- Agora:  id = get_my_profile_id() OR company_id = get_my_company_id()
--
-- Para quem tem conta, o resultado é o mesmo — o resolver devolve o mesmo id
-- que `auth.uid()` devolvia. O que muda é o significado: passa a ser «o meu
-- perfil», e continuará certo quando o id da conta deixar de ser o do perfil.
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (
    id = public.get_my_profile_id()          -- o próprio
    OR company_id = public.get_my_company_id() -- colegas da mesma empresa
  );

-- ─── 2. profiles_update_own ─────────────────────────────────────────────────
--
-- 🔴 Esta é a política que a 069 endureceu, e o `WITH CHECK` explícito é a
--    razão. Sem ele, o Postgres reutiliza o `USING` como `CHECK`, e como o
--    `id` não muda num `UPDATE ... WHERE id = auth.uid()`, qualquer conta
--    autenticada passava a alterar `company_id` e `role` à vontade. Era
--    auto-promoção a admin em qualquer empresa cujo UUID se conhecesse.
--
--    A protecção real da 069 é o trigger `fn_guard_profile_tenant_role`, que
--    esta migration **não toca** — e que não depende de `id = auth.uid()`,
--    porque olha para `auth.role()` e para os helpers da 014. Há testes que o
--    provam antes e depois do EXPAND.
--
--    Mantém-se aqui a mesma forma, com o resolver no lugar do `auth.uid()`.
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE
  USING (id = public.get_my_profile_id())
  WITH CHECK (
    id = public.get_my_profile_id()
    AND company_id = public.get_my_company_id()
  );

-- ─── 3. profiles_manage_company ─────────────────────────────────────────────
--
-- Não menciona `auth.uid()`: já usava os helpers da 014. Fica **como está**.
-- Recriá-la só para lhe tocar seria arriscar uma diferença de transcrição sem
-- ganhar nada — e uma política mal copiada é uma falha de isolamento.
--
--     `profiles_manage_company` = UNCHANGED
--     `profiles_insert_admin`   = UNCHANGED (015)

COMMIT;

-- ============================================================================
-- O que esta migration NÃO faz
-- ============================================================================
--
--  · não toca nas outras 85 políticas que ainda dizem `id = auth.uid()`. Todas
--    continuam correctas enquanto o backfill se mantiver verdadeiro; migram em
--    lotes próprios, com os seus ensaios;
--  · não toca no trigger da 069 — a protecção contra escalada de privilégios
--    fica exactamente como está;
--  · não altera `get_my_company_id()` nem `get_my_role()`;
--  · não escreve uma linha de dados.
--
-- Rollback em
-- `supabase/migrations/draft/rollback/PROVISIONAL_..._resolver_rls.down.sql`:
-- repõe as três políticas na forma que a 014 e a 069 deixaram. Não precisa de
-- guarda — recriar políticas não perde dados, e as duas formas decidem o mesmo
-- enquanto houver uma conta por perfil.
-- ============================================================================
