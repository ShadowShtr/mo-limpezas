import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Header } from "@/components/layout/header";
import { ContratosTable } from "./_components/table";
import { ContratoSheet } from "./_components/sheet";
import { Plus } from "lucide-react";
import { CONTRATO_SHEET_SELECT, type ContratosTableRow } from "@/lib/contrato-sheet-fields";
import type { ContratoPrefill } from "./_components/sheet";

export type { ContratosTableRow };

/**
 * `?novo=1&clienteId=&localId=&orcamentoId=` — de onde vem, e porquê pelo URL
 *
 * É por aqui que a conversão de uma lead do CRM aterra: cria o cliente e o
 * local, e manda o gestor para este formulário já preenchido com os valores do
 * orçamento aceite.
 *
 * 🔴 Chegar aqui NÃO grava nada. O formulário abre com os campos postos e quem
 *    carrega em «Criar contrato» é uma pessoa, depois de rever — foi decisão
 *    explícita do dono que nada entra no calendário sozinho.
 *
 * Pelo URL, e não por estado em memória, pela mesma razão que a aba `?predio=`
 * dos Clientes: o link sobrevive a um refresh e pode ser partilhado. Um
 * `orcamentoId` que não exista é ignorado em silêncio — o formulário abre na
 * mesma, sem valores. Um id velho num favorito não deve dar erro a quem clica.
 */
export default async function ContratosPage({
  searchParams,
}: {
  searchParams: Promise<{ novo?: string; clienteId?: string; localId?: string; orcamentoId?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();

  const { data: me } = await admin
    .from("profiles")
    .select("company_id")
    .eq("id", user!.id)
    .single();

  const companyId = me?.company_id ?? "";

  const [{ data: contratos }, { data: clientes }, { data: locais }, { data: equipas }, { data: settings }] =
    await Promise.all([
      supabase
        .from("contracts")
        .select(CONTRATO_SHEET_SELECT)
        .eq("company_id", companyId)
        .order("created_at", { ascending: false }),
      supabase
        .from("clients")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("status", "ativo")
        .order("name"),
      supabase
        .from("locations")
        .select("id, client_id, name, address, lat, lng, hourly_rate, access_code, instructions, has_key, key_label")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name"),
      supabase
        .from("teams_with_members")
        .select("id, name, color, members")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name"),
      admin
        .from("company_settings")
        .select("vat_rate")
        .eq("company_id", companyId)
        .single(),
    ]);

  const vatRate = settings?.vat_rate ?? 23;

  // ── Pré-preenchimento vindo de um orçamento aceite ────────────────────────
  //
  // Lido com o admin client e filtrado pela empresa da sessão, como tudo o
  // resto: o id vem do URL, e um URL é controlável por quem o escreve.
  let prefill: ContratoPrefill | undefined;

  if (params.novo === "1" && params.clienteId && params.localId) {
    prefill = { clienteId: params.clienteId, localId: params.localId };

    if (params.orcamentoId) {
      const { data: orcamento } = await admin
        .from("crm_quotes")
        .select("quote_number, pricing_kind, subtotal, discount_pct, apply_vat, total, vat_amount, notes")
        .eq("company_id", companyId)
        .eq("id", params.orcamentoId)
        .maybeSingle();

      if (orcamento) {
        const q = orcamento as {
          quote_number: string; pricing_kind: string; subtotal: number;
          discount_pct: number; apply_vat: boolean; total: number; vat_amount: number;
          notes: string | null;
        };

        // O valor do contrato é a base SEM IVA (total menos imposto): é assim
        // que `fixed_price` é entendido no resto do sistema, e a chavinha do
        // IVA trata do resto. Somar o imposto aqui cobraria IVA duas vezes.
        const semIva = Number(q.total) - Number(q.vat_amount);

        prefill = {
          ...prefill,
          name: `${q.quote_number} — contrato`,
          billingMode: q.pricing_kind === "mensal" ? "monthly" : "hourly",
          fixedPrice: q.pricing_kind === "mensal" ? semIva : null,
          applyVat: q.apply_vat,
          notes: [q.notes, `Origem: orçamento ${q.quote_number}.`]
            .filter(Boolean)
            .join("\n\n"),
        };
      }
    }
  }

  const equipasComContagem = (equipas ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    member_count: Array.isArray(t.members) ? t.members.length : 0,
  }));

  return (
    <div>
      <Header
        title="Contratos"
        subtitle={`${contratos?.length ?? 0} contratos`}
        actions={
          <ContratoSheet
            companyId={companyId}
            userId={user!.id}
            clientes={clientes ?? []}
            locais={locais ?? []}
            equipas={equipasComContagem}
            vatRate={vatRate}
            prefill={prefill}
            defaultOpen={Boolean(prefill)}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <Plus className="w-4 h-4" />
                Novo contrato
              </button>
            }
          />
        }
      />
      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1400px]">
        <ContratosTable
          contratos={(contratos ?? []) as unknown as ContratosTableRow[]}
          companyId={companyId}
          userId={user!.id}
          clientes={clientes ?? []}
          locais={locais ?? []}
          equipas={equipasComContagem}
          vatRate={vatRate}
        />
      </div>
    </div>
  );
}

