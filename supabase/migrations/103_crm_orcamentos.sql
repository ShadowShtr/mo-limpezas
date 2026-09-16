-- ============================================================================
-- 103 — CRM: o orçamento, a sua numeração e as suas revisões
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- Esta migration é FUNDAÇÃO. Cria as tabelas e as três RPC que a interface de
-- orçamentos vai usar numa PR seguinte. Não muda nenhum ecrã.
--
-- ---------------------------------------------------------------------------
-- 🔴 A numeração NÃO copia o `regexp_match` das facturas. Eis porquê.
-- ---------------------------------------------------------------------------
--
-- `create_invoice_with_items` (072/094) atribui o número assim:
--
--     SELECT COALESCE(MAX((regexp_match(i.invoice_number, '/(\d+)$'))[1]::int), 0)
--
-- Lê o sequencial do próprio texto, ancorado ao FIM da string. Funciona para
-- `F2026/008` — e falha em silêncio para um orçamento revisto:
--
--     'ORC2026/001-R1'  →  '/(\d+)$' não casa  →  MAX devolve NULL
--                       →  COALESCE dá 0  →  o número seguinte seria 001
--
-- Reemitir o 001 sobre um documento que já existe é o pior desfecho possível:
-- dois orçamentos com o mesmo número, um deles já enviado a um cliente. O
-- índice único apanharia a colisão e a operação falharia — mas falharia de
-- forma incompreensível, e continuaria a falhar a cada nova tentativa.
--
-- Por isso o sequencial vive numa COLUNA (`quote_seq`), e o número é derivado
-- dela, nunca o contrário. As facturas usam regexp por razão histórica — não
-- têm coluna. Um módulo novo não herda essa dívida.
--
-- O que SE copia da 094, e sem alterações, é o protocolo de serialização:
-- `pg_advisory_xact_lock` por empresa e ano, antes de ler o máximo.
--
-- 🔴 A chave do lock leva `':orc:'` no meio. A das facturas é
--    `hashtext(company || ':' || ano)`; ambas são a forma de UM argumento e
--    partilham o mesmo espaço de lock. Sem o discriminador, emitir uma factura
--    bloquearia quem estivesse a emitir um orçamento, sem razão nenhuma.
--
-- ---------------------------------------------------------------------------
-- 🔴 O que NÃO acontece aqui: o protocolo de período financeiro
-- ---------------------------------------------------------------------------
--
-- `create_invoice_with_items` chama `assert_financial_period_dates_open_locked`
-- antes de escrever. Esta RPC **não chama**, e é deliberado.
--
-- Um orçamento não é um documento fiscal, não mexe em caixa, não gera
-- movimento e não entra em nenhum fecho. Invocar o protocolo aqui impediria
-- orçamentar em Janeiro depois de Janeiro estar fechado — o que não faz
-- sentido nenhum: um orçamento emitido hoje pode ter data de hoje e ser aceite
-- em Março. O período entra em cena quando a aceitação virar contrato,
-- serviço ou factura — e aí já existe quem o imponha.
--
-- ---------------------------------------------------------------------------
-- Revisões: o que acontece ao editar um orçamento já enviado
-- ---------------------------------------------------------------------------
--
--   · `rascunho`  → edita-se em cima. Nunca saiu de casa.
--   · `enviado`, `recusado`, `expirado` → nasce uma REVISÃO: linha nova, mesmo
--     `quote_seq`, `revision + 1`, número `ORC2026/001-R1`. A anterior fica
--     com `superseded_by_id` preenchido e **mantém o seu estado** — «foi
--     enviada a 12 de Março» é um facto histórico, não um estado mutável.
--   · `aceite`   → 🔴 imutável. Um orçamento aceite é a base de um acordo;
--     mudar-lhe os preços por baixo é falsificar o acordo. Para alterar,
--     emite-se um orçamento novo, com número novo.
--
-- Uma revisão não consome número: a numeração conta documentos, não versões.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
--   · não toca em `invoices`, `invoice_items`, `services`, `contracts` nem
--     `cash_flow_entries`;
--   · não cria contrato nenhum ao aceitar — isso é a conversão, e é uma PR
--     posterior, com confirmação humana pelo meio;
--   · nada escreve `'expirado'` ainda: o estado existe no CHECK e a leitura
--     deriva-o de `valid_until`. Fica reservado para um cron futuro.
-- ============================================================================

DO $precondicoes$
BEGIN
  IF to_regclass('public.crm_leads') IS NULL OR to_regclass('public.crm_visits') IS NULL THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_PRECONDITION_FAILED: crm_leads/crm_visits ausentes (101/102)';
  END IF;

  IF to_regclass('public.crm_leads_id_company_unique') IS NULL
     OR to_regclass('public.clients_id_company_unique') IS NULL
     OR to_regclass('public.crm_visits_id_company_unique') IS NULL
     OR to_regclass('public.profiles_id_company_unique') IS NULL THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_PRECONDITION_FAILED: índices (id, company_id) ausentes (101/102/086)';
  END IF;

  IF to_regprocedure('public.update_updated_at()') IS NULL
     OR to_regprocedure('public.fn_capture_history()') IS NULL
     OR to_regprocedure('public.get_my_company_id()') IS NULL
     OR to_regprocedure('public.get_my_role()') IS NULL THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_PRECONDITION_FAILED: funções de base ausentes';
  END IF;

  IF to_regclass('public.company_settings') IS NULL THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_PRECONDITION_FAILED: company_settings ausente';
  END IF;
