/**
 * DIAGNÓSTICO — pagamentos cuja competência não bate com o vencimento.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ SÓ RELATÓRIO. Só SELECT. Não escreve, não corrige, não repara.           │
 * │ Não existe flag que o faça escrever: não é uma opção desligada por       │
 * │ omissão, é uma capacidade que este ficheiro não tem.                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * O que procura
 * -------------
 * Linhas de `fixed_variable_payments` em que o vencimento é uma data civil
 * válida E `period_year`/`period_month` apontam para um mês diferente do mês
 * desse vencimento.
 *
 * É o resíduo histórico de quando a competência era decidida pelo MÊS ABERTO NO
 * ECRÃ em vez de o ser pelo vencimento. O código actual já não produz linhas
 * assim — `createPayment` deriva a competência e `update_payment_atomic` move-a
 * junto com o vencimento. O que ficou para trás, ficou.
 *
 * Linhas SEM vencimento não são divergência e não são contadas: não há de onde
 * derivar competência, o mês de registo é a única informação temporal que
 * existe, e isso é deliberado. Confundir «diverge» com «não tem como saber»
 * seria inventar um problema.
 *
 * Porque é que não corrige
 * ------------------------
 * Mover a competência de um pagamento muda o mês a que a despesa pertence, e há
 * meses financeiros fechados. Uma correcção em massa reescreveria contas já
 * dadas por encerradas sem ninguém decidir isso. O relatório existe para essa
 * decisão ser tomada por uma pessoa, com números à frente.
 *
 * Uso:
 *   npx tsx scripts/diagnose-payment-competence.ts
 *   npx tsx scripts/diagnose-payment-competence.ts --out relatorio.json
 *
 * Sai com 0 mesmo havendo divergências: isto informa, não reprova.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { competenceFromDueDate } from "../src/domain/finance/payment-competence";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

// 🔴 A recusa é explícita e vem ANTES de tudo. Quem escrever `--apply` por
//    hábito, vindo de outra ferramenta, tem de receber um não — e não um
//    silêncio que se parece com sucesso.
for (const flag of ["apply", "execute", "write", "commit", "force", "fix", "repair"]) {
  if (argv.includes(`--${flag}`)) {
    console.error(
      `--${flag} não existe nesta ferramenta. Isto só diagnostica.\n`
      + "Corrigir competências históricas altera meses já fechados e exige decisão "
      + "e autorização próprias.",
    );
    process.exit(2);
  }
}

function loadEnv(): void {
  for (const f of [".env.local", ".env"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

interface Linha {
  id: string;
  company_id: string;
  due_date: string | null;
  period_year: number;
  period_month: number;
}

const mes = (y: number, m: number): string => `${y}-${String(m).padStart(2, "0")}`;

async function main(): Promise<void> {
  const db = createClient(url!, key!, { auth: { persistSession: false } });

  // 🔴 Só as colunas precisas para a comparação. Descrição, valor e notas ficam
  //    de fora de propósito: identificam fornecedores e montantes, e um
  //    relatório de datas não precisa deles para provar o que quer provar. O
  //    `id` chega para ir ver a linha depois, se alguém decidir olhar.
  const linhas: Linha[] = [];
  const PAGINA = 1000;
  for (let inicio = 0; ; inicio += PAGINA) {
    const { data, error } = await db
      .from("fixed_variable_payments")
      .select("id, company_id, due_date, period_year, period_month")
      .order("id", { ascending: true })
      .range(inicio, inicio + PAGINA - 1);
    if (error) {
      console.error(`Falha na leitura: ${error.message}`);
      process.exit(1);
    }
    const lote = (data ?? []) as Linha[];
    linhas.push(...lote);
    if (lote.length < PAGINA) break;
  }

  let semVencimento = 0;
  let vencimentoIlegivel = 0;
  const divergentes: Array<{
    id: string;
    company_id: string;
    due_date: string;
    competencia_gravada: string;
    competencia_do_vencimento: string;
  }> = [];

  for (const linha of linhas) {
    if (!linha.due_date) { semVencimento += 1; continue; }
    const derivada = competenceFromDueDate(linha.due_date);
    // Uma data que nem o domínio consegue ler é outra categoria de problema —
    // contada à parte, para não se disfarçar de divergência de competência.
    if (!derivada) { vencimentoIlegivel += 1; continue; }
    if (derivada.year === linha.period_year && derivada.month === linha.period_month) continue;
    divergentes.push({
      id: linha.id,
      company_id: linha.company_id,
      due_date: linha.due_date,
      competencia_gravada: mes(linha.period_year, linha.period_month),
      competencia_do_vencimento: mes(derivada.year, derivada.month),
    });
  }

  const porEmpresa = new Map<string, number>();
  for (const d of divergentes) porEmpresa.set(d.company_id, (porEmpresa.get(d.company_id) ?? 0) + 1);

  const relatorio = {
    gerado_em: new Date().toISOString(),
    somente_leitura: true,
    total_pagamentos: linhas.length,
    sem_vencimento: semVencimento,
    vencimento_ilegivel: vencimentoIlegivel,
    divergentes_total: divergentes.length,
    divergentes_por_empresa: [...porEmpresa]
      .map(([company_id, total]) => ({ company_id, total }))
      .sort((a, b) => b.total - a.total),
    divergentes,
  };

  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : null;
  if (out) {
    writeFileSync(out, JSON.stringify(relatorio, null, 2), "utf8");
    console.log(`Relatório escrito em ${out}`);
  }

  console.log(`\nPagamentos lidos ............ ${relatorio.total_pagamentos}`);
  console.log(`Sem vencimento (normal) ..... ${relatorio.sem_vencimento}`);
  console.log(`Vencimento ilegível ......... ${relatorio.vencimento_ilegivel}`);
  console.log(`Competência divergente ...... ${relatorio.divergentes_total}`);
  for (const e of relatorio.divergentes_por_empresa) {
    console.log(`  empresa ${e.company_id}: ${e.total}`);
  }
  if (relatorio.divergentes_total > 0) {
    console.log("\nNada foi alterado. Corrigir isto mexe em meses possivelmente fechados");
    console.log("e é uma decisão separada, não uma consequência deste relatório.");
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
