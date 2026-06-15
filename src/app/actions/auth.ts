"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";

const emailSchema = z.email("Email inválido.");
const passwordSchema = z.string().min(6, "Password deve ter pelo menos 6 caracteres.");

async function getClientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

export async function login(formData: FormData) {
  const ip = await getClientIp();
  if (!checkRateLimit(rateLimitKey("auth-login", ip), 5, 60_000)) {
    return { error: "Demasiadas tentativas de login. Aguarda um minuto." };
  }

  const rawEmail = formData.get("email") as string;
  const rawPassword = formData.get("password") as string;

  const emailResult = emailSchema.safeParse(rawEmail);
  if (!emailResult.success) return { error: emailResult.error.issues[0].message };

  const passResult = passwordSchema.safeParse(rawPassword);
  if (!passResult.success) return { error: passResult.error.issues[0].message };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: emailResult.data,
    password: rawPassword,
  });

  if (error) {
    return { error: "Email ou password incorretos." };
  }

  // O role real está em profiles, não no user_metadata — admins/gestores → /dashboard
  const role = data.user?.user_metadata?.role as string | undefined;
  redirect(role === "colaborador" ? "/app" : "/dashboard");
}

export async function loginMagicLink(formData: FormData) {
  const ip = await getClientIp();
  if (!checkRateLimit(rateLimitKey("auth-magic", ip), 3, 60_000)) {
    return { error: "Demasiadas tentativas. Aguarda um minuto." };
  }

  const rawEmail = formData.get("email") as string;
  const emailResult = emailSchema.safeParse(rawEmail);
  if (!emailResult.success) return { error: "Email inválido." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: emailResult.data,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  });

  if (error) {
    return { error: "Não foi possível enviar o link. Tenta novamente." };
  }

  return { success: "Link enviado para o teu email." };
}

export async function resetPassword(formData: FormData) {
  const ip = await getClientIp();
  if (!checkRateLimit(rateLimitKey("auth-reset", ip), 3, 300_000)) {
    return { error: "Demasiados pedidos de recuperação. Aguarda 5 minutos." };
  }

  const rawEmail = formData.get("email") as string;
  const emailResult = emailSchema.safeParse(rawEmail);
  if (!emailResult.success) return { error: "Email inválido." };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(emailResult.data, {
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/dashboard/perfil/password`,
  });

  if (error) {
    return { error: "Não foi possível enviar o email. Verifica o endereço." };
  }

  return { success: "Email de recuperação enviado." };
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

export async function inviteCollaborator(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Não autenticado." };

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!callerProfile || !["admin", "gestor"].includes(callerProfile.role)) {
    return { error: "Sem permissão." };
  }

  const email = formData.get("email") as string;
  const name = formData.get("name") as string;
  const companyId = formData.get("company_id") as string;

  if (companyId !== callerProfile.company_id) return { error: "Acesso negado." };

  // Gerar link de convite sem enviar o email padrão do Supabase
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: {
      data: { role: "colaborador", full_name: name, company_id: companyId },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/app/boas-vindas`,
    },
  });

  if (linkError || !linkData?.properties?.action_link) {
    return { error: "Não foi possível gerar o convite. Verifica o email." };
  }

  // Enviar email personalizado via Resend
  try {
    const { getResend, FROM_EMAIL } = await import("@/lib/email");
    const { collaboratorInviteTemplate } = await import("@/lib/email/templates");

    const { subject, html } = collaboratorInviteTemplate({
      collaboratorName: name,
      inviteUrl: linkData.properties.action_link,
    });

    const resend = getResend();
    await resend.emails.send({ from: FROM_EMAIL, to: email, subject, html });
  } catch {
    // Se o Resend falhar (ex: API key não configurada), usa o convite base do Supabase
    await admin.auth.admin.inviteUserByEmail(email, {
      data: { role: "colaborador", full_name: name, company_id: companyId },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/app/boas-vindas`,
    });
  }

  return { success: "Convite enviado.", userId: linkData.user.id };
}
