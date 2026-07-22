import { NextResponse } from "next/server";

export const runtime = "edge";

export function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export function GET() {
  // "version" permite provar QUE commit está no ar quando alguém reporta
  // "a alteração voltou atrás" (ver scripts/audit-reversoes.mjs, secção 2).
  return NextResponse.json({
    ok: true,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? null,
    env: process.env.VERCEL_ENV ?? "local",
  });
}
