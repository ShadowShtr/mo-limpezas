import { getVehicles } from "@/app/actions/vehicles";
import { VehiclesClient } from "./_components/vehicles-client";

export const metadata = { title: "Viaturas — Escala" };

export default async function ViatruasPage() {
  const vehicles = await getVehicles();
  return <VehiclesClient initialVehicles={vehicles} />;
}
