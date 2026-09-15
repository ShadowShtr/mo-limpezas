-- Rollback da 102.
--
-- 🔴 APAGA DADOS. As visitas marcadas e o que nelas foi medido (área, horas
--    estimadas, notas do local) desaparecem. Nada disso existe noutro sítio —
--    a visita é o único registo do que se foi lá ver.
--
--        SELECT count(*) FROM public.crm_visits;
--
--    Se devolver mais que zero, exportar antes de apagar.
--
-- 🔴 ROLLBACK_DATA_POLICY: em produção com dados reais, este ficheiro NÃO é o
--    rollback operacional — ver a nota na 104.down.
--
-- Não toca em `crm_leads`, `clients`, `services` nem no calendário. A 102
-- também não tocou: nenhuma visita chegou a criar um serviço, por desenho.
--
-- `crm_visits_id_company_unique` desaparece com a tabela (é um índice dela).

DROP TABLE IF EXISTS public.crm_visits;
