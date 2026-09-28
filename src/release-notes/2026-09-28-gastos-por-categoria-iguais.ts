import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-28-gastos-por-categoria-iguais",
  publishedAt: "2026-09-28T00:05:00.000Z",
  kind: "correcao",
  title: "Gastos por categoria: o mesmo valor nos Pagamentos e no Resumo",
  message:
    "O gráfico por categoria dos Pagamentos, no modo «Caixa», e o do Resumo passam a dar o mesmo "
    + "valor para o mesmo mês: contam as saídas confirmadas e as registadas por confirmar, e dizem "
    + "quanto destas está incluído. Uma saída de um pagamento sem categoria aparece em «Sem "
    + "categoria» nos dois.",
};
