"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getResend, FROM_EMAIL } from "@/lib/email";
import { clientReminderTemplate } from "@/lib/email/templates";

const emailAddressSchema = z.email();

export interface NotificationPayload {
  serviceId: string;
  clientId: string;
  clientName: string;
  serviceDate: string;
  serviceTime: string;
  method: "sms" | "email";
  contact: string;
}

export interface BulkResult {
  ok: boolean;
  sent: number;
  failed: number;
  errors: string[];
}

export async function sendBulkClientNotifications(
  payloads: NotificationPayload[],
): Promise<BulkResult> {
  // ── Wrapper global: garante que NUNCA lança exceção ──────────────────────────
  try {
    return await _sendBulkClientNotifications(payloads);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno desconhecido";
    console.error("[sendBulkClientNotifications] uncaught:", err);
    return { ok: false, sent: 0, failed: payloads.length, errors: [msg] };
  }
}

async function _sendBulkClientNotifications(
  payloads: NotificationPayload[],
): Promise<BulkResult> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, sent: 0, failed: 0, errors: ["Não autenticado."] };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, sent: 0, failed: 0, errors: ["Sem permissão."] };
  }

  const companyPhone = process.env.COMPANY_PHONE ?? "925 780 509";

  // Verificar Resend
  let resend: ReturnType<typeof getResend> | null = null;
  try {
    resend = getResend();
  } catch {
    return {
      ok: false, sent: 0, failed: payloads.length,
      errors: ["RESEND_API_KEY não configurada no Vercel. Vai a Settings → Environment Variables e adiciona RESEND_API_KEY."],
    };
  }

  const results: { ok: boolean; serviceId: string; method: string; error?: string }[] = [];

  for (const p of payloads) {
    if (p.method === "email") {
      if (!emailAddressSchema.safeParse(p.contact).success) {
        results.push({ ok: false, serviceId: p.serviceId, method: p.method, error: `Email inválido: ${p.contact}` });
        continue;
      }

      // Buscar morada para o template
      const { data: svc } = await admin
        .from("services_full")
        .select("location_address")
        .eq("id", p.serviceId)
        .single();

      const address = svc?.location_address ?? "—";

      const { subject, html } = clientReminderTemplate({
        clientName: p.clientName,
        serviceDate: p.serviceDate,
        serviceTime: p.serviceTime,
        address,
        companyPhone,
      });

      try {
        const { error } = await resend!.emails.send({
          from: FROM_EMAIL,
          to: p.contact,
          subject,
          html,
        });
        if (error) {
          // Erro de domínio não verificado: sugerir solução
          const hint = (error.message ?? "").toLowerCase().includes("domain")
            ? " Verifica se o domínio do FROM_EMAIL está verificado no Resend, ou usa 'onboarding@resend.dev'."
            : "";
          results.push({ ok: false, serviceId: p.serviceId, method: p.method, error: error.message + hint });
        } else {
          results.push({ ok: true, serviceId: p.serviceId, method: p.method });
        }
      } catch (sendErr) {
        results.push({
          ok: false, serviceId: p.serviceId, method: p.method,
          error: sendErr instanceof Error ? sendErr.message : "Erro ao enviar email",
        });
      }
    } else {
      // SMS — não implementado
      results.push({ ok: false, serviceId: p.serviceId, method: "sms", error: "SMS não implementado. Usa WhatsApp." });
    }
  }

  // Persistir histórico (se a tabela existir — migration 013)
  try {
    const records = payloads.map((p, i) => {
      const r = results[i];
      return {
        company_id:   profile.company_id,
        client_id:    p.clientId,
        service_id:   p.serviceId,
        method:       p.method,
        status:       r.ok ? "enviado" : "falhou",
        contact_used: p.contact,
        message_body: p.method === "email"
          ? `Lembrete: ${p.serviceDate} às ${p.serviceTime}`
          : `SMS: ${p.contact}`,
        sent_at:      r.ok ? new Date().toISOString() : null,
        created_by:   user.id,
      };
    });

    const { error: dbError } = await admin
      .from("client_notifications")
      .insert(records);

    if (dbError) {
      console.warn("[sendBulkClientNotifications] histórico falhou:", dbError.message);
    }
  } catch {
    // Não bloquear o resultado se o histórico falhar
  }

  const sent   = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const errors = results.filter((r) => r.error).map((r) => r.error!);

  return { ok: failed === 0, sent, failed, errors };
}
