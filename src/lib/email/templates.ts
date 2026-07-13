// ─── Template base ────────────────────────────────────────────────────────────

function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mó Limpezas</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#16A34A;padding:24px 32px;text-align:center;">
              <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
                Mó Limpezas
              </span>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:32px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f4f4f5;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                Mó Limpezas Lda · Portugal<br/>
                <a href="tel:925780509" style="color:#16A34A;text-decoration:none;">925 780 509</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Lembrete de serviço(s) ao cliente ───────────────────────────────────────

export interface ClientReminderService {
  date: string;    // "segunda-feira, 9 de junho"
  time: string;    // "09:00"
  address: string;
  value: number | null; // null = sem valor calculável, não mostra a linha
}

export interface ClientReminderData {
  clientName: string;
  services: ClientReminderService[];
  companyPhone: string;
}

function fmtEuro(v: number): string {
  return v.toFixed(2).replace(".", ",") + " €";
}

export function clientReminderTemplate(d: ClientReminderData) {
  const n = d.services.length;
  const subject = n === 1
    ? `Lembrete — Limpeza ${d.services[0].date} às ${d.services[0].time} | Mó Limpezas`
    : `Lembrete — ${n} serviços agendados | Mó Limpezas`;

  const rows = d.services.map((s) => `
    <tr>
      <td style="padding:16px 20px;border-bottom:1px solid #bbf7d0;">
        <p style="margin:0 0 8px;font-size:13px;color:#166534;">
          📅 <strong>${escHtml(s.date)}</strong> &nbsp; 🕐 <strong>${escHtml(s.time)}</strong>
        </p>
        <p style="margin:0${s.value != null ? " 0 4px" : ""};font-size:13px;color:#166534;">
          📍 ${escHtml(s.address)}
        </p>
        ${s.value != null ? `<p style="margin:0;font-size:13px;color:#166534;">💶 <strong>${escHtml(fmtEuro(s.value))}</strong></p>` : ""}
      </td>
    </tr>
  `).join("");

  const html = layout(`
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#111827;">
      Olá, ${escHtml(d.clientName)}!
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      A <strong style="color:#111827;">Mó Limpezas</strong> recorda-lhe ${n === 1 ? "o serviço agendado" : "os próximos serviços agendados"}:
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
           style="background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;padding:0;margin-bottom:24px;overflow:hidden;">
      ${rows}
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      Caso não necessite do serviço ou queira reagendar, contacte-nos:
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="tel:${escHtml(d.companyPhone)}"
             style="display:inline-block;padding:12px 28px;background:#16A34A;color:#ffffff;
                    text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
            📞 Ligar para ${escHtml(d.companyPhone)}
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;">
      Obrigado pela confiança! 🌿
    </p>
  `);

  return { subject, html };
}

// ─── Lembrete de serviço(s) ao cliente — WhatsApp (texto simples, com emojis) ─

export function clientReminderWhatsAppMessage(d: ClientReminderData): string {
  const lines = d.services.map((s) => {
    const valuePart = s.value != null ? `\n💶 ${fmtEuro(s.value)}` : "";
    return `📅 *${s.date}* às 🕐 *${s.time}*\n📍 ${s.address}${valuePart}`;
  }).join("\n\n");

  const intro = d.services.length === 1
    ? "Aqui está o seu próximo serviço agendado pela *Mó Limpezas* 🧹✨:"
    : "Aqui estão os seus próximos serviços agendados pela *Mó Limpezas* 🧹✨:";

  return `Olá ${d.clientName}! 👋\n\n${intro}\n\n${lines}\n\nSe precisar de reagendar ou tiver alguma dúvida, é só responder por aqui 😊\n\nObrigado pela confiança! 🌿\n📞 ${d.companyPhone}`;
}

// ─── Convite de colaboradora ──────────────────────────────────────────────────

export interface CollaboratorInviteData {
  collaboratorName: string;
  inviteUrl: string;
}

export function collaboratorInviteTemplate(d: CollaboratorInviteData) {
  const subject = "Convite — Mó Limpezas | Mó Limpezas";

  const html = layout(`
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#111827;">
      Olá, ${escHtml(d.collaboratorName)}!
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      Bem-vinda à equipa <strong style="color:#111827;">Mó Limpezas</strong>!<br/>
      Criámos um acesso à plataforma <strong>Mó Limpezas</strong> para veres a tua escala,
      registar ponto e gerir os teus serviços diretamente no telemóvel.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="${escHtml(d.inviteUrl)}"
             style="display:inline-block;padding:14px 32px;background:#16A34A;color:#ffffff;
                    text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">
            Ativar a minha conta
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;text-align:center;">
      Este link expira em 24 horas.
    </p>
    <p style="margin:0;font-size:12px;color:#d1d5db;text-align:center;">
      Se não esperavas este email, podes ignorá-lo.
    </p>
  `);

  return { subject, html };
}

// ─── Recuperação de password ─────────────────────────────────────────────────

export interface PasswordRecoveryData {
  collaboratorName: string;
  recoveryUrl: string;
}

export function passwordRecoveryTemplate(d: PasswordRecoveryData) {
  const subject = "Definir password — Mó Limpezas | Mó Limpezas";

  const html = layout(`
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#111827;">
      Olá, ${escHtml(d.collaboratorName)}!
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      Recebemos um pedido para definires/recuperares a tua password na plataforma
      <strong style="color:#111827;">Mó Limpezas</strong>.<br/>
      Clica no botão abaixo para escolheres uma password nova.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="${escHtml(d.recoveryUrl)}"
             style="display:inline-block;padding:14px 32px;background:#16A34A;color:#ffffff;
                    text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">
            Definir nova password
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;text-align:center;">
      Este link expira em 1 hora.
    </p>
    <p style="margin:0;font-size:12px;color:#d1d5db;text-align:center;">
      Se não pediste isto, podes ignorar este email — a tua password atual continua válida.
    </p>
  `);

  return { subject, html };
}

// ─── Utilitário ───────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
