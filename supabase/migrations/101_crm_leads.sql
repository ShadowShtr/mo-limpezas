-- ============================================================================
-- 101 — CRM: a oportunidade antes de haver cliente
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- Esta migration é FUNDAÇÃO. Não muda nenhum ecrã: cria as duas tabelas que a
-- interface do Pipeline de Leads vai passar a usar, numa PR seguinte.
--
-- ---------------------------------------------------------------------------
-- Porque é que isto existe
-- ---------------------------------------------------------------------------
--
-- O sistema sabe tudo sobre quem já é cliente e nada sobre quem ainda não é.
-- Um pedido de orçamento vive hoje num telefonema, num email, ou — na melhor
-- das hipóteses — num cartão de `management_tasks` com `category = 'orcamento'`
-- e um PDF anexo.
--
-- Um cartão de tarefa não responde a «quantos pedidos estão por fechar?», nem
-- a «de onde veio este trabalho?», nem a «porque é que perdemos aquele
-- condomínio?». Não tem origem, não tem dono comercial, não tem valor
-- estimado, e o seu estado é o estado de uma tarefa (pendente/em curso/
-- concluído), não o de uma oportunidade.
--
-- ---------------------------------------------------------------------------
-- Porque é que uma lead NÃO é um `clients` com `status` diferente
-- ---------------------------------------------------------------------------
--
-- Foi a primeira alternativa considerada, e rejeitada por três razões
-- concretas, todas verificáveis no código de hoje:
--
--   · `clients` é lido por Faturação, Cobranças, Relatórios, Calendário e
--     Mapa sem filtro de estado em vários sítios. Uma lead que ainda não
--     comprou nada apareceria em listas de faturação como cliente a zero.
--
--   · `locations.client_id` é NOT NULL e `contracts.location_id` é NOT NULL.
--     Um cliente sem local é um caso que o resto do sistema nunca teve de
--     tratar; criar locais fantasma para leads poria moradas por confirmar no
--     Mapa e na escala.
--
--   · Uma lead perde-se. Um cliente arquiva-se. `clients.status` só conhece
--     'ativo' e 'inativo', e não tem onde guardar o motivo da perda — que é
--     precisamente a informação que justifica ter um funil.
--
-- A conversão é explícita e num só sentido: quando a lead é ganha, nasce um
-- `clients` real (pela action que já existe, `createClienteComLocal`) e a lead
-- guarda o id desse cliente. A partir daí as duas linhas coexistem: a lead é a
-- história de como o cliente apareceu.
--
-- ---------------------------------------------------------------------------
-- Porque é que os estados NÃO são configuráveis como as colunas do Kanban
-- ---------------------------------------------------------------------------
--
-- `company_settings.kanban_columns` deixa o utilizador criar, renomear e
-- apagar colunas das Tarefas. Seria tentador reutilizar o mesmo mecanismo.
--
-- Não serve, porque estes estados **carregam regras**: `perdido` exige motivo,
-- `ganho` exige que exista um cliente convertido. Uma lista de estados que o
-- utilizador pode reescrever torna impossível impor essas regras na base — e
-- uma regra que só existe no formulário é uma regra que a próxima página
-- esquece.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
--   · não toca em `clients`, `locations`, `contracts`, `services`, `invoices`
--     nem `cash_flow_entries` — nem uma coluna, nem uma linha;
--   · não cria visitas nem orçamentos (102 e 103);
--   · não publica nada no Realtime;
--   · não acrescenta rota, action ou componente nenhum.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('companies'),
      ('profiles'),
      ('clients'),
      ('locations')
    ) AS esperado(nome)
   WHERE to_regclass('public.' || esperado.nome) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_LEADS_101_PRECONDITION_FAILED: tabelas em falta %', v_faltam;
  END IF;

  -- `update_updated_at` (001) e `fn_capture_history` (059) são usadas nos
  -- triggers abaixo. Sem elas o CREATE TRIGGER falharia a meio, com a tabela
  -- já criada — melhor falhar antes de escrever seja o que for.
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'CRM_LEADS_101_PRECONDITION_FAILED: update_updated_at() ausente (001)';
  END IF;
  IF to_regprocedure('public.fn_capture_history()') IS NULL THEN
    RAISE EXCEPTION 'CRM_LEADS_101_PRECONDITION_FAILED: fn_capture_history() ausente (059)';
  END IF;

  -- O modelo de RLS endurecido pós-084/085 depende destas duas.
  IF to_regprocedure('public.get_my_company_id()') IS NULL
     OR to_regprocedure('public.get_my_role()') IS NULL THEN
    RAISE EXCEPTION 'CRM_LEADS_101_PRECONDITION_FAILED: get_my_company_id()/get_my_role() ausentes (014)';
  END IF;

  -- A FK composta do cliente convertido precisa deste índice único, criado
  -- pela 086. Criá-lo aqui seria assumir em silêncio a responsabilidade dela.
  IF to_regclass('public.clients_id_company_unique') IS NULL THEN
    RAISE EXCEPTION 'CRM_LEADS_101_PRECONDITION_FAILED: índice clients_id_company_unique ausente (086)';
  END IF;
