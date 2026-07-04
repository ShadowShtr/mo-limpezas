"use client";

import { useState } from "react";
import { Loader2, Umbrella } from "lucide-react";
import { updateVacationBalance } from "@/app/actions/colaboradores";

interface Props {
  colaboradorId: string;
  currentBalance: number;
}

export function VacationBalanceForm({ colaboradorId, currentBalance }: Props) {
  const [balance, setBalance] = useState(String(currentBalance));
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setLoading(true);
    setSaved(false);
    setError(null);
    const val = parseFloat(balance);
    if (isNaN(val)) {
      setLoading(false);
      setError("Valor inválido.");
      return;
    }
    const res = await updateVacationBalance(colaboradorId, val);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <div className="flex items-center gap-2 mb-4">
        <Umbrella className="w-4 h-4 text-[var(--color-info)]" />
        <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Saldo de férias</h3>
      </div>
      <p className="text-xs text-[var(--color-text-sub)] mb-3">
        Define o saldo inicial de dias de férias. O sistema vai descontar automaticamente conforme as férias forem aprovadas.
      </p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="number"
            min={0}
            max={60}
            step={0.5}
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)]
                       focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)]">dias</span>
        </div>
        <button
          onClick={handleSave}
          disabled={loading}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved
              ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
              : "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]"
          } disabled:opacity-50`}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? "Guardado ✓" : "Guardar"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
