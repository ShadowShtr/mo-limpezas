-- ============================================================================
-- 064 - Revoga execucao publica de funcoes SECURITY DEFINER ja existentes
-- ============================================================================
-- Achado do T03 (docs/atomicidade-audit/T03-backup-manifesto-2026-08-04.md,
-- schema-inventory-2026-08-04.json): record_company_change_event,
-- delete_client_atomic e set_invoice_status_atomic sao SECURITY DEFINER e
-- estao concedidas a anon/authenticated/PUBLIC em producao.
--
-- Confirmado por leitura do codigo (nao suposicao):
--   - record_company_change_event: so e chamada de dentro de outras funcoes
--     SQL, nunca pelo codigo da aplicacao.
--   - delete_client_atomic: sem nenhum chamador ativo em src/.
--   - set_invoice_status_atomic: so e chamada via admin.rpc(...) usando a
--     service role key (src/app/actions/invoices.ts) - nunca com a sessao
--     do utilizador (anon/authenticated).
-- Service role sempre ignora GRANT/RLS, por isso esta migration nao muda
-- nenhum comportamento observavel da aplicacao - so fecha uma via de acesso
-- direto que nunca deveria ter existido.
--
-- So contem REVOKE - nada de DDL destrutivo, nada de CREATE OR REPLACE,
-- nada que dependa da reconciliacao maior 064/065 congelada. Nao toca em
-- search_path nem no corpo das funcoes (fica para a reconciliacao maior).
-- Idempotente: REVOKE de um privilegio que ja nao existe nao da erro.

REVOKE EXECUTE ON FUNCTION public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], tstzrange, jsonb)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.delete_client_atomic(uuid, uuid, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;

-- Verificacao esperada apos aplicar (deve devolver 0 linhas):
-- SELECT routine_name, grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public'
--   AND routine_name IN ('record_company_change_event', 'delete_client_atomic', 'set_invoice_status_atomic')
--   AND grantee IN ('anon', 'authenticated', 'PUBLIC');
