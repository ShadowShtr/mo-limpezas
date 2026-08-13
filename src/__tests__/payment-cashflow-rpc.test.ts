// ============================================================================
// Contrato da RPC de pagamento → caixa — preparado, não ligado
// ============================================================================
//
// Estes testes provam duas coisas independentes:
//
//   1. o payload que sai daqui corresponde **exactamente** à assinatura da
//      073, incluindo os nomes dos parâmetros;
//   2. nenhuma action importa este módulo — a ligação continua por fazer, e
//      é isso que está combinado enquanto as migrations não estiverem
//      aplicadas.
//
// O ponto 2 é o que impede este ficheiro de se tornar uma ligação acidental.
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

// ─── 6. 🔴 Ainda não está ligado ─────────────────────────────────────────────

describe("🔴 preparado, não ligado", () => {
  function varrer(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  /** Resolve um especificador de import para um ficheiro do repositório. */
  function resolver(spec: string, deQual: string): string | null {
    const base = spec.startsWith("@/")
      ? path.join(RAIZ, "src", spec.slice(2))
      : spec.startsWith(".")
        ? path.resolve(path.dirname(deQual), spec)
        : null;
    if (!base) return null; // pacote externo
    for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  }

  it("🔴 nenhuma action ou componente lhe chega, nem por módulo intermédio", () => {
    // Enquanto as 071/072/073 não estiverem aplicadas, ligar isto faria a
    // aplicação chamar uma função que não existe. O teste falha no momento em
    // que alguém liga — que é quando se quer a conversa, não depois.
    //
    // 🔴 Segue os imports em cadeia, e a razão é experiência própria: a
    //    primeira versão só procurava o import **directo**, e uma ponte de
    //    uma linha (`export { x } from "@/lib/finance-rpc/payment-cashflow"`)
    //    num módulo qualquer atravessava-a sem falhar nada. É a mesma
    //    armadilha que o detector de escrita já apanhou em cheio — reconhecer
    //    só o caminho conhecido dá um seguro falso.
    const alvo = path.join(RAIZ, "src/lib/finance-rpc/payment-cashflow.ts");
    const entradas = [
      ...varrer(path.join(RAIZ, "src/app")),
      ...varrer(path.join(RAIZ, "src/components")),
    ];

    const visto = new Set<string>();
    /** ficheiro → quem o trouxe, para conseguir mostrar a cadeia. */
    const veioDe = new Map<string, string>();
    const fila = [...entradas];
    entradas.forEach((f) => visto.add(f));

    while (fila.length) {
      const atual = fila.shift()!;
      const fonte = fs.readFileSync(atual, "utf8");
      for (const m of fonte.matchAll(/from\s+["']([^"']+)["']/g)) {
        const destino = resolver(m[1], atual);
        if (!destino || visto.has(destino)) continue;
        visto.add(destino);
        veioDe.set(destino, atual);
        if (destino === alvo) break;
        fila.push(destino);
      }
    }

    if (visto.has(alvo)) {
      const cadeia: string[] = [alvo];
      let cur: string | undefined = veioDe.get(alvo);
      while (cur) { cadeia.unshift(cur); cur = veioDe.get(cur); }
      const caminhos = cadeia.map((f) => path.relative(RAIZ, f).split(path.sep).join("/"));
      expect.fail(`o módulo já está ligado:\n  ${caminhos.join("\n  → ")}`);
    }
  });

  it("🔴 setPaymentStatus continua a escrever só na tabela do pagamento", () => {
    // O estado actual, dito em voz alta. Quando este teste falhar, é porque a
    // ligação foi feita — e aí confirma-se a ordem: migrations aplicadas,
    // ledger conferido, ensaio corrido, funções verificadas na base real.
    const fonte = fs.readFileSync(path.join(RAIZ, "src/app/actions/payments.ts"), "utf8");
    const corpo = fonte.slice(
      fonte.indexOf("export async function setPaymentStatus"),
      fonte.indexOf("export async function deletePayment"),
    );
    expect(corpo).toContain('.from("fixed_variable_payments")');
    expect(corpo).not.toContain(".rpc(");
    expect(corpo).not.toContain("cash_flow_entries");
  });
});
