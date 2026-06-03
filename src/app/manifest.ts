import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mó Limpezas",
    short_name: "Mó Limpezas",
    description: "Gestão de equipas de limpeza",
    start_url: "/app",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#16A34A",
    orientation: "portrait",
    categories: ["business", "productivity"],
    icons: [
      {
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
