import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SwUpdatePrompt } from "@/components/pwa/sw-update-prompt";
import { UpdateNoticeModal } from "@/components/update-notices/update-notice-modal";
import { getPendingNotices } from "@/app/actions/update-notices";
import { perfilPodeEntrar } from "@/domain/collaborators/access-state";

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
  // 🔴 A saída vale já — ver a nota igual no layout da app móvel.
  //
  //    Antes do desvio por papel, de propósito: uma gestora que levou saída
  //    não deve ser mandada para `/app` nem para lado nenhum dentro do
  //    sistema. Sai.
  if (!perfilPodeEntrar((profile as { status?: string | null }).status)) {
    await supabase.auth.signOut();
    redirect("/login?error=inactive");
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
