-- Rollback da 101.
--
-- 🔴 APAGA DADOS. As duas tabelas são novas e nada fora do CRM lhes toca, mas
--    se já tiverem sido usadas, as leads e o diário de contactos desaparecem —
--    e com eles os motivos de perda, que não existem em mais lado nenhum.
--
--        SELECT count(*) FROM public.crm_leads;
--        SELECT count(*) FROM public.crm_lead_interactions;
--
--    Se qualquer uma devolver mais que zero, exportar antes de apagar.
--
-- 🔴 ROLLBACK_DATA_POLICY: em produção com dados reais, este ficheiro NÃO é o
--    rollback operacional. O rollback operacional é não publicar o runtime que
--    consome a migration, ou corrigir para a frente. Um `down` destrutivo
--    corrido às cegas sobre dados reais destrói mais do que repõe.
--
-- 🔴 ORDEM: este ficheiro corre POR ÚLTIMO, depois de 104, 103 e 102 — as
--    outras migrations dependem das chaves candidatas e das tabelas daqui.
--
-- Não toca em `clients`, `locations`, `contracts`, `services` nem em nada
-- financeiro — a 101 também não tocou. Uma lead já convertida deixa o cliente
-- e o local que criou exactamente onde estão: são registos de primeira classe,
-- e a conversão é irreversível por desenho.
--
-- `data_history` guarda as linhas que passaram por UPDATE/DELETE enquanto a
-- tabela existiu. Não é apagada aqui: é o histórico, e é precisamente o que
-- pode salvar uma reposição.

-- As RPCs que a 101 cria.
DROP FUNCTION IF EXISTS public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid);

-- As tabelas. `crm_leads_id_company_unique` desaparece com `crm_leads` (é um
-- índice dela), e as FKs compostas desaparecem com as tabelas que as declaram.
DROP TABLE IF EXISTS public.crm_lead_interactions;
DROP TABLE IF EXISTS public.crm_leads;

-- 🔴 `profiles_id_company_unique` e `locations_id_company_unique` FICAM.
--
--    Foram criados pela 101, mas são índices únicos ADITIVOS sobre tabelas
--    preexistentes e vivas: não alteram dados, não alteram comportamento, e
--    `(id, company_id)` é trivialmente único porque `id` já é a chave primária
--    das duas tabelas.
--
--    Apagá-los seria mexer em `profiles` e `locations` — tabelas que a 101
--    encontrou já cá — para desfazer algo que não incomoda ninguém. E se a 101
--    voltar a correr, o `CREATE UNIQUE INDEX IF NOT EXISTS` encontra-os e
--    segue.
