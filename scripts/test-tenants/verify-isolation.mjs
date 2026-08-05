// ============================================================================
// PROVA DE ISOLAMENTO MULTIEMPRESA — sessões autenticadas reais, anon key
// ============================================================================
// Usa SUPABASE_URL + SUPABASE_ANON_KEY para autenticar as 4 contas de teste
// e provar RLS com sessões reais — nunca service_role nas operações que
// pretendem provar isolamento. As únicas exceções, claramente isoladas e
// comentadas, são leituras administrativas de configuração de teste (não
// operações de negócio): o UUID da empresa real para as usar como alvo dos
// testes negativos, e a contagem de baseline dessa empresa para confirmar
// no fim que nada mudou. Nenhuma delas prova ou depende de RLS.
//
// 22 testes obrigatórios (ver relatório de isolamento multiempresa,
// 2026-08-05). Cada teste imprime só "PASS — descrição" ou
// "FAIL — descrição segura". Nunca linhas de dados, JWTs, UUIDs reais.
// Qualquer FAIL faz o processo terminar com exit code != 0.
//
// Uso:
//   node scripts/test-tenants/verify-isolation.mjs
// ============================================================================

import {
  loadTestTenantsEnv,
  requireEnv,
  makeAdminClient,
  makeAnonClient,
  genRunId,
  syntheticName,
  TestResults,
  safeErrorMessage,
} from "./lib.mjs";

loadTestTenantsEnv();

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "TEST_A_ADMIN_EMAIL",
  "TEST_A_ADMIN_PASSWORD",
  "TEST_A_MANAGER_EMAIL",
  "TEST_A_MANAGER_PASSWORD",
  "TEST_A_COLLABORATOR_EMAIL",
  "TEST_A_COLLABORATOR_PASSWORD",
  "TEST_B_ADMIN_EMAIL",
  "TEST_B_ADMIN_PASSWORD",
];

