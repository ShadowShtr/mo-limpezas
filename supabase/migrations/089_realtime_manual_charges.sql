-- ============================================================================
-- 089 — publicar manual_charges no Realtime
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- ---------------------------------------------------------------------------
-- Porque é que isto existe
-- ---------------------------------------------------------------------------
--
-- O ecrã das Cobranças subscreve, num canal só, alterações a `services` E a
-- `manual_charges`. `services` está na publicação; `manual_charges` não — nem
-- aqui nem em produção.
--
-- O Realtime não ignora a metade que não pode servir: recusa o pedido inteiro.
--
--     Unable to subscribe to changes with given parameters.
--
-- O canal cai todo. Nem os eventos de `services` chegam. Medido no shadow de
-- paridade, com a aplicação real a subscrever — não é dedução.
--
-- O ecrã não parece partido porque a subscrição é gatilho e não fonte: há um
-- intervalo de 60s e um listener de foco que forçam a leitura canónica. Os
-- dados convergem; o que se perde é a convergência imediata, e ninguém dá por
-- isso porque nada falha à vista.
--
-- ---------------------------------------------------------------------------
-- Porque é uma migration à parte
-- ---------------------------------------------------------------------------
--
-- A PR das cobranças avulsas é só código, e o rollback dela é um `git revert`.
-- Meter esta linha lá dentro passaria a exigir rollback de schema para desfazer
-- uma alteração de runtime. Separadas, cada uma reverte-se sozinha.
--
-- Publicar uma tabela não expõe dados por si: o Realtime aplica RLS a cada
-- subscritor, e as policies de `manual_charges` continuam a ser as que já são.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_tabela boolean;
  v_pub boolean;
BEGIN
  SELECT to_regclass('public.manual_charges') IS NOT NULL INTO v_tabela;
  SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') INTO v_pub;

  IF NOT coalesce(v_tabela, false) THEN
    RAISE EXCEPTION 'REALTIME_089_PRECONDITION_FAILED: public.manual_charges não existe (a 086 não correu?)';
  END IF;
  IF NOT coalesce(v_pub, false) THEN
    RAISE EXCEPTION 'REALTIME_089_PRECONDITION_FAILED: a publicação supabase_realtime não existe';
  END IF;
END
$precondicoes$;

-- `ADD TABLE` numa tabela já publicada é erro, não no-op. O bloco torna a
-- migration re-executável sem esconder outros erros.
DO $publicar$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.manual_charges;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$publicar$;

-- O Realtime precisa da linha inteira para poder aplicar RLS ao evento de
-- UPDATE/DELETE. Com a identidade por omissão (a chave primária) só vem a
-- chave, e o subscritor não consegue ser avaliado contra as policies.
ALTER TABLE public.manual_charges REPLICA IDENTITY FULL;

DO $posestado$
DECLARE
  v_publicada boolean;
  v_identidade "char";
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_publication p
      JOIN pg_publication_rel pr ON pr.prpubid = p.oid
      JOIN pg_class c ON c.oid = pr.prrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = 'manual_charges'
  ) INTO v_publicada;

  SELECT c.relreplident INTO v_identidade
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'manual_charges';

  IF NOT v_publicada THEN
    RAISE EXCEPTION 'REALTIME_089_POSTSTATE_FAILED: manual_charges não ficou na publicação';
  END IF;
  IF v_identidade <> 'f' THEN
    RAISE EXCEPTION 'REALTIME_089_POSTSTATE_FAILED: REPLICA IDENTITY é %, esperado FULL', v_identidade;
  END IF;
END
$posestado$;
