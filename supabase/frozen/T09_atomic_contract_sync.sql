-- ============================================================================
-- T09 — SINCRONIZAÇÃO ATÓMICA CONTRATO ↔ OCORRÊNCIAS  ·  SQL CONGELADO
-- ============================================================================
--
-- ███  ESTE FICHEIRO NÃO É UMA MIGRATION E NÃO PODE SER APLICADO.  ███
--
-- Está em `supabase/frozen/`, não em `supabase/migrations/`.
-- `scripts/run-migrations.mjs` lê EXCLUSIVAMENTE `supabase/migrations/*.sql`
-- (constante MIGRATIONS_DIR), por isso o runner não o consegue ver.
--
-- DEPENDE DA T08: usa `services.occurrence_date` e o índice único
-- `services_occurrence_identity_uniq`, que também ainda não foram aplicados.
-- Aplicar isto sem a T08 falha — de propósito.
--
-- Aplicar exige: incidente encerrado, base descartável, ensaio completo e
-- autorização explícita e separada. A migration 070 continua intocada.
--
-- ── PORQUÊ ──────────────────────────────────────────────────────────────────
--
-- Hoje, atualizar um contrato são várias operações independentes: escrever o
-- contrato, gerar ocorrências, apagar as que deixaram de servir, auditar. Se
-- uma falhar a meio, o contrato fica gravado e o calendário fica a dizer outra
-- coisa — que é exatamente a inconsistência que a cliente relata.
--
-- Aqui passa a ser UMA transação: ou muda tudo, ou não muda nada.
--
-- ── SEGURANÇA ───────────────────────────────────────────────────────────────
--
-- A função é SECURITY INVOKER (o predefinido). Não usa SECURITY DEFINER
-- porque não precisa: correndo como quem chama, as políticas RLS de
-- `services` e `contracts` continuam a aplicar-se e não há elevação de
-- privilégio para auditar. `search_path` é fixado à mesma, para o corpo não
-- poder ser desviado por um schema no caminho de pesquisa do chamador.
--
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 1 — FUNÇÃO
-- ────────────────────────────────────────────────────────────────────────────
-- Recebe o plano já decidido em código (a decisão é pura e testada em
-- `src/domain/scheduling/reconciliation.ts`); aqui só se aplica.
--
-- O plano é um array JSON de itens:
--   { "occurrence_date": "2026-07-08",
--     "decision": "CREATE" | "UPDATE_FROM_CONTRACT" | "REMOVE_ORPHAN",
--     "payload": { ... campos do serviço ... } }
--
-- Decisões que não escrevem (KEEP, KEEP_EXCEPTION, KEEP_CANCELLED,
-- SKIP_EXCLUDED, MANUAL_REVIEW) não são enviadas: se chegarem, são ignoradas.

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_contract_occurrences(
  p_company_id  uuid,
  p_contract_id uuid,
  p_plan        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
-- SECURITY INVOKER (predefinido): a RLS do chamador continua a valer.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item      jsonb;
  v_created   int := 0;
  v_updated   int := 0;
  v_removed   int := 0;
  v_skipped   int := 0;
  v_contract  record;
  v_service   record;
BEGIN
  -- 1. Isolamento por empresa. Um contrato de outra empresa é invisível aqui,
  --    mesmo que o id seja adivinhado.
  SELECT id, company_id, status INTO v_contract
    FROM public.contracts
   WHERE id = p_contract_id
     AND company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'contrato % não existe nesta empresa', p_contract_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Serializar por contrato. Dois processos a sincronizar o MESMO contrato
  --    esperam um pelo outro; contratos diferentes não se bloqueiam. O lock é
  --    de transação: liberta sozinho no COMMIT ou no ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_contract_id::text, 0));

  -- 3. Aplicar o plano.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_plan, '[]'::jsonb))
  LOOP
    CASE v_item->>'decision'

      WHEN 'CREATE' THEN
        -- ON CONFLICT DO NOTHING repete o predicado do índice parcial da T08.
        -- É isto que torna a operação retry-safe: uma segunda tentativa não
        -- duplica, e não é erro.
        INSERT INTO public.services (
          company_id, location_id, team_id, contract_id, occurrence_date,
          reference_number, scheduled_start, scheduled_end,
          hourly_rate, calculated_value, apply_vat, num_people, status,
          cleaning_type, payment_status,
          upholstery_type, upholstery_notes, upholstery_units, upholstery_unit_price
        )
        SELECT
          p_company_id,
          (v_item->'payload'->>'location_id')::uuid,
          NULLIF(v_item->'payload'->>'team_id', '')::uuid,
          p_contract_id,
          (v_item->>'occurrence_date')::date,
          v_item->'payload'->>'reference_number',
          (v_item->'payload'->>'scheduled_start')::timestamptz,
          (v_item->'payload'->>'scheduled_end')::timestamptz,
          (v_item->'payload'->>'hourly_rate')::numeric,
          (v_item->'payload'->>'calculated_value')::numeric,
          COALESCE((v_item->'payload'->>'apply_vat')::boolean, false),
          COALESCE((v_item->'payload'->>'num_people')::int, 1),
          'agendado',
          v_item->'payload'->>'cleaning_type',
          v_item->'payload'->>'payment_status',
          v_item->'payload'->>'upholstery_type',
          v_item->'payload'->>'upholstery_notes',
          (v_item->'payload'->>'upholstery_units')::numeric,
          (v_item->'payload'->>'upholstery_unit_price')::numeric
        ON CONFLICT (company_id, contract_id, occurrence_date)
          WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL
          DO NOTHING;

        IF FOUND THEN v_created := v_created + 1; ELSE v_skipped := v_skipped + 1; END IF;

      WHEN 'UPDATE_FROM_CONTRACT' THEN
        -- As três condições finais são a rede de segurança: mesmo que o plano
        -- venha errado, a base recusa sobrescrever uma exceção, um
        -- cancelamento ou um serviço que já aconteceu.
        UPDATE public.services SET
          team_id               = NULLIF(v_item->'payload'->>'team_id', '')::uuid,
          scheduled_start       = (v_item->'payload'->>'scheduled_start')::timestamptz,
          scheduled_end         = (v_item->'payload'->>'scheduled_end')::timestamptz,
          hourly_rate           = (v_item->'payload'->>'hourly_rate')::numeric,
          calculated_value      = (v_item->'payload'->>'calculated_value')::numeric,
          apply_vat             = COALESCE((v_item->'payload'->>'apply_vat')::boolean, false),
          num_people            = COALESCE((v_item->'payload'->>'num_people')::int, 1),
          cleaning_type         = v_item->'payload'->>'cleaning_type',
          payment_status        = v_item->'payload'->>'payment_status',
          upholstery_type       = v_item->'payload'->>'upholstery_type',
          upholstery_notes      = v_item->'payload'->>'upholstery_notes',
          upholstery_units      = (v_item->'payload'->>'upholstery_units')::numeric,
          upholstery_unit_price = (v_item->'payload'->>'upholstery_unit_price')::numeric,
          -- Declara a sincronização legítima (migration 059): sem isto o
          -- trigger marcaria esta escrita como edição manual.
          contract_synced_at    = now()
        WHERE company_id      = p_company_id
          AND contract_id     = p_contract_id
          AND occurrence_date = (v_item->>'occurrence_date')::date
          AND is_exception    = false
          AND status          = 'agendado';

        IF FOUND THEN v_updated := v_updated + 1; ELSE v_skipped := v_skipped + 1; END IF;

      WHEN 'REMOVE_ORPHAN' THEN
        -- Antes de remover, a data entra em excluded_dates: é o que impede o
        -- cron de recriar a ocorrência na corrida seguinte. E é a
        -- occurrence_date, não a data agendada — o defeito encontrado na T08.
        UPDATE public.contracts
           SET excluded_dates = (
                 SELECT array_agg(DISTINCT d)
                   FROM unnest(
                     COALESCE(excluded_dates, ARRAY[]::text[])
                     || ARRAY[v_item->>'occurrence_date']
                   ) AS d
               )
         WHERE id = p_contract_id AND company_id = p_company_id;

        DELETE FROM public.services
         WHERE company_id      = p_company_id
           AND contract_id     = p_contract_id
           AND occurrence_date = (v_item->>'occurrence_date')::date
           AND is_exception    = false
           AND status          = 'agendado';

        IF FOUND THEN v_removed := v_removed + 1; ELSE v_skipped := v_skipped + 1; END IF;

      ELSE
        -- KEEP, KEEP_EXCEPTION, KEEP_CANCELLED, SKIP_EXCLUDED, MANUAL_REVIEW.
        v_skipped := v_skipped + 1;
    END CASE;
  END LOOP;

  -- 4. Devolver o estado autoritativo. Quem chamou não precisa de adivinhar
  --    nem de manter um estado inventado no frontend.
  RETURN jsonb_build_object(
    'contract_id', p_contract_id,
    'created',     v_created,
    'updated',     v_updated,
    'removed',     v_removed,
    'skipped',     v_skipped,
    'synced_at',   now(),
    'services',    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id,
               'occurrence_date', s.occurrence_date,
               'scheduled_start', s.scheduled_start,
               'status', s.status,
               'is_exception', s.is_exception
             ) ORDER BY s.occurrence_date)
        FROM public.services s
       WHERE s.company_id  = p_company_id
         AND s.contract_id = p_contract_id
         AND s.occurrence_date IS NOT NULL
    ), '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.sync_contract_occurrences(uuid, uuid, jsonb) IS
  'T09: aplica um plano de reconciliação numa única transação. A decisão vive '
  'em src/domain/scheduling/reconciliation.ts; aqui só se executa. Serializa '
  'por contrato com advisory lock e recusa tocar em exceções, cancelamentos e '
  'serviços já realizados.';

