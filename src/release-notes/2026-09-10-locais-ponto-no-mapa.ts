import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-10-locais-ponto-no-mapa",
  publishedAt: "2026-09-10T12:00:00.000Z",
  kind: "novidade",
  title: "Locais: marcar o ponto certo no mapa",
  // 🔴 O guard limita a mensagem a 400 caracteres. Não é capricho: o aviso é
  //    lido num modal, e uma nota que ninguém acaba de ler não avisa nada.
  message:
    "Quando a morada de um local não aparece na pesquisa, já podes marcar o ponto à mão no mapa e " +
    "arrastar o pin até ao sítio certo — há também um botão para usar a tua localização. Assim a " +
    "equipa é levada ao ponto exato, e não só à morada escrita. Na lista de Locais vês quantos ainda " +
    "estão sem ponto marcado, com um toque para corrigires só esses.",
};
