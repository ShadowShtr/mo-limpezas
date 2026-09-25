-- ============================================================================
-- 106 — o ESTADO do colaborador participa da autorização
-- ============================================================================
--
-- O que isto fecha, medido em produção a 2026-09-24, não deduzido:
--
--       perfis não activos ...................... 10  (1 inativo, 9 suspenso)
--       destes, com conta Auth ligada ............  8
--       destes, SEM banimento activo no Auth .....  8
--
-- Oito pessoas a quem a empresa já deu saída conseguem, neste momento,
-- autenticar-se e obter da base exactamente o mesmo que um colaborador activo.
-- Não é uma hipótese: `banned_until` é NULL ou passado nas oito contas, e
-- nenhuma das 100 políticas de RLS olha para `profiles.status`.
--
-- ---------------------------------------------------------------------------
-- 🔴 PORQUE É QUE DAR SAÍDA NÃO ESTAVA A DAR SAÍDA
-- ---------------------------------------------------------------------------
--
-- Havia DUAS verdades sobre o acesso de uma pessoa, e nenhuma delas obrigava a
-- outra:
--
--       profiles.status      ← o que a gestão vê e edita
--       auth.users.banned_until  ← o que impede a autenticação
--
-- `desativarAcesso()` escreve a segunda e não a primeira. `updateColaborador()`
-- escreve a primeira e não a segunda. Duas verdades que podem divergir sempre
-- divergem, e a medição acima mostra a divergência já instalada: oito perfis
-- não activos sem qualquer banimento.
--
-- Mesmo que o banimento estivesse lá, faltaria o essencial: um token já emitido
-- continua válido até expirar. O ban impede o LOGIN seguinte; não invalida a
-- sessão em curso. Enquanto a base não olhar para o estado, quem tem um token
-- vivo continua a ler tudo.
--
-- Esta migration põe o estado a decidir NA BASE, que é o único sítio onde a
-- decisão não depende de o runtime se lembrar de a tomar.
--
-- ---------------------------------------------------------------------------
-- 🔴 UM SÍTIO, E NÃO CEM
-- ---------------------------------------------------------------------------
--
-- Contado no catálogo vivo, hoje:
--
--       políticas em `public` ....................... 100
--       que usam get_my_profile_id() ................  69
--       que usam get_my_company_id() ................  43
--       que usam get_my_role() ......................  23
--       que usam can_access_service() ...............   3
--       que usam auth.uid() DIRECTAMENTE ............   0
--
-- `get_my_company_id()` e `get_my_role()` são, elas próprias,
-- `SELECT ... WHERE id = public.get_my_profile_id()`. Ou seja: o resolver é o
-- estrangulamento por onde toda a superfície passa. Mudá-lo fecha as três
-- funções e as 69 políticas de uma vez, sem tocar em política nenhuma.
--
-- Reescrever 69 políticas para cada uma verificar o estado seria 69 sítios onde
-- alguém se pode esquecer — e o próximo a escrever a 70.ª não tem como saber.
--
-- ---------------------------------------------------------------------------
-- 🔴 A EXCEPÇÃO: can_access_service NÃO PASSA PELO RESOLVER
-- ---------------------------------------------------------------------------
--
-- É a única das quatro que não usa `get_my_profile_id()`. Compara
-- `p.id = auth.uid()` directamente — a convenção ANTIGA, anterior à
-- reconciliação de identidade da 101b, em que `profiles.id` era o id do Auth.
--
-- Hoje isso ainda funciona por acidente: as 29 contas ligadas têm
-- `auth_user_id = id`. No dia em que existir um perfil ligado por
-- `auth_user_id` a um id diferente — que é exactamente o que a 101b passou a
-- permitir — esta função deixa de o reconhecer, em silêncio, e a pessoa perde
-- acesso aos seus próprios serviços sem ninguém perceber porquê.
--
-- E é a ÚNICA função `SECURITY DEFINER` do schema `public` sem `search_path`
-- fixado: 1 em 24, medido agora. Numa função DEFINER isso é a porta para
-- resolução de nomes controlada por quem chama.
--
-- Por isso é reconstruída: passa pelo resolver canónico, herda dele a
-- verificação de estado, e ganha o `search_path` que lhe faltava.
--
-- ---------------------------------------------------------------------------
-- 🔴 SÓ `ativo` ENTRA
-- ---------------------------------------------------------------------------
--
-- O domínio real da coluna, lido do CHECK vivo:
--
--       ativo | inativo | suspenso
--
-- A regra é uma só: `status = 'ativo'`. Sem `trim`, sem `lower`, sem fallback,
-- sem lista de estados «que também servem». Qualquer outro valor — incluindo um
-- que o CHECK viesse a admitir amanhã — não resolve identidade nenhuma.
--
-- Isto é deliberadamente a forma FECHADA: um estado novo nasce sem acesso, e
-- quem o introduzir tem de vir aqui decidir o contrário. O contrário — uma
-- lista de estados proibidos — daria acesso a tudo o que alguém esquecesse de
-- proibir.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
--   · não muda `company_id` nem `role`, e não toca em política nenhuma;
--   · não apaga, não arquiva e não renomeia dados. Nenhum `UPDATE` a
--     `profiles`. Os 10 perfis não activos ficam exactamente como estão —
--     o que muda é o que a base lhes responde;
--   · não bane ninguém no Auth. `auth.users` não é tocada: a migration não
--     pode escrever no schema de autenticação, e não deve;
--   · não traz runtime. A paridade entre `profiles.status` e o ban do Auth é
--     a 106-B, depois de isto estar aplicado e validado;
--   · não cria a coluna, não altera o CHECK e não introduz `arquivado`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Precondições — o que tem de existir antes
-- ---------------------------------------------------------------------------

