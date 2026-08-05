-- ============================================================================
-- 068 - handle_new_user() deixa de confiar em raw_user_meta_data
-- ============================================================================
-- Achado (docs/atomicidade-audit/migration-checksum-map-2026-08-05.md e
-- relatório de bloqueio de isolamento multiempresa, 2026-08-05): a função
-- lia `company_id` e `role` diretamente de raw_user_meta_data, o campo que
-- QUALQUER chamador do endpoint público de signup do Supabase Auth
-- (POST /auth/v1/signup, com a anon key, que é pública por desenho) pode
-- preencher livremente. Isto permitia, por si só, criar um profile com
-- role='admin' em QUALQUER company_id — incluindo a empresa real em
-- produção — sem qualquer autorização.
--
-- A aplicação nunca usou este caminho: confirmado por leitura do código
-- (src/app/actions/colaboradores.ts, src/app/actions/csv-import.ts) que
-- todo o provisionamento real de contas segue sempre o mesmo padrão
-- server-side, já autenticado como admin/gestor, com company_id vindo da
-- SESSÃO do chamador (nunca do payload do cliente):
--   1. valida que o ator é admin/gestor;
--   2. usa admin.auth.admin.createUser() (service_role);
--   3. faz upsert explícito em public.profiles com o company_id e role
--      corretos, decididos pelo servidor.
-- Ou seja: nenhum fluxo legítimo desta app depende deste trigger para
-- produzir o profile final. É seguro torná-lo neutro.
--
-- Decisão explícita (instrução do dono, 2026-08-05): NÃO substituir por
-- uma versão que valide companies.id ou force role='colaborador'. Mesmo
-- validando a empresa, um estranho continuaria a poder auto-inscrever-se
-- como colaborador numa empresa real cujo UUID conheça ou adivinhe — o
-- signup público não é o mecanismo de convite desta app. A correção
-- correta é remover por completo a confiança em metadata pública, não
-- afinar quanto dela é confiável. Sistema de convites fica fora desta
-- migration.
--
-- Mitigação complementar, fora do SQL: signup público e anonymous
-- sign-ins desativados no Supabase Dashboard (Authentication → General
-- Configuration) em 2026-08-05, confirmado pelo dono. Esta migration é
-- defesa em profundidade — continua correta mesmo que esse toggle seja
-- reativado por engano no futuro.
--
-- O trigger on_auth_user_created (AFTER INSERT ON auth.users) é mantido —
-- só a função por trás dele passa a ser no-op. Remover o trigger inteiro
-- não é necessário e reintroduzi-lo no futuro (para um fluxo de convite
-- real, por exemplo) exigiria mais coordenação do que só voltar a editar
-- a função.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Perfis nunca são provisionados a partir de raw_user_meta_data — esse
  -- campo é preenchível por qualquer chamador do signup público e não é
  -- uma fonte de autorização. O provisionamento autorizado é feito
  -- explicitamente pelos fluxos server-side (criar colaborador, importar
  -- CSV), depois de validar o administrador e a empresa, com upsert
  -- direto em public.profiles.
  RETURN NEW;
END;
$$;

-- Verificação esperada depois de aplicar:
-- SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'handle_new_user';
-- → deve conter só "RETURN NEW;", sem qualquer leitura de raw_user_meta_data
--   nem INSERT em public.profiles.
