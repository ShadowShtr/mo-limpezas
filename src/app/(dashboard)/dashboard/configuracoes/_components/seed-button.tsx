"use client";

import { useState } from "react";
import { FlaskConical, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";

export function SeedButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  async function handleSeed() {
    if (!confirm("Isto vai criar dados fictícios em todas as secções (colaboradores, clientes, contratos, serviços, tarefas, viaturas…). Continuar?")) return;
    setLoading(true);
    setResult(null);
    try {
      const url = secret.trim()
        ? `/api/seed-demo?secret=${encodeURIComponent(secret.trim())}`
        : "/api/seed-demo";
      const res = await fetch(url, { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        const s = json.summary;
        setResult({
          ok: true,
          message: `Criados: ${s.colaboradores} colaboradores · ${s.equipas} equipas · ${s.clientes} clientes · ${s.locais} locais · ${s.servicos} serviços · ${s.viaturas} viaturas · ${s.tarefas} tarefas`,
        });
      } else {
        setResult({ ok: false, message: json.error ?? "Erro desconhecido" });
      }
    } catch {
      setResult({ ok: false, message: "Erro de rede. Tenta novamente." });
    }
    setLoading(false);
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-background)]">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Dados de Teste</h2>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          Popula o sistema com dados fictícios em todas as secções para explorar as funcionalidades.
          Em produção, define a variável <code className="bg-gray-100 px-1 rounded">SEED_SECRET</code> no Vercel e introduz o valor abaixo.
        </p>
      </div>

      <div className="px-6 py-5 space-y-3">
        {/* Optional secret for production */}
        <div>
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-sub)] transition-colors"
          >
            {showSecret ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {showSecret ? "Ocultar" : "Mostrar"} campo SEED_SECRET (necessário em produção)
          </button>
          {showSecret && (
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Valor do SEED_SECRET…"
              className="mt-2 w-full max-w-xs px-3 py-2 text-sm border border-[var(--color-border)] rounded-lg outline-none focus:border-[var(--color-primary)]"
            />
          )}
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <button
            onClick={handleSeed}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-main)] disabled:opacity-60 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
            {loading ? "A criar dados…" : "Gerar dados de teste"}
          </button>

          {result && (
            <div className={`flex items-start gap-2 text-sm ${result.ok ? "text-green-600" : "text-red-600"}`}>
              {result.ok
                ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{result.message}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
