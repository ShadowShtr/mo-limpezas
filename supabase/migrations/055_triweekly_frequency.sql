-- Adiciona a frequência "triweekly" (3 em 3 semanas) aos contratos, ao lado
-- de weekly/biweekly já existentes — pedido do dono para dar mais opções de
-- cadência sem depender de um dia de mês arbitrário (que pode cair num
-- fim de semana).
-- Descobre o nome real da constraint em vez de assumir "contracts_frequency_check"
-- (nome por omissão do Postgres, mas pode ter sido renomeada nalgum passo anterior).
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'contracts'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%frequency%';

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE contracts DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE contracts ADD CONSTRAINT contracts_frequency_check
  CHECK (frequency IN ('daily', 'weekly', 'biweekly', 'triweekly', 'monthly', 'custom'));
