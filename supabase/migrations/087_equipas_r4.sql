-- ============================================================================
-- 087 — Equipas R4: três conceitos separados, e um save por transação
-- ============================================================================
--
-- 🔴 MIGRATION_NUMBER = 087. Número atribuído só depois de leitura read-only
--    fresca do ledger de produção confirmar 086 aplicada e ausência de 087.
--
-- ── O defeito que isto fecha ───────────────────────────────────────────────
--
-- 🔴 Hoje, arrastar uma pessoa no calendário ESCREVE, e escreve PERMANENTE.
--
--    `handleDragEnd` chama `moveCollaboratorToTeam` a meio do gesto. Essa
--    função fecha a pertença ativa noutras equipas, faz upsert na de destino,
--    **apaga todas as reatribuições diárias da pessoa**, notifica-a no
--    telemóvel, e revalida as páginas. Tudo isto por um arrasto, antes de
--    alguém carregar em «Guardar alocações».
--
--    Consequências, todas observadas:
--
--      · não há como cancelar — o botão Fechar não desfaz nada;
--      · «Guardar alocações» só guarda viaturas, porque as pessoas já foram
--        gravadas uma a uma;
--      · um arrasto experimental notifica a colaboradora;
--      · decisões diárias já planeadas são destruídas em silêncio.
--
-- ── Três conceitos que NÃO são o mesmo ─────────────────────────────────────
--
--    PERMANENT_TEAM      `team_members` com `left_at IS NULL`.
--                        Editado em: Menu → Equipas → Editar equipa.
--
--    DAILY_TEAM_OVERRIDE `collaborator_ride_assignments` para uma DATA.
--                        Editado em: Calendário → Alocação de equipas.
--
--    SERVICE_TEAM        `services.team_id`.
--                        NÃO se sincroniza automaticamente com os outros dois.
--
--    São relacionados. Não são idênticos. Confundi-los foi o que produziu um
--    modal de calendário a reescrever a composição permanente das equipas.
--
-- ── A regra de precedência, para um dia ────────────────────────────────────
--
--    Para colaboradora ativa e não ausente na data:
--
--      existe linha em collaborator_ride_assignments para a data?
--        team_id = UUID  → equipa efetiva nesse dia = UUID
--        team_id = NULL  → DISPONÍVEL / stand by nesse dia
--      não existe linha?
--        tem pertença ativa → a equipa permanente
--        não tem            → DISPONÍVEL
--
-- 🔴 LINHA AUSENTE != LINHA COM team_id NULL.
--
--    É esta distinção que torna possível pôr alguém em stand by num dia
--    concreto sem a tirar da equipa. Sem ela, «disponível hoje» e «não tem
--    equipa» colapsam no mesmo estado, e a operação perde a diferença entre
--    uma decisão e uma ausência de decisão. Por isso `team_id` passa a ser
--    NULLABLE, e a ausência de linha continua a significar «sem decisão».
--
-- ── O que esta migration NÃO faz ───────────────────────────────────────────
--
--    · não toca em `services.team_id` — SERVICE_TEAM continua separado;
--    · não apaga uma única linha de `collaborator_ride_assignments`. Mudar a
--      equipa permanente de alguém não invalida uma decisão explícita já
--      tomada para um dia concreto (ver `save_permanent_team_atomic`);
--    · não faz hard-delete de equipas. Arquiva;
--    · não notifica. As notificações são do lado da aplicação, e só DEPOIS do
--      commit.
-- ============================================================================

-- ─── 0. Precondições — fail-closed antes de qualquer DDL ────────────────────
--
-- 🔴 Cada guarda aceita o prestate OU o poststate desta migration, para que
--    reaplicar continue a funcionar. Qualquer terceiro estado para tudo.
DO $precondicoes$
DECLARE
  v_tipo     text;
  v_n        integer;
  v_dupes    integer;
  v_revision_nullable text;
  v_revision_default  text;
  v_revision_exists   boolean;
  v_legacy_ok boolean := false;
  v_r4_ok     boolean := false;
  v_fn_oid    oid;
  r_tab      record;
