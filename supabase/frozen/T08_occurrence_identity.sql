-- ============================================================================
-- T08 — IDENTIDADE CANÓNICA DE OCORRÊNCIA  ·  SQL CONGELADO
-- ============================================================================
--
-- ███  ESTE FICHEIRO NÃO É UMA MIGRATION E NÃO PODE SER APLICADO.  ███
--
-- Está em `supabase/frozen/`, não em `supabase/migrations/`.
-- `scripts/run-migrations.mjs` lê EXCLUSIVAMENTE `supabase/migrations/*.sql`
-- (constante MIGRATIONS_DIR), por isso este ficheiro é estruturalmente
-- invisível para o runner — não depende de ninguém se lembrar de o saltar.
--
-- Aplicar isto exige, por esta ordem:
--   1. o incidente de credenciais encerrado;
--   2. a base descartável criada;
--   3. o ensaio completo do runbook (docs/T08-identidade-ocorrencia.md);
--   4. autorização explícita e separada do proprietário.
--
-- A migration 070 continua intocada. A T08 é independente dela.
--
-- ── PORQUÊ ──────────────────────────────────────────────────────────────────
--
-- A geração de serviços decide "já existe?" comparando `contract_id` com o dia
-- de `scheduled_start`. Esse campo é ESTADO MUTÁVEL: quando alguém arrasta a
-- visita de quarta para sexta, a data de quarta fica sem serviço e a corrida
-- seguinte do cron cria um serviço novo — a mesma ocorrência lógica passa a
-- existir duas vezes.
--
-- Além disso, "SELECT para ver se existe, depois INSERT" tem uma janela de
-- corrida: dois processos podem ler "não existe" e inserir os dois.
--
-- A identidade passa a ser a DATA CANÓNICA da ocorrência, imutável, e a
-- garantia deixa de ser uma consulta prévia e passa a ser uma constraint.
--
-- ── MODELO ESCOLHIDO ────────────────────────────────────────────────────────
--
-- MODELO A: coluna `occurrence_date` em `services` + índice único parcial.
--
-- MODELO B (tabela `contract_occurrences` própria) foi REJEITADO: só seria
-- necessário para a identidade sobreviver à eliminação do serviço, e isso já
-- está resolvido — apagar uma ocorrência escreve a data em
-- `contracts.excluded_dates` ANTES de apagar (fail-closed, ver
-- `src/app/actions/cancellations.ts`), e é isso que impede o cron de a
-- recriar. Uma tabela nova acrescentaria uma segunda fonte de verdade e mais
-- um sítio para dessincronizar.
--
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 1 — COLUNA (nullable, sem efeito no código existente)
-- ────────────────────────────────────────────────────────────────────────────
-- Seguro de correr isolado: nada lê a coluna enquanto o código não for
-- ligado, e `NULL` está excluído do índice único do passo 4.

BEGIN;

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS occurrence_date DATE;

COMMENT ON COLUMN public.services.occurrence_date IS
  'Data canónica da ocorrência do contrato (T08). Identidade lógica e '
  'IMUTÁVEL: não muda quando o serviço é reagendado, muda de horário, de '
  'equipa, é marcado como exceção ou cancelado. NULL para serviços avulsos '
  '(sem contract_id) e para linhas anteriores ao backfill.';

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 2 — RELATÓRIO DE DUPLICADOS (só leitura; correr ANTES do backfill)
-- ────────────────────────────────────────────────────────────────────────────
-- Se isto devolver linhas, o índice único do passo 4 vai falhar. Resolver
-- primeiro, com o plano produzido por scripts/plan-occurrence-repair.ts.

-- SELECT
--   s.company_id,
--   s.contract_id,
--   (s.scheduled_start AT TIME ZONE 'Europe/Lisbon')::date AS dia,
--   count(*)                                               AS servicos,
--   array_agg(s.id ORDER BY s.created_at, s.id)            AS ids
-- FROM public.services s
-- WHERE s.contract_id IS NOT NULL
-- GROUP BY 1, 2, 3
-- HAVING count(*) > 1
-- ORDER BY 4 DESC, 1, 2, 3;


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 3 — BACKFILL CONSERVADOR
-- ────────────────────────────────────────────────────────────────────────────
-- Preenche APENAS o caso inequívoco (classe NORMAL do diagnóstico):
-- serviço ligado a contrato, que não é exceção, e único do seu contrato
-- naquele dia.
--
-- O que NÃO é tratado aqui, de propósito:
--   · exceções fora da data canónica (a data de origem não é recuperável —
--     `original_date` existe desde a migration 006 mas NENHUM código a
--     escreve, é sempre NULL);
--   · duplicados;
--   · serviços cuja data não pertence ao padrão de recorrência.
-- Esses saem no plano offline e exigem decisão humana. O SQL não adivinha.
--
-- Nota de fuso: a conversão é explícita para 'Europe/Lisbon'. Um
-- `scheduled_start::date` simples leria a data em UTC e trocaria o dia de
-- qualquer serviço marcado para a primeira hora do dia durante o horário de
-- verão.

BEGIN;

WITH unicos AS (
  SELECT
    s.id,
    (s.scheduled_start AT TIME ZONE 'Europe/Lisbon')::date AS dia
  FROM public.services s
  WHERE s.contract_id IS NOT NULL
    AND s.occurrence_date IS NULL
    AND s.is_exception = FALSE
    AND NOT EXISTS (
      SELECT 1
      FROM public.services outro
      WHERE outro.contract_id = s.contract_id
        AND outro.id <> s.id
        AND (outro.scheduled_start AT TIME ZONE 'Europe/Lisbon')::date
            = (s.scheduled_start AT TIME ZONE 'Europe/Lisbon')::date
    )
)
UPDATE public.services s
   SET occurrence_date = u.dia
  FROM unicos u
 WHERE s.id = u.id;

