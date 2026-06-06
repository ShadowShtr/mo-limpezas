import { Header } from "@/components/layout/header";
import { getMapServices } from "@/app/actions/map";
import { MapClient } from "./_components/map-client";
import { format } from "date-fns";

export default async function MapaPage() {
  const today = format(new Date(), "yyyy-MM-dd");
  const { services, teams, clockPoints } = await getMapServices(today);

  const servicesWithCoords = services.filter((s) => s.lat && s.lng);
  const gpsCount = clockPoints.length;

  return (
    <div className="flex flex-col">
      <Header
        title="Mapa"
        subtitle={`${servicesWithCoords.length} servico${servicesWithCoords.length !== 1 ? "s" : ""} com localizacao - ${gpsCount} ponto${gpsCount !== 1 ? "s" : ""} GPS registado${gpsCount !== 1 ? "s" : ""}`}
      />
      <MapClient
        initialServices={services}
        initialClockPoints={clockPoints}
        initialTeams={teams}
        initialDate={today}
      />
    </div>
  );
}