BEGIN
  -- 0a. As tabelas de que isto depende existem.
  FOR r_tab IN
    SELECT * FROM (VALUES
      ('public.teams'), ('public.team_members'), ('public.profiles'),
      ('public.collaborator_ride_assignments'), ('public.vehicle_allocations'),
      ('public.absences')
    ) AS t(nome)
  LOOP
    IF to_regclass(r_tab.nome) IS NULL THEN
      RAISE EXCEPTION 'EQUIPAS_R4_MISSING_DEPENDENCY: % não existe', r_tab.nome;
    END IF;
  END LOOP;

  -- 0b. `teams.revision` — só três mundos aceites:
  --     A. repo prestate: sem revision e sem triggers de revision;
  --     B. production legacy exacto: revision int NOT NULL DEFAULT 1 +
  --        trg_teams_revision -> fn_increment_revision(), bump em todo UPDATE;
  --     C. R4 poststate exacto: revision int NOT NULL + trigger/função R4.
  --
  SELECT data_type, is_nullable, column_default
    INTO v_tipo, v_revision_nullable, v_revision_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'revision';

  v_revision_exists := v_tipo IS NOT NULL;

  IF v_revision_exists AND v_tipo <> 'integer' THEN
    RAISE EXCEPTION
      'EQUIPAS_R4_UNEXPECTED_TEAMS_REVISION: teams.revision é % — esperado integer', v_tipo;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.teams'::regclass
     AND NOT t.tgisinternal
     AND (
       t.tgname IN ('trg_teams_revision', 'trg_teams_bump_revision')
       OR p.proname IN ('fn_increment_revision', 'fn_teams_bump_revision')
       OR t.tgname ILIKE '%revision%'
     );

  IF NOT v_revision_exists THEN
    IF v_n <> 0 THEN
      RAISE EXCEPTION
        'EQUIPAS_R4_UNEXPECTED_REVISION_STATE: trigger de revision existe sem teams.revision';
    END IF;
  ELSE
    IF v_revision_nullable <> 'NO' OR coalesce(v_revision_default, '') <> '1' THEN
      RAISE EXCEPTION
        'EQUIPAS_R4_UNEXPECTED_TEAMS_REVISION: esperado integer NOT NULL DEFAULT 1, obtido nullable=% default=%',
        v_revision_nullable, coalesce(v_revision_default, '(sem default)');
    END IF;

    SELECT (
      v_n = 1
      AND EXISTS (
        SELECT 1
          FROM pg_trigger t
          JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE t.tgrelid = 'public.teams'::regclass
           AND NOT t.tgisinternal
           AND t.tgname = 'trg_teams_revision'
           AND p.proname = 'fn_increment_revision'
           AND pg_get_functiondef(p.oid) LIKE '%NEW.revision := COALESCE(OLD.revision, 0) + 1%'
      )
    ) INTO v_legacy_ok;

    SELECT (
      v_n = 1
      AND EXISTS (
        SELECT 1
          FROM pg_trigger t
          JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE t.tgrelid = 'public.teams'::regclass
           AND NOT t.tgisinternal
           AND t.tgname = 'trg_teams_bump_revision'
           AND p.proname = 'fn_teams_bump_revision'
           AND pg_get_functiondef(p.oid) LIKE '%to_jsonb(OLD) - ''revision'' - ''updated_at''%'
      )
    ) INTO v_r4_ok;

    IF NOT v_legacy_ok AND NOT v_r4_ok THEN
      RAISE EXCEPTION
        'EQUIPAS_R4_UNEXPECTED_REVISION_STATE: revision existe mas mecanismo não é legacy exacto nem R4 exacto';
    END IF;
  END IF;

  -- 0c. 🔴 Ninguém pode estar em duas equipas permanentes ao mesmo tempo.
  --
  --    O índice parcial da secção 2 falharia com um erro cru do PostgreSQL se
  --    isto já acontecesse. Falhar aqui, com nomes, é a diferença entre «a
  --    migration rebentou» e «estas pessoas têm de ser arrumadas primeiro».
  SELECT count(*) INTO v_dupes
    FROM (
      SELECT collaborator_id
        FROM public.team_members
       WHERE left_at IS NULL
       GROUP BY collaborator_id
      HAVING count(*) > 1
    ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'EQUIPAS_R4_DUPLICATE_ACTIVE_MEMBERSHIP: % colaborador(es) com pertença ativa a mais de uma equipa. Encerrar as duplicadas com left_at antes de aplicar.',
      v_dupes;
  END IF;

  SELECT count(*) INTO v_dupes
    FROM (
      SELECT team_id, date
        FROM public.vehicle_allocations
       GROUP BY team_id, date
      HAVING count(*) > 1
    ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'EQUIPAS_R4_DUPLICATE_TEAM_DATE_VEHICLE: % team/date duplicado(s) em vehicle_allocations',
      v_dupes;
  END IF;

  -- 0d. `collaborator_ride_assignments.team_id` — NOT NULL (prestate) ou já
  --     nullable (poststate). Nada mais.
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'collaborator_ride_assignments'
     AND column_name  = 'team_id'
     AND data_type    = 'uuid';

  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'EQUIPAS_R4_UNEXPECTED_RIDE_ASSIGNMENTS: collaborator_ride_assignments.team_id não é uuid';
  END IF;

  -- 0e. A identidade do override é (collaborator_id, date). Sem ela, o
  --     `ON CONFLICT` do batch não tem árbitro e o INSERT rebenta com 42P10
  --     em runtime — num caminho que decide onde as pessoas trabalham.
  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'public.collaborator_ride_assignments'::regclass
     AND contype  = 'u'
     AND pg_get_constraintdef(oid) LIKE '%(collaborator_id, date)%';

  IF v_n < 1 THEN
    RAISE EXCEPTION
      'EQUIPAS_R4_MISSING_RIDE_IDENTITY: falta UNIQUE(collaborator_id, date) em collaborator_ride_assignments';
  END IF;
END
$precondicoes$;

-- ─── 1. teams.revision — token de concorrência da equipa permanente ─────────
--
-- Aditivo. Se produção já a tiver, o `IF NOT EXISTS` não faz nada e o trigger
-- é substituído pela versão desta migration.
ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

DROP TRIGGER IF EXISTS trg_teams_revision ON public.teams;

DO $adopt_legacy_revision$
DECLARE
  v_oid oid;
BEGIN
  SELECT to_regprocedure('public.fn_increment_revision()')::oid INTO v_oid;

  IF v_oid IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_depend
        WHERE refobjid = v_oid
          AND classid = 'pg_trigger'::regclass
     ) THEN
    DROP FUNCTION public.fn_increment_revision();
  END IF;
END
$adopt_legacy_revision$;

-- 🔴 O incremento vive num trigger, e não em cada `UPDATE` escrito à mão.
--    Um token de concorrência que dependa de quem escreve a query lembrar-se
--    de o incrementar não é um token: é uma convenção, e as convenções não
--    param uma segunda escrita.
CREATE OR REPLACE FUNCTION public.fn_teams_bump_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  -- Só quando algo mudou de facto. Um `UPDATE` que não altera nada não é uma
  -- alteração, e fazer avançar a revisão por causa dele invalidaria o token de
  -- quem estivesse a editar sem motivo nenhum.
  IF to_jsonb(OLD) - 'revision' - 'updated_at' IS DISTINCT FROM
     to_jsonb(NEW) - 'revision' - 'updated_at' THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_teams_bump_revision ON public.teams;
CREATE TRIGGER trg_teams_bump_revision
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.fn_teams_bump_revision();

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_allocations_team_date_unique
  ON public.vehicle_allocations (team_id, date);

-- ─── 2. team_members — histórico, e uma só pertença ativa ───────────────────
--
-- 🔴 `UNIQUE(team_id, collaborator_id)` da 004 deixa de poder ser a invariante.
--
--    Ela impede que exista mais do que uma linha para o mesmo par — e é
--    exactamente isso que o histórico precisa: se alguém sair da Equipa 1 em
--    Março e voltar em Setembro, são duas pertenças distintas, com datas
--    distintas. Com o UNIQUE antigo, a segunda só cabe reescrevendo a
--    primeira, e a passagem por outra equipa desaparece do registo.
--
--    É esta constraint que obriga o `saveEquipa` actual a fazer DELETE ALL +
--    INSERT ALL: sem poder acrescentar, só resta substituir.
ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_team_id_collaborator_id_key;

-- 🔴 A invariante que passa a valer: no máximo UMA pertença ativa por pessoa.
--
--    Parcial, sobre `left_at IS NULL`. As linhas históricas ficam fora do
--    índice e não estorvam. Uma pessoa em duas equipas ao mesmo tempo deixa de
--    ser representável — que é o que a operação sempre assumiu e a base nunca
--    garantiu.
CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_active_per_collaborator
  ON public.team_members (collaborator_id)
  WHERE left_at IS NULL;

-- Consultas de histórico por pessoa e por equipa.
CREATE INDEX IF NOT EXISTS team_members_collaborator_history_idx
  ON public.team_members (collaborator_id, left_at);
CREATE INDEX IF NOT EXISTS team_members_team_active_idx
  ON public.team_members (team_id) WHERE left_at IS NULL;

COMMENT ON COLUMN public.team_members.left_at IS
  'NULL = pertenca ativa. Uma data = pertenca encerrada nesse dia. Nunca se '
  'apaga a linha: o historico de quem esteve em que equipa e quando e o que '
  'permite explicar um servico antigo. Uma pessoa pode ter varias linhas para '
  'a mesma equipa ao longo do tempo.';

-- ─── 3. O override diário passa a poder dizer «hoje, ninguém» ───────────────
--
-- 🔴 `team_id` NULLABLE. É a diferença entre:
--
--      linha ausente        → não há decisão para este dia; vale a permanente
--      linha com team_id X  → hoje trabalha com a equipa X
--      linha com team_id ⌀  → hoje está em stand by, DE PROPÓSITO
--
--    Sem o terceiro estado, pôr alguém em Disponível num dia só era possível
--    tirando-a da equipa permanente — que é precisamente o defeito que esta
--    frente fecha.
ALTER TABLE public.collaborator_ride_assignments
  ALTER COLUMN team_id DROP NOT NULL;

COMMENT ON COLUMN public.collaborator_ride_assignments.team_id IS
  'Equipa com que a pessoa trabalha NESTE dia. NULL = stand by explicito neste '
  'dia (continua na equipa permanente). A AUSENCIA de linha e diferente: '
  'significa que nao ha decisao para este dia e vale a equipa permanente.';

-- ─── 4. Leitura canónica da equipa efetiva num dia ──────────────────────────
--
-- 🔴 Uma só definição, consumida pelo batch, pelos testes e pela aplicação.
--    Duas implementações da mesma regra divergem — foi assim que o modal
--    passou a mostrar uma composição e a aba Equipas outra.
--
--    Devolve uma linha por colaboradora ativa da empresa, com a origem da
--    decisão. `origem` não é decoração: é a proveniência que distingue «não
--    tem equipa» de «foi posta em stand by hoje», e o produto pede as duas.
CREATE OR REPLACE FUNCTION public.team_day_effective(p_company_id uuid, p_date date)
RETURNS TABLE (
  collaborator_id  uuid,
  effective_team_id uuid,
  permanent_team_id uuid,
  origem           text,   -- 'override_team' | 'override_standby' | 'permanent' | 'sem_equipa'
  ausente          boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
  SELECT
    p.id,
    CASE
      WHEN r.id IS NOT NULL THEN r.team_id
      ELSE pt.id
    END,
    pt.id,
    CASE
      WHEN r.id IS NOT NULL AND r.team_id IS NOT NULL THEN 'override_team'
      WHEN r.id IS NOT NULL                           THEN 'override_standby'
      WHEN pt.id IS NOT NULL                          THEN 'permanent'
      ELSE 'sem_equipa'
    END,
    EXISTS (
      SELECT 1 FROM public.absences a
       WHERE a.company_id = p_company_id
         AND a.collaborator_id = p.id
         AND a.starts_on <= p_date
         AND a.ends_on   >= p_date
    )
  FROM public.profiles p
  LEFT JOIN public.collaborator_ride_assignments r
         ON r.collaborator_id = p.id
        AND r.date            = p_date
        AND r.company_id      = p_company_id
  LEFT JOIN public.team_members tm
         ON tm.collaborator_id = p.id
        AND tm.left_at IS NULL
  LEFT JOIN public.teams pt
         ON pt.id = tm.team_id
        AND pt.company_id = p_company_id
        AND pt.active IS TRUE
  WHERE p.company_id = p_company_id
    AND p.status = 'ativo'
    AND p.role = 'colaborador'
$fn$;

COMMENT ON FUNCTION public.team_day_effective IS
  'Equipa efetiva de cada colaboradora ativa numa data, com a origem da '
  'decisao. Fonte unica da regra de precedencia override > permanente. '
  'ausente=true nao remove a pessoa do resultado: quem decide como a mostrar e '
  'a interface, mas a representacao efetiva e uma so por pessoa/data.';

-- ─── 5. Snapshot do dia — o token de concorrência do batch ──────────────────
--
-- 🔴 O snapshot cobre o estado que dá significado ao draft, não só as tabelas
--    escritas pelo batch. Sem row de override significa "vale a equipa
--    permanente"; logo mudança de membership permanente, ausência, ou equipa
--    ativa tem de invalidar o draft aberto.
CREATE OR REPLACE FUNCTION public.team_day_snapshot(p_company_id uuid, p_date date)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
  SELECT md5(
    coalesce((
      SELECT string_agg(
               e.collaborator_id::text || '>' ||
               coalesce(e.effective_team_id::text, 'SEM') || '>' ||
               coalesce(e.permanent_team_id::text, 'SEM') || '>' ||
               e.origem || '>' || e.ausente::text,
               ',' ORDER BY e.collaborator_id)
        FROM public.team_day_effective(p_company_id, p_date) e
    ), '')
    || '|' ||
    coalesce((
      SELECT string_agg(
               v.team_id::text || '>' || v.vehicle_id::text || '>' || coalesce(v.driver_id::text, '-'),
               ',' ORDER BY v.team_id)
        FROM public.vehicle_allocations v
       WHERE v.company_id = p_company_id AND v.date = p_date
    ), '')
    || '|' ||
    coalesce((
      SELECT string_agg(t.id::text || '>' || t.name || '>' || t.color || '>' || t.revision::text,
                        ',' ORDER BY t.id)
        FROM public.teams t
       WHERE t.company_id = p_company_id AND t.active IS TRUE
    ), '')
  )
$fn$;

-- ─── 5b. Snapshot/locks da configuração permanente ─────────────────────────
--
-- O save permanente pode mover uma pessoa que estava ativa noutra equipa. O
-- token tem de cobrir esse mapa global da empresa, não apenas a equipa aberta.
CREATE OR REPLACE FUNCTION public.permanent_membership_snapshot(p_company_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
  SELECT md5(coalesce((
    SELECT string_agg(
             p.id::text || '>' || coalesce(t.id::text, 'SEM'),
             ',' ORDER BY p.id
           )
      FROM public.profiles p
      LEFT JOIN public.team_members tm
             ON tm.collaborator_id = p.id
            AND tm.left_at IS NULL
      LEFT JOIN public.teams t
             ON t.id = tm.team_id
            AND t.company_id = p_company_id
            AND t.active IS TRUE
     WHERE p.company_id = p_company_id
       AND p.status = 'ativo'
       AND p.role = 'colaborador'
  ), ''))
$fn$;

CREATE OR REPLACE FUNCTION public._team_config_lock_shared(p_company_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
  SELECT pg_advisory_xact_lock_shared(hashtext('team_config'), hashtext(p_company_id::text))
$fn$;

CREATE OR REPLACE FUNCTION public._team_config_lock_exclusive(p_company_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
  SELECT pg_advisory_xact_lock(hashtext('team_config'), hashtext(p_company_id::text))
$fn$;

CREATE OR REPLACE FUNCTION public._team_day_lock_exclusive(p_company_id uuid, p_date date)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
  SELECT pg_advisory_xact_lock(hashtext('team_day:' || p_company_id::text), hashtext(p_date::text))
$fn$;

-- ─── 6. RPC — guardar o dia inteiro numa só transação ───────────────────────
--
-- 🔴 Uma transação, não N escritas em `Promise.all`.
--
--    Hoje o save faz um `Promise.all` de upserts/removes de viatura, e as
--    pessoas já tinham sido gravadas uma a uma pelo drag. Qualquer falha a
--    meio deixa metade do dia guardado — pessoas sim, viatura não, ou o
--    inverso. Não há como saber, olhando para o resultado, o que ficou por
--    aplicar.
CREATE OR REPLACE FUNCTION public.save_team_day_allocations_atomic(
  p_company_id        uuid,
  p_date              date,
  p_actor             uuid,
  p_expected_snapshot text,
  -- [{collaborator_id, team_id|null}] — a lista COMPLETA dos overrides do dia.
  -- Um colaborador ausente desta lista fica sem override (volta à permanente).
  p_overrides         jsonb,
  -- [{team_id, vehicle_id, driver_id|null}] — a lista COMPLETA do dia.
  p_vehicles          jsonb
)
RETURNS TABLE (snapshot text, overrides_escritos integer, viaturas_escritas integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_atual  text;
  v_ov     integer := 0;
  v_veh    integer := 0;
  v_bad    text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = p_actor
       AND p.company_id = p_company_id
       AND p.role IN ('admin', 'gestor')
       AND p.status = 'ativo'
  ) THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_ACTOR_NOT_ALLOWED'
      USING ERRCODE = 'check_violation';
  END IF;

  WITH o AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_overrides, '[]'::jsonb))
      AS x(collaborator_id uuid, team_id uuid)
  )
  SELECT collaborator_id::text INTO v_bad
    FROM o GROUP BY collaborator_id HAVING count(*) > 1 LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_DUPLICATE_COLLABORATOR: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  WITH o AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_overrides, '[]'::jsonb))
      AS x(collaborator_id uuid, team_id uuid)
  )
  SELECT collaborator_id::text INTO v_bad
    FROM o
   WHERE NOT EXISTS (
     SELECT 1 FROM public.profiles p
      WHERE p.id = o.collaborator_id
        AND p.company_id = p_company_id
        AND p.role = 'colaborador'
        AND p.status = 'ativo'
   )
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_INVALID_COLLABORATOR: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  WITH o AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_overrides, '[]'::jsonb))
      AS x(collaborator_id uuid, team_id uuid)
  )
  SELECT team_id::text INTO v_bad
    FROM o
   WHERE team_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.teams t
        WHERE t.id = o.team_id
          AND t.company_id = p_company_id
          AND t.active IS TRUE
     )
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_INVALID_TEAM: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  WITH a AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_vehicles, '[]'::jsonb))
      AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
  )
  SELECT team_id::text INTO v_bad
    FROM a GROUP BY team_id HAVING count(*) > 1 LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_DUPLICATE_TEAM_VEHICLE: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  WITH a AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_vehicles, '[]'::jsonb))
      AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
  )
  SELECT vehicle_id::text INTO v_bad
    FROM a GROUP BY vehicle_id HAVING count(*) > 1 LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_DUPLICATE_VEHICLE: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  WITH a AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_vehicles, '[]'::jsonb))
      AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
  )
  SELECT coalesce(team_id::text, vehicle_id::text, driver_id::text) INTO v_bad
    FROM a
   WHERE NOT EXISTS (
       SELECT 1 FROM public.teams t
        WHERE t.id = a.team_id AND t.company_id = p_company_id AND t.active IS TRUE
     )
      OR NOT EXISTS (
       SELECT 1 FROM public.vehicles v
        WHERE v.id = a.vehicle_id AND v.company_id = p_company_id AND v.status = 'ativo'
     )
      OR (
       a.driver_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.profiles p
          WHERE p.id = a.driver_id
            AND p.company_id = p_company_id
            AND p.role = 'colaborador'
            AND p.status = 'ativo'
       )
     )
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_INVALID_VEHICLE_PAYLOAD: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  WITH a AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_vehicles, '[]'::jsonb))
      AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
  ),
  o AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_overrides, '[]'::jsonb))
      AS x(collaborator_id uuid, team_id uuid)
  ),
  e AS (
    SELECT e.collaborator_id,
           CASE WHEN o.collaborator_id IS NOT NULL THEN o.team_id ELSE e.effective_team_id END AS desired_team_id
      FROM public.team_day_effective(p_company_id, p_date) e
      LEFT JOIN o ON o.collaborator_id = e.collaborator_id
  )
  SELECT a.driver_id::text INTO v_bad
    FROM a
    JOIN e ON e.collaborator_id = a.driver_id
   WHERE a.driver_id IS NOT NULL
     AND e.desired_team_id IS DISTINCT FROM a.team_id
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_DRIVER_NOT_IN_TEAM: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  -- Ordem obrigatória: configuração da empresa primeiro, dia depois. O shared
  -- lock deixa dois dias diferentes correrem em paralelo, mas impede que uma
  -- alteração permanente atravesse a validação/escrita do batch diário.
  PERFORM public._team_config_lock_shared(p_company_id);
  PERFORM public._team_day_lock_exclusive(p_company_id, p_date);

  -- Depois do lock: recalcular. Antes do lock, o valor podia mudar entre a
  -- leitura e a decisão, que é o próprio TOCTOU que isto fecha.
  v_atual := public.team_day_snapshot(p_company_id, p_date);

  IF p_expected_snapshot IS DISTINCT FROM v_atual THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_CONFLICT'
      USING ERRCODE = 'serialization_failure',
            HINT = 'Estas alocacoes foram alteradas por outra pessoa. Atualize para rever antes de guardar.';
  END IF;

  -- ── Overrides do dia ─────────────────────────────────────────────────────
  --
  -- 🔴 Só se apagam os overrides DESTE dia que deixaram de estar na lista.
  --    Nunca os de outros dias: uma decisão tomada para amanhã não é afetada
  --    por se estar a guardar hoje.
  DELETE FROM public.collaborator_ride_assignments r
   WHERE r.company_id = p_company_id
     AND r.date       = p_date
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) AS o
        WHERE (o->>'collaborator_id')::uuid = r.collaborator_id
     );

  INSERT INTO public.collaborator_ride_assignments
    (company_id, collaborator_id, team_id, date, assigned_by)
  SELECT p_company_id,
         (o->>'collaborator_id')::uuid,
         NULLIF(o->>'team_id', '')::uuid,
         p_date,
         p_actor
    FROM jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) AS o
  ON CONFLICT (collaborator_id, date)
  DO UPDATE SET team_id     = EXCLUDED.team_id,
                assigned_by = EXCLUDED.assigned_by,
                updated_at  = now();
  GET DIAGNOSTICS v_ov = ROW_COUNT;

  -- ── Viaturas do dia ──────────────────────────────────────────────────────
  DELETE FROM public.vehicle_allocations v
   WHERE v.company_id = p_company_id
     AND v.date       = p_date;

  INSERT INTO public.vehicle_allocations
    (company_id, vehicle_id, team_id, driver_id, date)
  SELECT p_company_id,
         (a->>'vehicle_id')::uuid,
         (a->>'team_id')::uuid,
         NULLIF(a->>'driver_id', '')::uuid,
         p_date
    FROM jsonb_array_elements(coalesce(p_vehicles, '[]'::jsonb)) AS a
  ON CONFLICT (vehicle_id, date)
  DO UPDATE SET team_id    = EXCLUDED.team_id,
                driver_id  = EXCLUDED.driver_id,
                updated_at = now();
  GET DIAGNOSTICS v_veh = ROW_COUNT;

  RETURN QUERY SELECT public.team_day_snapshot(p_company_id, p_date), v_ov, v_veh;
