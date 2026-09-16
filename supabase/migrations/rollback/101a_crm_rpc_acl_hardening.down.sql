-- ============================================================================
-- ROLLBACK da 101a — repõe o ACL que os DEFAULT PRIVILEGES deixaram na 101
-- ============================================================================
--
-- 🔴 ROLLBACK_101A_REOPENS_KNOWN_PRIVILEGE_BUG = YES
--
--    O prestate da 101a **é** o defeito. Correr isto devolve as duas RPC do
--    funil ao ACL medido em produção depois da 101:
--
--        move_crm_lead_stage_atomic   anon=EXECUTE  authenticated=EXECUTE
--                                     service_role=EXECUTE
--        reorder_crm_leads_atomic     anon=EXECUTE  authenticated=EXECUTE
--                                     service_role=EXECUTE
--
--    Ou seja: devolve ao papel `anon` — quem não tem sessão nenhuma — o
--    direito de INVOCAR funções que correm `SELECT ... FOR UPDATE` e tomam
--    locks de linha sobre `crm_leads`.
--
--    Este ficheiro existe para o ensaio de rollback ser honesto. Um rollback
--    que repusesse um estado *melhor* que o prestate não seria um rollback:
--    esconderia que a 101a é a única coisa entre produção e este ACL, e o
--    ensaio deixaria de medir o que diz medir. É a mesma decisão, e a mesma
--    razão, que está escrita no rollback da 084.
--
--    NENHUM ROLLBACK DE PRODUÇÃO ESTÁ AUTORIZADO. Não é `ROLLBACK_BLOCKED` —
--    é reversível, tecnicamente. É `ROLLBACK_UNSAFE_BY_DESIGN`, e correr isto
--    em produção exige decisão e autorização próprias, com consciência de que
--    reabre exactamente o buraco que a 101a veio fechar.
--
-- Ordem: a 101a só mexe no ACL e no `proconfig` de duas funções. Nada depende
-- dela. Este rollback não toca no corpo das funções, nem em tabelas, policies,
-- RLS ou na 101 — que continua aplicada e intacta.
-- ============================================================================

BEGIN;

-- ─── 1. Voltar ao estado limpo antes de reconstruir ────────────────────────
--
-- O mesmo `REVOKE ALL` da 101a, para que o prestate seja reposto por
-- construção e não por sobreposição: um `GRANT` por cima do ACL actual daria
-- um resultado diferente consoante o que a 101a tivesse ou não deixado para
-- trás.
REVOKE ALL ON FUNCTION
  public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)
FROM PUBLIC, anon, authenticated, service_role;

-- ─── 2. Repor o ACL pós-101, privilégio indevido incluído ──────────────────
--
-- `anon` e `authenticated` NÃO estão aqui por engano nem por comodidade: é
-- exactamente o que os DEFAULT PRIVILEGES do schema tinham posto e o que o
-- `REVOKE FROM PUBLIC` da 101 não removia. Repor sem eles seria fingir que o
-- prestate era outro.
GRANT EXECUTE ON FUNCTION
  public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)
TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)
TO anon, authenticated, service_role;

-- ─── 3. Largar o `search_path` fixo ────────────────────────────────────────
--
-- A 101 não o punha. Deixá-lo aqui faria o prestate ficar melhor do que era, e
-- o ensaio de reaplicação deixaria de provar que é a 101a que o põe.
ALTER FUNCTION
  public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)
  RESET search_path;

ALTER FUNCTION
  public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)
  RESET search_path;

COMMIT;
