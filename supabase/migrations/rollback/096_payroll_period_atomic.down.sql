-- Rollback da 096 — segurança de período da folha.
--
-- 🔴 ROLLBACK_DATA_DESTRUCTIVE = NO. Nenhuma linha de `payroll_records` ou de
--    `cash_flow_entries` é tocada.
--
-- 🔴 ROLLBACK_REQUIRES_CODE_ROLLBACK = PARCIAL. As quatro funções são NOVAS na
--    096 — não substituem nada — e hoje nenhum runtime publicado as chama:
--    `calculateAndSavePayroll`, `adjustPayrollRecord`, `approvePayrollRecords` e
--    `markPayrollPaid` ainda escrevem directamente da server action. Enquanto
--    assim for, este ficheiro corre sozinho sem partir nada.
--
--    Depois de a PR de runtime da folha ser publicada, NÃO pode.
--
-- 🔴 O QUE SE PERDE, e a segunda parte é a que importa:
--
--    · as quatro escritas voltam a ter a guarda de período só na action, uma
--      viagem antes — RACY;
--    · `markPayrollPaid` volta a ser DUAS escritas separadas. É a P0B, e o
--      próprio ficheiro da action a descreve: «uma falha entre elas deixa
--      salário pago sem saída de caixa». O dinheiro sai da conta da empresa no
--      mundo real e não sai em lado nenhum no sistema.
--
-- 🔴 ÂMBITO: nada aqui toca no cálculo da folha, nem à ida nem à volta.
--    PAYROLL_FLEX_STARTED = NO continua a ser verdade.
--
-- 🔴 FORWARD_FIX_PREFERRED = YES.

DROP FUNCTION IF EXISTS public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid);
DROP FUNCTION IF EXISTS public.approve_payroll_records_atomic(uuid, uuid[], uuid);
DROP FUNCTION IF EXISTS public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid);
DROP FUNCTION IF EXISTS public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid);
