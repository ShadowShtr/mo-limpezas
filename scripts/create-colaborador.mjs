// Script único: criar conta de colaborador para testes
//
//   node scripts/create-colaborador.mjs --project-ref <ref> --company-id <uuid>
//   node scripts/create-colaborador.mjs --project-ref <ref> --company-id <uuid> --apply
//
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).
import { openAdminDb } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "create-colaborador.mjs",
  purpose: "criar uma conta de colaborador para testes",
  writes: true,
});
const supabase = db.sb;

// Nunca no ficheiro: uma senha versionada é uma senha pública, e um email
// pessoal versionado é dado pessoal exposto (incidente de 2026-08-06, ver
// docs/PRODUCTION-RUNBOOK.md).
const EMAIL = process.env.SEED_EMAIL;
const PASSWORD = process.env.SEED_PASSWORD;
const COMPANY_ID = db.companyId;

if (!EMAIL || !PASSWORD) {
  console.error(
    "Define SEED_EMAIL e SEED_PASSWORD no ambiente antes de correr este script.",
  );
  process.exit(1);
}

async function run() {
  // Criar contas é uma escrita no Auth, que o helper não intercepta.
  if (!db.apply) {
    console.log("  [dry-run] criaria/actualizaria a conta de colaborador indicada em SEED_EMAIL");
    db.summary();
    return;
  }

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
      const { data: users, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) { console.error("listUsers:", listError.message); process.exit(1); }
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
  const perfil = await db.write(
    "profiles",
    (t) => t.upsert({
      id: userId,
      full_name: "Vitor Colaborador",
      email: EMAIL,
      role: "colaborador",
      company_id: COMPANY_ID,
      status: "ativo",
    }, { onConflict: "id" }),
    "perfil de colaborador",
  );
  if (!perfil.ok) process.exit(1);

  // Nem o email nem a password são impressos: ambos vieram do ambiente de quem
  // corre o script, e repeti-los no ecrã só os põe no histórico da shell.
  console.log("✅ Perfil definido como colaborador (credenciais: as de SEED_EMAIL/SEED_PASSWORD)");
  db.summary();
}

await run();
