// ============================================================================
// GUARDAS ANTI-REVERSÃO
// ============================================================================
// Testes estáticos que fixam as invariantes descobertas na auditoria de
// "alterações que desaparecem/voltam atrás" (ver scripts/audit-reversoes.mjs).
// Se um destes falhar, alguém reintroduziu uma das causas-raiz.
// ============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CLIENTE_SHEET_SELECT } from "@/lib/cliente-sheet-fields";
import { CONTRATO_SHEET_SELECT, CONTRACT_FINANCIAL_FIELDS } from "@/lib/contrato-sheet-fields";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ── 1. Edição parcial: os formulários têm de carregar TODAS as colunas que
//       gravam, senão o update escreve null por cima (bug type/notes + avença).
describe("edição parcial (perda de campos ao gravar)", () => {
  it("CLIENTE_SHEET_SELECT inclui todas as colunas que updateCliente grava", () => {
    for (const col of ["name", "email", "phone", "nif", "type", "notes", "status", "vat_exempt"]) {
      expect(CLIENTE_SHEET_SELECT, `coluna em falta no select do ClienteSheet: ${col}`).toContain(col);
    }
  });

  it("CONTRATO_SHEET_SELECT inclui as colunas financeiras da avença", () => {
    for (const col of ["fixed_price", "fixed_monthly", "apply_vat"]) {
      expect(CONTRACT_FINANCIAL_FIELDS).toContain(col);
      expect(CONTRATO_SHEET_SELECT).toContain(col);
    }
  });

  it("nenhuma página que renderiza ClienteSheet volta a escrever a lista de colunas à mão", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes("cliente-sheet-fields")) continue;
      const src = readFileSync(file, "utf8");
      const usesSheet = /<ClienteSheet[\s>]/.test(src);
      const queriesClients = /from\(["']clients["']\)/.test(src);
      if (usesSheet && queriesClients && !src.includes("CLIENTE_SHEET_SELECT")) offenders.push(file);
    }
    expect(offenders, `Estas páginas alimentam o ClienteSheet sem usar CLIENTE_SHEET_SELECT (risco de apagar type/notes ao gravar): ${offenders.join(", ")}`).toEqual([]);
  });

  it("nenhuma página que renderiza ContratoSheet volta a escrever a lista de colunas à mão", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes("contrato-sheet-fields")) continue;
      const src = readFileSync(file, "utf8");
      const usesSheet = /<ContratoSheet[\s>]/.test(src);
      const queriesContracts = /from\(["']contracts["']\)/.test(src);
      if (usesSheet && queriesContracts && !src.includes("CONTRATO_SHEET_SELECT")) offenders.push(file);
    }
    expect(offenders, `Estas páginas alimentam o ContratoSheet sem usar CONTRATO_SHEET_SELECT (risco de apagar o valor da avença): ${offenders.join(", ")}`).toEqual([]);
  });
});

// ── 2. Pipeline de migração: nunca mais re-executar tudo nem semear produção.
describe("run-migrations.mjs seguro", () => {
  const src = readFileSync(join(ROOT, "scripts", "run-migrations.mjs"), "utf8");

  it("não tem credenciais hardcoded", () => {
    expect(/password:\s*["'][^"']+["']/.test(src)).toBe(false);
    expect(src).toContain("SUPABASE_DB_URL");
  });

  it("usa tabela de controlo _migrations (só aplica pendentes)", () => {
    expect(src).toContain("_migrations");
    expect(src).toContain("--baseline");
  });

  it("seed só com flag explícita e guarda contra base com dados", () => {
    expect(src).toContain("--seed");
    expect(src).toMatch(/dbHasData/);
  });

  it("não engole erros de migração (sem 'already exists' ignorado)", () => {
    expect(src).not.toContain("already exists");
  });
});

// ── 3. Service worker: HTML nunca pode vir da cache (senão deploys "não aparecem").
describe("service worker (public/sw.js)", () => {
  const sw = readFileSync(join(ROOT, "public", "sw.js"), "utf8");

  it("navegações/HTML são sempre rede (network-first), nunca cache-first", () => {
    // A única escrita em cache (c.put) tem de estar dentro do bloco de assets estáticos.
    const putCount = (sw.match(/\.put\(/g) ?? []).length;
    expect(putCount).toBe(1);
    const assetBlock = sw.slice(sw.indexOf("js|css|png"), sw.indexOf("Páginas HTML"));
    expect(assetBlock).toContain(".put(");
  });

  it("/api/ nunca é cacheado", () => {
    expect(sw).toContain('url.pathname.startsWith("/api/")');
  });

  it("a versão da cache é carimbada por deploy (prebuild)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prebuild).toContain("stamp-sw");
  });
});

