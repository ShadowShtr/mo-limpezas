import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SwUpdatePrompt } from "@/components/pwa/sw-update-prompt";
import { UpdateNoticeModal } from "@/components/update-notices/update-notice-modal";
import { getPendingNotices } from "@/app/actions/update-notices";
import { estadoAutoriza } from "@/domain/collaborators/status";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("full_name, role, avatar_url, status")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile) {
    // Nunca silenciar isto: sem log, um profile em falta (ou uma chave
    // administrativa inválida a montante) fica indistinguível de um erro
    // transitório, e sem signOut() o proxy via loop com /login (ver
    // src/proxy.ts) — o utilizador autenticado nunca sai daqui.
    console.error("[dashboard] perfil indisponível", {
      userId: user.id,
      error: profileError?.message,
    });
    await supabase.auth.signOut();
    redirect("/login?error=profile");
  }
  // 🔴 Sessão válida, acesso retirado.
  //
  //    Esta consulta corre com service_role (BYPASSRLS): a 106 não a alcança.
  //    Sem isto, uma admin ou gestora suspensa continuava a ver o dashboard
  //    inteiro enquanto o token durasse.
  //
  //    `signOut()` antes do redirect, e por isso não há ciclo: sem sessão, o
  //    proxy deixa /login servir a página em vez de a reencaminhar para cá.
  if (!estadoAutoriza(profile.status)) {
    await supabase.auth.signOut();
    redirect("/login?error=sem-acesso");
  }

  if (profile.role === "colaborador") redirect("/app");

  // Avisos por ler. `getPendingNotices` nunca lança: um erro devolve lista
  // vazia e regista em log — a camada de avisos não pode derrubar o dashboard.
  const notices = await getPendingNotices();

  return (
    <DashboardShell
      userName={profile.full_name}
      userRole={profile.role}
      avatarUrl={profile.avatar_url}
    >
      {children}
      <SwUpdatePrompt />
      {notices.length > 0 && <UpdateNoticeModal notices={notices} />}
    </DashboardShell>
  );
}
