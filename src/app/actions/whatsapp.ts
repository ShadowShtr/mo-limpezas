"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export interface WhatsAppResult {
  ok: boolean;
  sid?: string;
  error?: string;
}

function getTwilio() {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN não configurados no Vercel.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const twilio = require("twilio");
  return twilio(sid, token);
}

export async function sendWhatsAppToClient(
  to: string,
  message: string,
): Promise<WhatsAppResult> {
  try {
    const supabase = await createClient();
    const admin    = createAdminClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Não autenticado." };

    const { data: profile } = await admin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile || !["admin", "gestor"].includes(profile.role)) {
      return { ok: false, error: "Sem permissão." };
    }

    const from = process.env.TWILIO_WHATSAPP_FROM;
    if (!from) return { ok: false, error: "TWILIO_WHATSAPP_FROM não configurado." };

    // Normalizar número: garantir formato +351XXXXXXXXX
    const normalized = normalizePhone(to);
    if (!normalized) return { ok: false, error: `Número inválido: ${to}` };

    const client = getTwilio();
    const msg = await client.messages.create({
      from: `whatsapp:${from}`,
      to:   `whatsapp:${normalized}`,
      body: message,
    });

    return { ok: true, sid: msg.sid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[sendWhatsAppToClient]", err);
    return { ok: false, error: msg };
  }
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("9")) return `+351${digits}`;
  if (digits.length === 12 && digits.startsWith("351")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("351")) return `+${digits.slice(1)}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("+")) return digits;
  return digits.length >= 8 ? `+${digits}` : null;
}
