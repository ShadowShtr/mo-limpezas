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

// ─── Lembrete de serviço ao cliente ──────────────────────────────────────────

export interface ClientReminderData {
  clientName: string;
  serviceDate: string;   // "segunda-feira, 9 de junho"
  serviceTime: string;   // "09:00"
  address: string;
  companyPhone: string;
}

export function clientReminderTemplate(d: ClientReminderData) {
  const subject = `Lembrete — Limpeza amanhã às ${d.serviceTime} | Mó Limpezas`;

  const html = layout(`
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#111827;">
      Olá, ${escHtml(d.clientName)}!
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      A <strong style="color:#111827;">Mó Limpezas</strong> recorda-lhe o serviço agendado para amanhã:
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
           style="background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;padding:0;margin-bottom:24px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 8px;font-size:13px;color:#166534;">
            📅 <strong>${escHtml(d.serviceDate)}</strong>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#166534;">
            🕐 <strong>${escHtml(d.serviceTime)}</strong>
          </p>
          <p style="margin:0;font-size:13px;color:#166534;">
            📍 ${escHtml(d.address)}
          </p>
        </td>
      </tr>
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

// ─── Utilitário ───────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
