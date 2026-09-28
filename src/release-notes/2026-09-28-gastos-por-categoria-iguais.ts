import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-28-gastos-por-categoria-iguais",
  publishedAt: "2026-09-28T10:05:00.000Z",
  kind: "correcao",
  title: "Gastos por categoria: o mesmo valor nos Pagamentos e no Resumo",
  message:
    "O gráfico de gastos por categoria dos Pagamentos, no modo «Caixa», e o gráfico de saídas por "
    + "categoria do Resumo passam a dar o mesmo valor para o mesmo mês. Os dois contam as saídas já "
    + "confirmadas e as registadas por confirmar, e dizem quanto destas está incluído. Uma saída de "
    + "um pagamento sem categoria aparece em «Sem categoria» nos dois, e uma categoria criada por si "
    + "já não se junta a uma antiga só por ter o mesmo nome.",
};
