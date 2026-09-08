import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-08-financeiro-mes-fechado",
  publishedAt: "2026-09-08T12:00:00.000Z",
  kind: "correcao",
  title: "Um mês fechado deixa mesmo de aceitar lançamentos",
  message:
    "Pagamentos, caixa, faturas, conciliação e recebimentos passaram a confirmar se o mês está " +
    "aberto no instante em que gravam. Antes, fechar o mês com um formulário aberto ainda deixava " +
    "o lançamento entrar. Agora aparece um aviso e nada é gravado. Um recebimento e o movimento " +
    "de caixa passam a nascer juntos: não fica um sem o outro, nem repetido se carregar duas vezes.",
};