END
$fn$;

-- ─── 7. RPC — guardar a equipa permanente, sem apagar histórico ─────────────
--
-- 🔴 Nada de DELETE ALL + INSERT ALL.
--
--    Quem continua mantém a linha ativa — o `joined_at` original é a data em
--    que a pessoa entrou, e reescrevê-lo por causa de um save de nome de
--    equipa apagaria um facto verdadeiro.
--    Quem sai fica com `left_at` de hoje.
--    Quem entra ganha uma linha nova.
DROP FUNCTION IF EXISTS public.save_permanent_team_atomic(uuid, uuid, uuid, integer, uuid[], text, text, boolean, uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.save_permanent_team_atomic(
  p_company_id       uuid,
  p_actor            uuid,
  p_team_id          uuid,          -- NULL = criar
  p_expected_revision integer,      -- NULL quando p_team_id é NULL
  p_expected_members  uuid[],       -- pertenças ativas que quem editou viu
  p_expected_membership_snapshot text,
  p_name             text,
  p_color            text,
  p_active           boolean,
  p_leader_id        uuid,
  p_members          uuid[]
)
-- 🔴 Os nomes de saída levam prefixo de propósito. `team_id` e `revision` são
--    colunas reais de `teams`/`team_members`, e uma OUT com o mesmo nome torna
--    ambígua qualquer referência dentro do corpo — o PostgreSQL recusa com
--    «column reference is ambiguous», e o erro aponta para a linha da query em
--    vez de para a assinatura.
RETURNS TABLE (out_team_id uuid, out_revision integer, entraram integer, sairam integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_team     public.teams%ROWTYPE;
  v_id       uuid;
  v_atuais   uuid[];
  v_hoje     date := (now() AT TIME ZONE 'Europe/Lisbon')::date;
  v_in       integer := 0;
  v_out      integer := 0;
  v_rev      integer;
  v_intruso  uuid;
  v_membership_snapshot text;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'TEAM_NAME_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = p_actor
       AND p.company_id = p_company_id
       AND p.role IN ('admin', 'gestor')
       AND p.status = 'ativo'
  ) THEN
    RAISE EXCEPTION 'TEAM_ACTOR_NOT_ALLOWED'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_leader_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.id = p_leader_id
          AND p.company_id = p_company_id
          AND p.status = 'ativo'
     ) THEN
    RAISE EXCEPTION 'TEAM_LEADER_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT m INTO v_intruso
    FROM unnest(coalesce(p_members, '{}'::uuid[])) AS m
   GROUP BY m
  HAVING count(*) > 1
   LIMIT 1;

  IF v_intruso IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_DUPLICATE_MEMBER_PAYLOAD: %', v_intruso
      USING ERRCODE = 'check_violation';
  END IF;

  -- Todos os membros pedidos têm de ser colaboradores ativos da empresa. A FK não o garante:
  -- `team_members.collaborator_id` aponta para `profiles`, sem empresa.
  SELECT m INTO v_intruso
    FROM unnest(coalesce(p_members, '{}'::uuid[])) AS m
   WHERE NOT EXISTS (
     SELECT 1 FROM public.profiles p
      WHERE p.id = m AND p.company_id = p_company_id
        AND p.role = 'colaborador'
        AND p.status = 'ativo'
   )
   LIMIT 1;

  IF v_intruso IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_MEMBER_NOT_ACTIVE_COLLABORATOR: %', v_intruso
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._team_config_lock_exclusive(p_company_id);

  v_membership_snapshot := public.permanent_membership_snapshot(p_company_id);
  IF p_expected_membership_snapshot IS DISTINCT FROM v_membership_snapshot THEN
    RAISE EXCEPTION 'TEAM_SAVE_CONFLICT'
      USING ERRCODE = 'serialization_failure',
            HINT = 'As pertenças permanentes foram alteradas por outra pessoa. Atualize para rever antes de guardar.';
  END IF;

  IF p_team_id IS NULL THEN
    INSERT INTO public.teams (company_id, name, color, active, leader_id)
    VALUES (p_company_id, p_name, coalesce(p_color, '#16A34A'), coalesce(p_active, true), p_leader_id)
    RETURNING id INTO v_id;
    v_atuais := '{}'::uuid[];
  ELSE
    -- 🔴 Lock da linha ANTES de ler a revisão. Ler primeiro e trancar depois
    --    deixa a janela aberta em que a outra pessoa grava.
    SELECT * INTO v_team
      FROM public.teams
     WHERE id = p_team_id AND company_id = p_company_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'TEAM_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    IF p_expected_revision IS DISTINCT FROM v_team.revision THEN
      RAISE EXCEPTION 'TEAM_SAVE_CONFLICT'
        USING ERRCODE = 'serialization_failure',
              HINT = 'Esta equipa foi alterada por outra pessoa. Atualize para rever antes de guardar.';
    END IF;

    -- 🔴 A revisão sozinha não chega: ela muda com `teams`, e a composição vive
    --    em `team_members`. Alguém pode ter acrescentado uma pessoa sem tocar
    --    na linha da equipa, e a revisão ficaria igual. Compara-se também o
    --    conjunto de pertenças ativas que quem editou tinha à frente.
    SELECT coalesce(array_agg(collaborator_id ORDER BY collaborator_id), '{}'::uuid[])
      INTO v_atuais
      FROM public.team_members
     WHERE team_id = p_team_id AND left_at IS NULL;

    IF v_atuais IS DISTINCT FROM (
         SELECT coalesce(array_agg(m ORDER BY m), '{}'::uuid[])
           FROM unnest(coalesce(p_expected_members, '{}'::uuid[])) AS m
       ) THEN
      RAISE EXCEPTION 'TEAM_SAVE_CONFLICT'
        USING ERRCODE = 'serialization_failure',
              HINT = 'Os membros desta equipa foram alterados por outra pessoa. Atualize para rever antes de guardar.';
    END IF;

    UPDATE public.teams
       SET name = p_name, color = coalesce(p_color, color),
           active = coalesce(p_active, active), leader_id = p_leader_id
     WHERE id = p_team_id AND company_id = p_company_id;

    v_id := p_team_id;
  END IF;

  -- ── Quem sai: encerra-se, nunca se apaga ─────────────────────────────────
  UPDATE public.team_members
     SET left_at = v_hoje
   WHERE team_id = v_id
     AND left_at IS NULL
     AND NOT (collaborator_id = ANY(coalesce(p_members, '{}'::uuid[])));
  GET DIAGNOSTICS v_out = ROW_COUNT;

  -- ── Quem entra: linha nova, com a data de hoje ───────────────────────────
  --
  -- 🔴 Antes de inserir, encerra-se qualquer pertença ativa NOUTRA equipa. O
  --    índice parcial da secção 2 recusaria a segunda, e é melhor tratar disto
  --    aqui — mudar de equipa é uma operação legítima — do que devolver uma
  --    violação de índice a quem só quis arrastar um nome.
  UPDATE public.team_members
     SET left_at = v_hoje
   WHERE left_at IS NULL
     AND team_id <> v_id
     AND collaborator_id = ANY(coalesce(p_members, '{}'::uuid[]));

  INSERT INTO public.team_members (team_id, collaborator_id, joined_at)
  SELECT v_id, m, v_hoje
    FROM unnest(coalesce(p_members, '{}'::uuid[])) AS m
   WHERE NOT EXISTS (
     SELECT 1 FROM public.team_members tm
      WHERE tm.team_id = v_id AND tm.collaborator_id = m AND tm.left_at IS NULL
   );
  GET DIAGNOSTICS v_in = ROW_COUNT;

  -- 🔴 NÃO se apagam os overrides diários de quem saiu.
  --
  --    Uma pessoa pode deixar a Equipa 1 permanentemente E continuar a ter,
  --    para quinta-feira, uma decisão explícita de trabalhar com a Equipa 3.
  --    Essa decisão foi tomada para aquele dia e continua válida. Apagá-las
  --    todas — que é o que `moveCollaboratorToTeam` faz hoje — destrói
  --    planeamento operacional real sem o dizer a ninguém.

  SELECT t.revision INTO v_rev FROM public.teams t WHERE t.id = v_id;
  RETURN QUERY SELECT v_id, v_rev, v_in, v_out;
