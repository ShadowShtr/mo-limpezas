"use client";

import dynamic from "next/dynamic";
import type { MapClockPoint, MapService, MapTeam } from "@/app/actions/map";

const MapView = dynamic(() => import("./map-view").then((m) => m.MapView), {
  ssr: false,
  loading: () => <div className="flex-1 bg-gray-50" />,
});

interface Props {
  initialServices: MapService[];
  initialClockPoints: MapClockPoint[];
  initialTeams: MapTeam[];
  initialDate: string;
}

export function MapClient(props: Props) {
  return <MapView {...props} />;
}
