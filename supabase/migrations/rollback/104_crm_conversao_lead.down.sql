-- Rollback da 104.
--
-- Apaga só a função que a 104 cria. Não desfaz conversões: os clientes e os
-- locais criados ficam exactamente onde estão, e as leads convertidas
-- continuam a apontar para eles.
--
-- 🔴 É deliberado, e é a única coisa correcta a fazer. Um cliente convertido é
--    um registo de primeira classe — pode já ter contrato, serviços no
--    calendário e dinheiro cobrado. Desfazer a ligação deixaria esse cliente
--    sem a história que explica de onde veio, e a lead a dizer que ganhou sem
--    apontar para nada.
--
-- Sem esta função, a conversão deixa de estar disponível na aplicação. Não
-- corrompe nada; apenas deixa de se poder converter até a 104 voltar.
--
-- 🔴 ROLLBACK_DATA_POLICY: em produção com dados reais, este ficheiro NÃO é o
--    rollback operacional. O rollback operacional é não publicar o runtime que
--    consome a migration, ou corrigir para a frente. Um `down` destrutivo
--    corrido às cegas sobre dados reais destrói mais do que repõe.

DROP FUNCTION IF EXISTS public.convert_crm_lead_atomic(
  uuid, uuid, uuid, uuid, text, text, text, numeric, numeric, numeric
);
