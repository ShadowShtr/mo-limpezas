import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-17-saida-de-colaboradores",
  publishedAt: "2026-09-17T10:00:00.000Z",
  kind: "novidade",
  title: "Colaboradores: dar saída sem perder o histórico",
  message:
    "O botão de eliminar deu lugar a «Dar saída», que começa por mostrar tudo o que está "
    + "ligado àquela pessoa. Quem tem histórico passa a ser desativada: deixa de entrar e sai "
    + "das equipas, escalas e folha, mas tudo o que fez continua lá, com o nome de quem o fez. "
    + "Eliminar de vez só aparece para quem não tem mesmo nenhum registo — até aqui, podia "
    + "deixar serviços e faturas sem se saber quem os fizera.",
};
