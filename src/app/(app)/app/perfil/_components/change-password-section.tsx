"use client";

import { useState } from "react";
import { KeyRound, Loader2, ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function ChangePasswordSection() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: "error" | "success"; text: string } | null>(null);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const password = fd.get("password") as string;
    const confirm = fd.get("confirm") as string;
    if (password.length < 8) return setMsg({ type: "error", text: "A password deve ter pelo menos 8 caracteres." });
    if (password !== confirm) return setMsg({ type: "error", text: "As passwords não coincidem." });

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return setMsg({ type: "error", text: "Não foi possível alterar a password. Tenta novamente." });
    form.reset();
    setMsg({ type: "success", text: "Password alterada com sucesso." });
  }

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: "var(--glass-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow)" }}
    >
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setMsg(null); }}
        className="flex items-center justify-between w-full p-4 active:opacity-80 transition-all"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-main)]">
          <KeyRound className="w-4 h-4 text-[var(--color-primary)]" />
          Alterar password
        </span>
        <ChevronDown className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <form onSubmit={handleSubmit} className="px-4 pb-4 space-y-3">
          <input
            name="password"
            type="password"
            required
            minLength={8}
            placeholder="Nova password (mín. 8 caracteres)"
            className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-all"
          />
          <input
            name="confirm"
            type="password"
            required
            minLength={8}
            placeholder="Confirmar nova password"
            className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm bg-white text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-all"
          />
          {msg && (
            <div className={`text-sm px-3 py-2 rounded-lg ${msg.type === "error" ? "bg-red-50 text-red-600 border border-red-100" : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
              {msg.text}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium text-sm disabled:opacity-60 transition-colors"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Guardar nova password
          </button>
        </form>
      )}
    </div>
  );
}