END
$precondicoes$;

-- O prefixo dos orçamentos, a par de `invoice_prefix`. Aditivo, com valor por
-- omissão — nenhuma linha existente precisa de ser tocada.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS quote_prefix text NOT NULL DEFAULT 'ORC';

-- ───────────────────────────────────────────────────────────────────────────
-- 1. O orçamento
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- A quem: uma lead, ou um cliente que já existe (proposta de serviço novo).
  --
  -- 🔴 Estas duas colunas são o DESTINATÁRIO ATUAL, e só isso. São estado
  --    corrente, mutável: a conversão troca `lead_id` por `client_id`, porque o
  --    documento passa a ser de um cliente que agora existe.
  lead_id         uuid,
  client_id       uuid,

  -- 🔴 De que lead NASCEU este orçamento. Imutável, e deliberadamente separada
  --    de `lead_id`.
  --
  --    O problema que esta coluna fecha: `crm_quotes_tem_destinatario` obriga a
  --    exactamente um de (`lead_id`, `client_id`), por isso a conversão TEM de
  --    pôr `lead_id` a NULL ao preencher `client_id`. Enquanto a proveniência
  --    vivia em `lead_id`, essa escrita apagava-a — e com ela a resposta a «de
  --    que lead, de que visita e de que orçamento é que este cliente nasceu?».
  --    `getQuotes({ leadId })` deixava de encontrar o orçamento que fechou o
  --    negócio, que é justamente o que se quer ver ao abrir a lead.
  --
  --    Uma coluna não pode ser ao mesmo tempo estado corrente e facto histórico.
  --    «A quem está endereçado hoje» muda; «de onde veio» não muda nunca —
  --    depois de escrita na criação, nenhum caminho lhe toca outra vez. É o
  --    mesmo princípio que já governa `crm_leads.converted_client_id` do outro
  --    lado da mesma relação, e é isso que torna a cadeia navegável nos dois
  --    sentidos:
  --
  --      lead ──source_lead_id──> quote ──client_id──> cliente
  --      lead <──converted_client_id── (a lead aponta para o cliente que gerou)
  --
  --    NULL quando o orçamento nasceu já de um cliente (proposta de serviço
  --    novo a quem já é cliente): aí não houve lead nenhuma, e inventar uma
  --    seria pior do que a ausência.
  source_lead_id  uuid,
  -- De onde saíram as medidas, quando saíram de uma visita.
  --
  -- 🔴 Sem `REFERENCES` na coluna: a FK é COMPOSTA. Uma FK simples aceitaria a
  --    visita de OUTRA empresa — o id é um uuid válido, e as Server Actions
  --    escrevem com service_role, que é BYPASSRLS. «Difícil de adivinhar» não
  --    é uma garantia de integridade.
  visit_id        uuid,

  -- ── Identidade do documento ──────────────────────────────────────────────
  quote_number    text NOT NULL,          -- 'ORC2026/001' | 'ORC2026/001-R1'
  quote_year      smallint NOT NULL,
  -- 🔴 O sequencial em coluna. Ver o cabeçalho: derivá-lo do texto por regexp
  --    falha em silêncio assim que existe uma revisão.
  quote_seq       integer NOT NULL,
  revision        smallint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  -- A raiz da cadeia de revisões. Na revisão 0 é o próprio id.
  root_quote_id   uuid NOT NULL,
  -- Preenchido quando uma revisão mais nova a substitui. NULL = é a viva.
  --
  -- 🔴 A FK é declarada mais abaixo como DEFERRABLE INITIALLY DEFERRED, e a
  --    razão é concreta: `revise_crm_quote` tem de marcar a antiga como
  --    substituída ANTES de inserir a nova, senão existem por um instante
  --    duas revisões vivas e o índice parcial `uq_crm_quotes_revisao_viva`
  --    recusa a operação. Diferida, a verificação acontece no fim da
  --    transação, quando as duas linhas já estão coerentes.
  superseded_by_id uuid,

  issue_date      date NOT NULL,
  valid_until     date NOT NULL,

  status          text NOT NULL DEFAULT 'rascunho'
                  CHECK (status IN ('rascunho', 'enviado', 'aceite', 'recusado', 'expirado', 'anulado')),
  sent_at         timestamptz,
  accepted_at     timestamptz,
  rejected_at     timestamptz,
  rejection_reason text,

  -- ── Dinheiro ─────────────────────────────────────────────────────────────
  -- 🔴 Instantâneo, e não referência. `vat_rate` é copiado das configurações
  --    no momento da emissão: mudar o IVA nas definições não pode alterar o
  --    total de um orçamento que já foi enviado a um cliente.
  pricing_kind    text NOT NULL DEFAULT 'pontual'
                  CHECK (pricing_kind IN ('pontual', 'mensal')),
  subtotal        numeric(10,2) NOT NULL CHECK (subtotal >= 0),
  discount_pct    numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  apply_vat       boolean NOT NULL DEFAULT true,
  vat_rate        numeric(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  vat_amount      numeric(10,2) NOT NULL CHECK (vat_amount >= 0),
  total           numeric(10,2) NOT NULL CHECK (total >= 0),

  -- ── Para pré-preencher o contrato, quando for aceite ─────────────────────
  -- Vocabulário de `contracts.frequency` e `contracts.schedule_days`, para que
  -- a conversão não tenha de traduzir de um domínio para o outro.
  proposed_frequency text,
  proposed_weekdays  jsonb,

  payment_terms   text,
  notes           text,
  internal_notes  text,

  -- Preenchidos pela conversão (PR posterior). Aqui só existem.
  converted_contract_id uuid,
  converted_service_id  uuid,

  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crm_quotes_tem_destinatario
    CHECK ((lead_id IS NOT NULL) <> (client_id IS NOT NULL)),

  CONSTRAINT crm_quotes_validade_coerente
    CHECK (valid_until >= issue_date),

  -- Um estado sem a sua data é um estado que ninguém consegue situar no tempo.
  CONSTRAINT crm_quotes_enviado_tem_data
    CHECK (status <> 'enviado' OR sent_at IS NOT NULL),
  CONSTRAINT crm_quotes_aceite_tem_data
    CHECK (status <> 'aceite' OR accepted_at IS NOT NULL),
  CONSTRAINT crm_quotes_recusado_tem_data
    CHECK (status <> 'recusado' OR rejected_at IS NOT NULL)
);

