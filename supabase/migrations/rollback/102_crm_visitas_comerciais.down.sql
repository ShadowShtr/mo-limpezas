-- Rollback da 102.
--
-- ---------------------------------------------------------------------------
-- 🔴 NO_DATA_LOSS — este ficheiro recusa-se a apagar visitas
-- ---------------------------------------------------------------------------
--
-- A versão anterior fazia `DROP TABLE IF EXISTS public.crm_visits` e avisava,
-- em comentário, para exportar antes. Um aviso não é uma protecção: quem corre
-- um rollback às três da manhã a seguir a uma aplicação falhada não lê o
-- cabeçalho, e a visita é o ÚNICO registo do que se foi lá ver — a área
-- medida, as horas estimadas, as notas do local. Nada disso existe noutro
-- sítio, e nada disso se reconstrói.
--
-- O contrato passa a ser explícito:
--
--     crm_visits ausente            → no-op, idempotente
--     crm_visits vazia              → DROP permitido
--     crm_visits com linhas         → RAISE, tabela e dados intactos
--
-- Quem quiser mesmo desfazer uma 102 com visitas reais tem de decidir, em
-- primeira pessoa, o que fazer aos dados — exportá-los, movê-los, ou apagá-los
-- com um comando próprio. O rollback não toma essa decisão por ninguém.
--
-- Tudo num só bloco: ou a contagem passa e a tabela cai, ou não cai nada.
-- Não há janela entre verificar e apagar.
--
-- Não toca em `crm_leads`, `clients`, `services` nem no calendário. A 102
-- também não tocou: nenhuma visita chegou a criar um serviço, por desenho.
--
-- `crm_visits_id_company_unique` desaparece com a tabela (é um índice dela).
-- ---------------------------------------------------------------------------

DO $rollback102$
DECLARE
  v_linhas bigint;
BEGIN
  IF to_regclass('public.crm_visits') IS NULL THEN
    RAISE NOTICE 'CRM_VISITS_102_ROLLBACK: public.crm_visits não existe — nada a desfazer';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.crm_visits' INTO v_linhas;

  IF v_linhas > 0 THEN
    RAISE EXCEPTION
      'CRM_VISITS_102_ROLLBACK_RECUSADO: % visita(s) em public.crm_visits — o rollback não apaga o que foi medido no local; trate dos dados primeiro',
      v_linhas;
  END IF;

  EXECUTE 'DROP TABLE public.crm_visits';
END
$rollback102$;
