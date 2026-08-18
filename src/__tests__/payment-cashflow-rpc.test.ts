// ============================================================================
// Pagamento → caixa: o contrato da RPC, e a ligação a ela
// ============================================================================
//
// As 071/072/073 foram aplicadas em 2026-08-14. Até aí, este ficheiro
// garantia que **nada** importava o módulo; agora garante o contrário — que
// `setPaymentStatus` o usa, e que mais ninguém escreve por fora dele.
//
// Três coisas provadas aqui:
//
//   1. o payload corresponde à assinatura da 073, nomes dos parâmetros
//      incluídos (o PostgREST casa argumentos **por nome**);
//   2. uma falha nunca é dada como sucesso, e a RPC em falta falha fechada;
//   3. a saída de caixa do pagamento tem **um só** sítio que a escreve.
//
// O ponto 3 é o que substitui o antigo «não está ligado»: a identidade de
// origem `(company, 'fixed_variable_payment', payment_id)` é o que torna a
// operação idempotente, e um segundo sítio a escrevê-la partiria essa
// garantia sem dar erro nenhum.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ERRO_PERIODO_FECHADO,
  RPC_DESMARCAR_PAGO,
  RPC_MARCAR_PAGO,
  construirArgumentosDesmarcarPago,
  construirArgumentosMarcarPago,
  desmarcarPagamentoPago,
  interpretarErro,
  interpretarRespostaDesmarcarPago,
  interpretarRespostaMarcarPago,
  marcarPagamentoPago,
  podeGerarMovimento,
  type ClienteRpc,
} from "@/lib/finance-rpc/payment-cashflow";

const RAIZ = process.cwd();
const EMPRESA = "11111111-1111-1111-1111-111111111111";
const PAGAMENTO = "22222222-2222-2222-2222-222222222222";
const MOVIMENTO = "33333333-3333-3333-3333-333333333333";

/** Um cliente que regista o que lhe pedem e devolve o que lhe mandarem. */
function clienteFalso(resposta: { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(resposta);
  return { cliente: { rpc } as unknown as ClienteRpc, rpc };
}

// ─── 1. O payload bate com o SQL ─────────────────────────────────────────────

describe("o payload corresponde à assinatura da 073", () => {
  const sql = fs.readFileSync(
    path.join(RAIZ, "supabase/migrations/073_payment_to_cashflow.sql"),
    "utf8",
  );

  it("🔴 os nomes das funções são os que estão no SQL", () => {
    // Não se inventa um alias. Um nome diferente falharia em runtime por uma
    // discrepância que ninguém iria procurar — a chamada parece bem escrita.
    expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${RPC_MARCAR_PAGO}\\b`));
    expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${RPC_DESMARCAR_PAGO}\\b`));
  });

  it("🔴 os nomes dos parâmetros são os que a função declara", () => {
    // O PostgREST casa argumentos **por nome**. Um `p_paid_date` em vez de
    // `p_paid_on` dá «could not find the function», que se leria como
    // "migration não aplicada" — e mandaria alguém investigar a base em vez
    // do código.
    const args = construirArgumentosMarcarPago({
      companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "2026-08-12",
    });
    expect(args.ok).toBe(true);
    if (!args.ok) return;

    const assinatura = sql.slice(
      sql.indexOf(`FUNCTION public.${RPC_MARCAR_PAGO}`),
      sql.indexOf("RETURNS TABLE (payment_id uuid, cash_entry_id uuid"),
    );
    for (const nome of Object.keys(args.args)) {
      expect(assinatura, `${nome} não existe na 073`).toContain(nome);
    }
    expect(Object.keys(args.args).sort()).toEqual(
      ["p_company_id", "p_paid_on", "p_payment_id"],
    );
  });

  it("os campos lidos da resposta são os que a função devolve", () => {
    expect(sql).toMatch(/RETURNS TABLE \(payment_id uuid, cash_entry_id uuid, ja_estava_pago boolean\)/);
    expect(sql).toMatch(/RETURNS TABLE \(payment_id uuid, movimentos_removidos int\)/);
  });

  it("o código do período fechado é o que a 073 levanta", () => {
    expect(sql).toContain(`RAISE EXCEPTION '${ERRO_PERIODO_FECHADO}'`);
  });

  it("a reversão só precisa de empresa e pagamento", () => {
    const args = construirArgumentosDesmarcarPago({ companyId: EMPRESA, paymentId: PAGAMENTO });
    expect(args.ok && Object.keys(args.args).sort()).toEqual(["p_company_id", "p_payment_id"]);
  });
});

