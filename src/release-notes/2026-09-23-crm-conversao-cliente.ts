import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-23-crm-conversao-cliente",
  // 🔴 Nunca uma hora no futuro: `releaseElegivel` usa `publishedAt` só como
  //    limite inferior face à criação do perfil, e não filtra o que ainda não
  //    aconteceu.
  publishedAt: "2026-09-23T15:00:00.000Z",
  kind: "novidade",
  title: "CRM: converter um orçamento aceite em cliente",
  message:
    "Quando uma lead aceita o orçamento, pode agora convertê-la em cliente directamente no CRM. "
    + "Abra o orçamento aceite e carregue em «Converter em cliente»: fica criado o cliente e o "
    + "local com os dados da lead, a lead passa a ganha e abre-se logo a ficha do cliente. "
    + "O contrato continua a ser decisão sua — faça-o na ficha do cliente, em Intervenções.",
};
