-- Rollback da 090.
--
-- Tirar a tabela da publicação faz o canal das Cobranças voltar a ser recusado
-- inteiro — incluindo a metade de `services`. O ecrã não fica errado (o
-- fallback de 60s/foco continua a trazer os dados), mas deixa de convergir de
-- imediato. É uma regressão de comportamento, não de correcção.
--
-- Não apaga nem altera uma linha de `manual_charges`.

ALTER TABLE public.manual_charges REPLICA IDENTITY DEFAULT;

DO $despublicar$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.manual_charges;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$despublicar$;
