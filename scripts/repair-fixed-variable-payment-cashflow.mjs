#!/usr/bin/env node
// ============================================================================
// REPAIR — movimentos de caixa em falta de pagamentos históricos
// ============================================================================
// Entre a migration 049 e a 073 havia uma incompatibilidade: a RPC escrevia
// `reference_type = 'fixed_variable_payment'` e o CHECK não o permitia. Quem
// marcava um pagamento como pago via a transacção inteira ser revertida — o
// pagamento ficava pendente e nenhum movimento nascia.
//
// A 075 corrigiu o CHECK, e desde então marcar como pago funciona. Mas os
// pagamentos que ficaram `pago` **antes** disso continuam sem o movimento de
// caixa correspondente. Este script cria esse movimento em falta.
//
// 🔴 O QUE ESTE SCRIPT NUNCA FAZ
//
//   · Não descobre candidatos sozinho. A lista é fechada, embutida abaixo, e
//     veio de uma análise read-only revista à mão. Um script que procura o que
//     reparar no momento de escrever pode encontrar coisas diferentes das que
//     alguém aprovou.
//
//   · Não altera o pagamento. `status`, `paid_at`, `amount` e `description`
//     ficam como estão — são história real. Só o efeito de caixa em falta é
//     acrescentado.
//
//   · Não chama `mark_payment_paid`. Essa RPC recebe uma data externa e aplica
//     lógica pensada para a mutação de hoje; aqui preserva-se o `paid_at` real
//     já gravado.
//
//   · Não escreve nada sem `--apply`. O modo por omissão é DRY-RUN.
//
// Uso:
//   node scripts/repair-fixed-variable-payment-cashflow.mjs            (dry-run)
//   node scripts/repair-fixed-variable-payment-cashflow.mjs --apply
//
// Precisa de SUPABASE_DB_URL ou DATABASE_URL (ligação Postgres directa).
// ============================================================================

import pg from "pg";

// ── A lista fechada ─────────────────────────────────────────────────────────
//
// 21 pagamentos, € 4.477,36. Classificados `STRONG_REPAIR_CANDIDATE` na
// análise de 2026-08-20 contra produção:
//
//   · `status = 'pago'` e `paid_at` preenchido;
//   · sem movimento de caixa com origem neste pagamento;
//   · período financeiro aberto;
//   · **nenhum lançamento manual do mesmo valor na empresa, em data nenhuma** —
//     verificado sem janela temporal, que é o teste mais forte para esta classe
//     de risco.
//
// Ficaram deliberadamente de fora:
//   · 18 com possível duplicado manual (€ 3.529,32) — revisão humana;
//   · 14 sem `paid_at` (€ 3.245,03) — inventar a data seria inventar o facto;
//   ·  4 já ligados (€ 322,41).
//
// Os totais foram conferidos: 21 + 18 + 14 + 4 = 57 pagamentos `pago`.

