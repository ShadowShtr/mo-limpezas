import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getFinanceLedger } from "@/app/actions/finance-ledger";
import { getExpenseCategoryCatalog } from "@/app/actions/expense-categories";
import { FinanceShell } from "@/components/financeiro/finance-shell";
import { parseFinancePeriod } from "@/lib/finance-period";
import { UnifiedPaymentsClient } from "./_components/unified-payments-client";

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

  // 🔴 UMA só resolução de identidade.
  //
  //    `getFinanceLedger` já passa por `requireProfile` e devolve, na mesma
  //    resposta, as linhas e a empresa que o guard apurou. Não há segundo
  //    lookup a `profiles` aqui — a versão anterior desta página fazia
  //    `.eq("id", user.id)`, o que assumia `profiles.id = auth.users.id`.
  //    Essa igualdade é verdade em produção hoje, mas o esquema não a garante:
  //    existem pessoas sem login, e um `auth_user_id` diferente do `id` é
  //    possível. Uma vista nova não deve nascer com essa suposição lá dentro.
  const res = await getFinanceLedger(period.year, period.month);

  // O catálogo é opcional: se não estiver disponível, o campo aparece vazio e
  // "sem categoria" continua a ser uma escolha válida. Uma falha aqui não pode
  // impedir alguém de registar um pagamento.
  const catalogo = await getExpenseCategoryCatalog();
  const categorias = catalogo.ok && catalogo.catalog.available
    ? catalogo.catalog.categories.map((c) => ({ id: c.id, name: c.name }))
    : [];

  // ═══════════════════════════════════════════════════════════════════════
  // 🔴 LEDGER_AUTHORITATIVE_READ_FAILED → FINANCIAL_WRITES = DISABLED
  // ═══════════════════════════════════════════════════════════════════════
  //
  //    Lista vazia e erro de leitura são estados DIFERENTES:
  //
  //        rows = []      → «não há movimentos neste mês»
  //        ok = false     → «não sabemos que movimentos existem»
  //
  //    Montar a vista mutável com `rows={[]}` colapsa os dois no primeiro, e
  //    é a versão perigosa: alguém veria um mês aparentemente vazio e criaria
  //    de novo um pagamento que já lá está, ou marcaria como pago algo cujo
  //    estado real ninguém leu. A duplicação nasceria da própria UI.
  //
  //    Por isso a superfície de escrita não é montada de todo — nem com
  //    `companyId` vazio, que seria um cliente mutável com identidade falsa.
  //    O período e a navegação continuam a funcionar: recarregar é seguro.
  if (!res.ok) {
    return (
      <FinanceShell
        period={period}
        title="Pagamentos"
        subtitle="Obrigações e movimentos de caixa, sem duplicar o mesmo pagamento"
      >
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900"
        >
          <p className="font-semibold">Não foi possível carregar os pagamentos deste mês.</p>
          <p className="mt-1.5">{res.error}</p>
          <p className="mt-3 text-amber-800">
            Por segurança, criar e alterar registos está indisponível até a lista
            carregar — assim não se corre o risco de duplicar um pagamento que já
            exista. Tente recarregar a página ou escolher outro mês.
          </p>
        </div>
      </FinanceShell>
    );
  }

  return (
    <FinanceShell
      period={period}
      title="Pagamentos"
      subtitle="Obrigações e movimentos de caixa, sem duplicar o mesmo pagamento"
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
      <UnifiedPaymentsClient
        key={period.key}
        categories={categorias}
        rows={res.rows}
        error={null}
        companyId={res.companyId}
        year={period.year}
        month={period.month}
      />
    </FinanceShell>
  );
}
