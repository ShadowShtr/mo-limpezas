"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getResend, FROM_EMAIL } from "@/lib/email";
import { clientReminderTemplate } from "@/lib/email/templates";

const emailAddressSchema = z.email();

export interface NotificationServiceItem {
  serviceId: string;
  date: string;
  time: string;
  address: string;
  value: number | null;
}

// Um payload por cliente, com todos os serviços a notificar de uma vez (o
// email lista todas as datas/valores numa única mensagem, em vez de um email
// por serviço). WhatsApp não passa por aqui — é sempre um link wa.me aberto
// manualmente pelo gestor (ver client-notifications-modal.tsx), consistente
// com o resto da app (nunca há confirmação de entrega de WhatsApp).
export interface NotificationPayload {
  clientId: string;
  clientName: string;
  contact: string; // email
  services: NotificationServiceItem[];
}

export interface BulkResult {
  ok: boolean;
  sent: number;
  failed: number;
  errors: string[];
}

/** Telefone da empresa para o rodapé dos avisos (email e WhatsApp). Não é
 * sensível — já aparece em todos os emails enviados a clientes. */
export async function getCompanyPhone(): Promise<string> {
  return process.env.COMPANY_PHONE ?? "925 780 509";
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

  const results: { ok: boolean; payload: NotificationPayload; error?: string }[] = [];

  for (const p of payloads) {
    if (!emailAddressSchema.safeParse(p.contact).success) {
      results.push({ ok: false, payload: p, error: `Email inválido: ${p.contact}` });
      continue;
    }
    if (p.services.length === 0) continue;

    const { subject, html } = clientReminderTemplate({
      clientName: p.clientName,
      services: p.services.map((s) => ({ date: s.date, time: s.time, address: s.address, value: s.value })),
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
        results.push({ ok: false, payload: p, error: error.message + hint });
      } else {
        results.push({ ok: true, payload: p });
      }
    } catch (sendErr) {
      results.push({
        ok: false, payload: p,
        error: sendErr instanceof Error ? sendErr.message : "Erro ao enviar email",
      });
    }
  }

  // Persistir histórico (se a tabela existir — migration 013). Uma linha por
  // serviço coberto (client_notifications.service_id é singular), todas com
  // o mesmo resultado/timestamp do envio do cliente a que pertencem.
  try {
    const records = results.flatMap((r) =>
      r.payload.services.map((s) => ({
        company_id:   profile.company_id,
        client_id:    r.payload.clientId,
        service_id:   s.serviceId,
        method:       "email" as const,
        status:       r.ok ? "enviado" : "falhou",
        contact_used: r.payload.contact,
        message_body: `Lembrete: ${s.date} às ${s.time}`,
        sent_at:      r.ok ? new Date().toISOString() : null,
        created_by:   user.id,
      })),
    );

    if (records.length > 0) {
      const { error: dbError } = await admin
        .from("client_notifications")
        .insert(records);

      if (dbError) {
        console.warn("[sendBulkClientNotifications] histórico falhou:", dbError.message);
      }
    }
  } catch {
    // Não bloquear o resultado se o histórico falhar
  }

  const sent   = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const errors = results.filter((r) => r.error).map((r) => r.error!);

  return { ok: failed === 0, sent, failed, errors };
}