// ── 3b. Rede de segurança (migração 059): histórico universal, exceções
//        automáticas e guarda do valor/hora têm de existir e manter-se.
describe("rede de segurança na base de dados (059_rede_seguranca.sql)", () => {
  const sql = readFileSync(join(ROOT, "supabase", "migrations", "059_rede_seguranca.sql"), "utf8");

  it("histórico universal cobre todas as tabelas críticas", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.data_history");
    for (const t of ["clients", "locations", "contracts", "services", "invoices", "invoice_items"]) {
      expect(sql, `trigger de histórico em falta para ${t}`).toMatch(
        new RegExp(`CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public\\.${t}`),
      );
    }
  });

  it("edições manuais de serviços de contrato viram exceção na própria base", () => {
    expect(sql).toContain("trg_services_mark_exception");
    expect(sql).toContain("contract_synced_at");
    expect(sql).toContain("NEW.is_exception := true");
  });

  it("a base recusa apagar hourly_rate de local com contrato por hora ativo", () => {
    expect(sql).toContain("trg_guard_location_rate");
    expect(sql).toContain("RAISE EXCEPTION");
  });

  it("a sincronização de contratos declara-se ao trigger (contract_synced_at)", () => {
    const contratos = readFileSync(join(SRC, "app", "actions", "contratos.ts"), "utf8");
    expect(contratos, "updateFutureServiceValuesForContract tem de enviar contract_synced_at, senão o trigger marca a sync como edição manual e as sincronizações futuras param").toContain("contract_synced_at");
  });

  it("a ferramenta de restauro existe e não tem credenciais hardcoded", () => {
    const restore = readFileSync(join(ROOT, "scripts", "restore-from-history.mjs"), "utf8");
    expect(restore).toContain("SUPABASE_DB_URL");
    expect(/password:\s*["'][^"']+["']/.test(restore)).toBe(false);
  });
});

// ── 3c. Guardas adicionais (migração 060) + painel de recuperação.
describe("guardas adicionais (060_guardas_adicionais.sql) e painel de recuperação", () => {
  const sql = readFileSync(join(ROOT, "supabase", "migrations", "060_guardas_adicionais.sql"), "utf8");

  it("avença mensal ativa não pode ficar sem valor (trigger no banco)", () => {
    expect(sql).toContain("trg_guard_contract_fixed_price");
    expect(sql).toContain("RAISE EXCEPTION");
  });

  it("avença duplicada é impossível ao nível do Postgres (EXCLUDE constraint)", () => {
    expect(sql).toContain("contracts_no_duplicate_monthly");
    expect(sql).toContain("EXCLUDE USING gist");
    expect(sql).toContain("btree_gist");
  });

  it("histórico regista company_id e changed_fields", () => {
    expect(sql).toContain("changed_fields");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS company_id/);
  });

  it("painel de recuperação existe com restauro via server action segura", () => {
    const page = readFileSync(
      join(SRC, "app", "(dashboard)", "dashboard", "sistema", "auditoria", "page.tsx"), "utf8");
    expect(page).toContain("restoreHistoryEntry");

    const action = readFileSync(join(SRC, "app", "actions", "data-history.ts"), "utf8");
    expect(action).toContain('"use server"');
    expect(action).toContain("requireProfile");
    expect(action, "restauro tem de confirmar linhas afetadas").toContain('.select("id")');
    expect(action, "restauro exige motivo").toContain("reason");
    expect(action, "restauro fica auditado").toContain("auditLog");
  });

  it("updateContrato confirma pós-gravação os campos financeiros (read-after-write)", () => {
    const contratos = readFileSync(join(SRC, "app", "actions", "contratos.ts"), "utf8");
    expect(contratos).toContain("não foi confirmada na base de dados");
  });
});

