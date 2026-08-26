import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPayments } from "@/app/actions/payments";
import { getExpenseCategoryCatalog } from "@/app/actions/expense-categories";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { PaymentsClient } from "./_components/payments-client";

export const metadata = { title: "Pagamentos — Escala" };

export default async function PagamentosPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const params = await searchParams;

  // Esta vista participa no período do módulo, como as outras seis.
  //
  // Esteve isolada, e com razão: `getPayments` chamava `ensureMonth`, e um
  // seletor de período teria transformado "mudar de mês" em "gerar esse mês".
  // A PR C tirou a escrita do caminho de leitura — abrir Setembro passou a ser
  // apenas ler Setembro, e Setembro vazio mostra-se vazio.
  const period = parseFinancePeriod(params.mes);

  const res = await getPayments(period.year, period.month);

  // O catálogo é opcional: se não estiver disponível, o campo aparece vazio e
  // "sem categoria" continua a ser uma escolha válida. Uma falha aqui não pode
  // impedir alguém de registar um pagamento.
  const catalogo = await getExpenseCategoryCatalog();
  const categorias = catalogo.ok && catalogo.catalog.available
    ? catalogo.catalog.categories.map((c) => ({ id: c.id, name: c.name }))
    : [];

  return (
    <FinanceShell
      period={period}
      title="Pagamentos"
      subtitle="Fixos e variáveis, com estado de pagamento"
    >
      {/*
        🔴 A identidade da vista é o período, não a rota.

        Sem `key`, mudar de mês muda os props mas o React reutiliza a MESMA
        instância — e `useState(initialData)` só lê o valor na montagem. O
        servidor entregava Julho e o ecrã continuava a mostrar Agosto. Era
        este o defeito reportado: «seleciono outro mês e continuam a aparecer
        os meses anteriores».

        Mudar de mês é mudar de contexto, e por isso a instância é recriada:
        o estado transitório do mês anterior — sheet aberto, seleção,
        paginação, rascunho por submeter — é descartado de propósito. Manter
        um formulário de Agosto vivo por baixo de um ecrã de Julho seria pior
        do que o perder.

        A `key` traz só o que define o snapshot do servidor. `search`, `tab` e
        `categoria` pertencem à mesma vista mensal e não entram aqui — se
        entrassem, escrever na pesquisa remontaria a vista a cada tecla.
      */}
      <PaymentsClient
        key={period.key}
        categorias={categorias}
        initialData={res.ok ? res.data : null}
        error={res.ok ? null : res.error}
        year={period.year}
        month={period.month}
      />
    </FinanceShell>
  );
}
