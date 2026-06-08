"use client";

import { useState } from "react";
import { login, resetPassword } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "recover">("login");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const formData = new FormData(e.currentTarget);

    if (mode === "recover") {
      const result = await resetPassword(formData);
      setLoading(false);
      if (result && "error" in result) setMessage({ type: "error", text: result.error as string });
      if (result && "success" in result) setMessage({ type: "success", text: result.success as string });
      return;
    }

    const result = await login(formData);
    setLoading(false);

    if (!result) return;

    if ("error" in result) {
      setMessage({ type: "error", text: result.error as string });
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)] px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-primary)] mb-4">
            <span className="text-white font-bold text-xl">ML</span>
          </div>
          <h1 className="text-2xl font-bold text-[var(--color-text-main)]">Mó Limpezas</h1>
          <p className="text-sm text-[var(--color-text-sub)] mt-1">
            {mode === "login" ? "Entra na tua conta" : "Recupera a tua password"}
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-xl border border-[var(--color-border)] shadow-sm p-6">
          <form onSubmit={handleSubmit} className="space-y-4">

            <div>
              <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">
                Email
              </label>
              <input
                name="email"
                type="email"
                required
                placeholder="gestor@molimpezas.pt"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm
                           bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                           focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent
                           transition-all"
              />
            </div>

            {mode === "login" && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-[var(--color-text-main)]">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => { setMode("recover"); setMessage(null); }}
                    className="text-xs text-[var(--color-primary)] hover:underline"
                  >
                    Esqueceste?
                  </button>
                </div>
                <input
                  name="password"
                  type="password"
                  required
                  placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm
                             bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                             focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent
                             transition-all"
                />
              </div>
            )}

            {message && (
              <div className={`text-sm px-3 py-2 rounded-lg ${
                message.type === "error"
                  ? "bg-red-50 text-red-600 border border-red-100"
                  : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"
              }`}>
                {message.text}
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "login" ? "Entrar" : "Enviar email de recuperação"}
            </Button>
          </form>

          {mode === "recover" && (
            <button
              onClick={() => { setMode("login"); setMessage(null); }}
              className="w-full mt-3 text-sm text-[var(--color-text-sub)] hover:text-[var(--color-text-main)] transition-colors"
            >
              ← Voltar ao login
            </button>
          )}
        </div>

        <p className="text-center text-xs text-[var(--color-text-muted)] mt-6">
          Mó Limpezas
        </p>
      </div>
    </div>
  );
}
