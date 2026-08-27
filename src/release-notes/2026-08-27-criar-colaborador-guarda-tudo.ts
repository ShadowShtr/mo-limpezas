// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: mudá-la faz o aviso
// reaparecer a quem já o confirmou. Reescrever o texto muda aquilo que alguém
// disse ter lido.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-27-criar-colaborador-guarda-tudo",
  publishedAt: "2026-08-27T12:30:00.000Z",
  kind: "correcao",
  title: "Criar colaborador funciona, e guarda o que preencher",
  message:
    "Guardar um colaborador novo dava erro e não criava ninguém. Já está " +
    "corrigido. Além disso, o NIF, o IBAN, o valor à hora e as datas de " +
    "contrato passam a ficar mesmo guardados — antes eram pedidos no " +
    "formulário e perdiam-se ao gravar. Continua a bastar o nome: o que " +
    "deixar em branco fica por preencher, e pode ser completado depois na " +
    "ficha da pessoa.",
};
