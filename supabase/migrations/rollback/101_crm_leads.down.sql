-- Rollback da 101.
--
-- 🔴 APAGA DADOS. As duas tabelas são novas e nada fora do CRM lhes toca, mas
--    se já tiverem sido usadas, as leads e o diário de contactos desaparecem —
--    e com eles os motivos de perda, que não existem em mais lado nenhum.
--
--    Antes de correr isto numa base com uso real:
--
--        SELECT count(*) FROM public.crm_leads;
--        SELECT count(*) FROM public.crm_lead_interactions;
--
--    Se qualquer uma devolver mais que zero, exportar antes de apagar.
--
-- Não toca em `clients`, `locations`, `contracts`, `services` nem em nada
-- financeiro — a 101 também não tocou. Uma lead já convertida deixa o cliente
-- e o local que criou exactamente onde estão: são registos de primeira classe,
-- e a conversão é irreversível por desenho.
--
-- `data_history` guarda as linhas que passaram por UPDATE/DELETE enquanto a
-- tabela existiu. Não é apagada aqui: é o histórico, e é precisamente o que
-- pode salvar uma reposição.

DROP TABLE IF EXISTS public.crm_lead_interactions;
DROP TABLE IF EXISTS public.crm_leads;

-- `locations_id_company_unique` fica de propósito.
--
-- É aditivo, não custa nada, e a 105 (conversão) volta a precisar dele. Apagá-lo
-- só criaria trabalho para o repor — e se entretanto alguma FK composta lhe
-- tiver passado a depender, o DROP falharia a meio do rollback.
