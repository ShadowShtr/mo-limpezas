"use client";

import { useState } from "react";
import { KeyRound, Loader2, Copy, Check } from "lucide-react";
import { resetColaboradorPassword } from "@/app/actions/colaboradores";

interface Props {
  colaboradorId: string;
}

export function ResetPasswordButton({ colaboradorId }: Props) {
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleReset() {
    if (!confirm("Gerar uma nova password provisória para esta colaboradora? A password atual deixa de funcionar.")) return;
    setLoading(true);
    setError(null);
    setPassword(null);
    const res = await resetColaboradorPassword(colaboradorId);
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setPassword(res.password);
  }

  function copy() {
    if (!password) return;
    navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <KeyRound className="w-4 h-4 text-[var(--color-primary)]" />
        <p className="text-sm font-semibold text-[var(--color-text-main)]">Acesso / Password</p>
      </div>

      {password ? (
        <div className="space-y-2">
          <p className="text-xs text-[var(--color-text-muted)]">
            Nova password provisória (anota e entrega à colaboradora — só aparece agora):
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-primary-light)] text-[var(--color-primary)] text-sm font-mono break-all">
              {password}
            </code>
            <button
              onClick={copy}
              className="shrink-0 p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
              title="Copiar"
            >
              {copied ? <Check className="w-4 h-4 text-[var(--color-primary)]" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Ela pode trocá-la depois em Perfil → Alterar password.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--color-text-muted)] mb-3">
            Gera uma nova password provisória (útil se a colaboradora se esqueceu).
          </p>
          {error && <p className="text-xs text-[var(--color-danger)] mb-2">{error}</p>}
          <button
            onClick={handleReset}
            disabled={loading}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-main)] hover:bg-[var(--color-background)] disabled:opacity-60 transition-colors"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Redefinir password
          </button>
        </>
      )}
    </div>
  );
}
