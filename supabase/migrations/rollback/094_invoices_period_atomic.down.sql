-- Rollback da 094 — faturas dentro do protocolo de período.
--
-- 🔴 ROLLBACK_DATA_DESTRUCTIVE = NO. Nenhuma linha de `invoices`,
--    `invoice_items` ou `cash_flow_entries` é tocada.
--
-- 🔴 ROLLBACK_REQUIRES_CODE_ROLLBACK = PARCIAL.
--
--    `set_invoice_status_atomic` e `delete_invoice_atomic` são NOVAS na 094 e
--    são aqui removidas. Hoje `updateInvoiceStatus` e `deleteInvoice` ainda
--    escrevem directamente da server action e não as chamam; se a PR de runtime
--    das faturas já estiver em produção, este ficheiro NÃO pode correr sozinho.
--
--    `create_invoice_with_items` NÃO é removida: `generateInvoices` usa-a desde
--    a 072. Para a repor na versão anterior reaplica-se a 072, que é toda em
--    `CREATE OR REPLACE`.
--
-- 🔴 O QUE SE PERDE, e é mais do que a guarda de período:
--
--    Marcar uma fatura como paga volta a ser DUAS viagens — o UPDATE da fatura
--    numa, o movimento de caixa noutra. Uma falha entre as duas volta a poder
--    deixar a fatura `pago` sem movimento, ou um movimento de uma fatura que
--    voltou a pendente. Era assim antes da 094 e passa a ser assim outra vez.
--
-- 🔴 FORWARD_FIX_PREFERRED = YES.

DROP FUNCTION IF EXISTS public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer);
DROP FUNCTION IF EXISTS public.delete_invoice_atomic(uuid, uuid, uuid);

-- `create_invoice_with_items` NÃO é removida aqui. Reponha-a reaplicando a 072.