-- Privilégios mínimos: nada para `anon`, nada para `public`. Só o papel
-- autenticado, e mesmo esse continua sujeito à RLS de services/contracts.
REVOKE ALL ON FUNCTION public.sync_contract_occurrences(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_contract_occurrences(uuid, uuid, jsonb) TO authenticated;

COMMIT;


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 2 — VALIDAÇÃO (só leitura)
-- ────────────────────────────────────────────────────────────────────────────

-- 2.1 — a função existe e NÃO é SECURITY DEFINER (prosecdef tem de ser false):
-- SELECT proname, prosecdef, proconfig
--   FROM pg_proc WHERE proname = 'sync_contract_occurrences';

-- 2.2 — `anon` não pode executar (tem de devolver 0 linhas):
-- SELECT grantee FROM information_schema.role_routine_grants
--  WHERE routine_name = 'sync_contract_occurrences' AND grantee = 'anon';

-- 2.3 — isolamento entre empresas: chamar com um company_id que não é o dono
--       do contrato tem de levantar exceção.

-- 2.4 — idempotência: correr o mesmo plano duas vezes; a segunda tem de
--       devolver created = 0 e o mesmo conjunto de serviços.

-- 2.5 — concorrência: duas sessões com o mesmo contrato ao mesmo tempo; a
--       segunda espera no advisory lock e não duplica.


-- ────────────────────────────────────────────────────────────────────────────
-- PASSO 3 — ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- Remover a função não perde dados: os serviços já escritos ficam, e o
-- caminho antigo (várias operações separadas) continua a funcionar.

-- BEGIN;
-- DROP FUNCTION IF EXISTS public.sync_contract_occurrences(uuid, uuid, jsonb);
-- COMMIT;
