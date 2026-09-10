import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-10-locais-mapa-a-vista",
  publishedAt: "2026-09-10T17:30:00.000Z",
  kind: "correcao",
  title: "Mapas: já mostram as ruas e vão para a morada",
  message:
    "O mapa dos locais estava a aparecer com um aviso por cima e sem detalhe. Já está corrigido: " +
    "agora mostra nomes de rua e números de porta. Assim que escreves a morada, o mapa vai sozinho " +
    "para essa zona, e se o local ainda não tem ponto marcado o mapa abre logo na ficha — é só tocar " +
    "onde é a entrada. Isto vale também para o mapa do dia, em Mapa.",
};
