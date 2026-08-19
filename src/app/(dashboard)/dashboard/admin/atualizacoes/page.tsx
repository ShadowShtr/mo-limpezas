import { redirect } from "next/navigation";
import { isPlatformAdmin, listNotices, getAudienceOptions } from "@/app/actions/update-notices";
import { AtualizacoesClient } from "./_components/atualizacoes-client";

export const metadata = { title: "Atualizações — Escala" };

/**
 * Painel de avisos de plataforma.
 *
 * 🔴 A rota é verificada no servidor, não apenas escondida do menu. Um
 *    utilizador que escreva o URL à mão sem ser administrador de plataforma é
 *    reencaminhado — e as actions por trás recusam na mesma, de forma
 *    independente desta verificação.
 */
export default async function AtualizacoesPage() {
  if (!(await isPlatformAdmin())) redirect("/dashboard");

  const [lista, opcoes] = await Promise.all([listNotices(), getAudienceOptions()]);

  return (
    <AtualizacoesClient
      notices={lista.ok ? lista.notices : []}
      loadError={lista.ok ? null : lista.error}
      companies={opcoes.ok ? opcoes.companies : []}
      profiles={opcoes.ok ? opcoes.profiles : []}
    />
  );
}