export const LISTA_FECHADA = [
  { id: "85b08a90-237f-48ed-a23c-ce7146bcfbd5", descricao: "MEO barbie",                    valor: "125.81", data: "2026-06-24" },
  { id: "62394e84-7272-4ed0-b7cd-47d10d0c0252", descricao: "MEO LOJA",                      valor: "77.02",  data: "2026-06-24" },
  { id: "da7fe4bc-950e-43ed-8128-52e32f961db0", descricao: "RENDA ATL",                     valor: "550.00", data: "2026-06-24" },
  { id: "ee94d666-b687-4f9b-b5aa-aa5d841d78f4", descricao: "RENDA MONICA",                  valor: "800.00", data: "2026-06-24" },
  { id: "c431d1cd-aa4f-43e8-a7a7-feaa2e85de9d", descricao: "ENDESA ATL",                    valor: "42.87",  data: "2026-06-25" },
  { id: "c965abca-609f-4521-be86-509d2e974fe4", descricao: "Endesa - garagem 1",            valor: "9.90",   data: "2026-07-09" },
  { id: "5ed3c298-ee11-4c66-ac92-e22a6b0bba23", descricao: "Endesa - garagem 2",            valor: "9.46",   data: "2026-07-09" },
  { id: "4565660f-be79-4610-80b1-00598263b296", descricao: "Seguro Tranquilidade - Passat", valor: "148.28", data: "2026-07-13" },
  { id: "29dd5789-b51a-4ff0-b8bb-0896466c18e6", descricao: "Endesa - Escritorio",           valor: "20.24",  data: "2026-07-14" },
  { id: "71809a47-417c-4f5d-87f3-90cc05380038", descricao: "Endesa ATL",                    valor: "41.05",  data: "2026-07-15" },
  { id: "888f3f93-7423-488c-a929-180ed05d13d6", descricao: "Meo",                           valor: "129.79", data: "2026-07-15" },
  { id: "511227b2-a9b1-44ba-8bb4-772ab2ede58a", descricao: "RENDA MONICA",                  valor: "632.00", data: "2026-07-20" },
  { id: "8c738d44-ac46-4f75-839b-d5ce7415a12f", descricao: "Meo - escritorio",              valor: "77.02",  data: "2026-07-22" },
  { id: "d63760d1-704a-42ce-84af-b0f39c3deb19", descricao: "RENDA ATL",                     valor: "550.00", data: "2026-07-22" },
  { id: "8930a592-ab1a-492a-a4ec-c11f15b6f747", descricao: "aguas de alenquer",             valor: "30.54",  data: "2026-07-27" },
  { id: "06c5248d-650c-4081-85be-31702612609d", descricao: "Charib - parceria Junho",       valor: "200.64", data: "2026-07-27" },
  { id: "7dd1c843-f858-40cc-bf7d-76920b094c18", descricao: "IUC",                           valor: "39.95",  data: "2026-07-27" },
  { id: "03cf8ce5-c9be-4797-9f5b-9d4f7d9e285f", descricao: "Seguro Generalli - Berlingo",   valor: "93.07",  data: "2026-07-27" },
  { id: "f376c0e7-48cb-4f30-bc56-c1a0635b70a7", descricao: "Endesa - loja",                 valor: "20.49",  data: "2026-08-11" },
  { id: "fa2778c9-3eca-4ff9-93fc-114a9b5c78ca", descricao: "RENDA ATL",                     valor: "550.00", data: "2026-08-11" },
  { id: "09ffe734-b28f-4250-a229-32e2a73ee658", descricao: "Parceria - Charib - Julho",     valor: "329.23", data: "2026-08-12" },
];

export const TOTAL_ESPERADO = "4477.36";

/** Somatório exacto em cêntimos — floats não contam dinheiro. */
export function somaCentimos(lista) {
  return lista.reduce((acc, l) => acc + Math.round(parseFloat(l.valor) * 100), 0);
}

/**
 * Revalidação de UMA linha, com o pagamento trancado.
 *
 * 🔴 A análise foi feita antes. Entre ela e a execução alguém pode ter marcado
 *    o pagamento como pendente, alterado o valor, ou lançado a despesa à mão.
 *    Confiar no snapshot seria escrever sobre um estado que já não existe.
 */
