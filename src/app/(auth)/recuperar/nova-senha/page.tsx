"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updatePassword } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2 } from "lucide-react";

export default function NovaSenhaPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const formData = new FormData(e.currentTarget);
    const result = await updatePassword(formData);
    setLoading(false);

    if (result && "error" in result) {
      setMessage({ type: "error", text: result.error as string });
      return;
    }
    if (result && "success" in result) {
      setDone(true);
      setMessage({ type: "success", text: result.success as string });
      setTimeout(() => router.push((result as { redirect?: string }).redirect ?? "/login"), 1500);
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
          <h1 className="text-2xl font-bold text-[var(--color-text-main)]">Definir nova password</h1>
          <p className="text-sm text-[var(--color-text-sub)] mt-1">
            Escolhe uma password nova para a tua conta
          </p>
        </div>

        <div className="bg-white rounded-xl border border-[var(--color-border)] shadow-sm p-6">
          {done ? (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <CheckCircle2 className="w-12 h-12 text-[var(--color-primary)]" />
              <p className="text-sm text-[var(--color-text-sub)]">
                Password alterada com sucesso. A entrar…
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">
                  Nova password
                </label>
                <input
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm
                             bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                             focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent
                             transition-all"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">
                  Confirmar password
                </label>
                <input
                  name="confirm"
                  type="password"
                  required
                  minLength={8}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm
                             bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                             focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent
                             transition-all"
                />
              </div>

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
                Guardar password
              </Button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-[var(--color-text-muted)] mt-6">
          Mó Limpezas
        </p>
      </div>
    </div>
  );
}