END
$precondicoes$;

-- O par (id, company_id) de `locations` ainda não tem índice único — a 086 só
-- criou o de `clients`. É aditivo, e é o que permite a FK composta do local
-- convertido. Fica aqui porque é aqui que passa a ser preciso.
CREATE UNIQUE INDEX IF NOT EXISTS locations_id_company_unique
  ON public.locations (id, company_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 1. A lead
-- ───────────────────────────────────────────────────────────────────────────
--
-- 🔴 `CREATE TABLE IF NOT EXISTS` é silencioso por desenho: se já existir uma
--    tabela com este nome e outra forma, não a corrige. O bloco de pós-estado
--    no fim do ficheiro é que verifica que a forma é a esperada.

CREATE TABLE IF NOT EXISTS public.crm_leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- ── Identificação ────────────────────────────────────────────────────────
  -- Só o nome é obrigatório. Uma lead nasce muitas vezes de um telefonema em
  -- que se apanha o nome e mais nada; exigir email ou telefone faria com que
  -- essas ficassem de fora do sistema — que é exactamente o problema de hoje.
  --
  -- Estes campos são, coluna a coluna, a entrada de `createClienteComLocal`.
  -- É por serem os mesmos que a conversão não obriga a redigitar nada.
  name            text NOT NULL,
  lead_type       text NOT NULL DEFAULT 'empresa'
                  CHECK (lead_type IN ('individual', 'empresa')),  -- espelha clients.type
  contact_name    text,
  email           text,
  phone           text,
  nif             text,
  address         text,
  lat             numeric(10,7),
  lng             numeric(10,7),

  -- ── Funil ────────────────────────────────────────────────────────────────
  stage           text NOT NULL DEFAULT 'novo'
                  CHECK (stage IN (
                    'novo', 'contactado', 'visita_agendada',
                    'orcamento_enviado', 'ganho', 'perdido'
                  )),

  -- Ordem manual dentro da coluna do quadro. Sem ela, arrastar só muda de
  -- coluna e não deixa priorizar o que está dentro dela.
  board_order     integer NOT NULL DEFAULT 0,

  -- De onde veio. Sem isto não há forma de saber o que traz trabalho, e a
  -- pergunta «vale a pena continuar a pagar isto?» fica sem resposta.
  source          text
                  CHECK (source IS NULL OR source IN (
                    'recomendacao', 'website', 'telefone', 'email',
                    'whatsapp', 'redes_sociais', 'passagem', 'parceiro', 'outro'
                  )),
  source_detail   text,

  -- O responsável comercial. Uma lead sem dono morre sem ninguém dar por
  -- isso — é o modo de falha mais comum de um funil.
  owner_id        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- ── Valor ────────────────────────────────────────────────────────────────
  -- 🔴 O valor e a sua natureza andam sempre juntos, e não é detalhe.
  --    Numa empresa de limpezas, 300 € de pós-obra pontual e 300 €/mês de
  --    avença não são o mesmo número. Um funil que os somasse numa coluna só
  --    mentiria — e mentiria sempre para cima.
  estimated_value      numeric(10,2)
                       CHECK (estimated_value IS NULL OR estimated_value >= 0),
  estimated_value_kind text NOT NULL DEFAULT 'mensal'
                       CHECK (estimated_value_kind IN ('mensal', 'pontual')),

  -- ── Próxima acção ────────────────────────────────────────────────────────
  -- O par com maior retorno da tabela: é o que permite pintar a vermelho o
  -- que está atrasado, e é isso que impede leads esquecidas.
  next_action_at   date,
  next_action_note text,

  -- ── Contexto do trabalho pedido ──────────────────────────────────────────
  -- `service_type` usa exactamente o vocabulário de `locations.service_type`,
  -- para que a conversão não tenha de traduzir de um domínio para o outro.
  service_type    text
                  CHECK (service_type IS NULL OR service_type IN (
                    'limpeza_regular', 'manutencao', 'pos_obra',
                    'vidros', 'carpetes', 'industrial', 'outro'
                  )),
  frequency_hint  text,
  notes           text,

  -- ── Desfecho ─────────────────────────────────────────────────────────────
  won_at          timestamptz,
  lost_at         timestamptz,

  -- 🔴 Enumerado, e não texto livre, por uma razão só: texto livre não se
  --    conta. «perdemos 40% por preço» é uma frase que só um CHECK permite
  --    produzir. O detalhe da conversa fica em `lost_reason_notes`.
  lost_reason     text
                  CHECK (lost_reason IS NULL OR lost_reason IN (
                    'preco', 'sem_resposta', 'escolheu_concorrente',
                    'adiou', 'fora_de_area', 'servico_nao_prestado', 'outro'
                  )),
  lost_reason_notes text,

  -- ── Conversão ────────────────────────────────────────────────────────────
  -- A prova de que já foi convertida — e a guarda contra convertê-la duas
  -- vezes, que criaria dois clientes iguais.
  converted_client_id   uuid,
  converted_location_id uuid,

  -- Soft-delete. Apagar uma lead perdida destruiria a estatística de motivos
  -- de perda, que é metade da razão de esta tabela existir.
  archived_at     timestamptz,

  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crm_leads_name_nao_vazio
    CHECK (length(btrim(name)) > 0),

  -- 🔴 Perder sem motivo é perder a única informação que a perda produz.
  --    O CHECK obriga-o na base, não só no formulário.
  CONSTRAINT crm_leads_perdida_exige_motivo
    CHECK (stage <> 'perdido' OR (lost_reason IS NOT NULL AND lost_at IS NOT NULL)),

  CONSTRAINT crm_leads_ganha_exige_data
    CHECK (stage <> 'ganho' OR won_at IS NOT NULL),

  -- Cliente e local nascem juntos na conversão (`createClienteComLocal` cria
  -- os dois ou nenhum). Um sem o outro seria uma conversão a meio.
  CONSTRAINT crm_leads_conversao_coerente
    CHECK ((converted_client_id IS NULL) = (converted_location_id IS NULL)),

  -- Uma lead 'novo' a apontar para um cliente é um estado que nenhum caminho
  -- do código produz, e que a leitura não saberia interpretar.
  CONSTRAINT crm_leads_conversao_so_se_ganha
    CHECK (converted_client_id IS NULL OR stage = 'ganho')
);

