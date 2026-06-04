import { Header } from "@/components/layout/header";
import { getMapServices } from "@/app/actions/map";
import { MapView } from "./_components/map-view";
import { format } from "date-fns";

export default async function MapaPage() {
  const today = format(new Date(), "yyyy-MM-dd");
  const { services, teams } = await getMapServices(today);

  const servicesWithCoords = services.filter((s) => s.lat && s.lng);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header
        title="Mapa"
        subtitle={`${servicesWithCoords.length} serviço${servicesWithCoords.length !== 1 ? "s" : ""} hoje com localização`}
      />
      <MapView
        initialServices={services}
        initialTeams={teams}
        initialDate={today}
      />
    </div>
  );
}
