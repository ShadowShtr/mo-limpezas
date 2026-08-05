// ============================================================================
// CLEANUP DOS TENANTS DE TESTE — no MESMO projeto Supabase de PRODUÇÃO
// ============================================================================
// Dry-run por padrão. Só apaga com --apply E --confirm
// DELETE_ISOLATED_PRODUCTION_TEST_TENANTS juntos. Localiza empresas
// EXCLUSIVAMENTE pelos slugs exatos. Aborta ao encontrar qualquer objeto
// que não pertença aos dois tenants de teste — nunca apaga "o que sobrar".
//
// Uso:
//   node scripts/test-tenants/cleanup.mjs                  # dry-run
//   node scripts/test-tenants/cleanup.mjs --apply --confirm DELETE_ISOLATED_PRODUCTION_TEST_TENANTS
// ============================================================================

import {
  TEST_SLUGS,
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
const CONFIRMED = confirmValue === "DELETE_ISOLATED_PRODUCTION_TEST_TENANTS";
const WRITE = APPLY && CONFIRMED;

if (APPLY && !CONFIRMED) {
  console.error("❌ --apply exige --confirm DELETE_ISOLATED_PRODUCTION_TEST_TENANTS (valor exato).");
  process.exit(1);
}

const EXPECTED_EMAILS = [
  "TEST_A_ADMIN_EMAIL",
  "TEST_A_MANAGER_EMAIL",
  "TEST_A_COLLABORATOR_EMAIL",
  "TEST_B_ADMIN_EMAIL",
].map((k) => process.env[k]).filter(Boolean);

async function main() {
  requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  const admin = makeAdminClient();

  console.log(WRITE ? "🔴 MODO --apply (apaga em produção)" : "🟡 dry-run (nenhuma escrita)");
  console.log("");

  // 1. Localizar empresas exclusivamente pelos slugs exatos.
  const { data: companies, error: compErr } = await admin.from("companies").select("id, slug").in("slug", TEST_SLUGS);
  if (compErr) throw new Error(`Falha ao procurar empresas de teste: ${safeErrorMessage(compErr)}`);

  const unexpectedSlugs = (companies ?? []).filter((c) => !TEST_SLUGS.includes(c.slug));
  if (unexpectedSlugs.length > 0) {
    throw new Error("Encontrado objeto com slug inesperado na query — abortando (não deveria ser possível com .in() exato).");
  }
  console.log(`Empresas de teste encontradas: ${companies.length}/${TEST_SLUGS.length}`);
  if (companies.length === 0) {
    console.log("Nada a limpar.");
    return;
  }

  const companyIds = companies.map((c) => c.id);

  // 2. Validar que todos os profiles ligados a estas empresas pertencem a
  //    emails exatos esperados — aborta se encontrar qualquer coisa fora
  //    do conjunto conhecido (ex.: dados criados manualmente por engano).
  const { data: profiles, error: profErr } = await admin
    .from("profiles")
    .select("id, email, company_id")
    .in("company_id", companyIds);
  if (profErr) throw new Error(`Falha ao procurar profiles de teste: ${safeErrorMessage(profErr)}`);

  const unexpectedProfiles = (profiles ?? []).filter((p) => !EXPECTED_EMAILS.includes(p.email));
  if (unexpectedProfiles.length > 0) {
    throw new Error(
      `Encontrados ${unexpectedProfiles.length} profile(s) nas empresas de teste com email fora do conjunto esperado — abortando sem apagar nada. Verifica manualmente antes de repetir.`,
    );
  }

  // 3. Confirmar que nenhuma linha pertence à empresa real (nenhuma delas
  //    tem company_id fora do conjunto companyIds, por construção das
  //    queries acima — reforçado aqui de forma explícita).
  const realLeak = (profiles ?? []).some((p) => !companyIds.includes(p.company_id));
  if (realLeak) {
    throw new Error("Uma linha teria company_id fora dos tenants de teste — abortando.");
  }

  // 4. Contagens agregadas do que será removido (mostrar antes de apagar).
  const tables = ["clients", "contracts", "services", "locations", "teams", "team_members"];
  const counts = {};
  for (const t of tables) {
    const { count } = await admin.from(t).select("id", { count: "exact", head: true }).in("company_id", companyIds);
    counts[t] = count ?? 0;
  }
  console.log("\nSerá removido:");
  console.log(`  companies: ${companies.length}`);
  console.log(`  profiles: ${(profiles ?? []).length}`);
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);
  console.log(`  utilizadores Auth: até ${EXPECTED_EMAILS.length} (por email exato)`);

  if (!WRITE) {
    console.log("\n🎉 Dry-run concluído — nada foi apagado.");
    return;
  }

  // ── Ordem: dados filhos sintéticos → profiles → Auth → company_settings → companies ──
  for (const t of tables) {
    const { error } = await admin.from(t).delete().in("company_id", companyIds);
    if (error) throw new Error(`Falha ao apagar ${t}: ${safeErrorMessage(error)}`);
  }
  console.log("dados filhos: apagados");

  const { error: delProfilesErr } = await admin.from("profiles").delete().in("company_id", companyIds);
  if (delProfilesErr) throw new Error(`Falha ao apagar profiles: ${safeErrorMessage(delProfilesErr)}`);
  console.log("profiles: apagados");

  for (const p of profiles ?? []) {
    const { error } = await admin.auth.admin.deleteUser(p.id);
    if (error) console.log(`  aviso: falha ao apagar utilizador Auth ${maskEmail(p.email)}: ${safeErrorMessage(error)}`);
  }
  console.log("utilizadores Auth: apagados");

  const { error: delSettingsErr } = await admin.from("company_settings").delete().in("company_id", companyIds);
  if (delSettingsErr) throw new Error(`Falha ao apagar company_settings: ${safeErrorMessage(delSettingsErr)}`);
  console.log("company_settings: apagados");

  const { error: delCompaniesErr } = await admin.from("companies").delete().in("id", companyIds);
  if (delCompaniesErr) throw new Error(`Falha ao apagar companies: ${safeErrorMessage(delCompaniesErr)}`);
  console.log("companies: apagadas");

  console.log("\n🎉 Cleanup concluído.");
}

main().catch((err) => {
  console.error(`❌ Erro fatal: ${safeErrorMessage(err)}`);
  process.exit(1);
});
