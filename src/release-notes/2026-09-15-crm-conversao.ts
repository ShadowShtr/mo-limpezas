import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-15-crm-conversao",
  publishedAt: "2026-09-15T18:00:00.000Z",
  kind: "novidade",
  title: "Do orçamento aceite a cliente, sem escrever tudo de novo",
  message:
    "Quando marca um orçamento como aceite, aparece o botão Converter em cliente: cria o "
    + "cliente e o local com os dados que já tinha na lead e abre o formulário do trabalho "
    + "com os valores do orçamento preenchidos. Nada fica agendado até confirmar. Se "
    + "carregar duas vezes, o cliente não é criado em duplicado.",
};
