// ============================================================================
// GUARDAS ESTÁTICAS — hotfix de isolamento multiempresa (068/069)
// ============================================================================
// Sem ligação a base de dados (este repo não tem infraestrutura de testes
// contra Postgres real — ver reversao-guards.test.ts para o mesmo padrão).
// Fixa, por leitura de ficheiro, que:
//   - a 068 tornou handle_new_user() neutro em relação a raw_user_meta_data;
//   - os fluxos server-side que criam contas não dependem desse trigger;
//   - nenhum caminho client-side chama supabase.auth.signUp();
//   - a 069 tem as cláusulas de bloqueio esperadas no trigger/policy.
// Se uma futura alteração remover estas proteções, os testes falham.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

// Normalizado para LF: um checkout novo (sem .gitattributes para ficheiros
// fora de 064/065/066/067) pode materializar estas migrations com CRLF —
// ver docs/atomicidade-audit/migration-checksum-map-2026-08-05.md. As
// buscas abaixo usam sequências "\n" literais, por isso o conteúdo lido
// tem de estar normalizado antes de qualquer indexOf/match, ou o teste
// fica dependente do estado do checkout local.
const readNormalized = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const migration068 = readNormalized(
  path.join(ROOT, "supabase/migrations/068_disable_untrusted_profile_bootstrap.sql"),
);
const migration069 = readNormalized(
  path.join(ROOT, "supabase/migrations/069_guard_profile_tenant_role.sql"),
);
const colaboradoresAction = readNormalized(path.join(ROOT, "src/app/actions/colaboradores.ts"));
const csvImportAction = readNormalized(path.join(ROOT, "src/app/actions/csv-import.ts"));

function functionBody(sql: string, fnName: string) {
  const start = sql.indexOf(`FUNCTION public.${fnName}`);
  expect(start, `${fnName} não encontrada em migration`).toBeGreaterThanOrEqual(0);
  const bodyStart = sql.indexOf("BEGIN", start);
  const bodyEnd = sql.indexOf("END;\n$$;", bodyStart);
  expect(bodyStart).toBeGreaterThan(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, bodyEnd);
}

