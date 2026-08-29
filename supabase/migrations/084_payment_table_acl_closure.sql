-- ============================================================================
-- 084 — fecho do ACL residual de fixed_variable_payments
-- ============================================================================
-- Achado (leitura read-only de produção pela direcção, 2026-08-29):
--
--     fixed_variable_payments, depois da 083 aplicada:
--
--       anon           SELECT=f INSERT=f UPDATE=f DELETE=f
--                      TRUNCATE=t REFERENCES=t TRIGGER=t MAINTAIN=t
--       authenticated  SELECT=t INSERT=f UPDATE=f DELETE=f
--                      TRUNCATE=t REFERENCES=t TRIGGER=t MAINTAIN=t
--       service_role   SELECT=t INSERT=t UPDATE=t DELETE=t
--                      TRUNCATE=t REFERENCES=t TRIGGER=t MAINTAIN=t
--
-- A 083 fez o que dizia fazer — fechou o DML — mas fechou-o **por enumeração**:
--
--     REVOKE INSERT, UPDATE, DELETE ... FROM PUBLIC, anon, authenticated;
--     REVOKE SELECT ... FROM PUBLIC, anon;
--
-- Enumerar quatro dos oito privilégios de tabela do PostgreSQL deixa os outros
-- quatro exactamente como estavam. E como estavam era: concedidos a toda a
-- gente, pelo `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated,
-- service_role` que o Supabase corre por omissão.
--
-- 🔴 O que está provado, e o que não está.
--
--    PROVADO: o papel `anon` da base detém hoje TRUNCATE, REFERENCES, TRIGGER
--    e MAINTAIN sobre a tabela financeira. Isso é incompatível com a invariante
--    que a 083 declara — PAYMENT_MUTATION_CANONICAL_PATH_ONLY — porque TRUNCATE
--    apaga a tabela inteira **sem passar por RLS** (o RLS não se aplica a
--    TRUNCATE) e sem gerar um único movimento de caixa, e TRIGGER permite
--    pendurar código arbitrário na tabela.
--
--    NÃO PROVADO, e por isso não afirmado em lado nenhum: que exista hoje um
--    caminho pela API REST capaz de executar TRUNCATE. Esse percurso de
--    exploração não foi demonstrado. O defeito que esta migration fecha é o
--    privilégio indevido em si — a distância entre o ACL real e o ACL
--    pretendido — não uma cadeia de exploração.
--
-- ── Porque não se corrige na 083 ────────────────────────────────────────────
--
-- A 083 está aplicada em produção e o seu checksum está no ledger:
--
--     056763d8307f70bfe60534b94aed1e78e4e72c3ed8c65aa37bf945579f581f5a
--
-- Editar o ficheiro punha REPO_CHECKSUM != PRODUCTION_LEDGER_CHECKSUM e partia
-- o `--dry-run` do runner para toda a gente. Uma migration aplicada é história,
-- não rascunho: corrige-se com a seguinte.
--
-- ── O que esta migration NÃO faz ───────────────────────────────────────────
--
--    Não recria a arquitectura de autorização da 083 (policy de leitura,
--    revogação de EXECUTE nas funções): isso é da 083 e continua a valer. Não
--    toca na 082 (atomicidade/TOCTOU). Não redefine `mark_payment_paid` nem
--    `unmark_payment_paid`. Não cria uma segunda policy financeira — a
--    `payments_manager_select` continua a ser a única.
--
--        083 = autorização inicial
--        082 = atomicidade / TOCTOU
--        084 = fecho completo do ACL residual
-- ============================================================================

-- ─── 1. Precondições — fail-closed antes de qualquer REVOKE ─────────────────
--
-- 🔴 Um REVOKE cego é a forma de partir produção com uma migration de
--    segurança. Esta migration só é correcta a partir de um estado concreto: a
--    083 aplicada, com o conteúdo que produziu o ACL medido acima. Se o estado
--    for outro, o que está aqui escrito deixa de ser verdade e a resposta certa
--    é parar — não adivinhar, não «normalizar» em silêncio.
--
--    UNKNOWN_STATE = FAIL_CLOSED. Nada é alterado antes desta guarda passar.
DO $precondicoes$
DECLARE
  v_ledger_count integer;
  v_checksum     text;
  v_policies     text[];
  -- Checksum canónico da 083 tal como está no ledger de produção (contagem 1)
  -- e tal como o runner o calcula para migrations novas: sha256 do ficheiro
  -- normalizado para LF (ver scripts/lib/migration-checksum.mjs).
  c_083_checksum constant text :=
    '056763d8307f70bfe60534b94aed1e78e4e72c3ed8c65aa37bf945579f581f5a';
