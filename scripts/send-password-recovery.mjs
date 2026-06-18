// ============================================================
// Envio em massa de recuperação de password — Mó Limpezas
// Ver docs/MIGRACAO_DADOS_REAIS.md
//
// ⚠️  PRÉ-REQUISITO: o domínio do RESEND_FROM_EMAIL TEM de estar verificado no
//     Resend (resend.com/domains). Sem isso o envio para terceiros dá 403.
//
// Uso:
//   node scripts/send-password-recovery.mjs            # DRY-RUN (só lista)
//   node scripts/send-password-recovery.mjs --send     # envia mesmo
//   node scripts/send-password-recovery.mjs --send --base https://mo-limpezas.vercel.app
//
// Envia a cada colaboradora com EMAIL REAL um link próprio
// (/recuperar/nova-senha?token_hash=...&type=recovery) que NÃO depende do
// Site URL/allowlist do Supabase. Salta logins @molimpezas.local (sem caixa
// de correio) e contas de teste (EXCLUDE).
//
// Requer .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                    RESEND_API_KEY, RESEND_FROM_EMAIL
// NÃO contém dados pessoais nem segredos.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { config } from "dotenv";

config({ path: "./.env.local" });

const args = process.argv.slice(2);
const SEND = args.includes("--send");
const BASE = (args[args.indexOf("--base") + 1] && !args[args.indexOf("--base") + 1].startsWith("--"))
  ? args[args.indexOf("--base") + 1]
  : "https://mo-limpezas.vercel.app";
const THROTTLE_MS = 700; // respeitar limites de envio

// Logins/emails a NÃO incluir (contas de teste/dev).
const EXCLUDE = new Set(["vitorshadowmedina@gmail.com", "shadowshtr@gmail.com"]);

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const FROM = process.env.RESEND_FROM_EMAIL || "Mó Limpezas <noreply@molimpezas.pt>";

function emailHtml(name, url) {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
<div style="background:#16A34A;padding:20px;text-align:center;color:#fff;font-weight:700;font-size:20px">Mó Limpezas</div>
<div style="padding:28px">
<p style="font-size:16px;font-weight:600;color:#111827;margin:0 0 8px">Olá, ${name}!</p>
<p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0 0 20px">Clica no botão abaixo para definires/recuperares a tua password na plataforma Mó Limpezas.</p>
<p style="text-align:center;margin:0 0 20px"><a href="${url}" style="display:inline-block;padding:14px 32px;background:#16A34A;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Definir nova password</a></p>
<p style="font-size:12px;color:#9ca3af;text-align:center;margin:0">Este link expira em 1 hora. Se não pediste, ignora este email.</p>
</div></div>`;
}

// 1. Recolher destinatários: colaboradores com email real (não @molimpezas.local)
const recipients = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("profiles").select("id, full_name, email").range(from, from + 999);
  if (error) { console.error("ERRO a ler profiles:", error.message); process.exit(1); }
  if (!data.length) break;
  for (const p of data) {
    const email = (p.email || "").trim().toLowerCase();
    if (!email || email.endsWith("@molimpezas.local") || EXCLUDE.has(email)) continue;
    recipients.push({ id: p.id, name: p.full_name, email });
  }
  if (data.length < 1000) break;
}

console.log(`Destinatários elegíveis (email real): ${recipients.length}`);
recipients.forEach((r) => console.log(`  - ${r.name.padEnd(22)} ${r.email}`));

if (!SEND) {
  console.log("\nDRY-RUN — nada foi enviado. Usa --send para enviar a sério.");
  console.log(`FROM: ${FROM}  | BASE: ${BASE}`);
  console.log("Lembra: o domínio do FROM tem de estar verificado no Resend.");
  process.exit(0);
}

// 2. Enviar
const resend = new Resend(process.env.RESEND_API_KEY);
let ok = 0, fail = 0;
for (const r of recipients) {
  try {
    const { data, error } = await sb.auth.admin.generateLink({ type: "recovery", email: r.email });
    if (error || !data?.properties?.hashed_token) { fail++; console.log("  link FAIL", r.email, error?.message || ""); continue; }
    const url = `${BASE}/recuperar/nova-senha?token_hash=${data.properties.hashed_token}&type=recovery`;
    const { error: se } = await resend.emails.send({
      from: FROM, to: r.email,
      subject: "Definir password — Mó Limpezas | Mó Limpezas",
      html: emailHtml(r.name, url),
    });
    if (se) { fail++; console.log("  send FAIL", r.email, se.message || JSON.stringify(se)); }
    else { ok++; console.log("  enviado:", r.email); }
  } catch (e) { fail++; console.log("  erro", r.email, e.message); }
  await new Promise((res) => setTimeout(res, THROTTLE_MS));
}
console.log(`\nCONCLUÍDO. enviados=${ok} falhas=${fail}`);
