// ============================================================================
// O BASELINE FIEL — a forma real do schema de produção, para ensaios de RLS
// ============================================================================
//
// 🔴 Porque este ficheiro existe.
//
//    Seis ensaios em Postgres real escreviam o seu próprio baseline à mão, com
//    3 a 13 tabelas. Produção tem 47, e 93 políticas. O ensaio do resolver
//    conhecia 3 das 6 políticas de `profiles` e 2 das 8 de `timesheets`.
//
//    Isso produziu 90 provas verdadeiras sobre um mundo que não é o nosso. E
//    escondeu o defeito que um preflight read-only encontrou depois: **71 das
//    93 políticas resolvem a identidade por `auth.uid()`**, e a migration só
//    tratava 10. As restantes 61 deixariam um colaborador com conta nova sem
//    conseguir picar o ponto, e um gestor novo sem acesso de gestão.
//
//    Um baseline incompleto não é um ensaio mais simples. É um ensaio que
//    responde a outra pergunta.
//
// ---------------------------------------------------------------------------
// De onde vem
// ---------------------------------------------------------------------------
//
// `fixtures/production-schema-shape.sql` é gerado por
// `scripts/dump-production-rls-baseline.mjs` a partir de uma leitura
// **read-only** da base real: tabelas, colunas, chaves primárias e
// estrangeiras, RLS e políticas. **Sem uma única linha de dados.**
//
// Não é o replay das migrations versionadas de propósito. Replayá-las exigiria
// inventar o andaime de `auth`, `storage` e papéis — que é, ele próprio,
// escrito à mão — e mesmo assim não reproduziria as quatro políticas que
// existem na base e em migration nenhuma. O que se quer medir é o schema real,
// e o schema real é este.
//
// ---------------------------------------------------------------------------
// O que não vem daqui
// ---------------------------------------------------------------------------
//
// `auth.users`, `auth.uid()`, `auth.role()` e os papéis `anon`/`authenticated`/
// `service_role` são do Supabase, não do nosso schema. Ficam no andaime abaixo,
// reduzidos ao que a RLS precisa para ser avaliada a sério — e nada mais, para
// o ensaio não passar a testar o andaime.
//
// Os `GRANT` importam mais do que parecem. Sem eles o Postgres recusa por
// *permissão de tabela* antes de sequer chegar à RLS, e um teste que espera uma
// recusa **passa pela razão errada**. Aconteceu: uma asserção de isolamento deu
// verde com `permission denied for table`, que não prova isolamento nenhum.
// ============================================================================

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** A forma do schema de produção, sem dados. */
export function formaDeProducao(): string {
  return fs.readFileSync(
    path.join(ROOT, "src", "__tests__", "fixtures", "production-schema-shape.sql"),
    "utf8",
  );
}

/**
 * O que o Supabase põe à volta do nosso schema, reduzido ao indispensável.
 *
 * Os helpers nascem como **cotos** que devolvem `NULL`: as políticas do
 * fixture referenciam-nos, e uma função SQL que leia `public.profiles` não pode
 * ser criada antes de a tabela existir. Os corpos verdadeiros são instalados
 * por `helpersLegados()`, depois do fixture.
 */
export const ANDAIME_SUPABASE = `
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE, banned_until timestamptz);

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $uid$;

CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $role$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'authenticated') $role$;

DO $papeis$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon;          END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role;  END IF;
END $papeis$;

-- Cotos. Substituídos por \`helpersLegados()\` assim que as tabelas existirem.
CREATE FUNCTION public.get_my_company_id() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULL::uuid $f$;
CREATE FUNCTION public.get_my_role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$;
CREATE FUNCTION public.get_service_company_id(p uuid) RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULL::uuid $f$;
CREATE FUNCTION public.can_access_service(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT true $f$;
`;

/**
 * Os helpers **como estavam antes** desta frente: identidade por
 * `id = auth.uid()`. É o ponto de partida honesto — é isto que a base tem hoje.
 */
export const HELPERS_LEGADOS = `
CREATE OR REPLACE FUNCTION public.get_my_company_id() RETURNS uuid
  LANGUAGE sql SECURITY DEFINER STABLE AS $f$
  SELECT company_id FROM public.profiles WHERE id = auth.uid() LIMIT 1 $f$;

CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text
  LANGUAGE sql SECURITY DEFINER STABLE AS $f$
  SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1 $f$;

CREATE OR REPLACE FUNCTION public.get_service_company_id(p uuid) RETURNS uuid
  LANGUAGE sql SECURITY DEFINER STABLE AS $f$
  SELECT company_id FROM public.services WHERE id = p $f$;
`;

/**
 * 🔴 Sem isto, a RLS nunca chega a ser avaliada.
 *
 * O Postgres verifica a permissão de tabela **antes** da política. Um teste que
 * espere «negado» vê `permission denied for table` e dá verde sem ter medido
 * nada. É o mesmo padrão dos 90 testes que não corriam por o Docker estar
 * parado: verde por ausência, não por prova.
 */
export const GRANTS_SUPABASE = `
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- O schema auth também precisa: há políticas e funções que o atravessam.
-- Sem isto o Postgres recusa por permissão de schema antes da RLS, e uma
-- asserção de recusa passa pela razão errada.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`;

/** Tudo por ordem: andaime → forma de produção → helpers reais → grants. */
export function baselineCompleto(): string {
  return [ANDAIME_SUPABASE, formaDeProducao(), HELPERS_LEGADOS, GRANTS_SUPABASE].join("\n");
}

// ─── Impressão digital ───────────────────────────────────────────────────────

/**
 * A impressão digital das políticas: nome, tabela, comando e expressões.
 *
 * Um número fixo seria frágil e mentiroso — passaria se alguém trocasse uma
 * política por outra. Isto denuncia **conteúdo**, que é o que interessa quando
 * a pergunta é «a base ainda é a que ensaiámos?».
 */
export const CONSULTA_IMPRESSAO_POLITICAS = `
  SELECT tablename, policyname, cmd,
         coalesce(qual, '') AS qual,
         coalesce(with_check, '') AS with_check
    FROM pg_policies
   WHERE schemaname = 'public'
   ORDER BY tablename, policyname
`;

/** Quantas políticas resolvem identidade pela equivalência antiga. */
export const CONSULTA_POLITICAS_LEGADAS = `
  SELECT count(*)::int AS n
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) LIKE '%auth.uid()%'
`;

/**
 * Medido contra a base real em 2026-08-27, antes de qualquer alteração.
 *
 * Se estes números mudarem, o fixture está velho — e o ensaio passou a
 * responder sobre um schema que já não é o de produção. Regerar com
 * `node scripts/dump-production-rls-baseline.mjs`.
 */
export const ESPERADO_NO_FIXTURE = {
  politicas: 93,
  politicasComIdentidadeLegada: 71,
  tabelas: 47,
  chavesParaProfiles: 43,
} as const;
