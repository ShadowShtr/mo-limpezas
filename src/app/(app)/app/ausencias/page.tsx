import { getMyRequests } from "@/app/actions/vacation";
import { AusenciasClient } from "./_components/ausencias-client";

export default async function AusenciasPage() {
  const { vacations, absences } = await getMyRequests();

  return (
    <div className="flex flex-col gap-4 pb-2">
      <h1 className="text-xl font-bold text-[var(--color-text-main)]">Ausências</h1>
      <AusenciasClient vacations={vacations} absences={absences} />
    </div>
  );
}
