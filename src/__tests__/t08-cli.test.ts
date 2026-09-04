// ============================================================================
// FERRAMENTAS OFFLINE DA T08 — GUARDAS DE ENTRADA/SAÍDA
// ============================================================================
// Duas propriedades que têm de se manter verdadeiras enquanto o incidente de
// credenciais estiver aberto:
//
//   1. as ferramentas NÃO SABEM ESCREVER. Qualquer flag de escrita é recusada
//      (fail-closed), por isso ninguém as pode apontar a produção por engano;
//
//   2. as ferramentas NÃO COPIAM o que não pediram. A leitura faz *pick*
//      explícito dos campos técnicos, logo nomes, emails, moradas ou telefones
//      que venham no snapshot nunca chegam ao relatório.
// ============================================================================

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertNoWriteFlags, hasFlag, lisbonDateOf, pickContract, pickService, readArg } from "../../scripts/t08-io";

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, "..", "..");

// ─── leitura de argumentos ──────────────────────────────────────────────────

describe("argumentos", () => {
  it("aceita --input valor e --input=valor", () => {
    expect(readArg(["--input", "a.json"], "input")).toBe("a.json");
    expect(readArg(["--input=b.json"], "input")).toBe("b.json");
    expect(readArg(["--outro", "x"], "input")).toBeNull();
  });

  it("deteta flags", () => {
    expect(hasFlag(["--apply"], "apply")).toBe(true);
    expect(hasFlag([], "apply")).toBe(false);
  });

  it("🔴 recusa qualquer flag de escrita", () => {
    for (const flag of ["apply", "execute", "write", "commit", "force"]) {
      expect(() => assertNoWriteFlags([`--${flag}`])).toThrow();
    }
  });

  it("não recusa uma invocação normal", () => {
    expect(() => assertNoWriteFlags(["--input", "a.json", "--out", "b.json"])).not.toThrow();
  });
});

// ─── leitura defensiva ──────────────────────────────────────────────────────

describe("leitura só de campos técnicos", () => {
  it("ignora tudo o que não pediu, incluindo dados pessoais", () => {
    const contrato = pickContract({
      id: "c1", company_id: "e1", frequency: "weekly", weekdays: [1],
      interval_days: 1, starts_on: "2026-07-01", ends_on: null, excluded_dates: [],
      // Campos que um export descuidado poderia trazer:
      client_name: "NOME REAL", client_email: "pessoa@exemplo.pt",
      address: "Rua Real 123", phone: "+351900000000", notes: "observação sensível",
    });
    const serializado = JSON.stringify(contrato);
    expect(serializado).not.toMatch(/NOME REAL|exemplo\.pt|Rua Real|351900000000|sensível/);
    expect(Object.keys(contrato).sort()).toEqual([
      "companyId", "endsOn", "excludedDates", "frequency", "id",
      "intervalDays", "startsOn", "status", "weekdays",
    ]);
  });

  it("o serviço também só traz campos técnicos", () => {
    const servico = pickService({
      id: "s1", company_id: "e1", contract_id: "c1",
      scheduled_start: "2026-07-08T09:00:00+01:00", status: "agendado",
      is_exception: false, created_at: "2026-06-01T00:00:00Z",
      collaborator_name: "NOME REAL", location_address: "Rua Real 123",
    });
    expect(JSON.stringify(servico)).not.toMatch(/NOME REAL|Rua Real/);
    expect(servico.scheduledDate).toBe("2026-07-08");
  });

  it("aceita camelCase e snake_case", () => {
    expect(pickContract({ startsOn: "2026-01-01" }).startsOn).toBe("2026-01-01");
    expect(pickContract({ starts_on: "2026-01-02" }).startsOn).toBe("2026-01-02");
  });

  it("valores de tipo errado não passam", () => {
    const c = pickContract({ id: 42, weekdays: "segunda", interval_days: "sete" });
    expect(c.id).toBe("");
    expect(c.weekdays).toBeNull();
    expect(c.intervalDays).toBe(1);
  });

  it("🔴 a data do serviço é lida em Lisboa, não em UTC", () => {
    // 00:30 de Lisboa em hora de verão é o dia ANTERIOR em UTC. Ler o dia com
    // `.slice(0, 10)` sobre o timestamp trocaria o dia — a mesma classe de
    // defeito que a T07 corrigiu no motor.
    expect(lisbonDateOf("2026-07-08T00:30:00+01:00")).toBe("2026-07-08");
    expect("2026-07-07T23:30:00Z".slice(0, 10)).toBe("2026-07-07"); // o erro que se evita
    expect(lisbonDateOf("2026-07-07T23:30:00Z")).toBe("2026-07-08");
  });

  it("timestamp inválido não inventa data", () => {
    expect(lisbonDateOf("ontem")).toBe("");
    expect(lisbonDateOf("")).toBe("");
  });
});

