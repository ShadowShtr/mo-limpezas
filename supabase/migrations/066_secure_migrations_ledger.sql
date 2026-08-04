-- ============================================================================
-- 066 - Protege public._migrations (ledger de migrations) de anon/authenticated
-- ============================================================================
-- Achado do T03 / classificação de grants (2026-08-04): _migrations tinha
-- RLS DESLIGADA e grants completos de SELECT/INSERT/UPDATE/DELETE/TRUNCATE/
-- TRIGGER/REFERENCES para anon e authenticated. Ao contrário do TRUNCATE
-- (que a API pública normal do PostgREST não expõe), INSERT/UPDATE/DELETE
-- SÃO expostos pela API REST normal — com RLS desligada e estes grants,
-- qualquer cliente autenticado (ou anon) podia, na prática, adulterar o
-- ledger de migrations via /rest/v1/_migrations.
--
-- Factos confirmados por leitura direta antes de escrever isto:
--   - dono da tabela: postgres (donos ignoram RLS por omissão — o runner,
--     que liga como postgres via SUPABASE_DB_URL, continua a funcionar);
--   - sem sequence/identity associada a nenhuma coluna;
--   - service_role já tem grants próprios (SELECT/INSERT/UPDATE/DELETE/...)
--     — não tocados aqui, só anon/authenticated/PUBLIC;
--   - não está na publicação Realtime;
--   - sem policies existentes.
--
-- Escopo desta migration: só _migrations. Não mexe nas 6 views sinalizadas
-- (services_full, teams_with_members, monthly_hours_summary,
-- services_calendar_summary, services_mobile_collaborator,
-- services_financial_private) nem em mais nenhuma tabela — cada uma precisa
-- da sua própria investigação antes de qualquer correção.

-- Nota: sem BEGIN/COMMIT próprios — scripts/run-migrations.mjs já envolve
-- cada ficheiro na sua própria transação (BEGIN antes, COMMIT depois de
-- registar o checksum no ledger). Um COMMIT aqui cometeria a transação
-- prematuramente, antes do runner gravar o registo em public._migrations.

DO $$
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION '_MIGRATIONS_TABLE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON TABLE public._migrations FROM PUBLIC, anon, authenticated;

ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "_migrations locked" ON public._migrations;
CREATE POLICY "_migrations locked" ON public._migrations
  FOR ALL USING (false) WITH CHECK (false);

-- Verificação esperada depois de aplicar (deve devolver 0 linhas):
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema='public' AND table_name='_migrations'
--   AND grantee IN ('anon','authenticated');
