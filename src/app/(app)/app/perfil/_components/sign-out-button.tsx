"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <button
      onClick={handleSignOut}
      className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl border border-[var(--color-border)] bg-white text-[var(--color-danger)] font-semibold text-sm active:bg-red-50 transition-colors mt-2"
    >
      <LogOut className="w-4 h-4" />
      Terminar sessão
    </button>
  );
}