END
$fn$;

-- ─── 8. RPC — arquivar equipa (nunca apagar) ────────────────────────────────
--
-- 🔴 `deleteEquipa` faz hoje `DELETE FROM teams`. As FKs são `ON DELETE
--    CASCADE` para `team_members` e `vehicle_allocations`: apagar uma equipa
--    leva atrás o histórico inteiro de quem lá esteve e de que viatura usou.
--    Os `services` ficam com `team_id` NULL — um serviço antigo deixa de saber
--    quem o fez.
--
--    Arquivar responde à mesma necessidade («esta equipa já não existe») sem
--    destruir o passado.
CREATE OR REPLACE FUNCTION public.archive_team_atomic(
  p_company_id uuid,
  p_actor      uuid,
  p_team_id    uuid
)
RETURNS TABLE (out_team_id uuid, memberships_encerradas integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'Europe/Lisbon')::date;
  v_n    integer := 0;
  v_future_services integer := 0;
  v_future_overrides integer := 0;
  v_future_vehicles integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = p_actor
       AND p.company_id = p_company_id
       AND p.role IN ('admin', 'gestor')
       AND p.status = 'ativo'
  ) THEN
    RAISE EXCEPTION 'TEAM_ACTOR_NOT_ALLOWED'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public._team_config_lock_exclusive(p_company_id);

  PERFORM 1 FROM public.teams
   WHERE id = p_team_id AND company_id = p_company_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEAM_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF to_regclass('public.services') IS NOT NULL THEN
    EXECUTE
      'SELECT count(*) FROM public.services WHERE company_id = $1 AND team_id = $2 AND scheduled_start::date >= $3'
      INTO v_future_services
      USING p_company_id, p_team_id, v_hoje;
  END IF;

  SELECT count(*) INTO v_future_overrides
    FROM public.collaborator_ride_assignments
   WHERE company_id = p_company_id
     AND team_id = p_team_id
     AND date >= v_hoje;

  SELECT count(*) INTO v_future_vehicles
    FROM public.vehicle_allocations
   WHERE company_id = p_company_id
     AND team_id = p_team_id
     AND date >= v_hoje;

  IF v_future_services > 0 OR v_future_overrides > 0 OR v_future_vehicles > 0 THEN
    RAISE EXCEPTION
      'TEAM_ARCHIVE_BLOCKED_BY_FUTURE_ASSIGNMENTS: services=% overrides=% vehicle_allocations=%',
      v_future_services, v_future_overrides, v_future_vehicles
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.teams SET active = false
   WHERE id = p_team_id AND company_id = p_company_id;

  -- As pertenças activas fecham-se com a data de hoje: a equipa deixou de
  -- existir operacionalmente, e uma pertença activa a uma equipa arquivada
  -- seria uma afirmação falsa.
  UPDATE public.team_members
     SET left_at = v_hoje
   WHERE team_id = p_team_id AND left_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN QUERY SELECT p_team_id, v_n;
