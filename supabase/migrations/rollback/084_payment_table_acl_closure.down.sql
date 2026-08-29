-- ============================================================================
-- ROLLBACK da 084 — repõe o ACL residual que a 083 deixou
-- ============================================================================
--
-- 🔴 ROLLBACK_084_REOPENS_KNOWN_PRIVILEGE_BUG = YES
--
--    O prestate da 084 **é** o defeito. Correr isto devolve a
--    `fixed_variable_payments` ao ACL medido em produção a 2026-08-29:
--
--        anon           TRUNCATE=t REFERENCES=t TRIGGER=t MAINTAIN=t
--        authenticated  SELECT=t TRUNCATE=t REFERENCES=t TRIGGER=t MAINTAIN=t
--        service_role   SELECT/INSERT/UPDATE/DELETE=t
--                       TRUNCATE=t REFERENCES=t TRIGGER=t MAINTAIN=t
--
--    Ou seja: devolve ao papel `anon` o privilégio de TRUNCATE sobre a tabela
--    financeira — uma operação que não passa por RLS e que apagaria a tabela
--    inteira sem gerar um único movimento de caixa.
--
--    Este ficheiro existe para o ensaio de rollback ser honesto: um rollback
--    que repusesse um estado *melhor* que o prestate não seria um rollback, e
--    esconderia que a 084 é a única coisa entre produção e este ACL.
--
--    NENHUM ROLLBACK DE PRODUÇÃO ESTÁ AUTORIZADO. Não é `ROLLBACK_BLOCKED` —
--    é reversível, tecnicamente. É `ROLLBACK_UNSAFE_BY_DESIGN`, e correr isto
--    em produção exige decisão e autorização próprias, com consciência de que
--    reabre exactamente o buraco que a 084 veio fechar.
--
-- Ordem: a 084 só mexe no ACL de uma tabela. Nada depende dela, e este
-- rollback não toca em policies, funções, nem na 082/083.
-- ============================================================================

BEGIN;

-- ─── 1. Voltar ao estado limpo antes de reconstruir ────────────────────────
--
-- O mesmo `REVOKE ALL` da 084, para que o prestate seja reposto por construção
-- e não por sobreposição: um GRANT por cima do ACL actual daria um resultado
-- diferente consoante o que a 084 tivesse ou não deixado para trás.
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM service_role;

-- ─── 2. Repor o ACL pós-083, privilégio residual incluído ──────────────────
--
-- 🔴 É aqui que o buraco se reabre, e está escrito à letra de propósito. A 083
--    revogava SELECT/INSERT/UPDATE/DELETE por enumeração e nunca tocava nos
--    outros quatro privilégios; o que sobrava era o `GRANT ALL` por omissão do
--    Supabase. Reproduzir isso significa conceder de volta, nomeadamente, os
--    quatro que ficaram.
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.fixed_variable_payments TO anon;

GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.fixed_variable_payments TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.fixed_variable_payments TO service_role;

-- ─── 3. Retirar o comentário que a 084 pôs ─────────────────────────────────
--
-- A tabela não tinha COMMENT antes da 084. Deixá-lo cá seria um rasto a
-- afirmar um ACL que este ficheiro acabou de desfazer.
COMMENT ON TABLE public.fixed_variable_payments IS NULL;

COMMIT;