// ─── 2. Argumentos ───────────────────────────────────────────────────────────

describe("argumentos inválidos não chegam a sair", () => {
  it.each([
    ["empresa não é uuid", { companyId: "empresa-1", paymentId: PAGAMENTO, paidOn: "2026-08-12" }],
    ["pagamento não é uuid", { companyId: EMPRESA, paymentId: "", paidOn: "2026-08-12" }],
    ["data vazia", { companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "" }],
    ["data com dia irreal", { companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "2026-02-30" }],
    // 🔴 O ano corrompido de Julho. Chegou a existir em contratos reais.
    ["ano corrompido", { companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "72026-01-01" }],
    ["data em formato PT", { companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "12/08/2026" }],
  ])("%s", (_, entrada) => {
    expect(construirArgumentosMarcarPago(entrada).ok).toBe(false);
  });

  it("uma data válida passa tal e qual, sem reformatação", () => {
    const r = construirArgumentosMarcarPago({
      companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "2026-08-12",
    });
    expect(r.ok && r.args.p_paid_on).toBe("2026-08-12");
  });

  it("🔴 argumentos inválidos não fazem nenhum pedido à base", async () => {
    const { cliente, rpc } = clienteFalso({ data: null, error: null });
    const r = await marcarPagamentoPago(cliente, {
      companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "72026-01-01",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toBe("argumentosInvalidos");
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ─── 3. Chamada ──────────────────────────────────────────────────────────────

describe("a chamada", () => {
  it("usa o nome e o payload certos", async () => {
    const { cliente, rpc } = clienteFalso({
      data: [{ payment_id: PAGAMENTO, cash_entry_id: MOVIMENTO, ja_estava_pago: false }],
      error: null,
    });
    const r = await marcarPagamentoPago(cliente, {
      companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "2026-08-12",
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("mark_payment_paid", {
      p_company_id: EMPRESA,
      p_payment_id: PAGAMENTO,
      p_paid_on: "2026-08-12",
    });
    expect(r).toEqual({ ok: true, jaEstavaPago: false, movimentoId: MOVIMENTO });
  });

  it("a repetição é reconhecida como repetição, não como erro", async () => {
    const { cliente } = clienteFalso({
      data: [{ payment_id: PAGAMENTO, cash_entry_id: MOVIMENTO, ja_estava_pago: true }],
      error: null,
    });
    const r = await marcarPagamentoPago(cliente, {
      companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "2026-08-12",
    });
    expect(r).toEqual({ ok: true, jaEstavaPago: true, movimentoId: MOVIMENTO });
  });

  it("aceita a resposta como objecto único e como linha de tabela", async () => {
    const linha = { payment_id: PAGAMENTO, cash_entry_id: MOVIMENTO, ja_estava_pago: false };
    for (const data of [linha, [linha]]) {
      expect(interpretarRespostaMarcarPago({ data, error: null })).toEqual({
        ok: true, jaEstavaPago: false, movimentoId: MOVIMENTO,
      });
    }
  });

  it("a reversão diz quantos movimentos removeu", async () => {
    const { cliente, rpc } = clienteFalso({
      data: [{ payment_id: PAGAMENTO, movimentos_removidos: 1 }], error: null,
    });
    const r = await desmarcarPagamentoPago(cliente, { companyId: EMPRESA, paymentId: PAGAMENTO });
    expect(rpc).toHaveBeenCalledWith("unmark_payment_paid", {
      p_company_id: EMPRESA, p_payment_id: PAGAMENTO,
    });
    expect(r).toEqual({ ok: true, movimentosRemovidos: 0 + 1 });
  });

  it("reverter o que já estava revertido é zero, não é erro", () => {
    expect(interpretarRespostaDesmarcarPago({
      data: [{ movimentos_removidos: 0 }], error: null,
    })).toEqual({ ok: true, movimentosRemovidos: 0 });
  });
});

// ─── 4. Falhar fechado ───────────────────────────────────────────────────────

describe("🔴 falha fechada — nunca há caminho antigo", () => {
  it.each([
    ["PGRST202", { message: "Could not find the function public.mark_payment_paid", code: "PGRST202" }],
    ["42883", { message: "function mark_payment_paid(uuid, uuid, date) does not exist", code: "42883" }],
    ["sem código", { message: "Could not find the function in the schema cache" }],
  ])("a função em falta é reconhecida (%s)", (_, erro) => {
    const r = interpretarErro(erro);
    expect(r.motivo).toBe("rpcEmFalta");
    expect(r.error).toContain("073");
  });

  it("🔴 a função em falta não devolve sucesso em circunstância nenhuma", async () => {
    const { cliente } = clienteFalso({
      data: null, error: { message: "Could not find the function", code: "PGRST202" },
    });
    const r = await marcarPagamentoPago(cliente, {
      companyId: EMPRESA, paymentId: PAGAMENTO, paidOn: "2026-08-12",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toBe("rpcEmFalta");
    // A mensagem tem de dizer que o pagamento **não** ficou alterado. Sem
    // isso, alguém repete a operação a achar que ficou meio feita.
    expect(!r.ok && r.error).toMatch(/não foi alterado/);
  });

  it("🔴 o módulo não conhece nenhum caminho alternativo", () => {
    // Guarda de intenção. Um `fallback`, um `catch` que escreve na tabela, ou
    // um "se não existir, faz o antigo" transformaria a falha em silêncio.
    const fonte = fs.readFileSync(
      path.join(RAIZ, "src/lib/finance-rpc/payment-cashflow.ts"), "utf8",
    ).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

    expect(fonte).not.toMatch(/\.from\(/);
    expect(fonte).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
    expect(fonte).not.toMatch(/fallback/i);
  });

  it("o período fechado tem mensagem própria, e não é confundido com erro genérico", () => {
    const r = interpretarErro({ message: `erro: ${ERRO_PERIODO_FECHADO}`, code: "P0002" });
    expect(r.motivo).toBe("periodoFechado");
    expect(r.error).toMatch(/fechado/i);
  });

  it("um erro qualquer da base fica como recusa, com a mensagem real", () => {
    const r = interpretarErro({ message: "new row violates row-level security policy", code: "42501" });
    expect(r.motivo).toBe("recusadoPelaBase");
    expect(r.error).toContain("row-level security");
  });

  it.each([
    ["resposta vazia", null],
    ["lista vazia", []],
    ["sem movimento", [{ payment_id: PAGAMENTO, ja_estava_pago: false }]],
    ["movimento nulo", [{ cash_entry_id: null, ja_estava_pago: false }]],
    ["sem ja_estava_pago", [{ cash_entry_id: MOVIMENTO }]],
  ])("🔴 %s não é sucesso", (_, data) => {
    const r = interpretarRespostaMarcarPago({ data, error: null });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toBe("respostaInesperada");
  });

  it("🔴 uma reversão sem contagem não é dada como feita", () => {
    for (const data of [null, [{}], [{ movimentos_removidos: -1 }], [{ movimentos_removidos: "1" }]]) {
      expect(interpretarRespostaDesmarcarPago({ data, error: null }).ok).toBe(false);
    }
  });
});

// ─── 5. Pré-voo ──────────────────────────────────────────────────────────────

describe("pré-voo do valor", () => {
  it.each([[null], [0], [-5]])("%s não pode gerar movimento", (amount) => {
    expect(podeGerarMovimento({ amount }).ok).toBe(false);
  });

  it("valores reais de cêntimos passam", () => {
    for (const amount of [0.29, 10.12, 19.99, 1.1, 49.9, 2563.51]) {
      expect(podeGerarMovimento({ amount }), `${amount}`).toEqual({ ok: true });
    }
  });
});

// ─── 6. 🔴 Ligado, e sem caminho antigo por baixo ────────────────────────────
//
// Estes testes eram o inverso: garantiam que **nada** importava este módulo,
// enquanto as 071/072/073 não estivessem aplicadas. Estão aplicadas desde
// 2026-08-14, e o que era preciso provar mudou de lado.
//
// O que **não** mudou é o que se está a defender: uma escrita financeira ou é
// atómica ou não é. O que antes se garantia pela ausência, garante-se agora
// pela forma da chamada.

describe("🔴 setPaymentStatus usa a RPC, e só a RPC", () => {
  const fonte = fs.readFileSync(path.join(RAIZ, "src/app/actions/payments.ts"), "utf8");
  const corpo = fonte.slice(
    fonte.indexOf("export async function setPaymentStatus"),
    fonte.indexOf("export async function deletePayment"),
  );

  it("marcar como pago chama mark_payment_paid", () => {
    expect(fonte).toMatch(/from "@\/lib\/finance-rpc\/payment-cashflow"/);
    expect(corpo).toContain("marcarPagamentoPago(admin");
  });

  it("voltar a pendente chama unmark_payment_paid", () => {
    expect(corpo).toContain("desmarcarPagamentoPago(admin");
  });

  it("🔴 a action não escreve em cash_flow_entries", () => {
    // A transacção é da 073. Um insert daqui — ainda que «só para garantir» —
    // criaria um segundo caminho para o mesmo movimento, e os dois divergiriam
    // à primeira alteração de um deles.
    const semComentarios = corpo.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(semComentarios).not.toContain("cash_flow_entries");
    expect(semComentarios).not.toMatch(/\.insert\(/);
  });

  it("🔴 nem escreve `paid_at` por fora da RPC", () => {
    // Era o que fazia antes. Se ficasse, o estado do pagamento passava a ter
    // duas origens: a RPC e esta linha.
    const semComentarios = corpo.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(semComentarios).not.toContain("paid_at");
  });

  it("a data do movimento é hoje em Lisboa, não em UTC", () => {
    // O processo corre em UTC na Vercel: `new Date()` na primeira hora do dia
    // dava o dia anterior, e o movimento caía no mês errado no dia 1.
    //
    // ⚠️ A asserção verifica a **origem** da data, não a escrita exacta. Desde
    //    a guarda de período financeiro (2026-08-17) o valor é calculado uma vez
    //    (`const hoje = todayInLisbon()`) e reutilizado nas duas chamadas — a
    //    guarda e a RPC têm de concordar sobre que dia é hoje. Uma asserção
    //    sobre a literal `paidOn: todayInLisbon()` falhava por causa da
    //    variável, sem que o invariante tivesse mudado.
    const semComentarios = corpo.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

    // A data vem de `todayInLisbon()`, e vai para `paidOn`.
    expect(semComentarios).toMatch(/todayInLisbon\(\)/);
    expect(semComentarios).toMatch(/paidOn:\s*(hoje|todayInLisbon\(\))/);

    // E o que não pode aparecer: a data do movimento derivada do relógio UTC.
    expect(semComentarios).not.toMatch(/paidOn:\s*new Date\(/);
  });

  it("🔴 um erro da RPC chega ao utilizador, e nada é dado como feito", () => {
    expect(corpo).toMatch(/if \(!r\.ok\) return \{ ok: false, error: r\.error \}/);
  });

  it("revalida as vistas onde o movimento novo aparece", () => {
    // Sem as Contas e o Fluxo de Caixa, a saída de caixa só aparecia depois de
    // uma navegação completa — e quem marcou o pagamento concluiria que não
    // tinha resultado.
    for (const rota of [
      "/dashboard/financeiro/pagamentos", "/dashboard/financeiro",
      "/dashboard/financeiro/contas", "/dashboard/financeiro/fluxo-caixa",
    ]) {
      expect(fonte).toContain(`revalidatePath("${rota}")`);
    }
  });

  it("cancelar não mexe no caixa por omissão", () => {
    // Um cancelamento depois de pago teria de decidir o que fazer ao
    // movimento. Essa decisão não se toma por omissão, num `else`.
    expect(corpo).toMatch(/status === "pago"/);
    expect(corpo).toMatch(/status === "pendente"/);
  });
});

describe("🔴 nenhuma outra superfície cria a saída de caixa do pagamento", () => {
  function varrer(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("só a 073 escreve um movimento com origem `fixed_variable_payment`", () => {
    // O guarda que substitui o «não está ligado»: a identidade de origem é o
    // que torna a operação idempotente, e um segundo sítio a escrevê-la
    // partiria essa garantia sem dar erro nenhum.
    // 🔴 O que se procura é a identidade usada como ORIGEM DE MOVIMENTO DE
    //    CAIXA — `reference_type`/`origem` em `cash_flow_entries`. Desde a 074
    //    a mesma string é também o `parent_type` de um anexo
    //    (`src/lib/attachments.ts`), num contexto que não toca em caixa: esses
    //    ficheiros não são superfícies de escrita de movimento, e incluí-los
    //    aqui seria um falso positivo que acabaria por ser silenciado.
    const CONTEXTO_CAIXA = /(reference_type|origem|source)\s*[:=]\s*["']fixed_variable_payment["']/;

    const culpados = varrer(path.join(RAIZ, "src"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => {
        const codigo = fs.readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
        const mencao = codigo.includes("fixed_variable_payment'")
          || codigo.includes('"fixed_variable_payment"');
        if (!mencao) return false;
        // Menção fora de contexto de caixa (ex.: parent_type de anexo) não conta.
        return CONTEXTO_CAIXA.test(codigo);
      })
      .map((f) => path.relative(RAIZ, f).split(path.sep).join("/"));

    expect(culpados).toEqual([]);
  });
});