END
$fn$;

-- ─── 8b. A view ganha a revisão, e continua a ser a ÚNICA definição ─────────
--
-- 🔴 `teams_with_members` (010) já filtra `left_at IS NULL` — é ela a definição
--    canónica de «membro activo», e a aba Equipas lê dela. Não se cria uma
--    segunda: acrescenta-se-lhe a revisão, para que o ecrã possa mandar o token
--    de concorrência de volta sem uma segunda consulta que podia ler noutro
--    instante.
--
--    `CREATE OR REPLACE VIEW` só aceita acrescentar colunas no FIM. É por isso
--    que `revision` vai para o fim, e não junto de `active`, onde ficaria melhor.
CREATE OR REPLACE VIEW public.teams_with_members AS
SELECT
  t.id,
  t.company_id,
  t.name,
  t.color,
  t.active,
  t.leader_id,
  COALESCE(
    json_agg(
      json_build_object(
        'id', p.id,
        'full_name', p.full_name,
        'avatar_url', p.avatar_url,
        'phone', p.phone
      )
    ) FILTER (WHERE p.id IS NOT NULL),
    '[]'
  ) AS members,
  t.revision,
  public.permanent_membership_snapshot(t.company_id) AS membership_snapshot
FROM public.teams t
LEFT JOIN public.team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
LEFT JOIN public.profiles p ON p.id = tm.collaborator_id
GROUP BY t.id, t.company_id, t.name, t.color, t.active, t.leader_id, t.revision;