async function revalidar(client, linha) {
  const { rows } = await client.query(
    `SELECT id, company_id, description, amount::text AS amount, status,
            paid_at, expense_category_id, period_year, period_month,
            (paid_at AT TIME ZONE 'Europe/Lisbon')::date::text AS cashflow_date
       FROM public.fixed_variable_payments
      WHERE id = $1
      FOR UPDATE`,
    [linha.id],
  );

  if (rows.length === 0) return { ok: false, motivo: "pagamento inexistente" };
  const p = rows[0];

  if (p.status !== "pago") return { ok: false, motivo: `status mudou para "${p.status}"` };
  if (!p.paid_at) return { ok: false, motivo: "paid_at foi apagado" };
  if (p.amount !== linha.valor) {
    return { ok: false, motivo: `valor mudou: ${linha.valor} → ${p.amount}` };
  }
  if (p.cashflow_date !== linha.data) {
    return { ok: false, motivo: `data mudou: ${linha.data} → ${p.cashflow_date}` };
  }

  // Já ligado — pode ter sido reparado entretanto, ou marcado pela UI.
  const { rows: ligado } = await client.query(
    `SELECT id FROM public.cash_flow_entries
      WHERE company_id = $1 AND reference_type = 'fixed_variable_payment'
        AND reference_id = $2`,
    [p.company_id, p.id],
  );
  if (ligado.length > 0) return { ok: false, motivo: "já tem movimento de origem" };

  // Anti-duplicação, outra vez. O gate correu na análise, mas alguém pode ter
  // lançado a despesa à mão desde então — e é isso que este script existe para
  // não duplicar.
  const { rows: manuais } = await client.query(
    `SELECT id, date::text, description FROM public.cash_flow_entries
      WHERE company_id = $1 AND type = 'saida' AND amount = $2::numeric
        AND reference_type IS NULL`,
    [p.company_id, linha.valor],
  );
  if (manuais.length > 0) {
    return { ok: false, motivo: `apareceu movimento manual do mesmo valor (${manuais[0].id})` };
  }

  // O período tem de continuar aberto.
  const { rows: fechado } = await client.query(
    `SELECT 1 FROM public.financial_periods
      WHERE company_id = $1 AND year = $2 AND month = $3 AND status = 'closed'`,
    [p.company_id, p.period_year, p.period_month],
  );
  if (fechado.length > 0) return { ok: false, motivo: "período financeiro fechado" };

  return { ok: true, pagamento: p };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

  if (!url) {
    console.error("❌ Falta SUPABASE_DB_URL (ou DATABASE_URL).");
    process.exit(1);
  }

  // Verificação de integridade da própria lista, antes de tocar na base.
  const total = somaCentimos(LISTA_FECHADA);
  const esperado = Math.round(parseFloat(TOTAL_ESPERADO) * 100);
  if (total !== esperado) {
    console.error(`❌ A lista soma ${(total / 100).toFixed(2)} €, esperado ${TOTAL_ESPERADO} €.`);
    console.error("   A lista foi alterada sem actualizar o total. Abortado.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  console.log(`\n${apply ? "🔴 APLICAR" : "🔍 DRY-RUN"} — ${LISTA_FECHADA.length} pagamentos, ${TOTAL_ESPERADO} €\n`);

  try {
    await client.query("BEGIN");

    const aInserir = [];
    const recusados = [];

    // 🔴 Validar a lista INTEIRA antes de inserir seja o que for. Trinta
    //    inseridos e sete falhados é o estado que não queremos.
    for (const linha of LISTA_FECHADA) {
      const r = await revalidar(client, linha);
      if (r.ok) aInserir.push({ linha, pagamento: r.pagamento });
      else recusados.push({ linha, motivo: r.motivo });
    }

    for (const { linha, motivo } of recusados) {
      console.log(`  ⨯ ${linha.descricao.padEnd(32)} ${linha.valor.padStart(8)} €  — ${motivo}`);
    }
    for (const { linha } of aInserir) {
      console.log(`  ✓ ${linha.descricao.padEnd(32)} ${linha.valor.padStart(8)} €  ${linha.data}`);
    }

    console.log(`\n  a inserir: ${aInserir.length}   recusados: ${recusados.length}`);

    if (recusados.length > 0) {
      // ALL_OR_NOTHING: uma linha que mudou desde a análise invalida o lote.
      // Rever a lista é mais barato do que descobrir depois que metade entrou.
      console.error("\n❌ Há linhas recusadas — nada foi escrito. Rever a lista e repetir a análise.");
      await client.query("ROLLBACK");
      process.exit(1);
    }

    if (!apply) {
      console.log("\n🔍 DRY-RUN — nada foi escrito. Usar --apply para executar.");
      await client.query("ROLLBACK");
      await client.end();
      return;
    }

    const criados = [];
    for (const { linha, pagamento } of aInserir) {
      const { rows } = await client.query(
        `INSERT INTO public.cash_flow_entries
           (company_id, type, amount, description, category, date,
            reference_type, reference_id, status, expense_category_id)
         VALUES ($1, 'saida', $2::numeric, $3, 'despesa', $4::date,
                 'fixed_variable_payment', $5, 'confirmado', $6)
         RETURNING id`,
        [pagamento.company_id, linha.valor, pagamento.description,
         linha.data, pagamento.id, pagamento.expense_category_id],
      );
      criados.push(rows[0].id);
    }

    // Verificação antes do COMMIT: se o número não bater, nada entra.
    if (criados.length !== aInserir.length) {
      console.error(`\n❌ Esperado ${aInserir.length} movimentos, criados ${criados.length}.`);
      await client.query("ROLLBACK");
      process.exit(1);
    }

    await client.query("COMMIT");

    console.log(`\n✅ ${criados.length} movimentos criados.\n`);
    console.log("Guardar para rollback — os ids exactos criados por esta execução:\n");
    console.log(`DELETE FROM public.cash_flow_entries WHERE id IN (\n  ${
      criados.map((id) => `'${id}'`).join(",\n  ")
    }\n);`);
    console.log("\n🔴 O rollback é por ID, nunca por valor/data/descrição — apagar");
    console.log("   por semelhança levaria à frente lançamentos manuais.\n");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n❌ ${e.message}\n   Nada foi escrito.`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("repair-fixed-variable-payment-cashflow.mjs")) {
  main();
}
