import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SwUpdatePrompt } from "@/components/pwa/sw-update-prompt";
import { UpdateNoticeModal } from "@/components/update-notices/update-notice-modal";
import { getPendingNotices } from "@/app/actions/update-notices";
import { perfilPodeEntrar } from "@/domain/collaborators/access-state";
import {
  MENSAGEM_FALHA_INFRA, RESOLUCAO_CODES,
} from "@/lib/collaborators/current-profile-resolver";
import { resolverPerfilDaSessao } from "@/lib/auth/current-user";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const resolucao = await resolverPerfilDaSessao();

  // 🔴 Um erro de leitura não é um perfil em falta, e não se responde aos dois
  //    com `signOut()`. Terminar a sessão num incidente de base expulsa toda a
  //    gente que esteja a trabalhar e apaga a causa.
  if (!resolucao.ok && resolucao.codigo === RESOLUCAO_CODES.PROFILE_DB_FAILURE) {
    console.error("[dashboard] perfil não resolvido", {
      userId: user.id, erro: resolucao.erro,
    });
    throw new Error(MENSAGEM_FALHA_INFRA);
  }

  if (!resolucao.ok) {
    // Perfil mesmo em falta. Sem `signOut()` o proxy entra em ciclo com /login
    // (ver src/proxy.ts) e o utilizador autenticado nunca sai daqui.
    console.error("[dashboard] perfil indisponível", { userId: user.id });
    await supabase.auth.signOut();
    redirect("/login?error=profile");
  }

  const profile = resolucao.perfil;

  // 🔴 A saída vale já — ver a nota igual no layout da app móvel.
  //
  //    Antes do desvio por papel, de propósito: uma gestora que levou saída
  //    não deve ser mandada para `/app` nem para lado nenhum dentro do
  //    sistema. Sai.
  if (!perfilPodeEntrar(profile.status)) {
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
