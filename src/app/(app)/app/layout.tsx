import { redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/app-header";
import { BottomNav } from "@/components/layout/bottom-nav";
import { PwaRegister } from "./_components/pwa-register";
import { getCurrentProfile, getCurrentUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { ConnectionBanner } from "@/components/ui/connection-banner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();

  // 🔴 Sessão válida e sem perfil utilizável: terminar a sessão, e dizer porquê.
  //
  //    Desde a 106-B, `getCurrentProfile()` devolve `null` também quando o
  //    perfil existe mas já não está activo. Sem o `signOut()`, o cookie ficava
  //    cá e a pessoa voltava a bater na mesma parede a cada navegação, sem
  //    nunca perceber porquê.
  //
  //    Não se distingue aqui «suspensa» de «sem perfil»: para quem está do
  //    outro lado do ecrã as duas querem dizer a mesma coisa — não entra, e
  //    quem administra resolve. Distinguir obrigaria a devolver daqui o motivo
  //    da recusa, e isso diria a quem tenta entrar o que há do outro lado.
  if (!profile) {
    if (await getCurrentUser()) {
      const supabase = await createClient();
      await supabase.auth.signOut();
      redirect("/login?error=sem-acesso");
    }
    redirect("/login");
  }
  if (profile.role !== "colaborador") redirect("/dashboard");

  return (
    <div className="flex flex-col min-h-screen" style={{ background: "linear-gradient(135deg, #d1fae5 0%, #f8fafc 55%, #dbeafe 100%)" }}>
      <PwaRegister />
      {/* Colaboradora em campo: health check espaçado (5 min) — poupa bateria/4G */}
      <ConnectionBanner intervalMs={300_000} />
      <AppHeader userId={profile.id} userName={profile.full_name} avatarUrl={profile.avatar_url} />
      <main className="flex-1 overflow-y-auto pb-20 px-4 pt-4">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