COMMENT ON TABLE public.crm_leads IS
  'Oportunidade comercial antes de existir cliente. NAO e um clients com '
  'status diferente: nao entra em faturacao, cobrancas, calendario nem mapa, '
  'e nao tem local associado. Quando e ganha, nasce um clients real pela '
  'action de conversao e os ids ficam em converted_client_id/location_id — as '
  'duas linhas coexistem, e a lead passa a ser a historia de como o cliente '
  'apareceu. Nunca converter uma lead em clients por UPDATE direto. Os '
  'estados sao um CHECK e nao colunas configuraveis: perdido exige motivo e '
  'ganho exige cliente, e essas regras tem de viver na base.';

-- 🔴 Duas FKs separadas para `companies` e `clients` não impediriam apontar
--    para um cliente de OUTRA empresa. A FK composta obriga — e obriga na
--    base, não na aplicação. Mesmo padrão da 086.
ALTER TABLE public.crm_leads
  DROP CONSTRAINT IF EXISTS crm_leads_cliente_mesma_empresa;
ALTER TABLE public.crm_leads
  ADD CONSTRAINT crm_leads_cliente_mesma_empresa
  FOREIGN KEY (converted_client_id, company_id)
  REFERENCES public.clients (id, company_id)
  ON DELETE RESTRICT;

ALTER TABLE public.crm_leads
  DROP CONSTRAINT IF EXISTS crm_leads_local_mesma_empresa;
ALTER TABLE public.crm_leads
  ADD CONSTRAINT crm_leads_local_mesma_empresa
  FOREIGN KEY (converted_location_id, company_id)
  REFERENCES public.locations (id, company_id)
  ON DELETE RESTRICT;