async function signIn(email, password) {
  const client = makeAnonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Falha ao autenticar conta de teste: ${safeErrorMessage(error)}`);
  return { client, userId: data.user.id };
}

async function ownCompanyId(session) {
  const { data, error } = await session.client.from("profiles").select("company_id").eq("id", session.userId).single();
  if (error) throw new Error(`Falha ao ler company_id próprio: ${safeErrorMessage(error)}`);
  return data.company_id;
}

/** true se a query devolveu exatamente 0 linhas (RLS filtrou, sem erro). */
async function selectsNothing(query) {
  const { data, error } = await query;
  if (error) return { blocked: true, reason: "error" }; // também conta como bloqueado
  return { blocked: (data ?? []).length === 0, reason: "empty" };
}

async function main() {
  requireEnv(REQUIRED_ENV);
  const results = new TestResults();
  const runId = genRunId();
  let createdClientId = null;

  // Sessões isoladas — uma instância Supabase por conta, sem storage partilhado.
  const a1 = await signIn(process.env.TEST_A_ADMIN_EMAIL, process.env.TEST_A_ADMIN_PASSWORD);
  const a2 = await signIn(process.env.TEST_A_MANAGER_EMAIL, process.env.TEST_A_MANAGER_PASSWORD);
  const a3 = await signIn(process.env.TEST_A_COLLABORATOR_EMAIL, process.env.TEST_A_COLLABORATOR_PASSWORD);
  const b1 = await signIn(process.env.TEST_B_ADMIN_EMAIL, process.env.TEST_B_ADMIN_PASSWORD);

  const tenantACompanyId = await ownCompanyId(a1);
  const tenantBCompanyId = await ownCompanyId(b1);

  // ── Leitura administrativa de configuração de teste, isolada do resto ──
  // Não prova nem depende de RLS: só descobre o UUID da empresa real (para
  // usar como alvo dos testes negativos 7 e 22) e captura uma contagem de
  // baseline (para o teste 21). Opcional — se SUPABASE_SERVICE_ROLE_KEY não
  // estiver definida, esses testes são reportados como FAIL explícito (não
  // silenciosamente ignorados), porque sem essa base não há como prová-los.
  let realCompanyId = null;
  let realBaselineCount = null;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const admin = makeAdminClient();
    const { data: companies, error: compErr } = await admin
      .from("companies")
      .select("id")
      .not("id", "in", `(${tenantACompanyId},${tenantBCompanyId})`)
      .limit(1);
    if (!compErr && companies && companies.length === 1) {
      realCompanyId = companies[0].id;
      const { count } = await admin
        .from("clients")
        .select("id", { count: "exact", head: true })
        .eq("company_id", realCompanyId);
      realBaselineCount = count ?? 0;
    }
  }

  try {
    // 1-4: cada conta só vê a própria empresa em `companies`.
    {
      const { data, error } = await a1.client.from("companies").select("id");
      if (!error && data?.length === 1 && data[0].id === tenantACompanyId) results.pass("Admin A vê somente a empresa A");
      else results.fail("Admin A vê somente a empresa A");
    }
    {
      const { data, error } = await a2.client.from("companies").select("id");
      if (!error && data?.length === 1 && data[0].id === tenantACompanyId) results.pass("Gestor A vê somente a empresa A");
      else results.fail("Gestor A vê somente a empresa A");
    }
    {
      const { data, error } = await a3.client.from("companies").select("id");
      if (!error && data?.length === 1 && data[0].id === tenantACompanyId) results.pass("Colaborador A vê somente os dados autorizados da empresa A");
      else results.fail("Colaborador A vê somente os dados autorizados da empresa A");
    }
    {
      const { data, error } = await b1.client.from("companies").select("id");
      if (!error && data?.length === 1 && data[0].id === tenantBCompanyId) results.pass("Admin B vê somente a empresa B");
      else results.fail("Admin B vê somente a empresa B");
    }

    // 5: nenhuma conta A consulta a empresa B por UUID direto.
    {
      let allBlocked = true;
      for (const s of [a1, a2, a3]) {
        const r = await selectsNothing(s.client.from("companies").select("id").eq("id", tenantBCompanyId));
        if (!r.blocked) allBlocked = false;
      }
      results.report(allBlocked, "Nenhuma conta A consulta a empresa B por UUID direto");
    }

    // 6: Admin B não consulta a empresa A por UUID direto.
    {
      const r = await selectsNothing(b1.client.from("companies").select("id").eq("id", tenantACompanyId));
      results.report(r.blocked, "Admin B não consulta a empresa A por UUID direto");
    }

    // 7: nenhuma conta de teste consulta a empresa real por UUID direto.
    if (realCompanyId) {
      let allBlocked = true;
      for (const s of [a1, a2, a3, b1]) {
        const r = await selectsNothing(s.client.from("companies").select("id").eq("id", realCompanyId));
        if (!r.blocked) allBlocked = false;
      }
      results.report(allBlocked, "Nenhuma conta de teste consulta a empresa real por UUID direto");
    } else {
      results.fail("Nenhuma conta de teste consulta a empresa real por UUID direto (SUPABASE_SERVICE_ROLE_KEY ausente — não foi possível descobrir o UUID da empresa real para testar)");
    }

    // 8: Admin A cria um cliente sintético no tenant A.
    {
      const name = syntheticName(runId, "CLIENTE");
      const { data, error } = await a1.client.from("clients").insert({ company_id: tenantACompanyId, name }).select("id").single();
      if (!error && data?.id) {
        createdClientId = data.id;
        results.pass("Admin A cria um cliente sintético no tenant A");
      } else {
        results.failFromError("Admin A cria um cliente sintético no tenant A", error);
      }
    }

    // 9: Gestor A vê o cliente sintético.
    if (createdClientId) {
      const { data, error } = await a2.client.from("clients").select("id").eq("id", createdClientId);
      results.report(!error && data?.length === 1, "Gestor A vê o cliente sintético");
    } else {
      results.fail("Gestor A vê o cliente sintético (pré-condição falhou: cliente não criado)");
    }

    // 10: Admin B não vê esse cliente.
    if (createdClientId) {
      const r = await selectsNothing(b1.client.from("clients").select("id").eq("id", createdClientId));
      results.report(r.blocked, "Admin B não vê o cliente sintético do tenant A");
    } else {
      results.fail("Admin B não vê o cliente sintético do tenant A (pré-condição falhou)");
    }

    // 11: Admin B não consegue atualizar ou apagar esse cliente.
    if (createdClientId) {
      const { data: upd } = await b1.client.from("clients").update({ notes: "tentativa" }).eq("id", createdClientId).select("id");
      const updateBlocked = (upd ?? []).length === 0;
      const { data: del } = await b1.client.from("clients").delete().eq("id", createdClientId).select("id");
      const deleteBlocked = (del ?? []).length === 0;
      results.report(updateBlocked && deleteBlocked, "Admin B não consegue atualizar nem apagar o cliente do tenant A");
    } else {
      results.fail("Admin B não consegue atualizar/apagar cliente do tenant A (pré-condição falhou)");
    }

    // 12: Admin B não consegue inserir um registo usando company_id do tenant A.
    {
      const { error } = await b1.client.from("clients").insert({ company_id: tenantACompanyId, name: syntheticName(runId, "B_TENTA_A") });
      results.report(Boolean(error), "Admin B não consegue inserir cliente com company_id do tenant A");
    }

    // 13: Admin A não consegue inserir um registo usando company_id do tenant B.
    {
      const { error } = await a1.client.from("clients").insert({ company_id: tenantBCompanyId, name: syntheticName(runId, "A_TENTA_B") });
      results.report(Boolean(error), "Admin A não consegue inserir cliente com company_id do tenant B");
    }

    // 14: Admin A não consegue mudar a própria company_id para o tenant B.
    {
      const { data } = await a1.client.from("profiles").update({ company_id: tenantBCompanyId }).eq("id", a1.userId).select("id");
      results.report((data ?? []).length === 0, "Admin A não consegue mudar a própria company_id");
    }

    // 15: Gestor A não consegue mudar a própria company_id para o tenant B.
    {
      const { data } = await a2.client.from("profiles").update({ company_id: tenantBCompanyId }).eq("id", a2.userId).select("id");
      results.report((data ?? []).length === 0, "Gestor A não consegue mudar a própria company_id");
    }

    // 16: Colaborador A não consegue mudar a própria company_id.
    {
      const { data } = await a3.client.from("profiles").update({ company_id: tenantBCompanyId }).eq("id", a3.userId).select("id");
      results.report((data ?? []).length === 0, "Colaborador A não consegue mudar a própria company_id");
    }

    // 17: Colaborador A não consegue mudar o próprio role para admin.
    {
      const { data } = await a3.client.from("profiles").update({ role: "admin" }).eq("id", a3.userId).select("id");
      results.report((data ?? []).length === 0, "Colaborador A não consegue mudar o próprio role para admin");
    }

    // 18: Colaborador A continua conseguindo atualizar um campo pessoal não sensível.
    {
      const marker = syntheticName(runId, "PHONE").slice(-15);
      const { data, error } = await a3.client.from("profiles").update({ phone: marker }).eq("id", a3.userId).select("id");
      results.report(!error && (data ?? []).length === 1, "Colaborador A continua conseguindo atualizar um campo pessoal não sensível (phone)");
    }

    // 19: Admin A consegue alterar o role do colaborador A dentro do mesmo tenant.
    {
      const { data, error } = await a1.client.from("profiles").update({ role: "gestor" }).eq("id", a3.userId).select("id");
      results.report(!error && (data ?? []).length === 1, "Admin A consegue alterar o role do colaborador A dentro do mesmo tenant");
    }

    // 20: restaurar o role original do colaborador.
    {
      const { data, error } = await a1.client.from("profiles").update({ role: "colaborador" }).eq("id", a3.userId).select("id");
      results.report(
        !error && (data ?? []).length === 1,
        "Role original do colaborador A restaurado",
        "Role original do colaborador A restaurado — ESTADO PODE TER FICADO INCONSISTENTE, verificar manualmente",
      );
    }

    // 21: nenhuma contagem da empresa real pode mudar.
    if (realCompanyId && realBaselineCount !== null && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const admin = makeAdminClient();
      const { count } = await admin.from("clients").select("id", { count: "exact", head: true }).eq("company_id", realCompanyId);
      results.report(count === realBaselineCount, "Nenhuma contagem da empresa real mudou");
    } else {
      results.fail("Nenhuma contagem da empresa real mudou (baseline indisponível — SUPABASE_SERVICE_ROLE_KEY ausente)");
    }

    // 22: nenhuma operação pode criar registos ligados à company_id real.
    if (realCompanyId) {
      const { error } = await a1.client.from("clients").insert({ company_id: realCompanyId, name: syntheticName(runId, "TENTA_REAL") });
      results.report(Boolean(error), "Nenhuma operação cria registos ligados à company_id real");
    } else {
      results.fail("Nenhuma operação cria registos ligados à company_id real (não verificável sem SUPABASE_SERVICE_ROLE_KEY)");
    }
  } finally {
    // Só apaga os dados sintéticos deste run_id — nunca as empresas/contas
    // de teste (reutilizadas nos testes seguintes de concorrência/contratos/
    // calendário/Realtime).
    if (createdClientId) {
      const { error } = await a1.client.from("clients").delete().eq("id", createdClientId);
      if (error) console.log(`FAIL — limpeza do cliente sintético (erro: ${safeErrorMessage(error)})`);
      else console.log("PASS — limpeza do cliente sintético concluída");
    }
  }

  const summary = results.summary();
  console.log("");
  console.log(`Resumo: ${summary.passed}/${summary.total} PASS`);
  if (results.hasFailures()) process.exit(1);
}

main().catch((err) => {
  console.error(`FAIL — erro fatal (${safeErrorMessage(err)})`);
  process.exit(1);
});
