-- Rollback da 104.
--
-- Apaga só a função. Não desfaz conversões: os clientes e os locais criados
-- ficam exactamente onde estão, e as leads convertidas continuam a apontar
-- para eles.
--
-- 🔴 É deliberado, e é a única coisa correcta a fazer. Um cliente convertido
--    é um registo de primeira classe — pode já ter contrato, serviços no
--    calendário e dinheiro cobrado. Desfazer a ligação deixaria esse cliente
--    sem a história que explica de onde veio, e a lead a dizer que ganhou sem
--    apontar para nada.
--
-- Sem esta função, a conversão deixa de estar disponível na aplicação. Não
-- corrompe nada; apenas deixa de se poder converter até a 104 voltar.

DROP FUNCTION IF EXISTS public.link_crm_lead_conversion(uuid, uuid, uuid, uuid, uuid, uuid);
