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
  try {
    const h = await headers();
    return h.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  } catch {
    return "unknown";
  }
}

// redirect()/notFound() do Next.js funcionam lançando um erro de controlo de fluxo.
// Esse erro TEM de subir — nunca o tratar como falha.
function isControlFlowError(e: unknown): boolean {
  const d = (e as { digest?: string } | null)?.digest;
  return typeof d === "string" && (d.startsWith("NEXT_REDIRECT") || d === "NEXT_NOT_FOUND");
}

export async function login(formData: FormData) {
  let target: string | null = null;
  try {
    // Rate limit já é "fail-open": se o Upstash falhar, deixa passar (nunca rebenta).
    if (!await checkRateLimit(rateLimitKey("auth-login", await getClientIp()), 5, 60_000)) {
      return { error: "Demasiadas tentativas de login. Aguarda um minuto." };
    }

    const rawInput = (formData.get("email") as string)?.trim();
    const rawPassword = formData.get("password") as string;

    // Aceita username puro (ex: admin1) ou email completo
    const resolvedEmail = rawInput?.includes("@")
      ? rawInput
      : `${rawInput}@molimpezas.local`;

    const emailResult = emailSchema.safeParse(resolvedEmail);
    if (!emailResult.success) return { error: "Utilizador ou email inválido." };

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

    // Usar profiles.role (fonte autoritativa). Se a leitura falhar, segue para o dashboard.
    let role: string | undefined;
    try {
      const { createAdminClient: mkAdmin } = await import("@/lib/supabase/admin");
      const { data: profile } = await mkAdmin()
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .single();
      role = profile?.role as string | undefined;
    } catch {
      role = undefined;
    }
    target = role === "colaborador" ? "/app" : "/dashboard";
  } catch (e) {
    if (isControlFlowError(e)) throw e;
    console.error("[login] erro inesperado:", e);
    return { error: "Erro temporário no login. Tenta novamente." };
  }
  // redirect() fora do try — lança NEXT_REDIRECT de propósito (não é erro).
  redirect(target ?? "/dashboard");
}

export async function loginMagicLink(formData: FormData) {
  try {
    if (!await checkRateLimit(rateLimitKey("auth-magic", await getClientIp()), 3, 60_000)) {
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
  } catch (e) {
    if (isControlFlowError(e)) throw e;
    console.error("[loginMagicLink] erro inesperado:", e);
    return { error: "Erro temporário. Tenta novamente." };
  }
}

export async function resetPassword(formData: FormData) {
  try {
  if (!await checkRateLimit(rateLimitKey("auth-reset", await getClientIp()), 3, 300_000)) {
    return { error: "Demasiados pedidos de recuperação. Aguarda 5 minutos." };
  }

  const rawEmail = formData.get("email") as string;
  const emailResult = emailSchema.safeParse(rawEmail);
  if (!emailResult.success) return { error: "Email inválido." };

  const email = emailResult.data;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  // Gera o token de recuperação. Usamos o token_hash num link próprio para a
  // página chamar verifyOtp — assim não dependemos do Site URL/allowlist do Supabase.
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
  });

  // Não revelar se o email existe — devolver sempre sucesso genérico
  if (linkError || !linkData?.properties?.hashed_token) {
    return { success: "Se o email existir, enviámos as instruções de recuperação." };
  }

  const recoveryUrl = `${process.env.NEXT_PUBLIC_APP_URL}/recuperar/nova-senha?token_hash=${linkData.properties.hashed_token}&type=recovery`;

  // Enviar email personalizado via Resend
  try {
    const { getResend, FROM_EMAIL } = await import("@/lib/email");
    const { passwordRecoveryTemplate } = await import("@/lib/email/templates");
    const name = (linkData.user?.user_metadata?.full_name as string) || "colaboradora";
    const { subject, html } = passwordRecoveryTemplate({
      collaboratorName: name,
      recoveryUrl,
    });
    const resend = getResend();
    await resend.emails.send({ from: FROM_EMAIL, to: email, subject, html });
  } catch {
    // Se o Resend falhar, não conseguimos entregar — resposta genérica na mesma.
  }

  return { success: "Se o email existir, enviámos as instruções de recuperação." };
  } catch (e) {
    if (isControlFlowError(e)) throw e;
    console.error("[resetPassword] erro inesperado:", e);
    // Resposta genérica — não revela se o email existe nem expõe o erro.
    return { success: "Se o email existir, enviámos as instruções de recuperação." };
  }
}

const newPasswordSchema = z.string().min(8, "A password deve ter pelo menos 8 caracteres.");

// Define a nova password do utilizador autenticado (sessão de recuperação ativa).
export async function updatePassword(formData: FormData) {
  try {
    const password = formData.get("password") as string;
    const confirm = formData.get("confirm") as string;

    const parsed = newPasswordSchema.safeParse(password);
    if (!parsed.success) return { error: parsed.error.issues[0].message };
    if (password !== confirm) return { error: "As passwords não coincidem." };

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sessão inválida ou expirada. Pede um novo link de recuperação." };

    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { error: "Não foi possível alterar a password. Tenta novamente." };

    let role: string | undefined;
    try {
      const { createAdminClient: mkAdmin2 } = await import("@/lib/supabase/admin");
      const { data: profile } = await mkAdmin2().from("profiles").select("role").eq("id", user.id).single();
      role = profile?.role as string | undefined;
    } catch {
      role = undefined;
    }
    return { success: "Password alterada com sucesso.", redirect: role === "colaborador" ? "/app" : "/dashboard" };
  } catch (e) {
    if (isControlFlowError(e)) throw e;
    console.error("[updatePassword] erro inesperado:", e);
    return { error: "Erro temporário. Tenta novamente." };
  }
}

export async function logout() {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
    revalidatePath("/", "layout");
  } catch (e) {
    if (isControlFlowError(e)) throw e;
    // Mesmo que o signOut falhe, segue para /login.
    console.error("[logout] erro ao terminar sessão:", e);
  }
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
