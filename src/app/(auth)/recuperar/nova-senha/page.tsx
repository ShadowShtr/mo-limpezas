"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2 } from "lucide-react";

export default function NovaSenhaPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // O link traz ?token_hash=...&type=recovery — validamos com verifyOtp para
  // estabelecer a sessão de recuperação (não depende do Site URL do Supabase).
  useEffect(() => {
    let active = true;
    const supabase = createClient();
    const params = new URLSearchParams(window.location.search);
    const token_hash = params.get("token_hash");
    const type = params.get("type") as "recovery" | null;

    async function run() {
      // Sessão pode já existir (ex.: link com #hash); senão, usa o token_hash.
      const { data: cur } = await supabase.auth.getSession();
      if (cur.session) { if (active) setReady(true); return; }
      if (token_hash && type) {
        const { error } = await supabase.auth.verifyOtp({ token_hash, type });
        if (active) {
          if (error) setInvalid(true);
          else setReady(true);
        }
      } else if (active) {
        setInvalid(true);
      }
    }
    run();
    return () => { active = false; };
  }, []);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const fd = new FormData(e.currentTarget);
    const password = fd.get("password") as string;
    const confirm = fd.get("confirm") as string;
    if (password.length < 8) return setMessage({ type: "error", text: "A password deve ter pelo menos 8 caracteres." });
    if (password !== confirm) return setMessage({ type: "error", text: "As passwords não coincidem." });

    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return setMessage({ type: "error", text: "Não foi possível alterar a password. Pede um novo link." });

    setDone(true);
    const role = data.user?.user_metadata?.role as string | undefined;
    setTimeout(() => router.push(role === "colaborador" ? "/app" : "/dashboard"), 1500);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)] px-4">
      <div className="w-full max-w-sm">
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
              <p className="text-sm text-[var(--color-text-sub)]">Password alterada com sucesso. A entrar…</p>
            </div>
          ) : invalid && !ready ? (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <p className="text-sm text-[var(--color-text-sub)]">
                Este link é inválido ou expirou. Volta ao login e pede um novo email de recuperação.
              </p>
              <Button onClick={() => router.push("/login")} className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white">
                Voltar ao login
              </Button>
            </div>
          ) : !ready ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-text-sub)]">
              <Loader2 className="h-4 w-4 animate-spin" /> A validar o link…
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Nova password</label>
                <input name="password" type="password" required minLength={8} placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-all" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Confirmar password</label>
                <input name="confirm" type="password" required minLength={8} placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-all" />
              </div>
              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg ${message.type === "error" ? "bg-red-50 text-red-600 border border-red-100" : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
                  {message.text}
                </div>
              )}
              <Button type="submit" disabled={loading} className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium">
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Guardar password
              </Button>
            </form>
          )}
        </div>
        <p className="text-center text-xs text-[var(--color-text-muted)] mt-6">Mó Limpezas</p>
      </div>
    </div>
  );
}
