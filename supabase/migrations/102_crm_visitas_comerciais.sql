-- ============================================================================
-- 102 — CRM: a visita comercial
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- Esta migration é FUNDAÇÃO. Cria a tabela que a agenda de visitas vai usar
-- numa PR seguinte. Não muda nenhum ecrã.
--
-- ---------------------------------------------------------------------------
-- 🔴 Porque é que isto NÃO é uma linha em `services`
-- ---------------------------------------------------------------------------
--
-- É a pergunta mais importante deste ficheiro, e a resposta já está escrita
-- neste repositório: a 086 rejeitou, por escrito, representar uma cobrança com
-- um `services` fictício — «criar trabalho a fingir para registar uma cobrança
-- é mentir a toda a operação para agradar ao financeiro». O argumento vale aqui
-- sem alteração, e há ainda três razões próprias:
--
--   1. `services.location_id` é NOT NULL, e uma lead não tem local. Criar um
--      `locations` para poder marcar uma visita poria uma morada por
--      confirmar — de alguém que talvez nunca venha a ser cliente — na lista
--      de Locais, no Mapa, e nas consultas de contratos.
--
--   2. Uma visita comercial não é trabalho executado. Não tem equipa, não tem
--      ponto, não tem horas a pagar, e não tem valor a facturar. Um `services`
--      fictício entraria na escala, no espelho de equipas, nos relatórios
--      operacionais de horas, no realtime de `services` — e, o pior de tudo,
--      em `getUnbilledServices`, que o listaria como «por facturar». Alguém
--      acabaria por o facturar.
--
--   3. Tornar `services.location_id` nullable para caber aqui obrigaria a
--      rever dezenas de consumidores que hoje assumem que existe sempre.
--      Raio de explosão enorme para representar algo que não é um serviço.
--
-- Por isso: tabela própria, com o vocabulário do que é — `nao_compareceu`,
-- `area_sqm`, `estimated_hours` — e sem o vocabulário do que não é.
--
-- ---------------------------------------------------------------------------
-- O que a visita mede, e porquê
-- ---------------------------------------------------------------------------
--
-- `area_sqm`, `estimated_hours` e `frequency_hint` são a razão de a visita
-- existir: é o que se vai lá ver, e é o que vai pré-preencher as linhas do
-- orçamento. Uma visita que não deixasse nada registado seria uma entrada de
-- agenda, não uma etapa comercial.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
--   · não toca em `services`, `contracts`, `locations` nem em nada financeiro;
--   · não cria orçamentos (103);
--   · não mexe no calendário — a vista do calendário, se vier, lê esta tabela
--     como camada sobreposta e não altera o modelo de `services`;
--   · não publica nada no Realtime.
-- ============================================================================

DO $precondicoes$
BEGIN
  IF to_regclass('public.crm_leads') IS NULL THEN
    RAISE EXCEPTION 'CRM_VISITS_102_PRECONDITION_FAILED: crm_leads ausente (a 101 não correu?)';
  END IF;

  IF to_regclass('public.crm_leads_id_company_unique') IS NULL THEN
    RAISE EXCEPTION 'CRM_VISITS_102_PRECONDITION_FAILED: índice crm_leads_id_company_unique ausente (101)';
  END IF;

  IF to_regclass('public.clients_id_company_unique') IS NULL THEN
    RAISE EXCEPTION 'CRM_VISITS_102_PRECONDITION_FAILED: índice clients_id_company_unique ausente (086)';
  END IF;

  IF to_regprocedure('public.update_updated_at()') IS NULL
     OR to_regprocedure('public.fn_capture_history()') IS NULL THEN
    RAISE EXCEPTION 'CRM_VISITS_102_PRECONDITION_FAILED: update_updated_at()/fn_capture_history() ausentes';
  END IF;

  IF to_regprocedure('public.get_my_company_id()') IS NULL
     OR to_regprocedure('public.get_my_role()') IS NULL THEN
    RAISE EXCEPTION 'CRM_VISITS_102_PRECONDITION_FAILED: get_my_company_id()/get_my_role() ausentes (014)';
  END IF;
