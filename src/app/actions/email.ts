"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getResend, FROM_EMAIL } from "@/lib/email";
import { clientReminderTemplate } from "@/lib/email/templates";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  serviceId: string;
  clientId: string;
  clientName: string;
  serviceDate: string;   // "d MMM" para display, ex: "9 jun"
  serviceTime: string;   // "HH:mm"
  method: "sms" | "email";
  contact: string;       // email ou telefone
}

export interface BulkResult {
  ok: boolean;
  sent: number;
  failed: number;
  errors: string[];
}

// ─── Enviar notificações em bulk ──────────────────────────────────────────────

export async function sendBulkClientNotifications(
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
  const resend = getResend();
  const results: { ok: boolean; serviceId: string; method: string; error?: string }[] = [];

  for (const p of payloads) {
    if (p.method === "email") {
      if (!p.contact || !p.contact.includes("@")) {
        results.push({ ok: false, serviceId: p.serviceId, method: p.method, error: "Email inválido" });
        continue;
      }

      // Buscar morada do serviço para o template
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

      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: p.contact,
        subject,
        html,
      });

      results.push({
        ok: !error,
        serviceId: p.serviceId,
        method: p.method,
        error: error?.message,
      });
    } else {
      // SMS — não implementado ainda, regista como pendente
      results.push({ ok: false, serviceId: p.serviceId, method: "sms", error: "SMS não implementado" });
    }
  }

  // Persistir na tabela client_notifications
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
        ? `Lembrete de limpeza: ${p.serviceDate} às ${p.serviceTime}`
        : `SMS pendente para ${p.contact}`,
      sent_at:      r.ok ? new Date().toISOString() : null,
      created_by:   user.id,
    };
  });

  const { error: dbError } = await admin
    .from("client_notifications")
    .insert(records);

  const sent   = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const errors = results.filter((r) => r.error).map((r) => r.error!);

  if (dbError) errors.push("Erro ao guardar histórico: " + dbError.message);

  return { ok: failed === 0, sent, failed, errors };
}
