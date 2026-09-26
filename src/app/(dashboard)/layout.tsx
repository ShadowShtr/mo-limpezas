import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SwUpdatePrompt } from "@/components/pwa/sw-update-prompt";
import { UpdateNoticeModal } from "@/components/update-notices/update-notice-modal";
import { getPendingNotices } from "@/app/actions/update-notices";
import { AvisosVencimentoModal } from "@/components/avisos/avisos-vencimento-modal";
import { getAvisosVencimento } from "@/app/actions/avisos";
import {
  resolverPerfilAutenticado, MOTIVO_SEM_PERFIL,
} from "@/lib/auth/resolve-profile";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 🔴 Sem quarta consulta de identidade.
  //
  //    Este layout tinha a sua propria: `.eq("id", user.id)`, com service_role
  //    e sem olhar para o estado. Passa pelo mesmo resolvedor que as server
  //    actions — a identidade do dashboard nao pode ser resolvida por regras
  //    diferentes das que decidem o que ele pode fazer.
  const r = await resolverPerfilAutenticado<{
    full_name: string; role: string; avatar_url: string | null;
  }>(createAdminClient(), user.id, "full_name, role, avatar_url");

  if (!r.ok) {
    // Nunca silenciar isto: sem log, um perfil em falta (ou uma chave
    // administrativa invalida a montante) fica indistinguivel de um erro
    // transitorio, e sem signOut() o proxy via loop com /login.
    console.error("[dashboard] perfil indisponivel", { userId: user.id, motivo: r.motivo });
    await supabase.auth.signOut();

    // 🔴 Sessao valida e acesso retirado le-se diferente de perfil em falta:
    //    a primeira e uma decisao de quem administra, a segunda e uma avaria.
    redirect(r.motivo === MOTIVO_SEM_PERFIL.INATIVO
      ? "/login?error=sem-acesso"
      : "/login?error=profile");
  }

  const profile = r.perfil;

  if (profile.role === "colaborador") redirect("/app");

  // Avisos por ler. `getPendingNotices` nunca lança: um erro devolve lista
  // vazia e regista em log — a camada de avisos não pode derrubar o dashboard.
  //
  // 🔴 As duas leituras correm em paralelo e valem a mesma promessa: nenhuma
  //    lança. São camadas de aviso, não de dados — se falharem, o dashboard
  //    abre na mesma e o assunto volta na próxima sessão.
  //
  //    Só admin e gestor chegam a esta linha: a colaboradora foi redireccionada
  //    para /app acima, e `getAvisosVencimento` revalida o papel do seu lado.
  //    Esconder não é autorizar, por isso são os dois.
  const [notices, avisos] = await Promise.all([
    getPendingNotices(),
    getAvisosVencimento(),
  ]);

  return (
    <DashboardShell
      userName={profile.full_name}
      userRole={profile.role}
      avatarUrl={profile.avatar_url}
    >
      {children}
      <SwUpdatePrompt />
      {notices.length > 0 && <UpdateNoticeModal notices={notices} />}
      <AvisosVencimentoModal inicial={avisos} />
    </DashboardShell>
  );
}