COMMIT;

-- Verificação do que ficou por preencher (só leitura):
-- SELECT count(*) FILTER (WHERE occurrence_date IS NULL) AS por_preencher,
--        count(*) FILTER (WHERE occurrence_date IS NOT NULL) AS preenchidos
--   FROM public.services
--  WHERE contract_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 4 — UNICIDADE (a garantia real)
-- ────────────────────────────────────────────────────────────────────────────
-- Índice ÚNICO PARCIAL. Parcial por duas razões:
--   · serviços avulsos (contract_id NULL) não têm identidade de ocorrência;
--   · linhas ainda por preencher (occurrence_date NULL) não podem bloquear.
--
-- `company_id` entra na chave porque toda a unicidade neste sistema é por
-- empresa — é a mesma regra do resto do modelo multi-empresa.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS services_occurrence_identity_uniq
  ON public.services (company_id, contract_id, occurrence_date)
  WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL;

COMMENT ON INDEX public.services_occurrence_identity_uniq IS
  'T08: uma ocorrência lógica de contrato = no máximo um serviço. Torna a '
  'geração retry-safe: dois processos concorrentes deixam de poder duplicar, '
  'porque o segundo colide na base em vez de depender de um SELECT prévio.';

COMMIT;

-- ALTERNATIVA para base com tráfego real (fora de transação, sem bloquear
-- escritas; usar esta na base de produção, se e quando for autorizado):
--
-- CREATE UNIQUE INDEX CONCURRENTLY services_occurrence_identity_uniq
--   ON public.services (company_id, contract_id, occurrence_date)
--   WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL;
--
-- CONCURRENTLY não pode correr dentro de BEGIN/COMMIT e, se falhar, deixa um
-- índice INVALID que tem de ser removido à mão antes de repetir:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 5 — INSERÇÃO IDEMPOTENTE (forma que o código passará a usar)
-- ────────────────────────────────────────────────────────────────────────────
-- Substitui o padrão "SELECT para ver se existe, depois INSERT". A inferência
-- do ON CONFLICT repete o predicado do índice parcial — sem isso o PostgreSQL
-- não o consegue escolher.
--
-- DO NOTHING e não DO UPDATE: a geração automática nunca deve sobrescrever uma
-- ocorrência que alguém editou, cancelou ou reagendou à mão.

-- INSERT INTO public.services (
--   company_id, location_id, team_id, contract_id, occurrence_date,
--   reference_number, scheduled_start, scheduled_end,
--   hourly_rate, calculated_value, apply_vat, num_people, status
-- )
-- VALUES (...)
-- ON CONFLICT (company_id, contract_id, occurrence_date)
--   WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL
--   DO NOTHING
-- RETURNING id;
--
-- Sem linha devolvida = a ocorrência já existia. Não é erro: é o resultado
-- correto de uma segunda tentativa.


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 6 — VALIDAÇÃO (só leitura; correr depois de tudo)
-- ────────────────────────────────────────────────────────────────────────────

-- 6.1 — o índice existe e é único e parcial:
-- SELECT indexdef FROM pg_indexes
--  WHERE schemaname = 'public' AND indexname = 'services_occurrence_identity_uniq';

-- 6.2 — nenhuma identidade repetida (tem de devolver 0 linhas):
-- SELECT company_id, contract_id, occurrence_date, count(*)
--   FROM public.services
--  WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL
--  GROUP BY 1, 2, 3 HAVING count(*) > 1;

-- 6.3 — serviços avulsos continuam sem identidade (tem de devolver 0):
-- SELECT count(*) FROM public.services
--  WHERE contract_id IS NULL AND occurrence_date IS NOT NULL;

-- 6.4 — quanto falta ao backfill:
-- SELECT count(*) FROM public.services
--  WHERE contract_id IS NOT NULL AND occurrence_date IS NULL;


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 7 — ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- Ordem inversa. Não há perda de dados: `occurrence_date` é informação
-- derivada, reconstituível pelo backfill a partir do que já existe.
--
-- Antes de reverter, confirmar que nenhum código em execução depende da
-- coluna (a integração da T08 fica desligada até o schema existir).

-- BEGIN;
-- DROP INDEX IF EXISTS public.services_occurrence_identity_uniq;
-- ALTER TABLE public.services DROP COLUMN IF EXISTS occurrence_date;
-- COMMIT;

-- Rollback parcial (manter a coluna, largar só a unicidade), quando o
-- objetivo é destravar escritas depressa sem perder o backfill:
-- DROP INDEX IF EXISTS public.services_occurrence_identity_uniq;


-- ============================================================================
-- NOTAS DE SEGURANÇA
-- ============================================================================
-- · Não cria nem altera funções: não há SECURITY DEFINER, e portanto não há
--   `search_path` para fixar. Se um passo futuro precisar de função, tem de
--   ser SECURITY INVOKER ou declarar `SET search_path = public, pg_temp`.
-- · Não altera RLS. `services` mantém as políticas em vigor; a coluna nova é
--   coberta pelas políticas existentes da tabela.
-- · Não concede privilégios a `anon` nem a `authenticated`.
-- · Não apaga nem altera dados de negócio. O único UPDATE preenche uma coluna
--   nova que estava a NULL, e apenas no caso inequívoco.
-- ============================================================================
