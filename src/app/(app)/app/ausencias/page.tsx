import { getMyRequests } from "@/app/actions/vacation";
import { AusenciasClient } from "./_components/ausencias-client";

export default async function AusenciasPage() {
  let absences: Awaited<ReturnType<typeof getMyRequests>>["absences"] = [];

  try {
    const result = await getMyRequests();
    absences = result.absences ?? [];
  } catch {
    // Continua sem dados — não crasha a página
  }

  return (
    <div className="flex flex-col gap-4 pb-2">
      <h1 className="text-xl font-bold text-[var(--color-text-main)]">Ausências</h1>
      <AusenciasClient absences={absences} />
    </div>
  );
}
