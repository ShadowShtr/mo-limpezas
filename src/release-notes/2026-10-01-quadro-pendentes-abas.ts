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
  key: "2026-10-01-quadro-pendentes-abas",
  publishedAt: "2026-10-01T00:00:00.000Z",
  kind: "novidade",
  title: "Prazos e pendentes: mais áreas e 15 dias à frente",
  message:
    "O quadro do «!» passa a ter abas — Financeiro, Tarefas, Comercial e " +
    "Equipa — e mostra os próximos 15 dias, além dos atrasados dos últimos 15. " +
    "Entram também as cobranças por receber, as cobranças avulsas, os " +
    "movimentos de caixa por confirmar e os pedidos de férias por aprovar. " +
    "Se alguma área não puder ser verificada, o quadro avisa em vez de dizer " +
    "que está tudo em dia.",
};