-- ─── 9. ACL — service_role apenas ───────────────────────────────────────────
--
-- Todas são `SECURITY INVOKER`: sem esta revogação, qualquer autenticado podia
-- chamá-las e saltar a guarda de papel da Server Action.
REVOKE ALL PRIVILEGES ON FUNCTION public.team_day_effective(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.team_day_effective(uuid, date) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.team_day_snapshot(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.team_day_snapshot(uuid, date) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.permanent_membership_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.permanent_membership_snapshot(uuid) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.save_team_day_allocations_atomic(uuid, date, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_team_day_allocations_atomic(uuid, date, uuid, text, jsonb, jsonb) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.save_permanent_team_atomic(uuid, uuid, uuid, integer, uuid[], text, text, text, boolean, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_permanent_team_atomic(uuid, uuid, uuid, integer, uuid[], text, text, text, boolean, uuid, uuid[]) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.archive_team_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.archive_team_atomic(uuid, uuid, uuid) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.fn_teams_bump_revision() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public._team_config_lock_shared(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public._team_config_lock_exclusive(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public._team_day_lock_exclusive(uuid, date) FROM PUBLIC, anon, authenticated;

-- ─── 10. Pós-estado — a migration verifica-se a si própria ──────────────────
DO $posestado$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='teams' AND column_name='revision') <> 1 THEN
    RAISE EXCEPTION 'EQUIPAS_R4_POSTSTATE_FAILED: teams.revision ausente';
  END IF;

  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='collaborator_ride_assignments'
         AND column_name='team_id') <> 'YES' THEN
    RAISE EXCEPTION 'EQUIPAS_R4_POSTSTATE_FAILED: ride_assignments.team_id continua NOT NULL';
  END IF;

  IF to_regclass('public.team_members_one_active_per_collaborator') IS NULL THEN
    RAISE EXCEPTION 'EQUIPAS_R4_POSTSTATE_FAILED: indice de pertenca ativa unica ausente';
  END IF;

  IF to_regclass('public.vehicle_allocations_team_date_unique') IS NULL THEN
    RAISE EXCEPTION 'EQUIPAS_R4_POSTSTATE_FAILED: UNIQUE(team_id,date) de viaturas ausente';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.teams'::regclass
       AND NOT t.tgisinternal
       AND (
         t.tgname ILIKE '%revision%'
         OR t.tgname = 'trg_teams_bump_revision'
         OR p.proname IN ('fn_increment_revision', 'fn_teams_bump_revision')
       )
  ) <> 1 THEN
    RAISE EXCEPTION 'EQUIPAS_R4_POSTSTATE_FAILED: esperado exatamente um trigger de revision';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.teams'::regclass
       AND NOT t.tgisinternal
       AND t.tgname = 'trg_teams_bump_revision'
       AND p.proname = 'fn_teams_bump_revision'
  ) THEN
    RAISE EXCEPTION 'EQUIPAS_R4_POSTSTATE_FAILED: trigger R4 canónico ausente';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.team_members'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%(team_id, collaborator_id)%'
  ) THEN
    RAISE EXCEPTION
      'EQUIPAS_R4_POSTSTATE_FAILED: UNIQUE(team_id, collaborator_id) ainda existe — o historico continua impossivel';
  END IF;
END
$posestado$;