END
$precondicoes$;

CREATE TABLE IF NOT EXISTS public.crm_visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- ── A quem se vai ────────────────────────────────────────────────────────
  -- Uma visita é a uma lead **ou** a um cliente que já existe (uma proposta de
  -- serviço novo a quem já é cliente é uma visita comercial na mesma). Nunca
  -- aos dois, nunca a nenhum — o CHECK abaixo trata disso.
  lead_id         uuid,
  client_id       uuid,

  -- ── Quando e com quem ────────────────────────────────────────────────────
  scheduled_start timestamptz NOT NULL,
  scheduled_end   timestamptz NOT NULL,

  -- 🔴 Um `profiles`, e nunca um `teams`. Uma visita é de uma pessoa, e pôr
  --    aqui uma equipa faria a visita aparecer no espelho de equipas e na
  --    escala — que é precisamente o que esta tabela existe para evitar.
  assigned_to     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Morada própria: a da lead pode ser a da sede e a visita ser a outro sítio.
  address         text,
  lat             numeric(10,7),
  lng             numeric(10,7),

  -- ── Desfecho ─────────────────────────────────────────────────────────────
  -- `nao_compareceu` é um estado próprio e não um cancelamento: quem marca uma
  -- visita e não aparece diz alguma coisa sobre a oportunidade que um
  -- «cancelada» não diz.
  status          text NOT NULL DEFAULT 'agendada'
                  CHECK (status IN ('agendada', 'realizada', 'nao_compareceu', 'cancelada')),
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,

  -- ── O que se foi lá medir ────────────────────────────────────────────────
  outcome_notes   text,
  area_sqm        numeric(10,2) CHECK (area_sqm IS NULL OR area_sqm > 0),
  estimated_hours numeric(5,2)  CHECK (estimated_hours IS NULL OR estimated_hours > 0),
  frequency_hint  text,

  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- 🔴 Exactamente um destinatário. Sem isto, uma visita podia ficar órfã
  --    (sem lead nem cliente) e não aparecer em ficha nenhuma.
  CONSTRAINT crm_visits_um_destinatario
    CHECK ((lead_id IS NOT NULL) <> (client_id IS NOT NULL)),

  -- Uma janela que acaba antes de começar não é uma janela.
  CONSTRAINT crm_visits_janela_valida
    CHECK (scheduled_end > scheduled_start),

  -- Um desfecho sem data é um desfecho que ninguém consegue situar no tempo.
  CONSTRAINT crm_visits_realizada_tem_data
    CHECK (status <> 'realizada' OR completed_at IS NOT NULL),
  CONSTRAINT crm_visits_cancelada_tem_data
    CHECK (status <> 'cancelada' OR cancelled_at IS NOT NULL)
);

COMMENT ON TABLE public.crm_visits IS
  'Visita comercial: a deslocacao para ver o local e orcar. NAO e um servico e '
  'nunca deve ser convertida num — nao tem equipa, nao tem ponto, nao tem valor '
  'a facturar, e nao entra na escala, no mapa, nos relatorios operacionais nem '
  'em getUnbilledServices. area_sqm/estimated_hours/frequency_hint sao o que se '
  'mede no local e o que pre-preenche as linhas do orcamento. Se o calendario a '
  'mostrar, le esta tabela como camada sobreposta, sem tocar no modelo de services.';

-- As duas FKs compostas: o destinatário tem de ser da mesma empresa.
ALTER TABLE public.crm_visits
  DROP CONSTRAINT IF EXISTS crm_visits_lead_mesma_empresa;
ALTER TABLE public.crm_visits
  ADD CONSTRAINT crm_visits_lead_mesma_empresa
  FOREIGN KEY (lead_id, company_id)
  REFERENCES public.crm_leads (id, company_id)
  ON DELETE CASCADE;

ALTER TABLE public.crm_visits
  DROP CONSTRAINT IF EXISTS crm_visits_cliente_mesma_empresa;
