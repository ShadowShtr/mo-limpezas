"use client";

import { useState } from "react";
import { FlaskConical, Loader2, CheckCircle2 } from "lucide-react";

export function SeedButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleSeed() {
    if (!confirm("Isto vai criar colaboradores, equipas, clientes e serviços fictícios para teste. Continuar?")) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/seed-demo", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        const s = json.summary;
        setResult(`✓ Criados: ${s.colaboradores} colaboradores, ${s.equipas} equipas, ${s.locais} locais, ${s.servicos} serviços`);
      } else {
        setResult("Erro: " + (json.error ?? "desconhecido"));
      }
    } catch {
      setResult("Erro de rede. Tenta novamente.");
    }
    setLoading(false);
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-background)]">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Dados de Teste</h2>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Popula o sistema com dados fictícios para explorar todas as funcionalidades.</p>
      </div>
      <div className="px-6 py-5 flex items-center gap-4">
        <button
          onClick={handleSeed}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] disabled:opacity-60 transition-colors"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
          {loading ? "A criar dados…" : "Gerar dados de teste"}
        </button>
        {result && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{result}</span>
          </div>
        )}
      </div>
    </div>
  );
}
