-- ============================================================================
-- 065 - Revoga privilegios de anon/authenticated em domain_mutations e
--        company_change_events (inclui TRUNCATE, que RLS nao cobre)
-- ============================================================================
-- Achado do T03 (leitura direta a information_schema.role_table_grants):
-- anon e authenticated tinham SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
-- TRIGGER e REFERENCES em ambas as tabelas. O RLS existente ja bloqueava
-- SELECT/INSERT/UPDATE/DELETE (nega por omissao quando nao ha policy para
-- o comando), MAS TRUNCATE nunca e coberto por row-level security no
-- Postgres - e uma limitacao do proprio motor, nao um erro de policy.
-- Ou seja: qualquer cliente com a chave anon podia apagar as duas tabelas
-- por completo, de todas as empresas, com um unico TRUNCATE.
--
-- Impacto real ate agora: nenhum, porque as duas tabelas estao vazias
-- (confirmado por leitura direta nesta mesma sessao). Mas tem de ser
-- fechado antes de a fundacao do outbox comecar a guardar dados reais.
--
-- So contem REVOKE/GRANT - sem DDL destrutivo, sem alterar dados. Nao
-- depende da reconciliacao maior 064/065 congelada.

REVOKE ALL ON public.domain_mutations FROM anon, authenticated;
REVOKE ALL ON public.company_change_events FROM anon, authenticated;

-- authenticated mantem SELECT em company_change_events - e o caminho de
-- leitura pretendido para gestores/admins, ja protegido pela policy
-- "managers see company change events" (RLS). Nunca INSERT/UPDATE/DELETE/
-- TRUNCATE a partir do navegador.
GRANT SELECT ON public.company_change_events TO authenticated;

-- Verificacao esperada apos aplicar (deve devolver so as linhas de SELECT
-- para authenticated em company_change_events - mais nada):
-- SELECT table_name, grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public'
--   AND table_name IN ('domain_mutations', 'company_change_events')
--   AND grantee IN ('anon', 'authenticated')
-- ORDER BY table_name, grantee, privilege_type;
