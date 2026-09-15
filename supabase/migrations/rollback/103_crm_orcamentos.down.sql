-- Rollback da 103.
--
-- 🔴 APAGA DADOS. Orçamentos, linhas e toda a cadeia de revisões. Se algum já
--    foi enviado a um cliente, o documento que ele recebeu deixa de ter
--    correspondência no sistema.
--
--        SELECT count(*) FROM public.crm_quotes;
--        SELECT count(*) FROM public.crm_quotes WHERE status <> 'rascunho';
--
--    Se a segunda devolver mais que zero, exportar antes de apagar — há
--    documentos que saíram de casa.
--
-- 🔴 ROLLBACK_DATA_POLICY: em produção com dados reais, este ficheiro NÃO é o
--    rollback operacional — ver a nota na 104.down.
--
-- Não toca em `invoices`, `services`, `contracts` nem em nada financeiro: a
-- 103 também não tocou. Um orçamento aceite que já tenha gerado contrato deixa
-- esse contrato exactamente onde está.

DROP FUNCTION IF EXISTS public.set_crm_quote_status(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb);
DROP FUNCTION IF EXISTS public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb);

DROP TABLE IF EXISTS public.crm_quote_items;
DROP TABLE IF EXISTS public.crm_quotes;

-- `company_settings.quote_prefix` fica de propósito.
--
-- É uma coluna com valor por omissão, não custa nada, e apagá-la obrigaria a
-- reescrever a linha de configurações de cada empresa. Se a 103 voltar a
-- correr, o `ADD COLUMN IF NOT EXISTS` encontra-a e segue.
