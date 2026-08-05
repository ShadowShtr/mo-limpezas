// ============================================================================
// PROVISIONAMENTO DE TENANTS DE TESTE — no MESMO projeto Supabase de PRODUÇÃO
// ============================================================================
// Cria (ou valida, se já existirem) duas empresas isoladas e quatro contas,
// para provar isolamento multiempresa real com sessões autenticadas.
//
// Dry-run por padrão. Só escreve com --apply E --confirm CREATE_ISOLATED_PRODUCTION_TEST_TENANTS
// juntos. Localiza empresas EXCLUSIVAMENTE pelo slug exato — nunca por nome,
// nunca por correspondência parcial. Nunca toca na empresa real.
//
// Uso:
//   node scripts/test-tenants/provision.mjs                  # dry-run
//   node scripts/test-tenants/provision.mjs --apply --confirm CREATE_ISOLATED_PRODUCTION_TEST_TENANTS
// ============================================================================

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  ROOT,
  TENANT_A_SLUG,
  TENANT_B_SLUG,
  TENANT_A_NAME,
  TENANT_B_NAME,
  loadTestTenantsEnv,
  requireEnv,
  makeAdminClient,
  maskEmail,
  safeErrorMessage,
} from "./lib.mjs";

loadTestTenantsEnv();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const confirmIdx = args.indexOf("--confirm");
const confirmValue = confirmIdx >= 0 ? args[confirmIdx + 1] : null;
const CONFIRMED = confirmValue === "CREATE_ISOLATED_PRODUCTION_TEST_TENANTS";
const WRITE = APPLY && CONFIRMED;

if (APPLY && !CONFIRMED) {
  console.error("❌ --apply exige --confirm CREATE_ISOLATED_PRODUCTION_TEST_TENANTS (valor exato).");
  process.exit(1);
}

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TEST_A_ADMIN_EMAIL",
  "TEST_A_ADMIN_PASSWORD",
  "TEST_A_MANAGER_EMAIL",
  "TEST_A_MANAGER_PASSWORD",
  "TEST_A_COLLABORATOR_EMAIL",
  "TEST_A_COLLABORATOR_PASSWORD",
  "TEST_B_ADMIN_EMAIL",
  "TEST_B_ADMIN_PASSWORD",
];

const PLAN = [
  { slug: TENANT_A_SLUG, name: TENANT_A_NAME, accounts: [
    { key: "TEST_A_ADMIN", role: "admin" },
    { key: "TEST_A_MANAGER", role: "gestor" },
    { key: "TEST_A_COLLABORATOR", role: "colaborador" },
  ]},
  { slug: TENANT_B_SLUG, name: TENANT_B_NAME, accounts: [
    { key: "TEST_B_ADMIN", role: "admin" },
  ]},
];

/** Localiza uma empresa exclusivamente pelo slug exato. Nunca fuzzy. */
async function findCompanyBySlug(admin, slug) {
  const { data, error } = await admin.from("companies").select("id, slug, active").eq("slug", slug).maybeSingle();
  if (error) throw new Error(`Falha ao procurar empresa (slug=${slug}): ${safeErrorMessage(error)}`);
  return data;
}

async function findAuthUserByEmail(admin, email) {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Falha ao listar utilizadores Auth: ${safeErrorMessage(error)}`);
    const found = data.users.find((u) => (u.email || "").trim().toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 200) break; // última página
  }
  return null;
}

async function findProfileById(admin, id) {
  const { data, error } = await admin.from("profiles").select("id, company_id, role, status").eq("id", id).maybeSingle();
  if (error) throw new Error(`Falha ao procurar profile: ${safeErrorMessage(error)}`);
  return data;
}

function recordState(entry) {
  const dir = join(ROOT, "scripts/test-tenants/.state");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `provision-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  // Nunca gravar password/token — só o que já foi decidido/reportado nesta run.
  writeFileSync(file, JSON.stringify(entry, null, 2), "utf8");
  return file;
}

