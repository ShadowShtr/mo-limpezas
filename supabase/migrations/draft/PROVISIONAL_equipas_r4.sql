-- ============================================================================
-- PROVISIONAL — Equipas R4: três conceitos separados, e um save por transação
-- ============================================================================
--
-- 🔴 MIGRATION_NUMBER = PROVISIONAL. Este ficheiro vive em `draft/` de
--    propósito: a 086 ainda não está integrada, e atribuir-lhe 087 agora seria
--    reservar um número que pode colidir. O número final atribui-se depois de
--    a #119 ser mesclada e a 086 aplicada — com `BASE_CHANGED =
--    REVALIDATION_REQUIRED` e nova varredura de colisão.
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

  -- 0b. `teams.revision` — ausente (criamos) ou já do tipo certo.
  --
  -- 🔴 A direção indicou que produção já tem `teams.revision` e um trigger de
  --    incremento. O REPOSITÓRIO não o confirma: a 004 não o cria, nenhuma
  --    migration o acrescenta, e `src/types/database.ts` não o declara em
  --    `teams.Row`. Não é possível decidir isto sem ler produção.
  --
  --    Por isso esta migration funciona nos dois mundos: se a coluna faltar,
  --    cria-a de forma aditiva; se existir, exige que seja inteira e usa-a. O
  --    que NÃO faz é assumir. Qualquer outro tipo para tudo — uma coluna
  --    `revision` de outro tipo é outra coisa com o mesmo nome.
  SELECT data_type INTO v_tipo
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'revision';

  IF v_tipo IS NOT NULL AND v_tipo NOT IN ('integer', 'bigint', 'smallint') THEN
    RAISE EXCEPTION
      'EQUIPAS_R4_UNEXPECTED_TEAMS_REVISION: teams.revision é % — esperado um inteiro', v_tipo;
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
      ELSE tm.team_id
    END,
    tm.team_id,
    CASE
      WHEN r.id IS NOT NULL AND r.team_id IS NOT NULL THEN 'override_team'
      WHEN r.id IS NOT NULL                           THEN 'override_standby'
      WHEN tm.team_id IS NOT NULL                     THEN 'permanent'
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
  WHERE p.company_id = p_company_id
    AND p.status = 'ativo'
$fn$;

COMMENT ON FUNCTION public.team_day_effective IS
  'Equipa efetiva de cada colaboradora ativa numa data, com a origem da '
  'decisao. Fonte unica da regra de precedencia override > permanente. '
  'ausente=true nao remove a pessoa do resultado: quem decide como a mostrar e '
  'a interface, mas a representacao efetiva e uma so por pessoa/data.';

-- ─── 5. Snapshot do dia — o token de concorrência do batch ──────────────────
--
-- 🔴 O snapshot cobre EXACTAMENTE o que o batch escreve: os overrides do dia e
--    as alocações de viatura do dia. Nem mais — incluir a composição permanente
--    faria uma edição na aba Equipas invalidar um save de calendário sem
--    necessidade — nem menos.
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
               r.collaborator_id::text || '>' || coalesce(r.team_id::text, 'STANDBY'),
               ',' ORDER BY r.collaborator_id)
        FROM public.collaborator_ride_assignments r
       WHERE r.company_id = p_company_id AND r.date = p_date
    ), '')
    || '|' ||
    coalesce((
      SELECT string_agg(
               v.team_id::text || '>' || v.vehicle_id::text || '>' || coalesce(v.driver_id::text, '-'),
               ',' ORDER BY v.team_id)
        FROM public.vehicle_allocations v
       WHERE v.company_id = p_company_id AND v.date = p_date
    ), '')
  )
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
BEGIN
  -- 🔴 Lock por empresa + data, e não por empresa.
  --
  --    Dois gestores a editar dias diferentes não têm conflito nenhum, e
  --    bloqueá-los um ao outro seria inventar contenção onde não existe. A
  --    chave é o par, e é por isso que são dois inteiros no advisory lock.
  PERFORM pg_advisory_xact_lock(
    hashtext('team_day:' || p_company_id::text),
    hashtext(p_date::text)
  );

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
     AND v.date       = p_date
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(p_vehicles, '[]'::jsonb)) AS a
        WHERE (a->>'team_id')::uuid = v.team_id
     );

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
CREATE OR REPLACE FUNCTION public.save_permanent_team_atomic(
  p_company_id       uuid,
  p_actor            uuid,
  p_team_id          uuid,          -- NULL = criar
  p_expected_revision integer,      -- NULL quando p_team_id é NULL
  p_expected_members  uuid[],       -- pertenças ativas que quem editou viu
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
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'TEAM_NAME_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  -- Todos os membros pedidos têm de ser da empresa. A FK não o garante:
  -- `team_members.collaborator_id` aponta para `profiles`, sem empresa.
  SELECT m INTO v_intruso
    FROM unnest(coalesce(p_members, '{}'::uuid[])) AS m
   WHERE NOT EXISTS (
     SELECT 1 FROM public.profiles p
      WHERE p.id = m AND p.company_id = p_company_id
   )
   LIMIT 1;

  IF v_intruso IS NOT NULL THEN
    RAISE EXCEPTION 'TEAM_MEMBER_WRONG_COMPANY: %', v_intruso
      USING ERRCODE = 'check_violation';
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
BEGIN
  PERFORM 1 FROM public.teams
   WHERE id = p_team_id AND company_id = p_company_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEAM_NOT_FOUND' USING ERRCODE = 'no_data_found';
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
  t.revision
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

REVOKE ALL PRIVILEGES ON FUNCTION public.save_team_day_allocations_atomic(uuid, date, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_team_day_allocations_atomic(uuid, date, uuid, text, jsonb, jsonb) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.save_permanent_team_atomic(uuid, uuid, uuid, integer, uuid[], text, text, boolean, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_permanent_team_atomic(uuid, uuid, uuid, integer, uuid[], text, text, boolean, uuid, uuid[]) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.archive_team_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.archive_team_atomic(uuid, uuid, uuid) TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.fn_teams_bump_revision() FROM PUBLIC, anon, authenticated;

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
