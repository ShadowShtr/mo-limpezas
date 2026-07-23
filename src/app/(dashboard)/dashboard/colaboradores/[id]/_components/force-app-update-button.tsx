"use client";

import { useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { forceAppUpdate } from "@/app/actions/colaboradores";

interface Props {
  colaboradorId: string;
}

export function ForceAppUpdateButton({ colaboradorId }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleClick() {
    setLoading(true);
    setResult(null);
    const res = await forceAppUpdate(colaboradorId);
    setLoading(false);
    setResult(
      res.ok
        ? { ok: true, text: `Pedido enviado (${res.sent} dispositivo${res.sent !== 1 ? "s" : ""}). A app dela vai verificar a atualização assim que o telemóvel entregar o aviso.` }
        : { ok: false, text: res.error }
    );
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <RefreshCw className="w-4 h-4 text-[var(--color-primary)]" />
        <p className="text-sm font-semibold text-[var(--color-text-main)]">Atualização da app</p>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        Se ela está presa numa versão antiga e nunca chega a fechar/reabrir a app, isto pede ao telemóvel dela para verificar e aplicar a atualização agora. Não é garantido — depende de o telemóvel entregar o aviso.
      </p>
      {result && (
        <p className={`text-xs mb-2 ${result.ok ? "text-[var(--color-primary)]" : "text-[var(--color-danger)]"}`}>
          {result.text}
        </p>
      )}
      <button
        onClick={handleClick}
        disabled={loading}
        className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-main)] hover:bg-[var(--color-background)] disabled:opacity-60 transition-colors"
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        Forçar atualização da app
      </button>
    </div>
  );
}
