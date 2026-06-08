"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export interface WhatsAppResult {
  ok: boolean;
  messageId?: string;
  error?: string;
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

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !accessToken) {
      return { ok: false, error: "WHATSAPP_NOT_CONFIGURED" };
    }

    const normalized = normalizePhone(to);
    if (!normalized) return { ok: false, error: `Número inválido: ${to}` };

    const res = await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: normalized,
          type: "text",
          text: { body: message },
        }),
      },
    );

    const json = await res.json() as { messages?: { id: string }[]; error?: { message: string } };

    if (!res.ok || json.error) {
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      console.error("[sendWhatsAppToClient] Meta API error:", msg);
      return { ok: false, error: msg };
    }

    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[sendWhatsAppToClient]", err);
    return { ok: false, error: msg };
  }
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("9")) return `351${digits}`;
  if (digits.length === 12 && digits.startsWith("351")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("+")) return digits.slice(1);
  return digits.length >= 8 ? digits : null;
}
