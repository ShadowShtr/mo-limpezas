import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolverPerfilDaSessao } from "@/lib/auth/current-user";

export default async function RootPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // 🔴 Pelo resolver, como todos os outros caminhos de autenticação.
  //
  //    Fazia aqui a sua própria consulta a `profiles` — a quarta maneira de
  //    responder à mesma pergunta. Era assim que as regras divergiam: esta,
  //    por exemplo, nunca soube o que era `status`.
  //
  //    Uma falha de leitura manda para `/dashboard`, que é onde o guard de lá
  //    decide com a razão em mão. Não se decide um encaminhamento com base
  //    numa leitura que não respondeu.
  const resolucao = await resolverPerfilDaSessao();

  if (resolucao.ok && resolucao.perfil.role === "colaborador") redirect("/app");
  redirect("/dashboard");
}
