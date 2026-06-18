import { NextResponse } from "next/server";

export const runtime = "edge";

export function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export function GET() {
  return NextResponse.json({ ok: true });
}