ALTER TABLE public.crm_visits
  ADD CONSTRAINT crm_visits_cliente_mesma_empresa
  FOREIGN KEY (client_id, company_id)
  REFERENCES public.clients (id, company_id)
  ON DELETE RESTRICT;

-- A agenda: «o que tenho para ver esta semana».
CREATE INDEX IF NOT EXISTS idx_crm_visits_company_start
  ON public.crm_visits (company_id, scheduled_start);

-- As visitas de uma lead, na ficha dela.
CREATE INDEX IF NOT EXISTS idx_crm_visits_lead
  ON public.crm_visits (company_id, lead_id, scheduled_start);

CREATE INDEX IF NOT EXISTS idx_crm_visits_client
  ON public.crm_visits (company_id, client_id, scheduled_start);

-- O acesso quente é a agenda por marcar; as já realizadas são história.
CREATE INDEX IF NOT EXISTS idx_crm_visits_agendadas
  ON public.crm_visits (company_id, scheduled_start)
  WHERE status = 'agendada';

DROP TRIGGER IF EXISTS crm_visits_updated_at ON public.crm_visits;
CREATE TRIGGER crm_visits_updated_at
  BEFORE UPDATE ON public.crm_visits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_history ON public.crm_visits;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.crm_visits
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

-- ── RLS e ACL — o modelo endurecido pós-084/085 ─────────────────────────────

ALTER TABLE public.crm_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_visits_manager_select" ON public.crm_visits;
CREATE POLICY "crm_visits_manager_select"
  ON public.crm_visits
  FOR SELECT
  USING (
    company_id = public.get_my_company_id()
    AND public.get_my_role() IN ('admin', 'gestor')
  );

REVOKE ALL PRIVILEGES ON TABLE public.crm_visits FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.crm_visits FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.crm_visits FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.crm_visits FROM service_role;

GRANT SELECT ON TABLE public.crm_visits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_visits TO service_role;

-- ── Pós-estado ──────────────────────────────────────────────────────────────

DO $posestado$
DECLARE
  v_faltam text[];
  v_rls boolean;
BEGIN
  SELECT array_agg(esperado.coluna) INTO v_faltam
    FROM (VALUES
      ('lead_id'), ('client_id'), ('scheduled_start'), ('scheduled_end'),
      ('assigned_to'), ('status'), ('area_sqm'), ('estimated_hours'), ('outcome_notes')
    ) AS esperado(coluna)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'crm_visits'
        AND c.column_name = esperado.coluna
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_VISITS_102_POSTSTATE_FAILED: colunas em falta %', v_faltam;
  END IF;

  -- 🔴 A ausência destas é tão importante como a presença das outras. Se
  --    alguma aparecer, alguém está a transformar a visita num serviço — que
  --    é exactamente o que o cabeçalho deste ficheiro existe para impedir.
  SELECT array_agg(proibida.coluna) INTO v_faltam
    FROM (VALUES ('team_id'), ('calculated_value'), ('payment_status'), ('hourly_rate')) AS proibida(coluna)
   WHERE EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'crm_visits'
        AND c.column_name = proibida.coluna
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_VISITS_102_POSTSTATE_FAILED: uma visita comercial não é um serviço — colunas indevidas %',
      v_faltam;
  END IF;

  SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'crm_visits';

  IF NOT coalesce(v_rls, false) THEN
    RAISE EXCEPTION 'CRM_VISITS_102_POSTSTATE_FAILED: RLS não ficou activa';
  END IF;

  SELECT array_agg(esperada.nome) INTO v_faltam
    FROM (VALUES
      ('crm_visits_um_destinatario'),
      ('crm_visits_janela_valida'),
      ('crm_visits_lead_mesma_empresa'),
      ('crm_visits_cliente_mesma_empresa')
    ) AS esperada(nome)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conname = esperada.nome AND conrelid = 'public.crm_visits'::regclass
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_VISITS_102_POSTSTATE_FAILED: restrições em falta %', v_faltam;
  END IF;
END
$posestado$;
