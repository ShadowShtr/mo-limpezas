import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizarColaborador } from "@/domain/collaborators/profile-input";

const ROOT = path.join(__dirname, "..", "..");
const action = fs.readFileSync(path.join(ROOT, "src/app/actions/colaboradores.ts"), "utf8");
const sheet = fs.readFileSync(
  path.join(ROOT, "src/app/(dashboard)/dashboard/colaboradores/_components/sheet.tsx"),
  "utf8",
);
const validNif = "123456789";
const validIban = "PT50000201231234567890154";

function normalized(input: unknown) {
  const result = normalizarColaborador(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("COL01-COL12 - campos do colaborador", () => {
  it("COL01 cria apenas com nome e normaliza opcionais para NULL", () => {
    expect(normalized({ full_name: "  Ana Silva  " })).toMatchObject({
      full_name: "Ana Silva", email: null, phone: null, nif: null, iban: null,
      hourly_rate: null, contract_start: null, contract_end: null,
    });
  });
  it("COL02 aceita NIF preenchido e valido", () => {
    expect(normalized({ full_name: "Ana", nif: validNif }).nif).toBe(validNif);
  });
  it("COL03 aceita IBAN preenchido e valido", () => {
    expect(normalized({ full_name: "Ana", iban: validIban }).iban).toBe(validIban);
  });
  it("COL04 aceita todos os campos", () => {
    expect(normalized({
      full_name: "Ana", email: "ANA@EXAMPLE.COM", phone: "910000000",
      nif: validNif, iban: validIban, hourly_rate: 9.5,
      contract_start: "2026-08-01", contract_end: "2027-08-01",
      role: "colaborador", status: "ativo", contracted_hours_month: 160,
      skills: ["Limpeza"],
    })).toMatchObject({ email: "ana@example.com", hourly_rate: 9.5 });
  });
  it.each([["COL05", ""], ["COL06", "   "]])(
    "%s bloqueia nome vazio", (_id, full_name) => {
      expect(normalizarColaborador({ full_name }).ok).toBe(false);
    },
  );
  it.each([
    ["COL07", "nif"], ["COL08", "iban"], ["COL09", "email"],
    ["COL10", "phone"], ["COL11", "address"],
  ])("%s aceita %s vazio", (_id, field) => {
    expect(normalizarColaborador({ full_name: "Ana", [field]: "" }).ok).toBe(true);
  });
  it("COL12 aceita datas vazias", () => {
    const value = normalized({ full_name: "Ana", contract_start: "", contract_end: "" });
    expect(value.contract_start).toBeNull();
    expect(value.contract_end).toBeNull();
  });
  it("valida NIF e IBAN quando preenchidos", () => {
    expect(normalizarColaborador({ full_name: "Ana", nif: "123" }).ok).toBe(false);
    expect(normalizarColaborador({ full_name: "Ana", iban: "PT00" }).ok).toBe(false);
  });
});

describe("COL13-COL18 - empresa canonica", () => {
  const createBody = action.slice(
    action.indexOf("export async function createColaborador"),
    action.indexOf("export async function updateColaborador"),
  );
  it("COL13 resolve company_id no perfil autenticado", () => {
    expect(createBody).toContain("getCurrentProfile()");
    expect(createBody).toContain("company_id: callerProfile.company_id");
  });
  it("COL14 o browser nao envia company_id", () => {
    expect(sheet).not.toContain("company_id:");
    expect(createBody).not.toContain("input.company_id");
  });
  it("COL15-COL16 company_id falso ou alheio nao e autoridade", () => {
    expect(createBody).not.toMatch(/company_id:\s*input\./);
    expect(createBody).not.toMatch(/company_id:\s*parsed\.data/);
  });
  it("COL17-COL18 falha fechada sem contexto canonico", () => {
    expect(createBody).toContain("COMPANY_CONTEXT_MISSING");
    expect(createBody).not.toMatch(/company_id:\s*[\"']/);
  });
});

describe("COL19-COL27 - duplicados e atualizacao", () => {
  it("COL19 permite nomes iguais porque nome nao e identidade", () => {
    expect(normalized({ full_name: "Ana" })).toEqual(normalized({ full_name: "Ana" }));
  });
  it("COL20 valida NIF mas mantem a unicidade da base", () => {
    expect(normalized({ full_name: "Ana", nif: validNif }).nif).toBe(validNif);
  });
  it("COL21-COL22 permite multiplos NIF e email NULL", () => {
    for (const name of ["Ana", "Ana"]) {
      expect(normalized({ full_name: name })).toMatchObject({ nif: null, email: null });
    }
  });
  it("COL23-COL26 opcionais mudam sem mudar identidade", () => {
    const id = "perfil-estavel";
    expect({ id, ...normalized({ full_name: "Ana" }) }.id).toBe(id);
    expect({ id, ...normalized({ full_name: "Ana", iban: validIban }) }.id).toBe(id);
    expect({ id, ...normalized({ full_name: "Ana", email: "a@example.com" }) }.id).toBe(id);
    expect({ id, ...normalized({ full_name: "Ana", email: "" }) }).toMatchObject({ id, email: null });
  });
  it("COL27 update fixa a empresa pelo contexto e nunca a recebe no payload", () => {
    const updateBody = action.slice(action.indexOf("export async function updateColaborador"));
    expect(updateBody).toContain('.eq("company_id", callerProfile.company_id)');
    expect(updateBody).not.toContain("input.company_id");
  });
});

describe("consumidores de identidade", () => {
  it("nenhuma consulta de contexto trata auth user id como profiles.id", () => {
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    visit(path.join(ROOT, "src"));
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return /\.from\("profiles"\)[\s\S]{0,300}\.eq\("id",\s*user!?\.id\)/.test(source);
    });
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});