BEGIN
  -- 1a. A 083 está aplicada, e uma só vez.
  SELECT count(*) INTO v_ledger_count
    FROM public._migrations
   WHERE name = '083_payment_authorization_hardening.sql';

  IF v_ledger_count <> 1 THEN
    RAISE EXCEPTION
      '084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE: 083 aparece % vezes no ledger, esperado 1',
      v_ledger_count;
  END IF;

  -- 1b. É a 083 que conhecemos, e não outra com o mesmo nome.
  --
  -- 🔴 O ensaio local grava checksums de conveniência nas migrations que aplica
  --    para montar o cenário. A igualdade só se exige quando o ledger traz algo
  --    com forma de sha256 — o que é sempre o caso do runner real e nunca o das
  --    fixtures. Sem esta condição, ou o ensaio não corre, ou a fixture tinha de
  --    inventar o checksum de produção; e isso é pior, porque passava a haver
  --    dois sítios a afirmar o mesmo valor.
  SELECT checksum INTO v_checksum
    FROM public._migrations
   WHERE name = '083_payment_authorization_hardening.sql';

  IF v_checksum ~ '^[0-9a-f]{64}$' AND v_checksum <> c_083_checksum THEN
    RAISE EXCEPTION
      '084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE: checksum da 083 é %, esperado %',
      v_checksum, c_083_checksum;
  END IF;

  -- 1c. O conjunto de policies é exactamente o que a 083 deixou.
  --
  -- Uma policy a mais significa que alguém abriu uma segunda porta desde a 083;
  -- uma a menos, que a 083 foi revertida. Nos dois casos o raciocínio desta
  -- migration deixou de se aplicar. Não se apaga a policy desconhecida: apagá-la
  -- seria decidir, em silêncio, sobre uma intenção que não é nossa.
  SELECT coalesce(array_agg(policyname || ':' || cmd ORDER BY policyname), '{}')
    INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'fixed_variable_payments';

  IF v_policies <> ARRAY['payments_manager_select:SELECT'] THEN
    RAISE EXCEPTION
      '084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE: policies de fixed_variable_payments = %, esperado {payments_manager_select:SELECT}',
      v_policies;
  END IF;
END
$precondicoes$;

-- ─── 2. ACL — fechado por conjunto, não por enumeração ─────────────────────
--
-- 🔴 É esta a lição da 083, e é o ponto inteiro desta migration.
--
--    `REVOKE ALL PRIVILEGES` é a única formulação que não envelhece: o
--    PostgreSQL 17 trouxe MAINTAIN, e uma lista escrita à mão em 2026 não
--    conhece o privilégio que a 18 vier a acrescentar. Revoga-se tudo e
--    concede-se de volta, nomeadamente, só o que tem de existir.
--
--    PUBLIC entra na lista por direito próprio: um GRANT a PUBLIC não é visto
--    por um REVOKE dirigido a um papel — são entradas distintas no ACL.
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.fixed_variable_payments FROM service_role;

-- `authenticated` lê, e só lê. Quais linhas continua a ser decisão da policy
-- `payments_manager_select` da 083: privilégio de tabela e RLS são camadas
-- diferentes, e ambas têm de estar certas.
GRANT SELECT ON TABLE public.fixed_variable_payments TO authenticated;

-- 🔴 O caminho canónico precisa de escrever, e de mais nada.
--
--    Não se usa `GRANT ALL` aqui. `ALL` devolveria TRUNCATE, REFERENCES,
--    TRIGGER e MAINTAIN ao service_role e reabriria metade do que esta
--    migration veio fechar, com a agravante de parecer resolvido. As operações
--    do caminho canónico — createPayment, update_payment_atomic, mark/unmark,
--    delete_payment_atomic — são exactamente estas quatro.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fixed_variable_payments TO service_role;

-- `anon` e `PUBLIC` ficam sem nada, e é deliberado: não existe caller anónimo
-- legítimo para uma tabela financeira. O dono da tabela (postgres) não é
-- tocado — revogar-lhe privilégios deixaria a manutenção do próprio esquema
-- sem caminho.

COMMENT ON TABLE public.fixed_variable_payments IS
  'Pagamentos fixos e variáveis. ACL fechado por conjunto na 084: authenticated '
  'só SELECT (as linhas pela policy payments_manager_select da 083), service_role '
  'só o CRUD do caminho canónico, anon/PUBLIC nada. '
  'TRUNCATE/REFERENCES/TRIGGER/MAINTAIN não pertencem a nenhum papel da API: '
  'TRUNCATE não passa por RLS e apagaria a tabela sem gerar movimento de caixa.';

-- ─── 3. Pós-estado — a migration verifica-se a si própria ──────────────────
--
-- 🔴 Sem isto, a prova do ACL final vive só nos testes — e os testes não correm
--    contra produção. Se um GRANT que não previmos sobreviver aos REVOKE acima,
--    é aqui que se sabe, com a transacção ainda por confirmar.
DO $posestado$
DECLARE
  r          record;
  v_esperado boolean;
BEGIN
  FOR r IN
    SELECT papel, privilegio,
           has_table_privilege(papel, 'public.fixed_variable_payments', privilegio) AS tem
      FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS papel
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                              'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS privilegio
  LOOP
    v_esperado := CASE
      WHEN r.papel = 'authenticated' AND r.privilegio = 'SELECT' THEN true
      WHEN r.papel = 'service_role'
       AND r.privilegio IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') THEN true
      ELSE false
    END;

    IF r.tem <> v_esperado THEN
      RAISE EXCEPTION
        '084_ACL_CLOSURE_POSTSTATE_FAILED: %.% = %, esperado %',
        r.papel, r.privilegio, r.tem, v_esperado;
    END IF;
  END LOOP;
END
$posestado$;
