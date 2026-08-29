-- ============================================================================
-- ROLLBACK da 085 — repõe a superfície pública que a 085 fechou
-- ============================================================================
--
-- 🔴 ROLLBACK_085_REOPENS_KNOWN_SECURITY_BUG = YES
-- 🔴 PRODUCTION_ROLLBACK_DEFAULT = FORBIDDEN
-- 🔴 ROLLBACK_EXACT_ACL_PRESTATE = NO
--
--    Este ficheiro reabre a CLASSE de exposição necessária para o ensaio ser
--    honesto. Não é uma reconstrução integral do ACL histórico, e não o
--    afirma — ver a nota na secção 1 sobre porque TRUNCATE não volta.
--
--    Correr isto devolve a base ao estado do incidente de 2026-08-29:
--
--        SET ROLE anon → SELECT public.teams_with_members    → devolve linhas
--        SET ROLE anon → SELECT public.monthly_hours_summary → devolve linhas
--        anon EXECUTE archive_expired_documents(uuid)        → possivel
--
--    Ou seja: nome, telefone, avatar e horas de pessoas reais voltam a estar
--    legíveis por quem não tem sessão nenhuma, e uma função SECURITY DEFINER
--    que ESCREVE (`UPDATE collaborator_documents`) volta a ficar ao alcance de
--    `anon`. Não é uma regressão hipotética: é o estado medido em produção que
--    motivou a 085.
--
--    Este ficheiro existe para o ensaio de rollback ser honesto — provar em
--    PostgreSQL descartável que a 085 é reversível — e **não** para ser
--    corrido em produção. Um rollback em produção exige autorização própria e
--    análise de impacto, com consciência de que reabre esta exposição.
--
--    Não é `ROLLBACK_BLOCKED`: é reversível. É `ROLLBACK_UNSAFE_BY_DESIGN`.
--
-- ── Se um caller legítimo partir depois da 085 ─────────────────────────────
--
--    O rollback NÃO é a resposta automática. Reverter tudo para desbloquear um
--    ecrã reabre as cinco superfícies para resolver uma. O caminho é:
--
--      1. caracterizar o caller — que papel, que cliente, que query;
--      2. decidir a autorização mínima que ele precisa;
--      3. versionar essa decisão numa migration nova.
--
--    Um GRANT nomeado e justificado é sempre preferível a reabrir o conjunto.
--
-- Ordem: nada depende da 085, por isso o rollback é isolado.
-- ============================================================================

BEGIN;

-- ─── 1. Views — voltam a correr como a dona, e a ACL ampla regressa ─────────
--
-- `security_invoker = false` é o comportamento por omissão de uma view em
-- PostgreSQL; repô-lo explicitamente deixa o prestate legível em vez de
-- implícito.
ALTER VIEW public.teams_with_members    SET (security_invoker = false);
ALTER VIEW public.monthly_hours_summary SET (security_invoker = false);

-- 🔴 ROLLBACK_EXACT_ACL_PRESTATE = NO — e é uma escolha, não uma falha.
--
--    O prestate real de produção tinha, em cada view, os OITO privilégios de
--    PG17 (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER,
--    MAINTAIN) concedidos a `anon`, `authenticated` e `service_role`. Este
--    rollback devolve APENAS `SELECT`.
--
--    Reconstruir o ACL histórico ao pormenor obrigaria a conceder outra vez
--    TRUNCATE a `anon` — dar a quem não tem sessão o poder de esvaziar
--    tabelas, e TRUNCATE não passa por RLS nenhum. Ficheiro de rollback
--    nenhum vale isso. Reabre-se a classe de exposição necessária ao ensaio
--    (a leitura por `anon`, que é o que a 085 fecha e o que o teste tem de
--    medir), e não mais do que isso.
--
--    Portanto este ficheiro NÃO repõe o prestate exacto, e não o afirma.
GRANT SELECT ON public.teams_with_members    TO anon, authenticated, service_role;
GRANT SELECT ON public.monthly_hours_summary TO anon, authenticated, service_role;

-- ─── 2. Funções — search_path solto e EXECUTE amplo, como estavam ───────────
ALTER FUNCTION public.archive_expired_documents(uuid)       RESET search_path;
ALTER FUNCTION public.get_documents_to_archive(uuid)        RESET search_path;
ALTER FUNCTION public.detect_schedule_conflicts(date, date) RESET search_path;

GRANT EXECUTE ON FUNCTION public.archive_expired_documents(uuid)       TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_documents_to_archive(uuid)        TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_schedule_conflicts(date, date) TO PUBLIC, anon, authenticated;

COMMIT;