// ─── execução real das ferramentas ──────────────────────────────────────────

describe("ferramentas a correr de ponta a ponta", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t08-"));

  function escrever(nome: string, dados: unknown): string {
    const caminho = path.join(tmp, nome);
    fs.writeFileSync(caminho, JSON.stringify(dados), "utf8");
    return caminho;
  }
  /**
   * O `tsx` LOCAL, resolvido à mão, sem `npx`.
   *
   * Isto corria como `execFile("npx", ["tsx", ...])`. O `npx`, quando não
   * encontra a ferramenta instalada, vai buscá-la à rede — e o `tsx` não estava
   * declarado no `package.json` nem no lockfile, portanto `npm ci` nunca o
   * instalava. Numa máquina de desenvolvimento o cache do npx já o tem e o
   * ensaio corre em ~4 s; num runner limpo o download é o caminho normal, e os
   * três casos que lançam subprocessos ficavam presos até ao teto de 60 s cada.
   * Era um `npm test` a depender de rede a meio da suite.
   *
   * Agora aponta-se ao binário que o `npm ci` instala. Se faltar, o ensaio
   * falha na hora e diz porquê, em vez de esperar um minuto por um download:
   * ausência de dependência declarada é defeito de instalação, não lentidão.
   */
  function binarioTsx(): string {
    const base = path.join(ROOT, "node_modules", ".bin");
    // O `.cmd` é o que o Windows sabe executar; noutros sistemas é o script sem
    // extensão. Verificam-se os dois para o ensaio não depender da plataforma.
    const candidatos = process.platform === "win32"
      ? [path.join(base, "tsx.cmd"), path.join(base, "tsx")]
      : [path.join(base, "tsx")];
    const encontrado = candidatos.find((c) => fs.existsSync(c));
    if (!encontrado) {
      throw new Error(
        `tsx não está instalado em node_modules/.bin (procurado: ${candidatos.join(", ")}). ` +
        "Declare-o como devDependency e corra `npm ci` — este ensaio não descarrega ferramentas.",
      );
    }
    return encontrado;
  }

  async function correr(script: string, args: string[]) {
    return execFileAsync(binarioTsx(), [path.join(ROOT, "scripts", script), ...args], {
      cwd: ROOT, shell: process.platform === "win32",
    });
  }

  it("o comparador produz o relatório e não altera a entrada", async () => {
    const entrada = {
      window: { start: "2026-01-05", end: "2026-12-31" },
      contracts: [
        { id: "c1", frequency: "biweekly", weekdays: [4], interval_days: 1, starts_on: "2026-01-05", ends_on: null, excluded_dates: [] },
        { id: "c2", frequency: "weekly", weekdays: [1], interval_days: 1, starts_on: "2026-01-05", ends_on: null, excluded_dates: [] },
      ],
    };
    const caminho = escrever("compat.json", entrada);
    const antes = fs.readFileSync(caminho, "utf8");

    const { stdout } = await correr("compare-recurrence-compat.ts", ["--input", caminho]);
    const relatorio = JSON.parse(stdout);

    expect(relatorio.summary.totalContracts).toBe(2);
    expect(relatorio.summary.biweeklyChanged).toBe(1);
    expect(relatorio.summary.weeklyChanged).toBe(0);
    expect(fs.readFileSync(caminho, "utf8")).toBe(antes);
  }, 60_000);

  it("o diagnóstico corre e classifica", async () => {
    const caminho = escrever("diag.json", {
      window: { start: "2026-07-01", end: "2026-07-31" },
      contracts: [{ id: "c1", company_id: "e1", frequency: "weekly", weekdays: [3], interval_days: 1, starts_on: "2026-07-01", ends_on: null, excluded_dates: [] }],
      services: [
        { id: "s1", company_id: "e1", contract_id: "c1", scheduled_start: "2026-07-08T09:00:00+01:00", status: "agendado", is_exception: false, created_at: "2026-06-01T00:00:00Z" },
        { id: "s2", company_id: "e1", contract_id: "c1", scheduled_start: "2026-07-08T14:00:00+01:00", status: "agendado", is_exception: false, created_at: "2026-06-02T00:00:00Z" },
      ],
    });
    const { stdout } = await correr("diagnose-occurrence-identity.ts", ["--input", caminho]);
    const relatorio = JSON.parse(stdout);
    expect(relatorio.summary.duplicateGroups).toBe(1);
    expect(relatorio.summary.duplicateServices).toBe(2);
  }, 60_000);

  it("🔴 o planeador recusa --apply", async () => {
    const caminho = escrever("plan.json", {
      window: { start: "2026-07-01", end: "2026-07-31" }, contracts: [], services: [],
    });
    await expect(correr("plan-occurrence-repair.ts", ["--input", caminho, "--apply"]))
      .rejects.toThrow();
  }, 60_000);
});