-- O quadro do funil lê por empresa, estado e ordem manual — o acesso quente.
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_stage
  ON public.crm_leads (company_id, stage, board_order);

-- «O que tenho para fazer?» — parcial, porque as leads fechadas e arquivadas
-- não têm próxima acção e não devem pesar no índice.
CREATE INDEX IF NOT EXISTS idx_crm_leads_next_action
  ON public.crm_leads (company_id, next_action_at)
  WHERE archived_at IS NULL AND stage NOT IN ('ganho', 'perdido');

-- «O que é meu?»
CREATE INDEX IF NOT EXISTS idx_crm_leads_owner
  ON public.crm_leads (company_id, owner_id)
  WHERE archived_at IS NULL AND stage NOT IN ('ganho', 'perdido');

-- Relatório de origens e de motivos de perda, por período.
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_created
  ON public.crm_leads (company_id, created_at);

DROP TRIGGER IF EXISTS crm_leads_updated_at ON public.crm_leads;
CREATE TRIGGER crm_leads_updated_at
  BEFORE UPDATE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_history ON public.crm_leads;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. O diário de contactos
-- ───────────────────────────────────────────────────────────────────────────
--
-- Uma linha por interacção. `kind = 'sistema'` é escrito pelas próprias
-- actions — mudança de estado, orçamento enviado, conversão. Sem isso a
-- timeline tem buracos e quem a lê tem de cruzar três ecrãs para perceber o
-- que aconteceu.

CREATE TABLE IF NOT EXISTS public.crm_lead_interactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL,

  kind         text NOT NULL
               CHECK (kind IN (
                 'chamada', 'email', 'whatsapp', 'reuniao',
                 'visita', 'nota', 'proposta_enviada', 'sistema'
               )),
  summary      text NOT NULL,

  -- Separado de `created_at` de propósito: regista-se hoje uma chamada de
  -- ontem. A ordem da timeline é por `occurred_at`; `created_at` é auditoria.
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  author_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crm_lead_interactions_summary_nao_vazio
    CHECK (length(btrim(summary)) > 0)
);

COMMENT ON TABLE public.crm_lead_interactions IS
  'Diario de contactos de uma lead: uma linha por interacao. kind=sistema e '
  'escrito pelas actions (mudanca de estado, orcamento enviado, conversao) '
  'para a timeline nao ter buracos. A correcao de um resumo fica registada '
  'em data_history pelo trigger.';

-- 🔴 A lead e a interacção têm de ser da mesma empresa. Sem este índice e a
--    FK composta que se lhe segue, `company_id` aqui seria decorativo: nada
--    obrigaria a coincidir com o da lead.
CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_id_company_unique
  ON public.crm_leads (id, company_id);

ALTER TABLE public.crm_lead_interactions
  DROP CONSTRAINT IF EXISTS crm_lead_interactions_lead_mesma_empresa;
ALTER TABLE public.crm_lead_interactions
  ADD CONSTRAINT crm_lead_interactions_lead_mesma_empresa
  FOREIGN KEY (lead_id, company_id)
  REFERENCES public.crm_leads (id, company_id)
  ON DELETE CASCADE;

-- A timeline de uma lead, por ordem de acontecimento — o acesso quente.
CREATE INDEX IF NOT EXISTS idx_crm_lead_interactions_lead
  ON public.crm_lead_interactions (company_id, lead_id, occurred_at DESC);

DROP TRIGGER IF EXISTS crm_lead_interactions_updated_at ON public.crm_lead_interactions;
CREATE TRIGGER crm_lead_interactions_updated_at
  BEFORE UPDATE ON public.crm_lead_interactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_history ON public.crm_lead_interactions;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.crm_lead_interactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. RLS e ACL — o modelo endurecido pós-084/085
-- ───────────────────────────────────────────────────────────────────────────
--
-- Leitura para admin/gestor da própria empresa; escrita só pelo caminho
-- canónico (Server Action com service-role). O browser nunca escreve.
--
-- Colaboradoras não têm policy nenhuma, e é deliberado: o funil comercial não
-- faz parte do trabalho delas, e o valor estimado de um negócio por fechar
-- não é informação que a app móvel precise de mostrar.