DO $precondicoes$
DECLARE
  v_faltam text[];
  v_check text;
BEGIN
  SELECT array_agg(t ORDER BY t) INTO v_faltam
    FROM unnest(ARRAY[
      'public.profiles', 'public.services', 'public.team_members',
      'public.service_reinforcements'
    ]) AS t
   WHERE to_regclass(t) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'COLAB_106_PRECONDITION_FAILED: tabelas em falta %',
      array_to_string(v_faltam, ', ');
  END IF;

  -- A coluna de que tudo isto depende.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'COLAB_106_PRECONDITION_FAILED: profiles.status ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'auth_user_id'
  ) THEN
    RAISE EXCEPTION
      'COLAB_106_PRECONDITION_FAILED: profiles.auth_user_id ausente — a 101b não está aplicada';
  END IF;

  -- 🔴 O DOMÍNIO da coluna, e não só a sua existência.
  --
  --    Esta migration decide por `status = 'ativo'`. Se o vocabulário da
  --    coluna for outro — `active`, `A`, o que for — o filtro não casava com
  --    ninguém e a migration trancava a empresa inteira fora da sua própria
  --    base, em silêncio e de uma vez. É o pior desfecho possível desta
  --    frente, e é barato de impedir.
  --
  -- 🔴 A procura é pela FORMA, não pelo NOME.
  --
  --    A primeira versão exigia `conname = 'profiles_status_check'`, que é
  --    como a restrição se chama em produção. Um nome de restrição é um
  --    detalhe de quem a criou: a mesma regra noutra base pode chamar-se
  --    outra coisa, e a migration recusava-se a instalar por causa de uma
  --    etiqueta. O que interessa é existir uma restrição sobre `status` que
  --    admita `ativo`.
  SELECT pg_get_constraintdef(oid) INTO v_check
    FROM pg_constraint
   WHERE conrelid = 'public.profiles'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%'
     AND pg_get_constraintdef(oid) LIKE '%''ativo''%'
   LIMIT 1;

  IF v_check IS NULL THEN
    RAISE EXCEPTION
      'COLAB_106_PRECONDITION_FAILED: não há restrição CHECK em profiles.status que admita ''ativo'' — o vocabulário desta base não é o que esta migration lê, e o filtro trancaria toda a gente fora';
  END IF;

  -- As quatro funções da superfície de identidade.
  SELECT array_agg(f ORDER BY f) INTO v_faltam
    FROM unnest(ARRAY[
      'public.get_my_profile_id()',
      'public.get_my_company_id()',
      'public.get_my_role()',
      'public.can_access_service(uuid)'
    ]) AS f
   WHERE to_regprocedure(f) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'COLAB_106_PRECONDITION_FAILED: funções de identidade em falta ou com outra assinatura %',
      array_to_string(v_faltam, ', ');
  END IF;

  -- 🔴 `get_my_company_id` e `get_my_role` TÊM de delegar no resolver.
  --
  --    É essa delegação que faz esta migration fechar as três de uma vez. Se
  --    alguma delas tiver sido reescrita para ler `profiles` por conta
  --    própria, mudar só o resolver deixaria um caminho aberto — e este
  --    ficheiro estaria a prometer uma coisa que não cumpre.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_my_company_id'
       AND p.prosrc ILIKE '%get_my_profile_id%'
  ) THEN
    RAISE EXCEPTION
      'COLAB_106_PRECONDITION_FAILED: get_my_company_id não delega em get_my_profile_id — mudar só o resolver deixaria um caminho aberto';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_my_role'
       AND p.prosrc ILIKE '%get_my_profile_id%'
  ) THEN
    RAISE EXCEPTION
      'COLAB_106_PRECONDITION_FAILED: get_my_role não delega em get_my_profile_id';
  END IF;
