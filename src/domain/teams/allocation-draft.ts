export type TeamDestination = string | null;

export type DayAssignment = {
  collaborator_id: string;
  team_id: TeamDestination;
};

export type VehicleAssignment = {
  team_id: string;
  vehicle_id: string;
  driver_id: string | null;
};

export type TeamAllocationSnapshot = {
  member_assignments: DayAssignment[];
  vehicle_allocations: VehicleAssignment[];
};

export type AssignmentDraft = Record<string, TeamDestination>;

export function assignmentMap(rows: DayAssignment[]): AssignmentDraft {
  return Object.fromEntries(rows.map((row) => [row.collaborator_id, row.team_id]));
}

export function effectiveTeam(
  collaboratorId: string,
  homeTeams: Record<string, TeamDestination>,
  overrides: AssignmentDraft,
): TeamDestination {
  return Object.prototype.hasOwnProperty.call(overrides, collaboratorId)
    ? overrides[collaboratorId]
    : homeTeams[collaboratorId] ?? null;
}

export function moveInDraft(
  current: AssignmentDraft,
  collaboratorId: string,
  destination: TeamDestination,
  homeTeams: Record<string, TeamDestination>,
): AssignmentDraft {
  const next = { ...current };
  const home = homeTeams[collaboratorId] ?? null;
  if (destination === home) delete next[collaboratorId];
  else next[collaboratorId] = destination;
  return next;
}

export function sortedDayAssignments(draft: AssignmentDraft): DayAssignment[] {
  return Object.entries(draft)
    .map(([collaborator_id, team_id]) => ({ collaborator_id, team_id }))
    .sort((a, b) => a.collaborator_id.localeCompare(b.collaborator_id));
}

export function canonicalSnapshot(snapshot: TeamAllocationSnapshot): TeamAllocationSnapshot {
  return {
    member_assignments: [...snapshot.member_assignments].sort((a, b) =>
      a.collaborator_id.localeCompare(b.collaborator_id),
    ),
    vehicle_allocations: [...snapshot.vehicle_allocations].sort((a, b) =>
      a.team_id.localeCompare(b.team_id) || a.vehicle_id.localeCompare(b.vehicle_id),
    ),
  };
}

export function snapshotsEqual(
  left: TeamAllocationSnapshot,
  right: TeamAllocationSnapshot,
): boolean {
  return JSON.stringify(canonicalSnapshot(left)) === JSON.stringify(canonicalSnapshot(right));
}
