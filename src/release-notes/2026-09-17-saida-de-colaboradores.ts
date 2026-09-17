import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-17-saida-de-colaboradores",
  publishedAt: "2026-09-17T10:00:00.000Z",
  kind: "novidade",
  title: "Colaboradores: dar saída sem perder o histórico",
  message:
    "O botão de eliminar deu lugar a «Dar saída», que começa por mostrar tudo o que está "
    + "ligado àquela pessoa. A saída faz-se por desativação: deixa de entrar de imediato, "
    + "mesmo com a aplicação aberta, e sai das equipas, escalas e folha — mas tudo o que fez "
    + "continua lá, com o nome de quem o fez. Quem estiver marcado como inativo ou suspenso "
    + "deixa de conseguir entrar. Eliminar de vez deixou de existir.",
};
