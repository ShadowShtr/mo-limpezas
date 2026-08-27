import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const modal = readFileSync(
  "src/app/(dashboard)/dashboard/calendario/_components/team-allocation-modal.tsx",
  "utf8",
);
const teamAction = readFileSync("src/app/actions/equipas.ts", "utf8");
const vehicleAction = readFileSync("src/app/actions/vehicles.ts", "utf8");
const sheet = readFileSync(
  "src/app/(dashboard)/dashboard/equipas/_components/sheet.tsx",
  "utf8",
);

describe("guardas da implementação de Equipas", () => {
  it("drag não importa nem chama actions de escrita", () => {
    expect(modal).not.toMatch(/moveCollaboratorToTeam|upsertAllocation|removeAllocation/);
    const dragBody = modal.match(/function handleDragEnd[\s\S]*?\n  }/)?.[0] ?? "";
    expect(dragBody).not.toMatch(/await|saveTeamDayAllocations/);
  });

  it("guardar usa uma única action de lote", () => {
    expect(modal).toContain("saveTeamDayAllocations({");
    expect(modal).toContain("handleDiscard");
  });

  it("remove as actions individuais que permitiam writes durante drag", () => {
    expect(vehicleAction).not.toMatch(/export async function (moveCollaboratorToTeam|upsertAllocation|removeAllocation)/);
    expect(vehicleAction).not.toMatch(/from\("team_members"\)[\s\S]{0,160}\.(update|upsert|delete)\(/);
  });

  it("página Equipas não apaga todos os memberships", () => {
    expect(teamAction).not.toMatch(/from\("team_members"\)[\s\S]{0,120}\.delete\(/);
    expect(teamAction).toContain('rpc("save_team_with_members_v2"');
  });

  it("sheet repõe membros atuais sempre que abre", () => {
    expect(sheet).toContain("setSelectedMembers(equipa?.members.map");
    expect(sheet).toContain("updatedAt: equipa.updated_at");
  });
});
