import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-08-financeiro-mes-fechado",
  publishedAt: "2026-09-08T12:00:00.000Z",
  kind: "correcao",
  title: "Um mês fechado deixa mesmo de aceitar lançamentos",
  message:
    "Pagamentos, movimentos de caixa, faturas, conciliação bancária e recebimentos de serviços " +
    "passaram a confirmar se o mês está aberto no mesmo instante em que gravam. " +
    "Antes, se o mês fosse fechado enquanto alguém tinha um formulário aberto, o lançamento ainda " +
    "conseguia entrar num mês já fechado — e as contas do mês mudavam depois de fechadas. " +
    "Agora, nesse caso, aparece um aviso e nada é gravado. " +
    "Marcar um recebimento continua a criar o movimento de caixa correspondente, mas os dois " +
    "passam a nascer juntos: deixa de ser possível ficar com um sem o outro, ou com o movimento " +
    "repetido se carregar duas vezes.",
};
