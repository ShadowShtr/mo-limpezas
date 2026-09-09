import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-09-folha-dias-extras",
  publishedAt: "2026-09-09T15:00:00.000Z",
  kind: "novidade",
  title: "Folha: dias extras, hora extra ao valor e adiantamentos",
  message:
    "A folha ganhou três campos que faltavam. Dias extras: marca quantos sábados ou feriados " +
    "foram trabalhados e quanto vale cada um. Hora extra: podes escrever o valor da hora em vez " +
    "de depender da percentagem. Adiantamento: campo próprio para descontar dinheiro já entregue, " +
    "separado dos outros descontos. Os campos a zero passam a aparecer vazios, para não ficar um " +
    "0 à frente do que escreves.",
};
