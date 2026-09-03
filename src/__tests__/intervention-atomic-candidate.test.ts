import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const candidate = fs.readFileSync(path.join(ROOT, "docs", "INTERVENTION_ATOMIC_SCHEMA_CANDIDATE.sql"), "utf8");
const action = fs.readFileSync(path.join(ROOT, "src", "app", "actions", "contratos.ts"), "utf8");
const pointSection = fs.readFileSync(path.join(ROOT, "src", "app", "(dashboard)", "dashboard", "clientes", "[id]", "_components", "interventions-section.tsx"), "utf8");
const serviceCreate = fs.readFileSync(path.join(ROOT, "src", "app", "(dashboard)", "dashboard", "calendario", "_components", "service-create-sheet.tsx"), "utf8");
const serviceAction = fs.readFileSync(path.join(ROOT, "src", "app", "(dashboard)", "dashboard", "calendario", "_actions", "create-service.ts"), "utf8");
const serviceUpdate = fs.readFileSync(path.join(ROOT, "src", "app", "(dashboard)", "dashboard", "calendario", "_actions", "update-service.ts"), "utf8");
const reschedule = fs.readFileSync(path.join(ROOT, "src", "app", "(dashboard)", "dashboard", "calendario", "_actions", "reschedule.ts"), "utf8");

describe("candidato de edição atómica de intervenção", () => {
  it("fica fora da cadeia numerada e declara DB-first", () => {
    expect(candidate).toContain("NOT_FOR_PRODUCTION");
    expect(candidate).toContain("NOT_A_MIGRATION");
    expect(candidate).toContain("MIGRATION_NUMBER_PENDING_TECHNICAL_DIRECTION");
    expect(fs.existsSync(path.join(ROOT, "supabase", "migrations", "INTERVENTION_ATOMIC_SCHEMA_CANDIDATE.sql"))).toBe(false);
  });

  it("fecha a alteração por contrato, revisão, exceção e empresa", () => {
    expect(candidate).toContain("apply_contract_change_atomic");
    expect(candidate).toContain("FOR UPDATE");
    expect(candidate).toContain("STALE_CONFLICT");
    expect(candidate).toContain("company_id = p_company_id");
    expect(candidate).toContain("is_exception = false");
    expect(candidate).toContain("status = 'agendado'");
    expect(candidate).toContain("contract_synced_at = now()");
    expect(candidate).toContain("audit_logs");
  });

  it("o save novo chama uma única fronteira RPC e preserva hourly_rate ausente", () => {
    const update = action.slice(action.indexOf("export async function updateContrato"));
    expect(update).toContain("apply_contract_change_atomic");
    expect(update).toContain("p_expected_updated_at");
    expect(update).toContain("input.hourly_rate !== undefined");
    expect(update).toContain("currentLocation.hourly_rate");
  });

  it("edição manual de serviço continua protegida como exceção", () => {
    expect(serviceUpdate).toContain("if (service.contract_id != null) update.is_exception = true");
    expect(reschedule).toContain("if (service.contract_id != null) update.is_exception = true");
  });
});

describe("semântica Pontual existente", () => {
  it("expõe Pontual separado e cria pelo writer standalone", () => {
    expect(pointSection).toContain("Serviço pontual");
    expect(pointSection).toContain("<ServiceCreateSheet");
    expect(serviceCreate).toContain("const res = await createService");
    expect(serviceCreate).toContain("if (recurring)");
    expect(serviceAction).not.toContain("contract_id:");
    expect(serviceCreate).not.toContain('frequency: "pontual"');
  });
});