COMMENT ON TABLE public.crm_quotes IS
  'Orcamento comercial. NAO e documento fiscal: nao entra em invoices, nao gera '
  'movimento de caixa e nao participa no protocolo de periodo financeiro — '
  'orcamentar num mes fechado e legitimo. O sequencial vive em quote_seq (coluna), '
  'nunca derivado do texto por regexp: ORC2026/001-R1 nao casa com /(\d+)$ e '
  'reemitiria o 001. Editar um orcamento ENVIADO cria uma revisao nova (mesma '
  'quote_seq, revision+1) e a anterior mantem o seu estado; um ACEITE e imutavel.';

-- `CREATE TABLE IF NOT EXISTS` não acrescenta colunas a uma tabela existente.
ALTER TABLE public.crm_quotes ADD COLUMN IF NOT EXISTS source_lead_id uuid;

-- Numa base onde a 103 já tenha corrido numa versão anterior, a proveniência
-- dos orçamentos ainda por converter está em `lead_id` e é recuperável. A dos
-- já convertidos não é — e não se inventa: fica NULL, que diz «não se sabe»,
-- em vez de um palpite que diria «foi esta».
UPDATE public.crm_quotes
   SET source_lead_id = lead_id
 WHERE source_lead_id IS NULL
   AND lead_id IS NOT NULL;

-- As FKs compostas: destinatário da mesma empresa.
ALTER TABLE public.crm_quotes DROP CONSTRAINT IF EXISTS crm_quotes_lead_mesma_empresa;
ALTER TABLE public.crm_quotes
  ADD CONSTRAINT crm_quotes_lead_mesma_empresa
  FOREIGN KEY (lead_id, company_id) REFERENCES public.crm_leads (id, company_id) ON DELETE CASCADE;

-- 🔴 A proveniência também é composta, pela mesma razão que o destinatário: um
--    uuid válido de OUTRA empresa passaria numa FK simples.
--
--    `ON DELETE CASCADE` como o `lead_id`: se a lead for apagada, o orçamento
--    que dela nasceu vai com ela — é a mesma história, e um orçamento órfão de
--    uma lead que já não existe não tem quem o explique.
ALTER TABLE public.crm_quotes DROP CONSTRAINT IF EXISTS crm_quotes_source_lead_mesma_empresa;
ALTER TABLE public.crm_quotes
  ADD CONSTRAINT crm_quotes_source_lead_mesma_empresa
  FOREIGN KEY (source_lead_id, company_id)
  REFERENCES public.crm_leads (id, company_id) ON DELETE CASCADE;

-- 🔴 A proveniência não se reescreve.
--
--    É a única garantia de que «de que lead nasceu este cliente» continua a ser
--    respondível meses depois. Sem ela, a coluna seria só mais um campo que
--    algum caminho de escrita futuro poderia actualizar «para ficar coerente»
--    — que é exactamente como a informação histórica se perde.
CREATE OR REPLACE FUNCTION public.crm_quotes_proveniencia_imutavel()
RETURNS trigger
LANGUAGE plpgsql
AS $imutavel$
BEGIN
  -- Preencher um valor em branco não é reescrever história — é registá-la, e é
  -- o que o backfill desta migration faz numa base que já tinha a 103 antiga.
  -- O que não se admite é ALTERAR uma proveniência já conhecida, nem apagá-la.
  IF OLD.source_lead_id IS NOT NULL
     AND NEW.source_lead_id IS DISTINCT FROM OLD.source_lead_id THEN
    RAISE EXCEPTION 'QUOTE_SOURCE_LEAD_IMMUTABLE: de % para %',
      OLD.source_lead_id, NEW.source_lead_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$imutavel$;

DROP TRIGGER IF EXISTS crm_quotes_proveniencia_imutavel ON public.crm_quotes;
CREATE TRIGGER crm_quotes_proveniencia_imutavel
  BEFORE UPDATE ON public.crm_quotes
  FOR EACH ROW EXECUTE FUNCTION public.crm_quotes_proveniencia_imutavel();