// Todos os ficheiros do repo (recursivo, exceto node_modules/.next) — usado
// para provar negativa: nenhuma chamada a auth.signUp em código cliente.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git" || name === "__tests__") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("068 — handle_new_user deixa de confiar em raw_user_meta_data", () => {
  const body = functionBody(migration068, "handle_new_user");

  it("não lê raw_user_meta_data (só menciona em comentário explicativo, nunca acede ao campo)", () => {
    expect(body).not.toMatch(/NEW\.raw_user_meta_data/);
    expect(body).not.toMatch(/raw_user_meta_data\s*->>/);
  });

  it("não insere em profiles", () => {
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.profiles/i);
  });

  it("não força role='colaborador' nem valida companies.id (decisão explícita: neutro, não parcialmente confiável)", () => {
    expect(body).not.toContain("'colaborador'");
    expect(body).not.toMatch(/FROM\s+public\.companies/i);
  });

  it("retorna NEW e mais nada", () => {
    const meaningfulLines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== "BEGIN" && !l.startsWith("--"));
    expect(meaningfulLines).toEqual(["RETURN NEW;"]);
  });

  it("createColaborador escreve em profiles explicitamente, sem depender do trigger", () => {
    // 🔴 O que a 068 protege é isto: a linha de `profiles` nasce de uma escrita
    //    explícita do servidor, e não do trigger a ler `raw_user_meta_data`.
    //
    //    Até à PHASE D isso era garantido por `auth.admin.createUser()` seguido
    //    de `upsert`. Deixou de o ser porque criar uma pessoa deixou de criar
    //    conta: agora é um `insert` directo, o que **reforça** a garantia — não
    //    há sequer um utilizador de Auth para o trigger observar.
    //
    //    A proteção continua exigida na sua forma essencial: escrita explícita,
    //    e a empresa a vir da sessão.
    expect(colaboradoresAction).toMatch(
      /admin\s*\n?\s*\.from\("profiles"\)\s*\n?\s*\.(insert|upsert)\(/);
    // company_id vem sempre da sessão do chamador, nunca do payload do cliente.
    expect(colaboradoresAction).toContain("company_id vem sempre da sessão do chamador");
  });

  it("🔴 criar colaborador não cria conta de acesso (PHASE D)", () => {
    const criar = colaboradoresAction.slice(
      colaboradoresAction.indexOf("export async function createColaborador"),
      colaboradoresAction.indexOf("export async function updateColaborador"));
    const codigo = criar.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(codigo).not.toMatch(/admin\.auth\.admin\.createUser\(/);
  });

  it("importação CSV usa admin.auth.admin.createUser() seguido de upsert explícito em profiles", () => {
    expect(csvImportAction).toMatch(/admin\.auth\.admin\.createUser\(/);
    expect(csvImportAction).toMatch(/admin\s*\n?\s*\.from\("profiles"\)\s*\n?\s*\.upsert\(/);
  });

  it("nenhum ficheiro do repositório chama supabase.auth.signUp() no lado cliente", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
      const content = fs.readFileSync(file, "utf8");
      if (/\.auth\.signUp\s*\(/.test(content)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});

describe("069 — bloqueia escalada de role e mudança de company_id em profiles", () => {
  const triggerBody = functionBody(migration069, "fn_guard_profile_tenant_role");

  it("função do trigger não é SECURITY DEFINER (não necessário — usa auth.role() e helpers já DEFINER)", () => {
    const defStart = migration069.indexOf("CREATE OR REPLACE FUNCTION public.fn_guard_profile_tenant_role");
    const defEnd = migration069.indexOf("$$;", defStart);
    const def = migration069.slice(defStart, defEnd);
    expect(def).not.toContain("SECURITY DEFINER");
  });

  it("deteta service_role via auth.role(), nunca via current_user/session_user", () => {
    expect(triggerBody).toContain("auth.role()");
    expect(triggerBody).not.toContain("current_user");
    expect(triggerBody).not.toContain("session_user");
  });

  it("bloqueia mudança de company_id fora de contexto service_role — mesmo para admin/gestor", () => {
    const idx = triggerBody.indexOf("NEW.company_id IS DISTINCT FROM OLD.company_id");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = triggerBody.slice(idx, triggerBody.indexOf("PROFILE_COMPANY_CHANGE_BLOCKED"));
    expect(block).toContain("service_role");
    // não deve haver bypass por role (admin/gestor) nesta secção — só service_role.
    expect(block).not.toMatch(/get_my_role\(\)/);
  });

  it("bloqueia escalada de role fora de service_role, exceto admin/gestor da mesma empresa com empresa inalterada", () => {
    const idx = triggerBody.indexOf("NEW.role IS DISTINCT FROM OLD.role");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = triggerBody.slice(idx, triggerBody.indexOf("PROFILE_ROLE_ESCALATION_BLOCKED"));
    expect(block).toContain("service_role");
    expect(block).toMatch(/get_my_role\(\)\s*IN\s*\('admin',\s*'gestor'\)/);
    expect(block).toContain("get_my_company_id() = OLD.company_id");
    expect(block).toContain("NEW.company_id = OLD.company_id");
  });

  it("colunas não sensíveis (full_name, etc.) não são tocadas pela guarda — só company_id e role", () => {
    expect(triggerBody).not.toContain("full_name");
    expect(triggerBody).not.toContain("phone");
  });

  it("erros usam código estável e nomeado, não mensagem solta", () => {
    expect(migration069).toContain("PROFILE_COMPANY_CHANGE_BLOCKED");
    expect(migration069).toContain("PROFILE_ROLE_ESCALATION_BLOCKED");
    expect(migration069).toContain("ERRCODE = 'P0001'");
  });

  it("trigger corre BEFORE UPDATE em public.profiles, por linha", () => {
    expect(migration069).toMatch(/CREATE TRIGGER trg_guard_profile_tenant_role\s+BEFORE UPDATE ON public\.profiles\s+FOR EACH ROW/);
  });

  it("profiles_update_own recriada com WITH CHECK explícito (id + company_id, não só id)", () => {
    const idx = migration069.indexOf('CREATE POLICY "profiles_update_own"');
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = migration069.slice(idx, idx + 400);
    expect(block).toContain("WITH CHECK");
    expect(block).toContain("id = auth.uid()");
    expect(block).toContain("company_id = public.get_my_company_id()");
  });

  it("não amplia a guarda a outras colunas sensíveis nesta migration (registadas como pendência)", () => {
    for (const col of ["vacation_balance", "hourly_rate", "status", "contracted_hours_month"]) {
      expect(migration069).not.toContain(`NEW.${col}`);
    }
  });
});
