import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-18-colaboradores-sem-eliminar",
  publishedAt: "2026-09-18T15:00:00.000Z",
  kind: "correcao",
  title: "Colaboradores: já não é possível eliminar uma pessoa",
  message:
    "O botão de eliminar saiu da lista de colaboradores. Apagar uma pessoa apagava — ou "
    + "deixava sem nome — o que ela tinha feito: serviços, faturas, folha, pontos. E quando "
    + "a eliminação falhava a meio, parte desse histórico já tinha ficado sem autor, sem "
    + "ninguém dar por isso. Para dar saída a alguém, retire o acesso na ficha dela: deixa "
    + "de entrar e tudo o que fez continua no sistema.",
};
