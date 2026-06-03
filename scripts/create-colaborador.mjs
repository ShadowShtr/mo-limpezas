// Script único: criar conta de colaborador para testes
// Uso: node scripts/create-colaborador.mjs
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const EMAIL    = "vitorshadowmedina@gmail.com";
const PASSWORD = "vitortmf1";
const COMPANY_ID = "00000000-0000-0000-0000-000000000001";

async function run() {
  // 1. Criar utilizador no auth
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });

  if (authError) {
    // Se já existe, tenta encontrá-lo pelo email
    if (authError.message?.includes("already registered") || authError.status === 422) {
      console.log("⚠️  Utilizador já existe, a actualizar perfil...");
      const { data: users } = await supabase.auth.admin.listUsers();
      const existing = users?.users?.find((u) => u.email === EMAIL);
      if (!existing) { console.error("Não encontrado."); process.exit(1); }
      await updateProfile(existing.id);
      return;
    }
    console.error("Erro ao criar utilizador:", authError.message);
    process.exit(1);
  }

  console.log("✅ Utilizador criado:", authData.user.id);
  await updateProfile(authData.user.id);
}

async function updateProfile(userId) {
  const { error } = await supabase
    .from("profiles")
    .upsert({
      id: userId,
      full_name: "Vitor Colaborador",
      email: EMAIL,
      role: "colaborador",
      company_id: COMPANY_ID,
      status: "ativo",
    }, { onConflict: "id" });

  if (error) {
    console.error("Erro ao actualizar perfil:", error.message);
    process.exit(1);
  }
  console.log("✅ Perfil definido como colaborador na empresa Mó Limpezas");
  console.log(`\nCredenciais:\n  Email: ${EMAIL}\n  Password: ${PASSWORD}`);
}

run();
