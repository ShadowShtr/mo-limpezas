// Script: criar 2 contas admin (admin1, admin2)
// Uso: node scripts/create-admins.mjs
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

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const PASSWORD = "@molimpezas2026";

const ADMINS = [
  { username: "admin1", full_name: "Admin 1" },
  { username: "admin2", full_name: "Admin 2" },
];

async function createAdmin({ username, full_name }) {
  const email = `${username}@molimpezas.local`;

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });

  let userId;

  if (authError) {
    if (authError.message?.includes("already registered") || authError.status === 422) {
      console.log(`⚠️  ${username} já existe, a actualizar perfil...`);
      const { data: list } = await supabase.auth.admin.listUsers();
      const existing = list?.users?.find((u) => u.email === email);
      if (!existing) { console.error(`❌ Não encontrado: ${email}`); return; }
      userId = existing.id;
    } else {
      console.error(`❌ Erro ao criar ${username}:`, authError.message);
      return;
    }
  } else {
    userId = authData.user.id;
    console.log(`✅ Utilizador criado: ${username} (${userId})`);
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert({
      id: userId,
      full_name,
      email,
      role: "admin",
      company_id: COMPANY_ID,
      status: "ativo",
    }, { onConflict: "id" });

  if (profileError) {
    console.error(`❌ Erro no perfil de ${username}:`, profileError.message);
    return;
  }

  console.log(`✅ Perfil admin definido para: ${username}`);
  console.log(`   Login: ${username}  |  Password: ${PASSWORD}\n`);
}

async function run() {
  console.log("A criar contas admin...\n");
  for (const admin of ADMINS) {
    await createAdmin(admin);
  }
  console.log("Concluído.");
}

run();
