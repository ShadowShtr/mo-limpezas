// Fonte única para provar, sem expor segredos, que código/ambiente/banco
// estão de facto alinhados. Ver plano de correção T01 (prova inequívoca de
// ambiente e versão) — usado por /api/health, /api/health/deep e pela página
// de diagnóstico em /dashboard/sistema/diagnostico.
//
export { CURRENT_SCHEMA_BASELINE } from "@/lib/migration-policy";

/**
 * Extrai só o identificador do projeto Supabase (o subdomínio) a partir de
 * NEXT_PUBLIC_SUPABASE_URL — nunca a URL completa. O valor em si já é
 * público (a variável começa por NEXT_PUBLIC_ e vai para o bundle do
 * browser), mas mesmo assim devolvemos só o suficiente para comparar
 * "é o mesmo projeto?" entre dois ambientes, não o endpoint completo.
 */
export function supabaseProjectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  const match = url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co/i);
  return match ? match[1] : null;
}

export function deployCommit(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
}

export function deployBranch(): string | null {
  return process.env.VERCEL_GIT_COMMIT_REF ?? null;
}

export function deployEnv(): string {
  return process.env.VERCEL_ENV ?? "local";
}