ALTER TABLE public.crm_quotes DROP CONSTRAINT IF EXISTS crm_quotes_cliente_mesma_empresa;
ALTER TABLE public.crm_quotes
  ADD CONSTRAINT crm_quotes_cliente_mesma_empresa
  FOREIGN KEY (client_id, company_id) REFERENCES public.clients (id, company_id) ON DELETE RESTRICT;

-- 🔴 A visita e o autor têm de ser da MESMA empresa do orçamento.
--
--    `ON DELETE NO ACTION`: numa FK composta o SET NULL poria `company_id` a
--    NULL, que é NOT NULL. Apagar uma visita que já deu origem a um orçamento
--    passa a ser bloqueado — o que faz sentido: a visita é a prova das medidas
--    que produziram aquele preço.
ALTER TABLE public.crm_quotes DROP CONSTRAINT IF EXISTS crm_quotes_visita_mesma_empresa;
ALTER TABLE public.crm_quotes
  ADD CONSTRAINT crm_quotes_visita_mesma_empresa
  FOREIGN KEY (visit_id, company_id)
  REFERENCES public.crm_visits (id, company_id)
  ON DELETE NO ACTION;

ALTER TABLE public.crm_quotes DROP CONSTRAINT IF EXISTS crm_quotes_created_by_mesma_empresa;
ALTER TABLE public.crm_quotes
  ADD CONSTRAINT crm_quotes_created_by_mesma_empresa
  FOREIGN KEY (created_by, company_id)
  REFERENCES public.profiles (id, company_id)
  ON DELETE NO ACTION;

-- 🔴 A chave candidata que as FKs compostas para dentro desta mesma tabela
--    exigem. Tem de existir ANTES delas — uma FK composta sem o índice único
--    correspondente é recusada pelo Postgres na criação.
CREATE UNIQUE INDEX IF NOT EXISTS crm_quotes_id_company_unique
  ON public.crm_quotes (id, company_id);

