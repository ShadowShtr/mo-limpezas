import { redirect } from "next/navigation";
import { AppHeader } from "@/components/layout/app-header";
import { BottomNav } from "@/components/layout/bottom-nav";
import { PwaRegister } from "./_components/pwa-register";
import { resolverPerfilDaSessao } from "@/lib/auth/current-user";
import {
  MENSAGEM_FALHA_INFRA, RESOLUCAO_CODES,
} from "@/lib/collaborators/current-profile-resolver";
import { createClient } from "@/lib/supabase/server";
import { perfilPodeEntrar } from "@/domain/collaborators/access-state";
import { ConnectionBanner } from "@/components/ui/connection-banner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const resolucao = await resolverPerfilDaSessao();

  // 🔴 Uma falha da base NÃO termina a sessão de ninguém.
  //
  //    `getCurrentProfile()` devolvia `null` tanto para «não há perfil» como
  //    para «a base não respondeu», e daqui saía sempre um redirect para o
  //    login. Num incidente de infraestrutura isso expulsa toda a gente que
  //    esteja a trabalhar e apaga a causa — foi assim que um `Unregistered API
  //    key` deste projeto apareceu como um ciclo de login.
  if (!resolucao.ok && resolucao.codigo === RESOLUCAO_CODES.PROFILE_DB_FAILURE) {
    console.error("[app] perfil não resolvido", { erro: resolucao.erro });
    throw new Error(MENSAGEM_FALHA_INFRA);
  }
  if (!resolucao.ok) redirect("/login");
  const profile = resolucao.perfil;

  // 🔴 A saída tem de valer já, não quando o token expirar.
  //
  //    Banir a conta no Auth impede o login seguinte e nada mais: quem
  //    estivesse com a app aberta continuava a marcar pontos e a fechar
  //    serviços durante o resto da validade do access token. A sessão
  //    termina-se aqui, para a pessoa não ficar num limbo em que a app abre e
  //    tudo lá dentro recusa.
  if (!perfilPodeEntrar(profile.status)) {
    const supabase = await createClient();
    await supabase.auth.signOut();
    redirect("/login?error=inactive");
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
