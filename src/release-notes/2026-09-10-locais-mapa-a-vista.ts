import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-10-locais-mapa-a-vista",
  publishedAt: "2026-09-10T17:30:00.000Z",
  kind: "correcao",
  title: "Locais: o mapa já aparece sozinho",
  message:
    "O mapa para marcar o ponto do local estava escondido atrás de um link pequeno e era difícil " +
    "de encontrar. Agora, sempre que um local ainda não tem ponto marcado, o mapa aparece logo " +
    "aberto na ficha — é só tocar onde é a entrada. Quando o ponto já está marcado, o mapa recolhe " +
    "para a ficha não ficar comprida, e há sempre o botão 'Ver / corrigir pin' para voltar lá.",
};
