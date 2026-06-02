"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function login(formData: FormData) {
  const supabase = await createClient();

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: "Email ou password incorretos." };
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function loginMagicLink(formData: FormData) {
  const supabase = await createClient();

  const email = formData.get("email") as string;

  const { error } = await supabase.auth.signInWithOtp({
    email,
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
  const supabase = await createClient();

  const email = formData.get("email") as string;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
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
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const email = formData.get("email") as string;
  const name = formData.get("name") as string;
  const companyId = formData.get("company_id") as string;

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { role: "colaborador", full_name: name, company_id: companyId },
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/app/boas-vindas`,
  });

  if (error) {
    return { error: "Não foi possível enviar o convite. Verifica o email." };
  }

  return { success: "Convite enviado.", userId: data.user.id };
}
