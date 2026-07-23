import { NextResponse } from "next/server";
import type { ZodType } from "zod";

// Payload control — defesa em profundidade para rotas de API que recebem
// JSON de fora (telemóvel/browser): nenhuma confia às cegas no que chega.
// Três camadas, por esta ordem:
//   1. Limite de tamanho ANTES de fazer parse (um corpo enorme não chega
//      sequer a ser processado — protege CPU/memória mesmo que o pedido
//      acabe por ser rejeitado).
//   2. Parse seguro (JSON malformado nunca rebenta sem tratamento).
//   3. Validação de forma/tipo via Zod (schema.safeParse) — campos com tipo
//      errado, em falta, ou payloads completamente disparatados são
//      rejeitados com 400 antes de tocarem em lógica de negócio.
// Nenhuma rota deve fazer `await req.json()` diretamente sem passar por isto.

const DEFAULT_MAX_BYTES = 32 * 1024; // 32KB — generoso para JSON de metadata; nenhuma destas rotas recebe ficheiros no corpo JSON.

export type PayloadGuardResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export async function parseJsonBody<T>(
  req: Request,
  schema: ZodType<T>,
  opts: { maxBytes?: number } = {},
): Promise<PayloadGuardResult<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Não foi possível ler o pedido." }, { status: 400 }) };
  }

  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, response: NextResponse.json({ error: "Pedido demasiado grande." }, { status: 413 }) };
  }

  let json: unknown;
  try {
    json = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, response: NextResponse.json({ error: "JSON inválido." }, { status: 400 }) };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Dados inválidos.",
          issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, data: result.data };
}