END;
$precondicoes$;

-- ---------------------------------------------------------------------------
-- 0a. Proveniência das DEPENDÊNCIAS — o ledger, não só os objectos
-- ---------------------------------------------------------------------------
--
-- 🔴 SCHEMA_EFFECT != MIGRATION_PROVENANCE. O runner aceita `--only`: sem este
--    bloco, a 106 instalar-se-ia sobre um resolver cuja origem ninguém
--    consegue reconstruir.
--
-- 🔴 A 034 fica DE FORA desta lista, e a razão tem de ser dita.
--
--    Foi a 034 que criou `can_access_service`, e seria natural exigi-la aqui.
--    Mas o ledger de produção tem, para a 034, o checksum
--    `439313eba1b708db…` enquanto o ficheiro no repositório dá
--    `d8d80b25ee22b5be…` — a divergência histórica CRLF/LF deste repositório,
--    anterior à normalização que as migrations novas usam. Exigir esse
--    checksum faria a 106 recusar-se a instalar por um motivo que nada tem a
--    ver com autorização.
--
--    Em vez disso, o bloco 0b verifica a FORMA REAL da função que vai ser
--    substituída. É uma prova mais forte do que uma linha de ledger: mede o
--    que lá está, e não o que alguém registou ter lá posto.
--
-- 🔴 Também não se exige a cadeia 102→105. Ela está aplicada, mas é de outro
--    domínio: fazer uma correcção de autorização depender do CRM seria criar
--    um acoplamento que não existe.

DO $dependencias$
DECLARE
  v_faltam  text[];
  v_erradas text[];
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'COLAB_106_LEDGER_AUSENTE: public._migrations não existe — a 106 só corre pelo runner canónico';
  END IF;

  WITH esperado(nome, checksum) AS (
    VALUES
      ('101_crm_leads.sql',               '92fb13678187609c7951faaae6dcf3a3688f04694efb4b34c6f04e23aee46942'),
      ('101a_crm_rpc_acl_hardening.sql',  '51aca907d2e9310f36d01901f5bb4911f8a951a536bcb9886071b0ef1d0528fb'),
      ('101b_identity_reconciliation.sql','33614ef362300bca1a4a9bff8928172b45f2418b9409bb8eaaaa2e1805f4e136')
  )
  SELECT
    array_agg(e.nome ORDER BY e.nome) FILTER (WHERE m.name IS NULL),
    array_agg(e.nome || ' (ledger ' || coalesce(m.checksum, 'NULL') || ')' ORDER BY e.nome)
      FILTER (WHERE m.name IS NOT NULL AND m.checksum IS DISTINCT FROM e.checksum)
    INTO v_faltam, v_erradas
    FROM esperado e
    LEFT JOIN public._migrations m ON m.name = e.nome;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'COLAB_106_DEPENDENCY_LEDGER_MISSING: fundações sem linha de ledger % — os objectos podem existir, mas a proveniência não; nada foi alterado',
      array_to_string(v_faltam, ', ');
  END IF;

  IF v_erradas IS NOT NULL THEN
    RAISE EXCEPTION
      'COLAB_106_DEPENDENCY_CHECKSUM_DIVERGED: o ledger diz aplicada mas o conteúdo não é o esperado % — nada foi alterado',
      array_to_string(v_erradas, ', ');
  END IF;
END;
$dependencias$;

-- ---------------------------------------------------------------------------
-- 0b. Proveniência da própria 106 — efeito presente não é migration aplicada
-- ---------------------------------------------------------------------------
--
-- 🔴 Os efeitos desta migration são REDEFINIÇÕES, não criações. Não há um
--    objecto novo cuja presença se possa testar com `to_regprocedure`: as duas
--    funções já existem antes e continuam a existir depois.
--
--    Por isso o efeito é detectado pelo CONTEÚDO — o resolver a filtrar por
--    estado, e `can_access_service` a passar pelo resolver com `search_path`
--    fixado. É a única forma honesta de distinguir «já aplicada» de «ainda
--    não»: perguntar ao catálogo o que as funções fazem hoje.