-- A cadeia de revisões aponta para dentro da própria tabela. Diferida, pela
-- razão explicada na declaração da coluna: durante a revisão, a antiga aponta
-- por um instante para uma linha que ainda não foi inserida.
--
-- 🔴 Duas correcções em relação à primeira versão desta constraint.
--
-- 1. COMPOSTA, como todas as outras referências desta tabela.
--
--    `FOREIGN KEY (superseded_by_id) REFERENCES crm_quotes (id)` garante que a
--    linha apontada existe — não que seja da MESMA empresa. As referências para
--    fora (lead, client, visit, created_by) já eram compostas; as referências
--    da tabela para si própria não eram, e eram precisamente as que ficavam
--    sem rede. Como `service_role` é BYPASSRLS e tem escrita, o isolamento da
--    cadeia de revisões não pode assentar em RLS: tem de assentar na chave.
--
-- 2. RESTRICT em vez de SET NULL.
--
--    `ON DELETE SET NULL` parecia inofensivo e não era: apagar a revisão nova
--    punha `superseded_by_id` a NULL na velha — e o índice parcial
--    `uq_crm_quotes_revisao_viva` conta como VIVA toda a linha com
--    `superseded_by_id IS NULL`. Uma revisão substituída, e possivelmente já
--    recusada, voltava a ser o documento vivo do orçamento sem que ninguém o
--    tivesse decidido. Um orçamento não se apaga; corrige-se com uma revisão.
ALTER TABLE public.crm_quotes DROP CONSTRAINT IF EXISTS crm_quotes_superseded_fk;
ALTER TABLE public.crm_quotes
  ADD CONSTRAINT crm_quotes_superseded_fk
  FOREIGN KEY (superseded_by_id, company_id)
  REFERENCES public.crm_quotes (id, company_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- 🔴 `root_quote_id` não tinha FK NENHUMA.
--
--    É a coluna que diz «todas estas revisões são o mesmo documento», e é a
--    chave do índice que garante uma só revisão viva por documento. Sem FK,
--    nada impedia apontá-la para um orçamento de outra empresa — e a partir daí
--    a cadeia de revisões de duas empresas partilharia a mesma raiz, com um
--    índice parcial a decidir qual delas tem a revisão viva.
--
-- Diferida pela mesma razão que a de cima: a primeira revisão de um documento
-- tem `root_quote_id = id`, e a linha aponta para si própria no instante em que
-- é inserida.
ALTER TABLE public.crm_quotes DROP CONSTRAINT IF EXISTS crm_quotes_root_fk;
ALTER TABLE public.crm_quotes
  ADD CONSTRAINT crm_quotes_root_fk
  FOREIGN KEY (root_quote_id, company_id)
  REFERENCES public.crm_quotes (id, company_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- Dois orçamentos com o mesmo número seriam dois documentos a dizer-se o mesmo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_quotes_numero
  ON public.crm_quotes (company_id, quote_number);

-- E a mesma revisão do mesmo sequencial não pode existir duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_quotes_seq_revisao
  ON public.crm_quotes (company_id, quote_year, quote_seq, revision);

-- 🔴 No máximo UMA revisão viva por documento. É este índice parcial que
--    transforma duas revisões concorrentes num conflito em vez de duas
--    versões vivas do mesmo orçamento — e ninguém saber qual vale.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_quotes_revisao_viva
  ON public.crm_quotes (company_id, root_quote_id)
  WHERE superseded_by_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_crm_quotes_company_status
  ON public.crm_quotes (company_id, status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_crm_quotes_lead
  ON public.crm_quotes (company_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_quotes_client
  ON public.crm_quotes (company_id, client_id);

DROP TRIGGER IF EXISTS crm_quotes_updated_at ON public.crm_quotes;
CREATE TRIGGER crm_quotes_updated_at
  BEFORE UPDATE ON public.crm_quotes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_history ON public.crm_quotes;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.crm_quotes
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. As linhas
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_quote_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  quote_id    uuid NOT NULL,

  position    smallint NOT NULL,
  description text NOT NULL,
  quantity    numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit        text NOT NULL DEFAULT 'servico'
              CHECK (unit IN ('hora', 'm2', 'unidade', 'mes', 'servico')),
  unit_price  numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  -- 🔴 Calculado no servidor, dentro da RPC. Aceitar o total de linha vindo do
  --    cliente deixaria um orçamento dizer 100 € numa linha de 10 × 50 €.
  line_total  numeric(10,2) NOT NULL CHECK (line_total >= 0),

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT crm_quote_items_descricao_nao_vazia
    CHECK (length(btrim(description)) > 0)
);

COMMENT ON TABLE public.crm_quote_items IS
  'Linhas de um orcamento. line_total e sempre calculado no servidor pela RPC, '
  'nunca aceite do cliente. Sem IVA por linha: a taxa vive no cabecalho, como '
  'em invoices. Sem service_id: quando se orcamenta ainda nao ha servico nenhum.';

ALTER TABLE public.crm_quote_items DROP CONSTRAINT IF EXISTS crm_quote_items_quote_mesma_empresa;
ALTER TABLE public.crm_quote_items
  ADD CONSTRAINT crm_quote_items_quote_mesma_empresa
  FOREIGN KEY (quote_id, company_id)
  REFERENCES public.crm_quotes (id, company_id)
  ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_quote_items_posicao
  ON public.crm_quote_items (quote_id, position);
CREATE INDEX IF NOT EXISTS idx_crm_quote_items_quote
  ON public.crm_quote_items (company_id, quote_id, position);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. RLS e ACL
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.crm_quotes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_quote_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_quotes_manager_select" ON public.crm_quotes;
CREATE POLICY "crm_quotes_manager_select"
  ON public.crm_quotes FOR SELECT
  USING (company_id = public.get_my_company_id() AND public.get_my_role() IN ('admin', 'gestor'));

DROP POLICY IF EXISTS "crm_quote_items_manager_select" ON public.crm_quote_items;
CREATE POLICY "crm_quote_items_manager_select"
  ON public.crm_quote_items FOR SELECT
  USING (company_id = public.get_my_company_id() AND public.get_my_role() IN ('admin', 'gestor'));

REVOKE ALL PRIVILEGES ON TABLE public.crm_quotes      FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.crm_quotes      FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.crm_quotes      FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.crm_quotes      FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.crm_quote_items FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.crm_quote_items FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.crm_quote_items FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.crm_quote_items FROM service_role;

GRANT SELECT ON TABLE public.crm_quotes      TO authenticated;
GRANT SELECT ON TABLE public.crm_quote_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_quotes      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_quote_items TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Criar um orçamento, com número, numa só transação
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_crm_quote_with_items(
  p_company_id       uuid,
  p_lead_id          uuid,
  p_client_id        uuid,
  p_visit_id         uuid,
  p_prefix           text,
  p_year             integer,
  p_issue_date       date,
  p_valid_until      date,
  p_pricing_kind     text,
  p_discount_pct     numeric,
  p_apply_vat        boolean,
  p_vat_rate         numeric,
  p_proposed_frequency text,
  p_proposed_weekdays  jsonb,
  p_payment_terms    text,
  p_notes            text,
  p_internal_notes   text,
  p_actor            uuid,
  p_items            jsonb
)
RETURNS TABLE (quote_id uuid, quote_number text)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_seq      integer;
  v_numero   text;
  v_id       uuid := gen_random_uuid();
  v_subtotal numeric(10,2);
  v_base     numeric(10,2);
  v_iva      numeric(10,2);
  v_total    numeric(10,2);
  v_itens    integer;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Um orçamento sem linhas é um documento a zero que parece emitido.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Coerência LÓGICA da visita — o que a FK composta não consegue dizer.
  --
  --    A FK garante que a visita é da mesma empresa. Não garante que é da
  --    mesma LEAD: dentro da mesma empresa, nada impediria orçamentar a lead A
  --    com as medições da visita à lead B. As áreas e horas dessa visita
  --    entrariam num preço que não lhes diz respeito.
  IF p_visit_id IS NOT NULL THEN
    PERFORM 1
       FROM public.crm_visits v
      WHERE v.id = p_visit_id
        AND v.company_id = p_company_id
        AND (
          (p_lead_id   IS NOT NULL AND v.lead_id   IS NOT DISTINCT FROM p_lead_id)
       OR (p_client_id IS NOT NULL AND v.client_id IS NOT DISTINCT FROM p_client_id)
        );

    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTE_VISIT_MISMATCH: a visita não pertence a este destinatário'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 🔴 Sem `assert_financial_period_dates_open_locked`. Ver o cabeçalho: um
  --    orçamento não é documento financeiro, e orçamentar num mês fechado é
  --    legítimo.

  -- Serializa a atribuição do número por empresa e ano.
  --
  -- 🔴 O ':orc:' no meio da chave separa este espaço do das facturas, que usam
  --    hashtext(company || ':' || ano) na mesma forma de um argumento.
  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':orc:' || p_year::text));

  SELECT COALESCE(MAX(q.quote_seq), 0) INTO v_seq
    FROM public.crm_quotes q
   WHERE q.company_id = p_company_id
     AND q.quote_year = p_year;

  v_seq := v_seq + 1;
  v_numero := p_prefix || p_year::text || '/' || lpad(v_seq::text, 3, '0');

  -- Os totais, calculados aqui e não aceites do cliente.
  SELECT COALESCE(sum(round((i->>'quantity')::numeric * (i->>'unit_price')::numeric, 2)), 0)
    INTO v_subtotal
    FROM jsonb_array_elements(p_items) AS i;

  v_base := round(v_subtotal * (1 - COALESCE(p_discount_pct, 0) / 100), 2);
  v_iva  := CASE WHEN COALESCE(p_apply_vat, true) AND COALESCE(p_vat_rate, 0) > 0
                 THEN round(v_base * p_vat_rate / 100, 2)
                 ELSE 0 END;
  v_total := v_base + v_iva;

  INSERT INTO public.crm_quotes (
    id, company_id, lead_id, client_id, source_lead_id, visit_id,
    quote_number, quote_year, quote_seq, revision, root_quote_id,
    issue_date, valid_until, status,
    pricing_kind, subtotal, discount_pct, apply_vat, vat_rate, vat_amount, total,
    proposed_frequency, proposed_weekdays, payment_terms, notes, internal_notes,
    created_by
  ) VALUES (
    -- `source_lead_id` nasce igual a `lead_id` e nunca mais muda. Quando o
    -- orcamento nasce de um cliente que ja existe, p_lead_id e NULL e a
    -- proveniencia fica NULL — nao houve lead nenhuma.
    v_id, p_company_id, p_lead_id, p_client_id, p_lead_id, p_visit_id,
    v_numero, p_year, v_seq, 0, v_id,
    p_issue_date, p_valid_until, 'rascunho',
    COALESCE(p_pricing_kind, 'pontual'), v_subtotal, COALESCE(p_discount_pct, 0),
    COALESCE(p_apply_vat, true), p_vat_rate, v_iva, v_total,
    p_proposed_frequency, p_proposed_weekdays, p_payment_terms, p_notes, p_internal_notes,
    p_actor
  );

  INSERT INTO public.crm_quote_items (
    company_id, quote_id, position, description, quantity, unit, unit_price, line_total
  )
  SELECT
    p_company_id,
    v_id,
    (ordinalidade - 1)::smallint,
    i->>'description',
    (i->>'quantity')::numeric,
    COALESCE(i->>'unit', 'servico'),
    (i->>'unit_price')::numeric,
    round((i->>'quantity')::numeric * (i->>'unit_price')::numeric, 2)
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(i, ordinalidade);

  -- A verificação que prova que as linhas todas entraram — mesmo padrão da 094.
  --
  -- 🔴 O alias `it.` é obrigatório. `quote_id` é ao mesmo tempo coluna de
  --    `crm_quote_items` e parâmetro de SAÍDA desta função, e o plpgsql
  --    resolve a favor do parâmetro: sem o alias, isto rebenta com «column
  --    reference "quote_id" is ambiguous». A 094 deixou o aviso escrito para
  --    o `invoice_number`; vale aqui igual, e o ensaio voltou a apanhá-lo.
  SELECT count(*) INTO v_itens
    FROM public.crm_quote_items it
   WHERE it.quote_id = v_id;
  IF v_itens <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'CRM_QUOTE_ITEMS_MISMATCH: esperadas %, gravadas %',
      jsonb_array_length(p_items), v_itens USING ERRCODE = 'check_violation';
  END IF;

  quote_id := v_id;
  quote_number := v_numero;
  RETURN NEXT;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Rever um orçamento já enviado
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.revise_crm_quote(
  p_company_id     uuid,
  p_quote_id       uuid,
  p_actor          uuid,
  p_issue_date     date,
  p_valid_until    date,
  p_discount_pct   numeric,
  p_apply_vat      boolean,
  p_vat_rate       numeric,
  p_notes          text,
  p_items          jsonb
)
RETURNS TABLE (quote_id uuid, quote_number text)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_antiga   public.crm_quotes%ROWTYPE;
  v_id       uuid := gen_random_uuid();
  v_numero   text;
  v_revisao  smallint;
  v_subtotal numeric(10,2);
  v_base     numeric(10,2);
  v_iva      numeric(10,2);
  v_total    numeric(10,2);
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Um orçamento sem linhas é um documento a zero que parece emitido.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- `FOR UPDATE` serializa duas revisões concorrentes da mesma linha.
  SELECT * INTO v_antiga
    FROM public.crm_quotes
   WHERE id = p_quote_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- 🔴 Um orçamento aceite é a base de um acordo. Mudar-lhe os preços por
  --    baixo é falsificar o acordo — emite-se um novo, com número novo.
  IF v_antiga.status = 'aceite' THEN
    RAISE EXCEPTION 'QUOTE_ACCEPTED_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF v_antiga.status = 'anulado' THEN
    RAISE EXCEPTION 'QUOTE_VOIDED_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  -- Rever uma revisão já substituída criaria um ramo paralelo.
  IF v_antiga.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_SUPERSEDED' USING ERRCODE = 'check_violation';
  END IF;

  -- Um rascunho edita-se em cima; não é aqui que isso acontece.
  IF v_antiga.status = 'rascunho' THEN
    RAISE EXCEPTION 'QUOTE_DRAFT_EDIT_IN_PLACE' USING ERRCODE = 'check_violation';
  END IF;

  v_revisao := v_antiga.revision + 1;
  -- O número base sem o sufixo, para não acumular '-R1-R2'.
  v_numero := split_part(v_antiga.quote_number, '-R', 1) || '-R' || v_revisao::text;

  SELECT COALESCE(sum(round((i->>'quantity')::numeric * (i->>'unit_price')::numeric, 2)), 0)
    INTO v_subtotal
    FROM jsonb_array_elements(p_items) AS i;

  v_base := round(v_subtotal * (1 - COALESCE(p_discount_pct, 0) / 100), 2);
  v_iva  := CASE WHEN COALESCE(p_apply_vat, true) AND COALESCE(p_vat_rate, 0) > 0
                 THEN round(v_base * p_vat_rate / 100, 2)
                 ELSE 0 END;
  v_total := v_base + v_iva;

  -- 🔴 A antiga é marcada ANTES de a nova entrar, e a ordem não é estética.
  --
  --    O índice `uq_crm_quotes_revisao_viva` só admite uma linha com
  --    `superseded_by_id IS NULL` por documento. Inserir primeiro criaria, por
  --    um instante, duas vivas — e o índice recusaria a operação inteira.
  --
  --    Isto só é possível porque `crm_quotes_superseded_fk` é DEFERRABLE: aqui
  --    aponta-se para uma linha que ainda não existe, e a verificação acontece
  --    no fim da transação, quando já existe.
  --
  --    O `status` da antiga NÃO é reescrito. «Foi enviada a 12 de Março» é um
  --    facto histórico, não um estado mutável. O que muda é só o ponteiro.
  UPDATE public.crm_quotes SET superseded_by_id = v_id WHERE id = v_antiga.id;

  -- A revisão nasce em rascunho e sem as datas de envio/decisão da anterior:
  -- é um documento novo, ainda não enviado.
  INSERT INTO public.crm_quotes (
    id, company_id, lead_id, client_id, source_lead_id, visit_id,
    quote_number, quote_year, quote_seq, revision, root_quote_id,
    issue_date, valid_until, status,
    pricing_kind, subtotal, discount_pct, apply_vat, vat_rate, vat_amount, total,
    proposed_frequency, proposed_weekdays, payment_terms, notes, internal_notes,
    created_by
  ) VALUES (
    -- A revisao herda a proveniencia da anterior: e o MESMO documento, e a lead
    -- de que nasceu nao muda por se lhe corrigir um preco.
    v_id, p_company_id, v_antiga.lead_id, v_antiga.client_id, v_antiga.source_lead_id, v_antiga.visit_id,
    v_numero, v_antiga.quote_year, v_antiga.quote_seq, v_revisao, v_antiga.root_quote_id,
    p_issue_date, p_valid_until, 'rascunho',
    v_antiga.pricing_kind, v_subtotal, COALESCE(p_discount_pct, 0),
    COALESCE(p_apply_vat, true), p_vat_rate, v_iva, v_total,
    v_antiga.proposed_frequency, v_antiga.proposed_weekdays, v_antiga.payment_terms,
    COALESCE(p_notes, v_antiga.notes), v_antiga.internal_notes,
    p_actor
  );

  INSERT INTO public.crm_quote_items (
    company_id, quote_id, position, description, quantity, unit, unit_price, line_total
  )
  SELECT
    p_company_id, v_id, (ordinalidade - 1)::smallint,
    i->>'description', (i->>'quantity')::numeric, COALESCE(i->>'unit', 'servico'),
    (i->>'unit_price')::numeric,
    round((i->>'quantity')::numeric * (i->>'unit_price')::numeric, 2)
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(i, ordinalidade);

  quote_id := v_id;
  quote_number := v_numero;
  RETURN NEXT;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Mudar o estado
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_crm_quote_status(
  p_company_id uuid,
  p_quote_id   uuid,
  p_actor      uuid,
  p_status     text,
  p_reason     text
)
RETURNS TABLE (quote_id uuid, status text)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_atual public.crm_quotes%ROWTYPE;
  v_agora timestamptz := now();
BEGIN
  SELECT * INTO v_atual
    FROM public.crm_quotes
   WHERE id = p_quote_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- 🔴 Uma revisão substituída é HISTÓRIA, e história não muda de estado.
  --
  --    `revise_crm_quote` preenche `superseded_by_id` na revisão antiga e
  --    preserva o estado que ela tinha — o que está certo. Mas nada impedia,
  --    depois disso, mexer-lhe no estado por aqui. Bastava:
  --
  --      R0 'enviado' → cria-se R1 → R0 fica superseded, ainda 'enviado'
  --      → alguém marca R0 como 'aceite'
  --
  --    e a partir daí a R0 podia voltar a circular e até dar origem à conversão,
  --    com um preço que a revisão seguinte já tinha substituído. A integridade
  --    da cadeia de revisões depende de as revisões antigas serem apenas
  --    legíveis.
  --
  --    Antes da idempotência de propósito: repetir uma operação sobre um
  --    documento substituído continua a ser uma operação sobre um documento
  --    substituído.
  IF v_atual.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_SUPERSEDED: substituido por %', v_atual.superseded_by_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_atual.status = p_status THEN
    quote_id := p_quote_id; status := p_status; RETURN NEXT; RETURN;
  END IF;

  -- As transições permitidas, validadas aqui e não só na interface: uma regra
  -- que vive só no ecrã é uma regra que o próximo caminho de escrita ignora.
  IF NOT (
       (v_atual.status = 'rascunho' AND p_status IN ('enviado', 'anulado'))
    OR (v_atual.status = 'enviado'  AND p_status IN ('aceite', 'recusado', 'expirado', 'anulado'))
    OR (v_atual.status = 'expirado' AND p_status IN ('aceite', 'recusado', 'anulado'))
    OR (v_atual.status = 'recusado' AND p_status IN ('anulado'))
  ) THEN
    RAISE EXCEPTION 'QUOTE_TRANSITION_NOT_ALLOWED: % -> %', v_atual.status, p_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Aceitar um orçamento fora de validade seria aceitar um preço que já não
  --    está de pé. Obriga-se a rever primeiro — que é o que um comercial faria.
  IF p_status = 'aceite' AND v_atual.valid_until < current_date THEN
    RAISE EXCEPTION 'QUOTE_EXPIRED_CANNOT_ACCEPT' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.crm_quotes
     SET status = p_status,
         sent_at     = CASE WHEN p_status = 'enviado'  THEN COALESCE(sent_at, v_agora) ELSE sent_at END,
         accepted_at = CASE WHEN p_status = 'aceite'   THEN v_agora ELSE accepted_at END,
         rejected_at = CASE WHEN p_status = 'recusado' THEN v_agora ELSE rejected_at END,
         rejection_reason = CASE WHEN p_status = 'recusado' THEN p_reason ELSE rejection_reason END
   WHERE id = p_quote_id;

  quote_id := p_quote_id;
  status := p_status;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_crm_quote_status(uuid, uuid, uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_crm_quote_status(uuid, uuid, uuid, text, text) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Pós-estado
-- ───────────────────────────────────────────────────────────────────────────

DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'crm_quotes' AND column_name = 'quote_seq'
  ) THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: quote_seq ausente — a numeração ficaria refém do regexp';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'quote_prefix'
  ) THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: company_settings.quote_prefix ausente';
  END IF;

  SELECT array_agg(esperada.nome) INTO v_faltam
    FROM (VALUES
      ('uq_crm_quotes_numero'),
      ('uq_crm_quotes_seq_revisao'),
      ('uq_crm_quotes_revisao_viva')
    ) AS esperada(nome)
   WHERE to_regclass('public.' || esperada.nome) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: índices únicos em falta %', v_faltam;
  END IF;

  SELECT array_agg(esperada.nome) INTO v_faltam
    FROM (VALUES
      ('crm_quotes_lead_mesma_empresa'),
      ('crm_quotes_cliente_mesma_empresa'),
      ('crm_quotes_visita_mesma_empresa'),
      ('crm_quotes_created_by_mesma_empresa'),
      ('crm_quote_items_quote_mesma_empresa'),
      -- 🔴 As referências da tabela para SI PRÓPRIA. Eram as únicas que não
      --    eram compostas, e por isso as únicas onde a cadeia de revisões podia
      --    atravessar empresas.
      ('crm_quotes_superseded_fk'),
      ('crm_quotes_root_fk'),
      ('crm_quotes_source_lead_mesma_empresa')
    ) AS esperada(nome)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint WHERE conname = esperada.nome
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: FKs compostas em falta %', v_faltam;
  END IF;

  -- 🔴 As duas auto-referências têm de ser COMPOSTAS (duas colunas), não
  --    simples. Verificar só o nome deixaria passar a versão antiga da
  --    constraint, que existia e não isolava nada.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname IN ('crm_quotes_superseded_fk', 'crm_quotes_root_fk',
                       'crm_quotes_source_lead_mesma_empresa')
       AND conrelid = 'public.crm_quotes'::regclass
       AND array_length(conkey, 1) <> 2
  ) THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: FK de auto-referência não é composta';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'crm_quotes'
       AND column_name = 'source_lead_id'
  ) THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: crm_quotes.source_lead_id ausente — a proveniência morreria na conversão';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'crm_quotes_proveniencia_imutavel'
       AND tgrelid = 'public.crm_quotes'::regclass
  ) THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: trigger de imutabilidade da proveniência ausente';
  END IF;

  SELECT array_agg(esperada.nome) INTO v_faltam
    FROM (VALUES
      ('create_crm_quote_with_items'),
      ('revise_crm_quote'),
      ('set_crm_quote_status')
    ) AS esperada(nome)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperada.nome
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_QUOTES_103_POSTSTATE_FAILED: RPC em falta %', v_faltam;
  END IF;
END
$posestado$;
