-- Rollback da 106.
--
-- ---------------------------------------------------------------------------
-- 🔴 ESTE ROLLBACK REABRE ACESSO. LEIA ANTES DE O CORRER.
-- ---------------------------------------------------------------------------
--
-- Ao contrário dos rollbacks da 104 e da 105 — que removiam capacidades novas e
-- não tocavam em nada do que já existia — este devolve as duas funções à forma
-- ANTERIOR, e a forma anterior é a que NÃO olha para `profiles.status`.
--
-- Consequência concreta, medida em produção a 2026-09-24: as oito pessoas com
-- perfil não activo e conta Auth sem banimento voltam, no instante do commit, a
-- ter da base exactamente o que um colaborador activo tem.
--
-- Isto não é um efeito lateral — é literalmente desfazer a migration. Mas quem
-- corre um ficheiro chamado «rollback» espera voltar a um estado seguro, e aqui
-- volta-se a um estado MENOS seguro. Por isso está escrito em cima, e por isso
-- o bloco avisa com a contagem real antes de mexer.
--
-- Antes de correr isto, a pergunta certa não é «como desfaço?» mas «porque é
-- que a 106 está a impedir alguém que devia entrar?». Se a resposta for «há um
-- perfil activo que não resolve», o caminho é corrigir o estado desse perfil,
-- não remover a regra para toda a gente.
--
-- ---------------------------------------------------------------------------
-- O que este ficheiro NÃO faz
-- ---------------------------------------------------------------------------
--
--     · não toca em `profiles` — nenhum estado é alterado, revertido ou
--       «arrumado». Os perfis não activos continuam não activos;
--     · não toca em `auth.users` — nenhum ban é posto ou retirado;
--     · não recria políticas. Nenhuma foi alterada pela 106: ela mudou o corpo
--       de duas funções, e as 69 políticas continuaram a apontar para as
--       mesmas.
--
-- ---------------------------------------------------------------------------
-- Contrato
-- ---------------------------------------------------------------------------
--
--     ledger  efeitos
--       0        0     → no-op idempotente
--       0       >0     → ALIENADO: as funções não estão nesta forma por causa
--                        desta migration → RAISE
--       1        0     → LEDGER_WITHOUT_EFFECT → RAISE (decisão humana)
--       1        1     → PARTIAL_EFFECT → RAISE (decisão humana)
--       1        2     → checksum confere? → repõe as duas + DELETE do ledger
--                        checksum diverge?  → RAISE
--
-- 🔴 ESTADO PARCIAL FALHA FECHADO. Uma das duas funções endurecida e a outra
--    não é a prova de que algo correu mal — um apply interrompido, um
--    `CREATE OR REPLACE` manual. Normalizá-lo em silêncio apaga essa prova.
--
-- ---------------------------------------------------------------------------
-- 🔴 O CHECKSUM É VERIFICADO ANTES DE QUALQUER ESCRITA
-- ---------------------------------------------------------------------------
--
-- Se o conteúdo do ledger não for o desta 106, o que está aplicado é outra
-- coisa com o mesmo nome — e este ficheiro não sabe repor o que essa outra
-- coisa substituiu. Repor às cegas um resolver que 69 políticas usam é a forma
-- mais rápida de partir a leitura de toda a gente.
--
-- O valor é o `checksumForNewMigration()` do runner: SHA-256 do conteúdo
-- normalizado a LF. A leitura é `FOR UPDATE`.
-- ---------------------------------------------------------------------------