DO $proveniencia$
DECLARE
  v_ledger  boolean;
  v_efeitos text[];
  v_total_efeitos CONSTANT integer := 2;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'COLAB_106_LEDGER_AUSENTE: public._migrations não existe — a 106 só corre pelo runner canónico';
  END IF;

  v_ledger := EXISTS (
    SELECT 1 FROM public._migrations WHERE name = '106_colaborador_status_autorizacao.sql'
  );

  SELECT array_agg(efeito.nome ORDER BY efeito.nome) INTO v_efeitos
    FROM (VALUES
      ('get_my_profile_id filtra por estado',
       (SELECT 'presente' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_my_profile_id'
           AND p.prosrc ILIKE '%status%' AND p.prosrc ILIKE '%ativo%')),
      ('can_access_service pelo resolver e com search_path',
       (SELECT 'presente' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'can_access_service'
           AND p.prosrc ILIKE '%get_my_profile_id%' AND p.proconfig IS NOT NULL))
    ) AS efeito(nome, presente)
   WHERE efeito.presente IS NOT NULL;

  IF v_ledger AND v_efeitos IS NULL THEN
    RAISE EXCEPTION
      'COLAB_106_LEDGER_WITHOUT_EFFECT: há linha de ledger da 106 mas nenhum dos seus efeitos existe — decida primeiro o que é verdade';
  ELSIF v_ledger AND array_length(v_efeitos, 1) < v_total_efeitos THEN
    RAISE EXCEPTION
      'COLAB_106_LEDGER_WITH_PARTIAL_EFFECT: a linha diz aplicada, mas só % de % efeitos existem (%) — a 106 ficou a meio',
      array_length(v_efeitos, 1), v_total_efeitos, array_to_string(v_efeitos, ', ');
  ELSIF v_ledger THEN
    RAISE EXCEPTION
      'COLAB_106_JA_APLICADA: linha de ledger e efeitos todos presentes — reaplicar reescreveria as funções e a sua ACL';
  ELSIF v_efeitos IS NOT NULL THEN
    RAISE EXCEPTION
      'COLAB_106_EFFECT_WITHOUT_LEDGER: já existem efeitos da 106 sem linha de ledger (%) — estado desconhecido, nada foi alterado',
      array_to_string(v_efeitos, ', ');
  END IF;
END;
$proveniencia$;

-- ---------------------------------------------------------------------------
-- 0c. Pré-estado — o resolver que vai ser substituído é o que este ficheiro leu
-- ---------------------------------------------------------------------------
--
-- 🔴 Substituir às cegas uma função que 69 políticas usam é o caminho mais
--    curto para partir a leitura de toda a gente. Antes de reescrever, prova-se
--    que o que lá está tem a forma conhecida.

-- 🔴 ESTE BLOCO VEM DEPOIS DA PROVENIÊNCIA, e a ordem não é estética.
--
--    Enquanto estava antes, uma 106 já aplicada era diagnosticada como
--    «alguém alterou o resolver» — porque o pré-estado encontrava o corpo NOVO
--    e não o predecessor. A pergunta «vou sequer aplicar?» tem de ser
--    respondida antes de «o predecessor é o esperado?», senão a mensagem
--    manda investigar um problema que não existe.
--
-- 🔴 A COMPARAÇÃO É DO CORPO INTEIRO, e não de uma palavra.
--
--    A primeira versão deste bloco aceitava o resolver se `prosrc` contivesse
--    a palavra `auth_user_id`, e `can_access_service` se contivesse
--    `auth.uid()` OU `get_my_profile_id`. Isso não prova forma nenhuma: uma
--    função alterada depois da 101b, com regra nova e a palavra lá dentro,
--    passava — e a 106 pisava-a com `CREATE OR REPLACE`, apagando trabalho de
--    outra pessoa sem aviso.
--
--    Pior: este ficheiro AFIRMA, no bloco 0a, que a forma viva é prova mais
--    forte do que o checksum histórico da 034. Uma afirmação dessas não se
--    sustenta medindo uma palavra.
--
-- 🔴 O espaço em branco é normalizado; o resto é EXACTO.
--
--    `[[:space:]]+ → ' '` tira da comparação a indentação e o CRLF/LF, que
--    variam com quem aplicou e com o sistema de ficheiros. O que sobra —
--    tabelas, colunas, operadores, ordem — tem de bater carácter a carácter.
--
--    A classe POSIX é deliberada: `\s` obrigaria a escapar a barra invertida,
--    e este ficheiro atravessa camadas onde isso se perde em silêncio.
--
-- 🔴 As formas esperadas foram lidas do CATÁLOGO VIVO de produção a
--    2026-09-24, não copiadas dos ficheiros de migration. Não é a mesma coisa:
--    o corpo da `can_access_service` em produção NÃO tem os comentários que a
--    034 tem no repositório. Comparar com o ficheiro faria a migration
--    recusar-se a instalar precisamente na base que ela existe para corrigir.

