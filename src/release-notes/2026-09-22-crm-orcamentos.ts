import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-22-crm-orcamentos",
  // 🔴 Nunca uma hora no futuro: `releaseElegivel` usa `publishedAt` só como
  //    limite inferior face à criação do perfil, e não filtra o que ainda não
  //    aconteceu. Uma nota datada de logo à tarde apareceria na mesma agora.
  publishedAt: "2026-09-22T10:00:00.000Z",
  kind: "novidade",
  title: "CRM: orçamentos",
  message:
    "O CRM tem um terceiro separador, Orçamentos. Faça o orçamento a uma lead ou a um cliente, "
    + "com as linhas que quiser, desconto e IVA, e ligue-o à visita onde tirou as medidas. "
    + "Descarregue o PDF, envie-o e marque depois como enviado, aceite ou recusado. Se o preço "
    + "mudar depois de já ter saído, faça uma revisão: nasce um documento novo e o anterior "
    + "fica no histórico. As notas internas não saem no PDF.",
};
