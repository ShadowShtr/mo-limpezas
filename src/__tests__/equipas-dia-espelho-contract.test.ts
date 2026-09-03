import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const action = readFileSync(join(process.cwd(), "src/app/actions/equipas-dia-espelho.ts"), "utf8");
const view = readFileSync(join(process.cwd(), "src/app/(dashboard)/dashboard/equipas/_components/effective-day.tsx"), "utf8");

describe("Equipas ↔ Calendário usam o mesmo read model efetivo", () => {
  it("não reimplementa precedência: parte de carregarDia/team_day_effective", () => {
    expect(action).toContain("await carregarDia(companyId, date)");
    expect(action).not.toContain("from(\"team_members\")");
    expect(action).not.toContain("from(\"collaborator_ride_assignments\")");
  });

  it("ausências são filtradas pela data selecionada", () => {
    expect(action).toContain('.lte("starts_on", date)');
    expect(action).toContain('.gte("ends_on", date)');
  });

  it("ausente sai de equipa e disponível e aparece na secção própria", () => {
    expect(view).toContain("effective.filter((line) => line.ausente)");
    expect(view).toContain("!line.ausente && line.effective_team_id === null");
    expect(view).toContain("!line.ausente && line.effective_team_id === team.id");
  });

  it("UX distingue decisão diária de composição permanente", () => {
    expect(view).toContain("Só neste dia");
    expect(view).toContain("Permanente");
  });
});