DO $preestado$
DECLARE
  RESOLVER_ESPERADO CONSTANT text :=
    'SELECT id FROM profiles WHERE auth_user_id = auth.uid() UNION ALL SELECT id FROM profiles p WHERE p.id = auth.uid() AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id) AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid()) LIMIT 1;';

  SERVICO_ESPERADO CONSTANT text :=
    'SELECT EXISTS ( SELECT 1 FROM services s INNER JOIN profiles p ON p.id = auth.uid() AND p.company_id = s.company_id WHERE s.id = p_service_id AND ( EXISTS ( SELECT 1 FROM team_members tm WHERE tm.team_id = s.team_id AND tm.collaborator_id = auth.uid() AND (tm.left_at IS NULL OR tm.left_at > NOW()) ) OR EXISTS ( SELECT 1 FROM service_reinforcements sr WHERE sr.service_id = s.id AND sr.collaborator_id = auth.uid() ) ) )';

  v_corpo    text;
  v_definer  boolean;
  v_volatil  "char";
  v_lang     text;
  v_config   text;
  v_grantees text[];
  v_grantable boolean;
  v_esperados text[];
  v_oid      oid;
  r          text;
BEGIN
  -- ── O resolver, tal como a 101b o deixou ────────────────────────────────
  v_oid := to_regprocedure('public.get_my_profile_id()');

  SELECT btrim(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')),
         p.prosecdef, p.provolatile, l.lanname,
         coalesce(array_to_string(p.proconfig, ', '), '')
    INTO v_corpo, v_definer, v_volatil, v_lang, v_config
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_oid;

  IF v_corpo IS DISTINCT FROM RESOLVER_ESPERADO THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: get_my_profile_id não tem o corpo canónico da 101b. Alguém o alterou depois, e substituí-lo apagaria essa alteração. Encontrado: %',
      left(v_corpo, 400);
  END IF;

  IF NOT v_definer OR v_volatil <> 's' OR v_lang <> 'sql' THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: get_my_profile_id com definição inesperada (definer=%, volatilidade=%, linguagem=%)',
      v_definer, v_volatil, v_lang;
  END IF;

  IF v_config <> 'search_path=public' THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: get_my_profile_id com search_path inesperado (%)',
      coalesce(nullif(v_config, ''), '(nenhum)');
  END IF;

  -- 🔴 A ACL também. Se alguém tiver dado EXECUTE a mais um papel, a 106
  --    revogava-o silenciosamente no bloco 3 — e isso é uma decisão de outra
  --    pessoa a ser desfeita sem ninguém dar por ela.
  SELECT array_agg(DISTINCT a.grantee::regrole::text ORDER BY a.grantee::regrole::text),
         bool_or(a.is_grantable)
    INTO v_grantees, v_grantable
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE';

  -- O esperado: o owner e os papéis do Supabase QUE EXISTEM. Sem PUBLIC.
  SELECT array_agg(g ORDER BY g) INTO v_esperados
    FROM (
      SELECT p.proowner::regrole::text AS g FROM pg_proc p WHERE p.oid = v_oid
      UNION
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
    ) AS e;

  IF v_grantees IS DISTINCT FROM v_esperados THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: ACL de get_my_profile_id é % — esperado %',
      coalesce(array_to_string(v_grantees, ', '), 'NENHUMA'),
      array_to_string(v_esperados, ', ');
  END IF;
  -- 🔴 E o GRANT OPTION, que a lista de grantees NÃO mostra.
  --
  --    `authenticated` com EXECUTE e `authenticated` com EXECUTE WITH GRANT
  --    OPTION produzem exactamente a MESMA lista de nomes. A diferença é que o
  --    segundo pode passar o privilégio adiante — e o bloco da ACL desta
  --    migration faz `REVOKE ALL` seguido de `GRANT EXECUTE`, que o retira em
  --    silêncio. Alguém decidiu dar essa capacidade; não é esta migration que
  --    a desfaz sem dizer nada.
  IF coalesce(v_grantable, false) THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: get_my_profile_id tem EXECUTE com WITH GRANT OPTION — a 106 iria retirá-lo sem o dizer. Nada foi alterado.';
  END IF;


  -- ── can_access_service, tal como a 034 a deixou ─────────────────────────
  v_oid := to_regprocedure('public.can_access_service(uuid)');

  SELECT btrim(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')),
         p.prosecdef, p.provolatile, l.lanname,
         coalesce(array_to_string(p.proconfig, ', '), '')
    INTO v_corpo, v_definer, v_volatil, v_lang, v_config
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_oid;

  IF v_corpo IS DISTINCT FROM SERVICO_ESPERADO THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: can_access_service não tem o corpo vivo da 034. Encontrado: %',
      left(v_corpo, 400);
  END IF;

  IF NOT v_definer OR v_volatil <> 's' OR v_lang <> 'sql' THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: can_access_service com definição inesperada (definer=%, volatilidade=%, linguagem=%)',
      v_definer, v_volatil, v_lang;
  END IF;

  -- 🔴 A AUSÊNCIA de search_path é parte da forma esperada. Se já lá estiver
  --    um, alguém corrigiu isto antes desta migration — e o que a 106 ia
  --    fazer já está feito, por outra mão e talvez de outra maneira.
  IF v_config <> '' THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: can_access_service já tem search_path (%) — alguém a endureceu antes desta migration',
      v_config;
  END IF;

  SELECT array_agg(DISTINCT a.grantee::regrole::text ORDER BY a.grantee::regrole::text),
         bool_or(a.is_grantable)
    INTO v_grantees, v_grantable
    FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE';

  -- 🔴 Aqui o esperado INCLUI PUBLIC (`-`): é o que produção tem, e é
  --    precisamente o que a 106 vai retirar. Esperar a forma já corrigida
  --    seria aceitar como predecessor aquilo que é o resultado.
  SELECT array_agg(g ORDER BY g) INTO v_esperados
    FROM (
      SELECT '-' AS g
      UNION
      SELECT p.proowner::regrole::text FROM pg_proc p WHERE p.oid = v_oid
      UNION
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
    ) AS e;

  IF v_grantees IS DISTINCT FROM v_esperados THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: ACL de can_access_service é % — esperado %',
      coalesce(array_to_string(v_grantees, ', '), 'NENHUMA'),
      array_to_string(v_esperados, ', ');
  END IF;
  -- 🔴 E o GRANT OPTION, que a lista de grantees NÃO mostra.
  --
  --    `authenticated` com EXECUTE e `authenticated` com EXECUTE WITH GRANT
  --    OPTION produzem exactamente a MESMA lista de nomes. A diferença é que o
  --    segundo pode passar o privilégio adiante — e o bloco da ACL desta
  --    migration faz `REVOKE ALL` seguido de `GRANT EXECUTE`, que o retira em
  --    silêncio. Alguém decidiu dar essa capacidade; não é esta migration que
  --    a desfaz sem dizer nada.
  IF coalesce(v_grantable, false) THEN
    RAISE EXCEPTION
      'COLAB_106_PREESTADO_INESPERADO: can_access_service tem EXECUTE com WITH GRANT OPTION — a 106 iria retirá-lo sem o dizer. Nada foi alterado.';
  END IF;


  -- Silencia o aviso de variável não usada sem esconder nada.
  r := NULL;
END;
$preestado$;

-- ---------------------------------------------------------------------------
-- 1. O resolver passa a exigir estado activo
-- ---------------------------------------------------------------------------
--
-- 🔴 `CREATE OR REPLACE`, e não `DROP` + `CREATE`.
--
--    69 políticas dependem desta função. Um `DROP` obrigaria a `CASCADE` — que
--    apagaria as políticas — ou falharia. `OR REPLACE` troca o corpo mantendo
--    o oid, e as políticas continuam a apontar para a mesma função.
--
-- 🔴 O filtro está nos DOIS ramos.
--
--    O segundo ramo é a convenção antiga (`profiles.id` = id do Auth), que a
--    101b manteve durante a transição. Hoje está provadamente sem uso — zero
--    perfis sem `auth_user_id` cujo `id` seja uma conta Auth, medido em
--    produção. Mas «sem uso hoje» não é «impossível amanhã», e um ramo sem
--    filtro seria exactamente a forma de a saída deixar de dar saída outra vez.

CREATE OR REPLACE FUNCTION public.get_my_profile_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT id FROM profiles
   WHERE auth_user_id = auth.uid()
     AND status = 'ativo'
  UNION ALL
  SELECT id FROM profiles p
   WHERE p.id = auth.uid()
     AND p.status = 'ativo'
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
     AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid())
  LIMIT 1;
$fn$;

COMMENT ON FUNCTION public.get_my_profile_id() IS
  'O id da pessoa autenticada, ou NULL. Desde a 106 so resolve quando '
  'profiles.status = ''ativo'': inativo, suspenso ou qualquer estado futuro nao '
  'resolvem identidade nenhuma, e as 69 politicas que dependem desta funcao '
  'deixam de devolver linhas. get_my_company_id e get_my_role delegam aqui e '
  'herdam a regra. Responde pela coluna auth_user_id e, enquanto a transicao da '
  '101b durar, tambem pela convencao antiga — com o mesmo filtro de estado nos '
  'dois ramos.';

-- ---------------------------------------------------------------------------
-- 2. can_access_service passa pelo resolver canónico
-- ---------------------------------------------------------------------------
--
-- 🔴 Três mudanças, e cada uma fecha um defeito concreto:
--
--      1. `public.get_my_profile_id()` em vez de `auth.uid()` — deixa de
--         assumir que `profiles.id` é o id do Auth, e herda o filtro de estado;
--
--      2. `SET search_path` — era a única função DEFINER do schema sem ele;
--
--      3. o isolamento por empresa continua explícito (`p.company_id =
--         s.company_id`), porque é ele que impede ver o serviço de outra
--         empresa mesmo com identidade válida.
--
-- 🔴 Continua `SECURITY DEFINER`, e é deliberado: a função é chamada de dentro
--    de políticas de RLS sobre `services`, e tem de poder ler `team_members` e
--    `service_reinforcements` sem que a RLS dessas tabelas a volte a filtrar —
--    o que daria recursão. É o mesmo motivo que a fez nascer DEFINER na 034.

CREATE OR REPLACE FUNCTION public.can_access_service(p_service_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.services s
      JOIN public.profiles p
        ON p.id = public.get_my_profile_id()
       AND p.company_id = s.company_id
     WHERE s.id = p_service_id
       AND (
         EXISTS (
           SELECT 1 FROM public.team_members tm
            WHERE tm.team_id = s.team_id
              AND tm.collaborator_id = p.id
              AND (tm.left_at IS NULL OR tm.left_at > now())
         )
         OR EXISTS (
           SELECT 1 FROM public.service_reinforcements sr
            WHERE sr.service_id = s.id
              AND sr.collaborator_id = p.id
         )
       )
  );
$fn$;

COMMENT ON FUNCTION public.can_access_service(uuid) IS
  'Se a pessoa autenticada pode ver este servico. Desde a 106 resolve a '
  'identidade por get_my_profile_id() em vez de assumir profiles.id = auth.uid(), '
  'o que a faz herdar a exigencia de status = ''ativo'' e deixar de depender da '
  'convencao anterior a 101b. Mantem o isolamento por empresa e passa a ter '
  'search_path fixado — era a unica funcao SECURITY DEFINER do schema sem ele.';

-- ---------------------------------------------------------------------------
-- 3. ACL — menor privilégio, sem partir as políticas
-- ---------------------------------------------------------------------------
--
-- 🔴 `anon` e `authenticated` PRECISAM de EXECUTE, e isso não é relaxamento.
--
--    Uma política de RLS é avaliada com os privilégios de quem pede. Sem
--    EXECUTE, um pedido anónimo rebentava com `permission denied for function`
--    — que revela que a função existe — em vez de simplesmente não devolver
--    nada. Sem sessão, `auth.uid()` é NULL, o resolver devolve NULL, e
--    `id = NULL` nunca é verdadeiro.
--
-- 🔴 O que sai é o EXECUTE de PUBLIC.
--
--    `can_access_service`, `get_my_company_id` e `get_my_role` tinham-no;
--    `get_my_profile_id` não. Nenhuma política precisa dele — são avaliadas
--    como `anon`, `authenticated` ou `service_role`, e os três mantêm-no.
--    Retirá-lo alinha as quatro na forma mais restrita que já existia numa
--    delas.
--
-- 🔴 Os GRANT são condicionais ao papel existir: numa base de ensaio sem os
--    papéis do Supabase, um GRANT a um papel inexistente aborta a migration
--    inteira por um motivo que nada tem a ver com o que ela faz.

DO $acl$
DECLARE
  r text;
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.get_my_profile_id()',
    'public.can_access_service(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);

    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
      END IF;
    END LOOP;
  END LOOP;
END;
$acl$;

-- ---------------------------------------------------------------------------
-- 4. Pós-estado — o que esta migration promete ter deixado
-- ---------------------------------------------------------------------------
--
-- 🔴 Se alguma promessa não se cumprir, a migration FALHA e nada fica
--    aplicado. Um resolver que parece endurecido e não está é pior do que um
--    que não mudou: ninguém volta a olhar para ele.

DO $poststate$
DECLARE
  v_oid oid;
  v_src text;
  v_config text[];
  v_grantees text[];
  v_grantable boolean;
  f text;
  r text;
BEGIN
  -- ── O resolver ──────────────────────────────────────────────────────────
  v_oid := to_regprocedure('public.get_my_profile_id()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'COLAB_106_POSTSTATE_FAILED: get_my_profile_id desapareceu';
  END IF;

  SELECT p.prosrc, p.proconfig INTO v_src, v_config FROM pg_proc p WHERE p.oid = v_oid;

  IF position('status' in v_src) = 0 OR position('ativo' in v_src) = 0 THEN
    RAISE EXCEPTION
      'COLAB_106_POSTSTATE_FAILED: get_my_profile_id não filtra por estado activo';
  END IF;

  -- 🔴 Os DOIS ramos. Um `UNION ALL` com o filtro só no primeiro deixaria a
  --    convenção antiga a resolver identidades não activas.
  IF (length(v_src) - length(replace(v_src, 'ativo', ''))) / length('ativo') < 2 THEN
    RAISE EXCEPTION
      'COLAB_106_POSTSTATE_FAILED: só um dos ramos de get_my_profile_id filtra por estado';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND prosecdef) THEN
    RAISE EXCEPTION 'COLAB_106_POSTSTATE_FAILED: get_my_profile_id deixou de ser SECURITY DEFINER';
  END IF;

  IF v_config IS NULL THEN
    RAISE EXCEPTION 'COLAB_106_POSTSTATE_FAILED: get_my_profile_id sem search_path';
  END IF;

  -- ── can_access_service ──────────────────────────────────────────────────
  v_oid := to_regprocedure('public.can_access_service(uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'COLAB_106_POSTSTATE_FAILED: can_access_service desapareceu';
  END IF;

  SELECT p.prosrc, p.proconfig INTO v_src, v_config FROM pg_proc p WHERE p.oid = v_oid;

  IF position('get_my_profile_id' in v_src) = 0 THEN
    RAISE EXCEPTION
      'COLAB_106_POSTSTATE_FAILED: can_access_service não passa pelo resolver canónico';
  END IF;

  -- 🔴 A comparação directa com `auth.uid()` tem de ter DESAPARECIDO. Enquanto
  --    lá estiver, a função continua a assumir profiles.id = id do Auth.
  IF position('auth.uid()' in v_src) > 0 THEN
    RAISE EXCEPTION
      'COLAB_106_POSTSTATE_FAILED: can_access_service ainda usa auth.uid() directamente';
  END IF;

  IF NOT ('search_path=pg_catalog, public' = ANY(coalesce(v_config, '{}'))) THEN
    RAISE EXCEPTION
      'COLAB_106_POSTSTATE_FAILED: can_access_service sem o search_path exacto (%)',
      coalesce(array_to_string(v_config, ', '), 'NULL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND prosecdef) THEN
    RAISE EXCEPTION
      'COLAB_106_POSTSTATE_FAILED: can_access_service deixou de ser SECURITY DEFINER — as políticas de services entrariam em recursão';
  END IF;

  -- ── ACL das duas ────────────────────────────────────────────────────────
  FOREACH f IN ARRAY ARRAY['public.get_my_profile_id()', 'public.can_access_service(uuid)'] LOOP
    v_oid := to_regprocedure(f);

    SELECT array_agg(DISTINCT acl.grantee::regrole::text ORDER BY acl.grantee::regrole::text),
           bool_or(acl.is_grantable)
      INTO v_grantees, v_grantable
      FROM pg_proc p,
           LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
     WHERE p.oid = v_oid AND acl.privilege_type = 'EXECUTE';

    -- 🔴 PUBLIC aparece em `aclexplode` como o papel de oid 0, que
    --    `::regrole::text` mostra como `-`. É essa a forma que não pode estar
    --    cá: EXECUTE implícito para toda a gente.
    IF '-' = ANY(coalesce(v_grantees, '{}')) THEN
      RAISE EXCEPTION
        'COLAB_106_POSTSTATE_FAILED: % ainda tem EXECUTE para PUBLIC', f;
    END IF;

    IF coalesce(v_grantable, false) THEN
      RAISE EXCEPTION 'COLAB_106_POSTSTATE_FAILED: % tem EXECUTE com WITH GRANT OPTION', f;
    END IF;

    -- Os papéis que as políticas precisam continuam lá.
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
         AND NOT (r = ANY(coalesce(v_grantees, '{}'))) THEN
        RAISE EXCEPTION
          'COLAB_106_POSTSTATE_FAILED: % perdeu EXECUTE para % — as políticas de RLS deixariam de poder avaliá-la', f, r;
      END IF;
    END LOOP;
  END LOOP;

  -- ── NO_DATA_LOSS ────────────────────────────────────────────────────────
  --
  -- 🔴 Esta migration não escreve em `profiles`. A verificação existe porque
  --    uma versão futura pode ser tentada a «arrumar» os estados, e isso seria
  --    decidir por outra pessoa o que fazer com a saída dela.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE status <> 'ativo')
     AND EXISTS (SELECT 1 FROM public.profiles) THEN
    RAISE NOTICE
      'COLAB_106: nenhum perfil não activo nesta base — nada a revogar, a regra fica instalada na mesma.';
  END IF;
END;
$poststate$;
