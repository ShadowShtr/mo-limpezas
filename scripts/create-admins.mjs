// Script: criar 2 contas admin (admin1, admin2)
//
//   node scripts/create-admins.mjs --project-ref <ref> --company-id <uuid>
//   node scripts/create-admins.mjs --project-ref <ref> --company-id <uuid> --apply
//
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).
import { openAdminDb } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "create-admins.mjs",
  purpose: "criar/promover as contas admin1 e admin2",
  writes: true,
});
const supabase = db.sb;
const COMPANY_ID = db.companyId;

// Nunca no ficheiro: uma senha versionada é uma senha pública (incidente de
// 2026-08-06, ver docs/PRODUCTION-RUNBOOK.md).
const PASSWORD = process.env.SEED_PASSWORD;

if (!PASSWORD) {
  console.error(
    "Define SEED_PASSWORD no ambiente antes de correr este script.",
  );
  process.exit(1);
}

const ADMINS = [
  { username: "admin1", full_name: "Admin 1" },
  { username: "admin2", full_name: "Admin 2" },
];

async function createAdmin({ username, full_name }) {
  const email = `${username}@molimpezas.local`;

  // Criar contas é uma escrita no Auth, que o helper não intercepta — a
  // travagem do dry-run tem de ser explícita aqui.
  if (!db.apply) {
    console.log(`  [dry-run] criaria/promoveria ${username} (${email}) como admin`);
    return;
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });

  let userId;

  if (authError) {
    if (authError.message?.includes("already registered") || authError.status === 422) {
      console.log(`⚠️  ${username} já existe, a actualizar perfil...`);
      const { data: list, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) { console.error(`❌ listUsers: ${listError.message}`); return; }
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

  const perfil = await db.write(
    "profiles",
    (t) => t.upsert({
      id: userId,
      full_name,
      email,
      role: "admin",
      company_id: COMPANY_ID,
      status: "ativo",
    }, { onConflict: "id" }),
    `perfil admin de ${username}`,
  );
  if (!perfil.ok) return;

  // A password NÃO é impressa. Quem corre o script foi quem definiu
  // SEED_PASSWORD, por isso já a sabe — imprimi-la só a punha no histórico da
  // shell e nos logs de quem estiver a ver o ecrã.
  console.log(`✅ Perfil admin definido para: ${username} (login: ${username})\n`);
}

async function run() {
  console.log("A criar contas admin...\n");
  for (const admin of ADMINS) {
    await createAdmin(admin);
  }
  db.summary();
}

await run();