// ── 3d. Correções da auditoria E (pós-implementação).
describe("auditoria E — buracos residuais fechados", () => {
  it("requireAll: campo crítico AUSENTE bloqueia updates completos (não só undefined)", async () => {
    const { assertCriticalFieldsLoaded } = await import("@/lib/critical-fields");
    // contrato sem fixed_price/fixed_monthly/apply_vat → bloqueado
    const semFinanceiros = assertCriticalFieldsLoaded("contracts", {
      schedule_days: [], starts_on: "2026-01-01", ends_on: null, status: "ativo",
      num_people: null, upholstery_units: null, upholstery_unit_price: null,
    }, { requireAll: true });
    expect(semFinanceiros.ok).toBe(false);
    if (!semFinanceiros.ok) expect(semFinanceiros.missing).toEqual(
      expect.arrayContaining(["fixed_price", "fixed_monthly", "apply_vat"]));

    // cliente sem type/notes/vat_exempt → bloqueado
    const semTipo = assertCriticalFieldsLoaded("clients", { status: "ativo" }, { requireAll: true });
    expect(semTipo.ok).toBe(false);

    // payload completo (null é intencional e permitido) → passa
    const completo = assertCriticalFieldsLoaded("clients",
      { type: "empresa", notes: null, vat_exempt: false, status: "ativo" }, { requireAll: true });
    expect(completo.ok).toBe(true);

    // patch update (sem requireAll) continua a aceitar payloads parciais
    const patch = assertCriticalFieldsLoaded("services", { manual_value: 10, apply_vat: true });
    expect(patch.ok).toBe(true);
  });

  it("as 3 actions de update completo usam requireAll", () => {
    for (const f of ["clientes.ts", "contratos.ts", "locations.ts"]) {
      const src = readFileSync(join(SRC, "app", "actions", f), "utf8");
      expect(src, `${f} sem requireAll`).toContain("requireAll: true");
    }
  });

  it("cancelService confirma linha afetada, filtra por company_id e marca is_exception", () => {
    const src = readFileSync(join(SRC, "app", "actions", "cancellations.ts"), "utf8");
    const cancelBody = src.slice(src.indexOf("export async function cancelService"), src.indexOf("deleteCalendarService"));
    expect(cancelBody, "update do cancelamento sem .select(\"id\")").toContain('.select("id")');
    expect(cancelBody, "cancelamento de serviço de contrato tem de virar exceção").toContain("is_exception");
    expect(cancelBody, "cancelService tem de revalidar antes dos returns de notificação").toContain("revalidatePath");
  });

  it("deleteCalendarService recusa 0 eliminados e confirma updates ao contrato", () => {
    const src = readFileSync(join(SRC, "app", "actions", "cancellations.ts"), "utf8");
    const delBody = src.slice(src.indexOf("export async function deleteCalendarService"));
    expect(delBody).toContain("Nada foi eliminado");
    expect(delBody, "arquivo da recorrência sem confirmação").toMatch(/status: "cancelado" \}\)[\s\S]{0,200}\.select\("id"\)/);
    expect(delBody, "excluded_dates sem confirmação").toMatch(/excluded_dates[\s\S]{0,220}\.select\("id"\)/);
    expect(delBody).toContain("/dashboard/cobrancas");
  });

  it("markServiceAbsence marca is_exception em serviços de contrato", () => {
    const src = readFileSync(join(SRC, "app", "(dashboard)", "dashboard", "calendario", "_actions", "update-service.ts"), "utf8");
    const body = src.slice(src.indexOf("markServiceAbsence"));
    expect(body).toContain("contract_id");
    expect(body).toContain("is_exception");
  });

  it("runner de migrações valida checksum e bloqueia divergências", () => {
    const src = readFileSync(join(ROOT, "scripts", "run-migrations.mjs"), "utf8");
    expect(src).toContain("checksum");
    expect(src).toContain("sha256");
    expect(src).toContain("CHECKSUM DIVERGENTE");
  });

  it("migração 061 guarda schedule_days de contrato ativo e pricing do local", () => {
    const sql = readFileSync(join(ROOT, "supabase", "migrations", "061_guardas_campos_criticos.sql"), "utf8");
    expect(sql).toContain("trg_guard_contract_schedule");
    expect(sql).toContain("trg_guard_location_pricing");
    expect(sql).toContain("app.allow_unsafe");
  });

  it("página de auditoria não usa user! (redireciona sem sessão)", () => {
    const page = readFileSync(join(SRC, "app", "(dashboard)", "dashboard", "sistema", "auditoria", "page.tsx"), "utf8");
    expect(page).not.toContain("user!.id");
    expect(page).toContain('redirect("/login")');
  });
});