DO $rollback_106$
DECLARE
  -- 🔴 O checksum canónico desta 106. Se o SQL mudar, este valor TEM de mudar
  --    com ele — há um ensaio que os compara.
  CHECKSUM_106 CONSTANT text := '5774bff64a5f28c25f049907b1c3f69a95f9b470d8732d7170999ecca64e5d02';

  v_checksum text;
  v_ledger   boolean;
  v_resolver boolean;
  v_servico  boolean;
  v_efeitos  integer;
  v_naoativos integer;
  r text;
  f text;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'COLAB_106_ROLLBACK_LEDGER_AUSENTE: public._migrations não existe — este rollback só corre pelo runner canónico';
  END IF;

  v_ledger := EXISTS (
    SELECT 1 FROM public._migrations WHERE name = '106_colaborador_status_autorizacao.sql'
  );

  v_resolver := EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_my_profile_id'
       AND p.prosrc ILIKE '%status%' AND p.prosrc ILIKE '%ativo%');

  v_servico := EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'can_access_service'
       AND p.prosrc ILIKE '%get_my_profile_id%' AND p.proconfig IS NOT NULL);

  v_efeitos := (CASE WHEN v_resolver THEN 1 ELSE 0 END)
             + (CASE WHEN v_servico THEN 1 ELSE 0 END);

  IF NOT v_ledger AND v_efeitos = 0 THEN
    RAISE NOTICE 'COLAB_106_ROLLBACK_NOOP: nem ledger nem efeitos — nada a desfazer';
    RETURN;
  END IF;

  IF NOT v_ledger AND v_efeitos > 0 THEN
    RAISE EXCEPTION
      'COLAB_106_ROLLBACK_ALIENADO: existem % efeito(s) da 106 sem linha de ledger — não estão nesta forma por causa desta migration, nada foi alterado',
      v_efeitos;
  END IF;

  IF v_ledger AND v_efeitos = 0 THEN
    RAISE EXCEPTION
      'COLAB_106_ROLLBACK_LEDGER_WITHOUT_EFFECT: há linha de ledger e nenhum efeito — decida primeiro o que é verdade';
  END IF;

  IF v_ledger AND v_efeitos < 2 THEN
    RAISE EXCEPTION
      'COLAB_106_ROLLBACK_PARTIAL_EFFECT: linha de ledger com só % de 2 efeitos (resolver=%, can_access_service=%) — estado parcial não se normaliza em silêncio; nada foi alterado',
      v_efeitos,
      (CASE WHEN v_resolver THEN 'endurecido' ELSE 'por endurecer' END),
      (CASE WHEN v_servico THEN 'endurecido' ELSE 'por endurecer' END);
  END IF;

  SELECT m.checksum INTO v_checksum
    FROM public._migrations m
   WHERE m.name = '106_colaborador_status_autorizacao.sql'
   FOR UPDATE;

  IF v_checksum IS DISTINCT FROM CHECKSUM_106 THEN
    RAISE EXCEPTION
      'COLAB_106_ROLLBACK_CHECKSUM_DIVERGENTE: o ledger tem % e esta 106 é % — o que está aplicado não é esta migration; nada foi alterado',
      coalesce(v_checksum, 'NULL'), CHECKSUM_106;
  END IF;

  -- 🔴 O aviso que importa, com o número real.
  SELECT count(*) INTO v_naoativos
    FROM public.profiles WHERE status <> 'ativo' AND auth_user_id IS NOT NULL;

  IF v_naoativos > 0 THEN
    RAISE WARNING
      'COLAB_106_ROLLBACK_REABRE_ACESSO: % perfil(is) NÃO ACTIVO(S) com conta Auth voltam a ser resolvidos como identidade autorizada assim que esta transação fizer commit. Os perfis e os bans NÃO são alterados — o que muda é a base voltar a ignorar o estado.',
      v_naoativos;
  END IF;

  -- ── Repor o resolver da 101b, sem o filtro de estado ────────────────────
  CREATE OR REPLACE FUNCTION public.get_my_profile_id()
  RETURNS uuid
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
  AS $fn$
    SELECT id FROM profiles WHERE auth_user_id = auth.uid()
    UNION ALL
    SELECT id FROM profiles p
     WHERE p.id = auth.uid()
       AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
       AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid())
    LIMIT 1;
  $fn$;

  COMMENT ON FUNCTION public.get_my_profile_id() IS
    'O id da pessoa autenticada, ou NULL se não houver sessão ou a conta não '
    'estiver ligada a ninguém. Responde pela coluna auth_user_id e, enquanto '
    'a transição durar, também pela convenção antiga em que profiles.id era '
    'o id do Auth.';

  -- ── Repor can_access_service da 034 ─────────────────────────────────────
  --
  -- 🔴 Volta SEM `search_path`, porque era assim que estava. Repor com o
  --    search_path fixado seria fazer um rollback parcial — deixaria metade da
  --    106 aplicada e a outra metade não, que é precisamente o estado que o
  --    contrato acima recusa. Quem desfaz, desfaz inteiro.
  EXECUTE $repor$
    CREATE OR REPLACE FUNCTION public.can_access_service(p_service_id uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    STABLE
    AS $fn$
      SELECT EXISTS (
        SELECT 1
        FROM   services s
        INNER  JOIN profiles p ON p.id = auth.uid() AND p.company_id = s.company_id
        WHERE  s.id = p_service_id
        AND (
          EXISTS (
            SELECT 1 FROM team_members tm
            WHERE  tm.team_id        = s.team_id
            AND    tm.collaborator_id = auth.uid()
            AND   (tm.left_at IS NULL OR tm.left_at > NOW())
          )
          OR EXISTS (
            SELECT 1 FROM service_reinforcements sr
            WHERE  sr.service_id     = s.id
            AND    sr.collaborator_id = auth.uid()
          )
        )
      )
    $fn$;
  $repor$;

  -- 🔴 A ACL volta à forma anterior: PUBLIC tinha EXECUTE em
  --    `can_access_service` e não tinha em `get_my_profile_id`. Repor as duas
  --    iguais seria inventar um estado que nunca existiu.
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.can_access_service(uuid) TO PUBLIC';

  FOREACH f IN ARRAY ARRAY['public.get_my_profile_id()', 'public.can_access_service(uuid)'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
      END IF;
    END LOOP;
  END LOOP;

  DELETE FROM public._migrations WHERE name = '106_colaborador_status_autorizacao.sql';

  RAISE NOTICE
    'COLAB_106_ROLLBACK_OK: resolver e can_access_service repostos na forma anterior; linha de ledger apagada. Nenhum perfil e nenhum ban foram tocados.';
END;
$rollback_106$;
