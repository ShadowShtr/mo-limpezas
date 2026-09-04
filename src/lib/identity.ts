import type { createAdminClient } from "@/lib/supabase/admin";

// ============================================================================
// IDENTIDADE — auth.uid() → profiles.auth_user_id → profiles.id
// ============================================================================
//
// O defeito que isto fecha.
//
// `requireProfile` procurava o perfil com `profiles.id = auth.uid()`, ou seja
// assumia que o id do perfil e o id da conta de acesso são o mesmo valor.
// Hoje, em produção, são — mas por acidente, não por desenho: as 29 pessoas
// com login foram criadas quando o perfil nascia junto com a conta.
//
// Existem 17 pessoas SEM conta de acesso (`auth_user_id IS NULL`) — colaboradoras
// criadas só com o nome. Quando alguma delas receber acesso,
// `createCollaboratorAccess` cria uma conta nova no Auth e grava
// `auth_user_id = <id da conta nova>` num perfil que JÁ tem outro `id`. A partir
// desse instante `profiles.id <> auth.uid()`, e a consulta antiga deixa de
// encontrar o perfil: a pessoa entra com a password certa e o sistema comporta-se
// como se não existisse.
//
// Não é uma hipótese: é o que acontece na primeira vez que alguém carregar em
// "dar acesso" a uma das 17.
//
// A ligação canónica é `auth_user_id`, e só ela. Não há fallback para
// `profiles.id`: um fallback aqui é o que faz a mesma consulta significar duas
// coisas diferentes conforme a pessoa, e é exactamente isso que se está a
// remover.

type AdminClient = ReturnType<typeof createAdminClient>;

export const IDENTITY_CODES = {
  /** Nenhum perfil ligado a esta conta de acesso. */
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  /** A consulta falhou. NÃO é o mesmo que "não existe" — ver abaixo. */
  IDENTITY_LOOKUP_FAILED: "IDENTITY_LOOKUP_FAILED",
  /** Mais do que um perfil ligado à mesma conta. Nunca resolver por conta própria. */
  IDENTITY_AMBIGUOUS: "IDENTITY_AMBIGUOUS",
} as const;

export type IdentityCode = (typeof IDENTITY_CODES)[keyof typeof IDENTITY_CODES];

export interface ResolvedProfile {
  id: string;
  company_id: string;
  role: string;
}

export type IdentityResult =
  | { ok: true; profile: ResolvedProfile }
  | { ok: false; code: IdentityCode; error: string };

/** Colunas mínimas de identidade. Quem precisar de mais, que leia à parte. */
export const IDENTITY_COLUMNS = "id, company_id, role, auth_user_id";

/**
 * Decide a identidade a partir do que a base devolveu.
 *
 * Está separada da consulta de propósito: é aqui que vive a política, e uma
 * função pura testa-se sem base de dados nem mocks de cliente.
 *
 * Fail-closed em três sítios, e cada um por uma razão diferente:
 *
 *   · erro de leitura — não se sabe se existe. Tratar como "não existe" daria
 *     acesso negado a quem tem direito numa falha transitória, e — pior — num
 *     código que decidisse o contrário daria acesso a quem não tem;
 *   · zero linhas — não há ligação; a conta não pertence a ninguém aqui;
 *   · duas ou mais linhas — a base tem duas pessoas ligadas à mesma conta.
 *     Escolher uma seria escolher a empresa de alguém à sorte.
 */
export function decideIdentity(input: {
  error?: { message?: string } | null;
  rows?: Array<{ id?: unknown; company_id?: unknown; role?: unknown }> | null;
}): IdentityResult {
  if (input.error) {
    return {
      ok: false,
      code: IDENTITY_CODES.IDENTITY_LOOKUP_FAILED,
      error: "Não foi possível confirmar a identidade. Tente novamente.",
    };
  }

  const rows = input.rows ?? [];
  if (rows.length === 0) {
    return {
      ok: false,
      code: IDENTITY_CODES.PROFILE_NOT_FOUND,
      error: "Perfil não encontrado.",
    };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      code: IDENTITY_CODES.IDENTITY_AMBIGUOUS,
      error: "Identidade ambígua. Contacte a administração.",
    };
  }

  const row = rows[0];
  // `company_id` em falta é fail-closed: sem empresa não há isolamento
  // multi-tenant nenhum, e um `undefined` a viajar como filtro devolve tudo.
  if (typeof row.id !== "string" || typeof row.company_id !== "string" || typeof row.role !== "string") {
    return {
      ok: false,
      code: IDENTITY_CODES.IDENTITY_LOOKUP_FAILED,
      error: "Não foi possível confirmar a identidade. Tente novamente.",
    };
  }

  return { ok: true, profile: { id: row.id, company_id: row.company_id, role: row.role } };
}

/**
 * Resolve o perfil de uma conta de acesso.
 *
 * `auth_user_id` e mais nada. Sem `.single()`: o `.single()` do supabase-js
 * devolve erro tanto para zero linhas como para várias, e essas duas situações
 * têm respostas diferentes — uma é "não tens perfil", a outra é um defeito de
 * dados que ninguém deve resolver adivinhando.
 */
export async function resolveProfileByAuthUser(
  admin: AdminClient,
  authUserId: string,
): Promise<IdentityResult> {
  if (!authUserId) {
    return {
      ok: false,
      code: IDENTITY_CODES.PROFILE_NOT_FOUND,
      error: "Perfil não encontrado.",
    };
  }

  const { data, error } = await admin
    .from("profiles")
    .select("id, company_id, role")
    .eq("auth_user_id", authUserId)
    .limit(2);

  return decideIdentity({ error, rows: data });
}