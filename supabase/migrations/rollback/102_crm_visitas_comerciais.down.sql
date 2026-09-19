-- Rollback da 102.
--
-- ---------------------------------------------------------------------------
-- 🔴 NO_DATA_LOSS — este ficheiro recusa-se a apagar visitas
-- ---------------------------------------------------------------------------
--
-- A primeira versão fazia `DROP TABLE IF EXISTS public.crm_visits` e avisava,
-- em comentário, para exportar antes. Um aviso não é uma protecção: quem corre
-- um rollback às três da manhã a seguir a uma aplicação falhada não lê o
-- cabeçalho, e a visita é o ÚNICO registo do que se foi lá ver — a área
-- medida, as horas estimadas, as notas do local. Nada disso existe noutro
-- sítio, e nada disso se reconstrói.
--
-- ---------------------------------------------------------------------------
-- 🔴 Contar e apagar não chega: é preciso o lock primeiro
-- ---------------------------------------------------------------------------
--
-- A segunda versão contava e apagava dentro do mesmo bloco `DO`, e dizia que
-- «não há janela». Era falso. Um bloco não é um lock: entre o `count(*)` e o
-- `DROP` cabe uma transação concorrente que insere uma visita e faz commit —
-- e o `DROP`, que só então pede `ACCESS EXCLUSIVE`, espera por ela e apaga-a a
-- seguir. A contagem teria dito zero, e mesmo assim perdia-se uma visita.
--
-- Por isso o `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` vem ANTES da contagem.
-- Um writer concorrente ou já commitou — e a contagem vê-o, e recusa — ou fica
-- à espera do lock e encontra a tabela já apagada. Não há terceira ordem.
--
-- ---------------------------------------------------------------------------
-- 🔴 Simetria com o ledger
-- ---------------------------------------------------------------------------
--
-- A segunda versão apagava a tabela e deixava a linha da 102 no ledger. O
-- estado resultante — `102 = PRESENT`, `crm_visits = ABSENT` — é o pior de
-- todos: o runner considera a 102 aplicada e nunca mais a reconstrói. Desfazer
-- um efeito sem desfazer a proveniência é criar drift a fingir que se arruma.
--
-- Este rollback é o inverso exacto da 102: `DROP` da tabela e `DELETE` da
-- linha, no mesmo bloco, ou nada. E prova a própria proveniência antes de
-- apagar seja o que for — sem isso, apagaria alegremente uma `crm_visits`
-- vazia que nunca lhe pertenceu.
--
--     ledger  tabela
--       0       0     → no-op idempotente
--       0       1     → ALIENADA: a tabela não é desta migration → RAISE
--       1       0     → LEDGER_WITHOUT_EFFECT → RAISE (decisão humana)
--       1       1     → checksum tem de bater; lock; contar; vazia → DROP+DELETE
--
-- O checksum pinado é o da 102 tal como está neste repositório. Se o ledger
-- guardar outro, a tabela à frente foi criada por um ficheiro diferente
-- daquele que este rollback sabe desfazer — e aí não se desfaz nada.
--
-- Não toca em `crm_leads`, `clients`, `services` nem no calendário. A 102
-- também não tocou: nenhuma visita chegou a criar um serviço, por desenho.
--
-- `crm_visits_id_company_unique` desaparece com a tabela (é um índice dela).
-- ---------------------------------------------------------------------------

DO $rollback102$
DECLARE
  c_migration CONSTANT text := '102_crm_visitas_comerciais.sql';
  c_lf   CONSTANT text := '236cfdb6fc18ec8ac52496abb2226e2fe998a5ea4f0187597b9f249d301f4c8e';
  c_crlf CONSTANT text := '781f88bd47102bc13bf68767a9c6639e543b2a816c768e26e39021b27fc7f01f';
  v_checksum text;
  v_ledger boolean;
  v_tabela boolean;
  v_linhas bigint;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_VISITS_102_ROLLBACK_LEDGER_AUSENTE: public._migrations não existe — sem ledger não se prova o que esta tabela é';
  END IF;

  -- 🔴 `FOR UPDATE` serializa dois rollbacks simultâneos: o segundo espera, e
  --    quando entra já não encontra linha nenhuma.
  SELECT checksum INTO v_checksum
    FROM public._migrations
   WHERE name = c_migration
     FOR UPDATE;

  v_ledger := FOUND;
  v_tabela := to_regclass('public.crm_visits') IS NOT NULL;

  IF NOT v_ledger AND NOT v_tabela THEN
    RAISE NOTICE 'CRM_VISITS_102_ROLLBACK: sem linha de ledger e sem tabela — nada a desfazer';
    RETURN;
  END IF;

  IF NOT v_ledger AND v_tabela THEN
    RAISE EXCEPTION
      'CRM_VISITS_102_ROLLBACK_TABELA_ALIENADA: public.crm_visits existe sem linha de ledger da 102 — não foi esta migration que a criou, e não é esta que a apaga';
  END IF;

  IF v_ledger AND NOT v_tabela THEN
    RAISE EXCEPTION
      'CRM_VISITS_102_ROLLBACK_LEDGER_WITHOUT_EFFECT: há linha de ledger da 102 mas a tabela não existe — apagar a linha aqui esconderia o que aconteceu; reconcilie em primeira pessoa';
  END IF;

  IF v_checksum IS NULL OR v_checksum NOT IN (c_lf, c_crlf) THEN
    RAISE EXCEPTION
      'CRM_VISITS_102_ROLLBACK_CHECKSUM_DIVERGENTE: o ledger guarda % para a 102 — a tabela à frente não foi criada pelo ficheiro que este rollback desfaz',
      coalesce(v_checksum, 'NULL');
  END IF;

  -- 🔴 O lock ANTES da contagem. É isto que fecha a corrida.
  EXECUTE 'LOCK TABLE public.crm_visits IN ACCESS EXCLUSIVE MODE';

  EXECUTE 'SELECT count(*) FROM public.crm_visits' INTO v_linhas;

  IF v_linhas > 0 THEN
    RAISE EXCEPTION
      'CRM_VISITS_102_ROLLBACK_RECUSADO: % visita(s) em public.crm_visits — o rollback não apaga o que foi medido no local; trate dos dados primeiro',
      v_linhas;
  END IF;

  EXECUTE 'DROP TABLE public.crm_visits';
  DELETE FROM public._migrations WHERE name = c_migration;
END
$rollback102$;
