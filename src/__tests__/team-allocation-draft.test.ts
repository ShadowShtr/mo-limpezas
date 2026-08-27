import { describe, expect, it } from "vitest";
import {
  assignmentMap,
  effectiveTeam,
  moveInDraft,
  snapshotsEqual,
  sortedDayAssignments,
} from "@/domain/teams/allocation-draft";

const homes = { ana: "team-a", bia: "team-b", clara: null };

describe("draft diario de equipas", () => {
  it("move equipa para equipa sem escrever no estado original", () => {
    const original = {};
    const next = moveInDraft(original, "ana", "team-b", homes);
    expect(original).toEqual({});
    expect(next).toEqual({ ana: "team-b" });
    expect(effectiveTeam("ana", homes, next)).toBe("team-b");
  });

  it("move equipa para Disponivel com override null explicito", () => {
    const next = moveInDraft({}, "ana", null, homes);
    expect(next).toEqual({ ana: null });
    expect(effectiveTeam("ana", homes, next)).toBeNull();
  });

  it("move Disponivel para equipa", () => {
    const next = moveInDraft({}, "clara", "team-a", homes);
    expect(next).toEqual({ clara: "team-a" });
    expect(effectiveTeam("clara", homes, next)).toBe("team-a");
  });

  it("voltar ao destino permanente remove o override diario", () => {
    const next = moveInDraft({ ana: "team-b" }, "ana", "team-a", homes);
    expect(next).toEqual({});
  });

  it("preserva null ao converter linhas para o draft", () => {
    expect(assignmentMap([{ collaborator_id: "ana", team_id: null }])).toEqual({ ana: null });
  });

  it("serializa deterministicamente para save em lote", () => {
    expect(sortedDayAssignments({ clara: "team-a", ana: null })).toEqual([
      { collaborator_id: "ana", team_id: null },
      { collaborator_id: "clara", team_id: "team-a" },
    ]);
  });

  it("compara snapshots sem depender da ordem recebida", () => {
    expect(snapshotsEqual(
      {
        member_assignments: [
          { collaborator_id: "bia", team_id: null },
          { collaborator_id: "ana", team_id: "team-b" },
        ],
        vehicle_allocations: [
          { team_id: "team-b", vehicle_id: "v2", driver_id: null },
          { team_id: "team-a", vehicle_id: "v1", driver_id: "ana" },
        ],
      },
      {
        member_assignments: [
          { collaborator_id: "ana", team_id: "team-b" },
          { collaborator_id: "bia", team_id: null },
        ],
        vehicle_allocations: [
          { team_id: "team-a", vehicle_id: "v1", driver_id: "ana" },
          { team_id: "team-b", vehicle_id: "v2", driver_id: null },
        ],
      },
    )).toBe(true);
  });
});