// ── 3e. Correções da auditoria F.
describe("auditoria F — campos operacionais, delete atómico e actor", () => {
  it("CRITICAL_FIELDS.contracts inclui os campos operacionais (cleaning/payment/estofos)", async () => {
    const { assertCriticalFieldsLoaded, CRITICAL_FIELDS } = await import("@/lib/critical-fields");
    for (const f of ["cleaning_type", "payment_status", "upholstery_type", "upholstery_notes", "unit_value"]) {
      expect(CRITICAL_FIELDS.contracts as readonly string[], `campo em falta: ${f}`).toContain(f);
    }
    // updateContrato sem cleaning_type/payment_status → bloqueado
    const semOperacionais = assertCriticalFieldsLoaded("contracts", {
      fixed_price: null, fixed_monthly: false, apply_vat: false,
      schedule_days: [], starts_on: "2026-01-01", ends_on: null, status: "ativo",
      num_people: null, upholstery_units: null, upholstery_unit_price: null,
      upholstery_type: null, upholstery_notes: null, unit_value: null,
    }, { requireAll: true });
    expect(semOperacionais.ok).toBe(false);
    if (!semOperacionais.ok) expect(semOperacionais.missing).toEqual(
      expect.arrayContaining(["cleaning_type", "payment_status"]));
  });

  it("migração 062: RPC atómica de delete + actor no histórico", () => {
    const sql = readFileSync(join(ROOT, "supabase", "migrations", "062_delete_atomico_e_actor.sql"), "utf8");
    expect(sql).toContain("delete_calendar_service_safe");
    expect(sql).toContain("app.actor_id");
    expect(sql, "RPC nunca pode ser chamável pelo browser").toContain("REVOKE");
    expect(sql, "bookkeeping ANTES do delete dentro da transação").toMatch(/excluded_dates[\s\S]+DELETE FROM public\.services/);
  });

  it("deleteCalendarService usa a RPC atómica com fallback em ordem fail-safe", () => {
    const src = readFileSync(join(SRC, "app", "actions", "cancellations.ts"), "utf8");
    expect(src).toContain('rpc("delete_calendar_service_safe"');
    const fallback = src.slice(src.indexOf("Fallback enquanto a migração 062"));
    // no fallback, o arquivo/exceção vem ANTES do delete
    const idxArchive = fallback.indexOf('status: "cancelado"');
    const idxDeleteAll = fallback.indexOf('.eq("contract_id", svc.contract_id)');
    expect(idxArchive).toBeGreaterThan(-1);
    expect(idxArchive, "fallback all: arquivar tem de vir antes do delete").toBeLessThan(idxDeleteAll);
    const idxExcl = fallback.indexOf("excluded_dates");
    const idxDelSingle = fallback.lastIndexOf('.from("services").delete()');
    expect(idxExcl, "fallback single: excluded_dates antes do delete").toBeLessThan(idxDelSingle);
  });

  it("fn_capture_history usa app.actor_id com fallback auth.uid()", () => {
    const sql = readFileSync(join(ROOT, "supabase", "migrations", "062_delete_atomico_e_actor.sql"), "utf8");
    expect(sql).toMatch(/COALESCE\(\s*NULLIF\(current_setting\('app\.actor_id', true\), ''\)::uuid,\s*auth\.uid\(\)\s*\)/);
  });

  it("read-after-write do contrato cobre os campos operacionais", () => {
    const src = readFileSync(join(SRC, "app", "actions", "contratos.ts"), "utf8");
    expect(src).toContain("campos divergentes");
    for (const f of ["cleaning_type", "payment_status", "upholstery_notes", "schedule_days", "num_people"]) {
      const rawSection = src.slice(src.indexOf("Read-after-write COMPLETO"));
      expect(rawSection, `read-after-write sem ${f}`).toContain(f);
    }
  });

  it("runner faz backfill de checksums antigos", () => {
    const src = readFileSync(join(ROOT, "scripts", "run-migrations.mjs"), "utf8");
    expect(src).toContain("checksum backfill");
  });
});

// ── 4. Rastreabilidade: /api/health tem de expor a versão em produção.
describe("versão do deploy rastreável", () => {
  it("/api/health devolve o commit (VERCEL_GIT_COMMIT_SHA)", () => {
    const src = readFileSync(join(SRC, "app", "api", "health", "route.ts"), "utf8");
    expect(src).toContain("VERCEL_GIT_COMMIT_SHA");
  });
});
