import { Resend } from "resend";

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY não configurada");
    _resend = new Resend(key);
  }
  return _resend;
}

export const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ?? "Mó Limpezas <noreply@molimpezas.pt>";
