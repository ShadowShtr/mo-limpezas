import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-10-locais-mapa-a-vista",
  publishedAt: "2026-09-10T17:30:00.000Z",
  kind: "correcao",
  title: "Mapas: já mostram as ruas e vão para a morada",
  message:
    "Os mapas estavam a aparecer com um aviso carimbado por cima e sem detalhe. Já está corrigido: " +
    "mostram nomes de rua e números de porta, tanto nos locais como no mapa do dia. Assim que " +
    "escreves a morada, o mapa vai sozinho para essa zona, e se o local ainda não tem ponto marcado " +
    "o mapa abre logo na ficha — é só tocar onde é a entrada.",
};