async function main() {
  requireEnv(REQUIRED_ENV);
  const admin = makeAdminClient();

  console.log(WRITE ? "🔴 MODO --apply (escreve em produção)" : "🟡 dry-run (nenhuma escrita)");
  console.log("");

  const stateLog = { timestamp: new Date().toISOString(), write: WRITE, tenants: [] };
  const problems = [];

  for (const tenant of PLAN) {
    console.log(`── ${tenant.slug} ──`);
    const tenantState = { slug: tenant.slug, companyExisted: false, companyCreated: false, settingsExisted: false, settingsCreated: false, accounts: [] };

    let company = await findCompanyBySlug(admin, tenant.slug);
    if (company) {
      tenantState.companyExisted = true;
      console.log(`  empresa: já existe (slug exato bate)`);
      if (company.active !== true) {
        problems.push(`Empresa ${tenant.slug} existe mas active=${company.active} — inesperado, aborto.`);
      }
    } else {
      console.log(`  empresa: ${WRITE ? "a criar" : "seria criada"} — name="${tenant.name}", slug="${tenant.slug}", active=true`);
      if (WRITE) {
        const { data, error } = await admin
          .from("companies")
          .insert({ name: tenant.name, slug: tenant.slug, active: true })
          .select("id, slug, active")
          .single();
        if (error) throw new Error(`Falha ao criar empresa ${tenant.slug}: ${safeErrorMessage(error)}`);
        company = data;
        tenantState.companyCreated = true;
        console.log(`  empresa: criada`);
      }
    }

    if (WRITE && company) {
      const { data: settings, error: settingsErr } = await admin
        .from("company_settings")
        .select("id")
        .eq("company_id", company.id)
        .maybeSingle();
      if (settingsErr) throw new Error(`Falha ao procurar company_settings (${tenant.slug}): ${safeErrorMessage(settingsErr)}`);
      if (settings) {
        tenantState.settingsExisted = true;
        console.log(`  company_settings: já existe`);
      } else {
        // Só company_id — todo o resto usa os defaults atuais do schema
        // (confirmado por leitura de information_schema.columns antes desta
        // migration de dados), nunca copiado da empresa real.
        const { error: insErr } = await admin.from("company_settings").insert({ company_id: company.id });
        if (insErr) throw new Error(`Falha ao criar company_settings (${tenant.slug}): ${safeErrorMessage(insErr)}`);
        tenantState.settingsCreated = true;
        console.log(`  company_settings: criado (defaults do schema)`);
      }
    } else if (!WRITE) {
      console.log(`  company_settings: ${company ? "verificação adiada para --apply" : "seria criado com defaults do schema, depois da empresa"}`);
    }

    for (const acc of tenant.accounts) {
      const email = process.env[`${acc.key}_EMAIL`];
      const password = process.env[`${acc.key}_PASSWORD`];
      const accState = { role: acc.role, existed: false, created: false, profileFixed: false };
      console.log(`  conta ${acc.role} (${maskEmail(email)}):`);

      if (!WRITE) {
        console.log(`    dry-run: aplicaria admin.auth.admin.createUser() se não existir, depois upsert em profiles (role=${acc.role})`);
        tenantState.accounts.push(accState);
        continue;
      }
      if (!company) throw new Error(`Empresa ${tenant.slug} indisponível ao provisionar conta ${acc.role} — estado inconsistente.`);

      let authUser = await findAuthUserByEmail(admin, email);
      if (authUser) {
        accState.existed = true;
        console.log(`    auth.users: já existe`);
        const profile = await findProfileById(admin, authUser.id);
        if (profile && profile.company_id !== company.id) {
          throw new Error(
            `Conta ${maskEmail(email)} já existe mas está ligada a outra empresa — abortando sem mover automaticamente.`,
          );
        }
      } else {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            test_account: true,
            test_suite: "tenant-isolation",
            company_slug: tenant.slug,
          },
        });
        if (createErr) throw new Error(`Falha ao criar utilizador ${maskEmail(email)}: ${safeErrorMessage(createErr)}`);
        authUser = created.user;
        accState.created = true;
        console.log(`    auth.users: criado`);
      }

      // handle_new_user() é deliberadamente neutra desde a 068 — upsert
      // explícito é sempre necessário, nunca opcional.
      const { error: upsertErr } = await admin.from("profiles").upsert(
        {
          id: authUser.id,
          company_id: company.id,
          role: acc.role,
          full_name: `${acc.role} de teste (${tenant.slug})`,
          email,
          status: "ativo",
        },
        { onConflict: "id" },
      );
      if (upsertErr) throw new Error(`Falha ao fazer upsert do profile (${maskEmail(email)}): ${safeErrorMessage(upsertErr)}`);
      accState.profileFixed = true;
      console.log(`    profiles: upsert ok (role=${acc.role}, empresa correta)`);

      tenantState.accounts.push(accState);
    }

    stateLog.tenants.push(tenantState);
    console.log("");
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`❌ ${p}`);
    process.exit(1);
  }

  if (WRITE) {
    const file = recordState(stateLog);
    console.log(`Estado desta execução registado em: ${file.replace(ROOT, ".")}`);
  }

  console.log(WRITE ? "🎉 Provisionamento concluído." : "🎉 Dry-run concluído — nada foi escrito.");
}

main().catch((err) => {
  console.error(`❌ Erro fatal: ${safeErrorMessage(err)}`);
  process.exit(1);
});
