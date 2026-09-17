import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-17-saida-de-colaboradores",
  publishedAt: "2026-09-17T10:00:00.000Z",
  kind: "novidade",
  title: "Colaboradores: dar saída sem perder o histórico",
  message:
    "O botão de eliminar deu lugar a «Dar saída». Antes de decidir seja o que for, o ecrã "
    + "mostra tudo o que está ligado àquela pessoa — serviços, pontos, faltas, férias, folha, "
    + "pagamentos, documentos, tarefas e leads — e quantos registos são. Quem tem histórico "
    + "passa a ser desativada: deixa de entrar na aplicação e sai das equipas, escalas e folha, "
    + "mas tudo o que fez continua no sistema, com o nome de quem fez. Eliminar de vez só "
    + "aparece para quem não tem mesmo nenhum registo — um perfil criado por engano, por "
    + "exemplo. Até aqui, eliminar podia deixar serviços e faturas sem se saber quem os tinha "
    + "feito; isso deixou de ser possível.",
};
