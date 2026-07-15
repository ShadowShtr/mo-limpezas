-- ============================================================
-- MIGRATION 053: Ativar Realtime na tabela notifications
--
-- NotificationsBell subscreve postgres_changes em "notifications" desde a
-- Fase 1, mas a tabela nunca foi adicionada à publicação supabase_realtime
-- — o sino e o novo pop-up de aviso só atualizavam ao reabrir o sino ou
-- recarregar a página, nunca "ao vivo". Confirmado com teste isolado:
-- inserção via service role não gerou nenhum evento no canal subscrito.
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
