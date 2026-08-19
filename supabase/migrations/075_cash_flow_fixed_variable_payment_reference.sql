-- ============================================================
-- MIGRATION 075: `fixed_variable_payment` como origem de movimento de caixa
--
-- 🔴 CORRIGE UM BUG DE PRODUÇÃO PROVADO (2026-08-18).
--
-- Sintoma relatado: «marco o pagamento como pago e não atualiza».
--
-- Causa: a RPC `mark_payment_paid()` da migration 073 insere em
-- `cash_flow_entries` com `reference_type = 'fixed_variable_payment'`. Mas o
-- CHECK em produção — posto pela 049, que só acrescentou `service_payment` —
-- permite apenas:
--
--     invoice · payroll · service_payment
--
-- O `INSERT` violava o CHECK, a transacção inteira era revertida, e o
-- resultado era exactamente o que o utilizador via: o pagamento continuava
-- pendente, nenhum movimento de caixa aparecia, e nada explicava porquê.
--
-- A UI agravava o problema ao descartar o resultado da action (corrigido em
-- `c7ec712`), mas o erro que ela engolia era **real**: a base recusava mesmo a
-- escrita. Corrigir só a UI passaria a mostrar a mensagem de erro sem nunca
-- deixar marcar um pagamento como pago.
--
-- Esta migration acrescenta `fixed_variable_payment` à lista permitida. Não
-- remove nada, não altera dados, não cria movimentos históricos.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
-- · **Não faz backfill.** Os pagamentos que ficaram por marcar continuam como
--   estão. Esta migration só permite que marcações **futuras** funcionem —
--   criar movimentos históricos é uma decisão separada, com o seu próprio
--   gate, e depende de análise caso a caso (há movimentos manuais que podem
--   já corresponder a alguns deles).
--
-- · **Não toca na 073.** A identidade
--   `reference_type='fixed_variable_payment'` + `reference_id=payment.id` é
--   deliberada: é ela que torna a operação idempotente através do índice único
--   da 024. Reescrever a RPC para usar um tipo já permitido resolveria o
--   sintoma e partiria a identidade económica.
--
-- · **Não altera o comportamento de `NULL`.** Em SQL, `NULL IN (...)` avalia
--   como `NULL`, e um CHECK só rejeita quando é `FALSE` — logo `NULL` sempre
--   passou. A forma explícita abaixo documenta isso em vez de o deixar
--   implícito num detalhe de lógica ternária.
-- ============================================================

BEGIN;

ALTER TABLE public.cash_flow_entries
  DROP CONSTRAINT IF EXISTS cash_flow_entries_reference_type_check;

ALTER TABLE public.cash_flow_entries
  ADD CONSTRAINT cash_flow_entries_reference_type_check
  CHECK (
    reference_type IS NULL
    OR reference_type IN (
      'invoice',              -- 20260608_new_features
      'payroll',              -- 20260608_new_features
      'service_payment',      -- 049 (Cobrança Diária)
      'fixed_variable_payment' -- 075 (RPC da 073, este ficheiro)
    )
  );

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK — ler antes de usar
-- ---------------------------------------------------------------------------
--
-- ⚠️ Este rollback **volta a partir** `mark_payment_paid()`. É reversão
--    técnica do schema, não uma operação a executar depois de a funcionalidade
--    estar em uso.
--
-- ⚠️ E se já existirem linhas com `reference_type = 'fixed_variable_payment'`,
--    o constraint antigo **não pode sequer ser criado**: o `ADD CONSTRAINT`
--    falha ao validar as linhas existentes. Nesse ponto o rollback exige
--    decidir primeiro o que fazer a esses movimentos — que são movimentos de
--    caixa reais, não metadata.
--
-- ALTER TABLE public.cash_flow_entries
--   DROP CONSTRAINT IF EXISTS cash_flow_entries_reference_type_check;
--
-- ALTER TABLE public.cash_flow_entries
--   ADD CONSTRAINT cash_flow_entries_reference_type_check
--   CHECK (
--     reference_type IS NULL
--     OR reference_type IN ('invoice', 'payroll', 'service_payment')
--   );