ALTER TABLE public.crm_leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_lead_interactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_leads_manager_select" ON public.crm_leads;
CREATE POLICY "crm_leads_manager_select"
  ON public.crm_leads
  FOR SELECT
  USING (
    company_id = public.get_my_company_id()
    AND public.get_my_role() IN ('admin', 'gestor')
  );

DROP POLICY IF EXISTS "crm_lead_interactions_manager_select" ON public.crm_lead_interactions;
CREATE POLICY "crm_lead_interactions_manager_select"
  ON public.crm_lead_interactions
  FOR SELECT
  USING (
    company_id = public.get_my_company_id()
    AND public.get_my_role() IN ('admin', 'gestor')
  );

-- Nenhuma policy de INSERT/UPDATE/DELETE, e isso é deliberado: sem policy
-- permissiva, o RLS nega. `service_role` é BYPASSRLS e escreve pelo caminho
-- canónico.
REVOKE ALL PRIVILEGES ON TABLE public.crm_leads             FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.crm_leads             FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.crm_leads             FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.crm_leads             FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.crm_lead_interactions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.crm_lead_interactions FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.crm_lead_interactions FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.crm_lead_interactions FROM service_role;

GRANT SELECT ON TABLE public.crm_leads             TO authenticated;
GRANT SELECT ON TABLE public.crm_lead_interactions TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_leads             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_lead_interactions TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Pós-estado
-- ───────────────────────────────────────────────────────────────────────────
--
-- `CREATE TABLE IF NOT EXISTS` não corrige uma tabela pré-existente com outra
-- forma. Este bloco é que transforma «não deu erro» em «ficou como se queria».

DO $posestado$
DECLARE
  v_faltam text[];
  v_rls_leads boolean;
  v_rls_interacoes boolean;
BEGIN
  SELECT array_agg(esperado.descricao) INTO v_faltam
    FROM (VALUES
      ('crm_leads.stage',                 'crm_leads',             'stage'),
      ('crm_leads.board_order',           'crm_leads',             'board_order'),
      ('crm_leads.source',                'crm_leads',             'source'),
      ('crm_leads.owner_id',              'crm_leads',             'owner_id'),
      ('crm_leads.estimated_value',       'crm_leads',             'estimated_value'),
      ('crm_leads.estimated_value_kind',  'crm_leads',             'estimated_value_kind'),
      ('crm_leads.next_action_at',        'crm_leads',             'next_action_at'),
      ('crm_leads.lost_reason',           'crm_leads',             'lost_reason'),
      ('crm_leads.converted_client_id',   'crm_leads',             'converted_client_id'),
      ('crm_leads.converted_location_id', 'crm_leads',             'converted_location_id'),
      ('crm_leads.archived_at',           'crm_leads',             'archived_at'),
      ('crm_lead_interactions.kind',        'crm_lead_interactions', 'kind'),
      ('crm_lead_interactions.occurred_at', 'crm_lead_interactions', 'occurred_at')
    ) AS esperado(descricao, tabela, coluna)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name   = esperado.tabela
        AND c.column_name  = esperado.coluna
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_LEADS_101_POSTSTATE_FAILED: colunas em falta %', v_faltam;
  END IF;

  SELECT c.relrowsecurity INTO v_rls_leads
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'crm_leads';
  SELECT c.relrowsecurity INTO v_rls_interacoes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'crm_lead_interactions';

  IF NOT coalesce(v_rls_leads, false) OR NOT coalesce(v_rls_interacoes, false) THEN
    RAISE EXCEPTION 'CRM_LEADS_101_POSTSTATE_FAILED: RLS não ficou activa';
  END IF;

  -- As três FKs compostas são o que impede cruzar empresas. Se alguma faltar,
  -- o isolamento passa a depender só da aplicação.
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('crm_leads_cliente_mesma_empresa',            'public.crm_leads'),
      ('crm_leads_local_mesma_empresa',              'public.crm_leads'),
      ('crm_lead_interactions_lead_mesma_empresa',   'public.crm_lead_interactions'),
      -- O CHECK do motivo de perda é metade da razão de esta tabela existir.
      ('crm_leads_perdida_exige_motivo',             'public.crm_leads'),
      ('crm_leads_conversao_so_se_ganha',            'public.crm_leads')
    ) AS esperado(nome, tabela)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conname = esperado.nome
        AND conrelid = esperado.tabela::regclass
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_LEADS_101_POSTSTATE_FAILED: restrições em falta %', v_faltam;
  END IF;
END
$posestado$;
