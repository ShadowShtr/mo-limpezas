import { getVehicles } from "@/app/actions/vehicles";
import { VehiclesClient } from "./_components/vehicles-client";
import { Header } from "@/components/layout/header";

export const metadata = { title: "Viaturas — Escala" };

export default async function ViatruasPage() {
  const vehicles = await getVehicles();
  return (
    <div>
      <Header title="Viaturas" subtitle="Gestão da frota da empresa" />
      <div className="px-4 py-5 sm:p-6 lg:px-8 max-w-[1400px]">
        <VehiclesClient initialVehicles={vehicles} />
      </div>
    </div>
  );
}
