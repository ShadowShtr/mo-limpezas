import { NextResponse } from "next/server";
import { CURRENT_MIGRATION_VERSION, deployBranch, deployCommit, deployEnv, supabaseProjectRef } from "@/lib/deploy-info";

export const runtime = "edge";

export function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export function GET() {
  // "version" permite provar QUE commit está no ar quando alguém reporta
  // "a alteração voltou atrás" (ver scripts/audit-reversoes.mjs, secção 2).
  // migrationVersion/supabaseProjectRef permitem confirmar que dois
  // dispositivos/ambientes apontam para o mesmo código e o mesmo projeto
  // Supabase, sem nunca devolver URL completa, chave ou segredo (ver
  // plano de correção T01 e src/lib/deploy-info.ts).
  return NextResponse.json({
    ok: true,
    version: deployCommit(),
    branch: deployBranch(),
    commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? null,
    env: deployEnv(),
    migrationVersion: CURRENT_MIGRATION_VERSION,
    supabaseProjectRef: supabaseProjectRef(),
  });
}
