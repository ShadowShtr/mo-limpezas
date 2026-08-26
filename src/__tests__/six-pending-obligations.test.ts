// ============================================================================
// REPARAÇÃO DAS 6 OBRIGAÇÕES PENDENTES — as decisões, sem base de dados
// ============================================================================
//
// Seis facturas de fornecedor foram registadas directamente em
// `cash_flow_entries` como saídas pendentes. São obrigações a pagar, e o sítio
// delas é Pagamentos. A reparação cria o pagamento e **liga** o movimento que
// já existe — não cria um segundo, não apaga o primeiro.
//
// Aqui testa-se o que decide. O que escreve é ensaiado em Postgres real
// (`npm run rehearse:six`), onde o executor é corrido a sério pelo CLI.
//
// ---------------------------------------------------------------------------
// Duas decisões do proprietário que estes testes fixam
// ---------------------------------------------------------------------------
//
//   `due_date = NULL` — a data legada foi **medida** como data de registo (é
//   igual ao `created_at` nas seis), não como vencimento. Copiá-la para
//   `due_date` faria o sistema afirmar um atraso que ninguém pode confirmar.
//   Ausência de informação não vira data inventada.
//
//   competência = mês civil do registo — não o mês aberto na UI. Sem
//   `due_date` não há nada a derivar, e o que resta é onde a factura nasceu.
// ============================================================================

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ESPERADAS, KIND_ALVO, ORIGEM_PAGAMENTO, CAMPOS_ESCRITOS_NO_MOVIMENTO,
  competenciaDaDataLegada, resolverCategoriaDoAlvo, construirAlvo,
  razoesDeInelegibilidade, serializarParaHash, verificarHashManifesto,
  validarManifesto, planoRollback,
} from "../../scripts/repairs/lib/six-pending-core.mjs";

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const ROOT = process.cwd();
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const EMPRESA = "11111111-1111-1111-1111-111111111111";
const PAG = "aaaaaaaa-0000-4000-8000-000000000001";

const legado = (over: Record<string, unknown> = {}) => ({
  id: "cccccccc-0000-4000-8000-000000000001",
  company_id: EMPRESA,
  type: "saida",
  amount: "153.75",
  description: "Factura de fornecedor",
  category: "despesa",
  date: "2026-07-10",
  status: "pendente",
  reference_type: null,
  reference_id: null,
  expense_category_id: null,
  notes: "registo legado",
  created_at: "2026-07-10 09:12:00+00",
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// Data e competência
// ═══════════════════════════════════════════════════════════════════════════

describe("a competência vem do mês civil do registo", () => {
  it("SIX-A. 10/07/2026 → 2026/07", () => {
    expect(competenciaDaDataLegada("2026-07-10")).toEqual({ ano: 2026, mes: 7 });
  });

  it("SIX-B. 07/08/2026 → 2026/08", () => {
    expect(competenciaDaDataLegada("2026-08-07")).toEqual({ ano: 2026, mes: 8 });
  });

  it("SIX-C. 🔴 um `Date` não é aceite — tem de ser texto", () => {
    // Na #78, o node-postgres devolveu colunas `date` como objectos `Date`,
    // este cálculo respondeu `null`, e quem chamava leu isso como «não tem
    // data». O snapshot saiu com ZERO candidatos e passou por sucesso. Só não
    // ficou por descobrir porque existia uma contagem independente.
    //
    // Por isso o CLI lê `date::text`, e por isso `null` aqui quer dizer «não
    // consigo ler», não «não tem».
    expect(competenciaDaDataLegada(new Date("2026-07-10") as unknown as string)).toBeNull();
    expect(competenciaDaDataLegada(1752105600000 as unknown as string)).toBeNull();
  });

  it("SIX-D. o dia 1 em Lisboa não escorrega para o mês anterior", () => {
    // `new Date("2026-08-01")` dá 31 de Julho em Lisboa no Verão. O cálculo é
    // sobre o texto, e não passa por `Date` em lado nenhum.
    expect(competenciaDaDataLegada("2026-08-01")).toEqual({ ano: 2026, mes: 8 });
    expect(ler("scripts/repairs/lib/six-pending-core.mjs")).not.toMatch(/new Date\(/);
  });

  it("SIX-E. datas malformadas são recusadas, não adivinhadas", () => {
    for (const m of ["72026-01-01", "2026-13-01", "2026-00-10", "2026-07-32", "10/07/2026", "", "   "]) {
      expect(competenciaDaDataLegada(m), m).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Categoria
// ═══════════════════════════════════════════════════════════════════════════

describe("categoria: preservar, ou nada", () => {
  const catalogo = [
    { id: "cat-forn", name: "Fornecedores" },
    { id: "cat-comb", name: "Combustível" },
  ];

  it("SIX-F. um id estruturado já existente é preservado tal e qual", () => {
    const r = resolverCategoriaDoAlvo(legado({ expense_category_id: "cat-forn" }), catalogo);
    expect(r).toEqual({ id: "cat-forn", origem: "preservada" });
  });

  it("SIX-G. 🔴 `fornecedor` NÃO é mapeado para `Fornecedores`", () => {
    // Parecido não é determinístico. Três das seis têm este texto legado, e
    // mapeá-lo por semelhança classificaria dinheiro real por palpite.
    const r = resolverCategoriaDoAlvo(legado({ category: "fornecedor" }), catalogo);
    expect(r.id).toBeNull();
    expect(r.origem).toBe("sem-equivalencia-deterministica");
  });

  it("SIX-H. um nome exactamente igual é mapeado", () => {
    const r = resolverCategoriaDoAlvo(legado({ category: "Combustível" }), catalogo);
    expect(r).toEqual({ id: "cat-comb", origem: "mapeada" });
  });

  it("SIX-I. dois nomes iguais no catálogo não são determinísticos", () => {
    const ambiguo = [{ id: "a", name: "Serviços" }, { id: "b", name: "serviços" }];
    expect(resolverCategoriaDoAlvo(legado({ category: "Serviços" }), ambiguo).id).toBeNull();
  });

  it("SIX-J. sem categoria nenhuma não se inventa uma", () => {
    expect(resolverCategoriaDoAlvo(legado({ category: null }), catalogo))
      .toEqual({ id: null, origem: "nenhuma" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O alvo
// ═══════════════════════════════════════════════════════════════════════════

/** O alvo de uma linha, com a falha a rebentar em vez de virar `undefined`. */
function alvoDe(l: ReturnType<typeof legado>, paymentId: string | null = PAG) {
  const r = construirAlvo(l, { paymentId, catalogo: [] });
  if (!r.ok) throw new Error(r.error);
  return r.alvo as Record<string, unknown>;
}

describe("o pagamento que cada linha deve tornar-se", () => {
  it("SIX-K. 🔴 due_date fica NULO — a data legada não é vencimento", () => {
    const alvo = alvoDe(legado());
    expect(alvo.due_date).toBeNull();
    // E não aparece disfarçada noutro campo qualquer.
    expect(Object.values(alvo)).not.toContain("2026-07-10");
  });

  it("SIX-L. a competência é a do registo, e não o mês corrente", () => {
    const alvo = alvoDe(legado({ date: "2026-07-10" }));
    expect([alvo.period_year, alvo.period_month]).toEqual([2026, 7]);
  });

  it("SIX-M. kind = `variavel` e sem recorrência", () => {
    // `variavel`, não `variable`: é o valor que o CHECK da 037 permite. O outro
    // seria recusado pela base, e só no momento da escrita em produção.
    const alvo = alvoDe(legado());
    expect(alvo.kind).toBe("variavel");
    expect(KIND_ALVO).toBe("variavel");
    expect(alvo.recurring).toBe(false);
    expect(ler("supabase/migrations/037_fixed_variable_payments.sql"))
      .toMatch(/kind IN \('fixo', 'variavel'\)/);
  });

  it("SIX-N. valor, descrição e notas passam intactos", () => {
    const alvo = alvoDe(legado({ amount: "351.96", description: "Higiprol -  FT2026/523", notes: "nota antiga" }));
    expect(alvo.amount).toBe("351.96");
    expect(alvo.description).toBe("Higiprol -  FT2026/523");   // espaço duplo incluído
    expect(alvo.notes).toBe("nota antiga");
  });

  it("SIX-O. o pagamento nasce pendente", () => {
    expect(alvoDe(legado()).status).toBe("pendente");
  });

  it("SIX-P. 🔴 uma data ilegível aborta — não fica sem competência", () => {
    const r = construirAlvo(legado({ date: "72026-01-01" }), { paymentId: PAG, catalogo: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ilegível/i);
  });

  it("SIX-Q. sem id pré-gerado não há alvo", () => {
    // §22: os ids nascem no manifesto. Procurá-los depois por descrição e valor
    // é como o repair perderia a noção de quais linhas lhe pertencem.
    expect(construirAlvo(legado(), { paymentId: null, catalogo: [] }).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Elegibilidade
// ═══════════════════════════════════════════════════════════════════════════

describe("só entra o que é exactamente o esperado", () => {
  it("SIX-R. a linha típica é elegível", () => {
    expect(razoesDeInelegibilidade(legado())).toEqual([]);
  });

  it("SIX-S. uma entrada, uma confirmada, ou uma já ligada ficam de fora", () => {
    expect(razoesDeInelegibilidade(legado({ type: "entrada" }))).toHaveLength(1);
    expect(razoesDeInelegibilidade(legado({ status: "confirmado" }))).toHaveLength(1);
    expect(razoesDeInelegibilidade(legado({ reference_type: ORIGEM_PAGAMENTO }))).not.toEqual([]);
  });

  it("SIX-T. valor ausente, zero ou negativo é recusado", () => {
    for (const a of [null, "0", "0.00", "-10.00", "abc"]) {
      expect(razoesDeInelegibilidade(legado({ amount: a })), String(a)).not.toEqual([]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Manifesto
// ═══════════════════════════════════════════════════════════════════════════

function manifestoValido() {
  const l = legado();
  const alvo = construirAlvo(l, { paymentId: PAG, catalogo: [] }).alvo;
  const linha = {
    legacy_cashflow_id: l.id, target_payment_id: PAG, company_id: EMPRESA,
    before: { ...l }, target: alvo,
    after: { ...l, reference_type: ORIGEM_PAGAMENTO, reference_id: PAG },
  };
  const linhas = Array.from({ length: ESPERADAS }, (_, i) => ({
    ...linha,
    legacy_cashflow_id: `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`,
    target_payment_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
    before: { ...linha.before, id: `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}` },
    target: { ...alvo, id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}` },
    after: {
      ...linha.after,
      id: `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`,
      reference_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
    },
  }));
  return { linhas };
}

describe("o manifesto tem de se aguentar sozinho", () => {
  it("SIX-U. o manifesto bem formado passa", () => {
    expect(validarManifesto(manifestoValido())).toEqual({ ok: true });
  });

  it("SIX-V. 🔴 um due_date preenchido reprova o manifesto inteiro", () => {
    const m = manifestoValido();
    (m.linhas[2].target as Record<string, unknown>).due_date = "2026-07-10";
    const r = validarManifesto(m);
    expect(r.ok).toBe(false);
    expect(r.erros!.join(" ")).toMatch(/due_date tem de ser nulo/);
  });

  it("SIX-W. uma competência que não é a do registo reprova", () => {
    const m = manifestoValido();
    m.linhas[1].target.period_month = 8;   // o registo é de Julho
    expect(validarManifesto(m).ok).toBe(false);
  });

  it("SIX-X. 🔴 alterar a data, o valor ou a descrição do movimento reprova", () => {
    for (const campo of ["date", "amount", "description", "created_at"]) {
      const m = manifestoValido();
      (m.linhas[0].after as Record<string, unknown>)[campo] = "outra coisa";
      const r = validarManifesto(m);
      expect(r.ok, campo).toBe(false);
      expect(r.erros!.join(" ")).toMatch(new RegExp(`não pode alterar .${campo}`));
    }
  });

  it("SIX-Y. o movimento tem de continuar pendente depois da ligação", () => {
    const m = manifestoValido();
    m.linhas[0].after.status = "confirmado";
    expect(validarManifesto(m).ok).toBe(false);
  });

  it("SIX-Z. um número de linhas diferente de 6 reprova", () => {
    const m = manifestoValido();
    m.linhas.pop();
    expect(validarManifesto(m).ok).toBe(false);
  });

  it("SIX-AA. ids repetidos reprovam", () => {
    const m = manifestoValido();
    m.linhas[1].target_payment_id = m.linhas[0].target_payment_id;
    expect(validarManifesto(m).ok).toBe(false);
  });

  it("SIX-AB. o valor do pagamento tem de ser o do movimento", () => {
    const m = manifestoValido();
    m.linhas[0].target.amount = "999.99";
    expect(validarManifesto(m).ok).toBe(false);
  });
});

describe("o hash é o que separa «autorizado» de «gerado»", () => {
  it("SIX-AC. o hash bate certo consigo próprio", () => {
    const m = manifestoValido() as Record<string, unknown>;
    const sha = sha256(serializarParaHash(m));
    expect(verificarHashManifesto({ ...m, sha256: sha }, sha, sha256)).toEqual({ ok: true });
  });

  it("SIX-AD. 🔴 mudar uma linha invalida o hash", () => {
    const m = manifestoValido() as Record<string, unknown> & { linhas: { target: { amount: string } }[] };
    const sha = sha256(serializarParaHash(m));
    m.linhas[0].target.amount = "1.00";
    expect(verificarHashManifesto(m, sha, sha256).ok).toBe(false);
  });

  it("SIX-AE. a ordem das chaves não muda o hash", () => {
    // Sem isto, o mesmo manifesto daria dois hashes conforme a ordem em que o
    // JSON saísse, e a verificação seria uma moeda ao ar.
    const a = { alfa: 1, beta: { x: 1, y: 2 }, linhas: [] };
    const b = { linhas: [], beta: { y: 2, x: 1 }, alfa: 1 };
    expect(sha256(serializarParaHash(a))).toBe(sha256(serializarParaHash(b)));
  });

  it("SIX-AF. um sha malformado é recusado antes de qualquer comparação", () => {
    const m = manifestoValido();
    expect(verificarHashManifesto(m, "curto", sha256).ok).toBe(false);
    expect(verificarHashManifesto(m, undefined as unknown as string, sha256).ok).toBe(false);
  });

  it("SIX-AG. a verificação vive no núcleo, não no CLI", () => {
    // Na #78 esta verificação existia só no CLI, e por isso não havia um único
    // teste capaz de a apanhar a desaparecer.
    expect(ler("scripts/repairs/lib/six-pending-core.mjs")).toMatch(/export function verificarHashManifesto/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rollback
// ═══════════════════════════════════════════════════════════════════════════

describe("a reversão recusa em vez de destruir", () => {
  // 🔴 F14-C. «Limpo» passou a querer dizer **tudo** como o manifesto o viu,
  //    não só o esqueleto económico. A reversão compara agora descrição, datas,
  //    categorias, notas, anexos e conciliação — um estado que só declarasse
  //    `status`/`amount` deixaria esses campos `undefined` e faria a reversão
  //    recusar com razão.
  const estadoLimpo = (m: ReturnType<typeof manifestoValido>) => ({
    pagamentos: Object.fromEntries(m.linhas.map((l) => [l.target_payment_id, {
      status: "pendente", amount: l.target.amount, due_date: null,
      description: l.target.description, notes: l.target.notes,
      expense_category_id: l.target.expense_category_id,
      period_year: l.target.period_year, period_month: l.target.period_month,
      attachment_url: null, attachment_count: 0,
    }])),
    movimentos: Object.fromEntries(m.linhas.map((l) => [l.legacy_cashflow_id, {
      status: "pendente", reference_id: l.target_payment_id,
      description: l.before.description, date: l.before.date,
      category: l.before.category, expense_category_id: l.before.expense_category_id,
      notes: l.before.notes, amount: l.before.amount,
      reconciliation_count: 0,
    }])),
  });

  it("SIX-AH. com tudo intacto, a reversão tem plano", () => {
    const m = manifestoValido();
    const p = planoRollback(m, estadoLimpo(m));
    expect(p.ok).toBe(true);
    expect(p.passos).toHaveLength(ESPERADAS);
  });

  it("SIX-AI. 🔴 um pagamento já pago faz a reversão RECUSAR", () => {
    const m = manifestoValido();
    const e = estadoLimpo(m);
    e.pagamentos[m.linhas[3].target_payment_id].status = "pago";
    const p = planoRollback(m, e);
    expect(p.ok).toBe(false);
    expect(p.impedimentos!.join(" ")).toMatch(/houve actividade depois do repair/);
  });

  it("SIX-AJ. um movimento já confirmado faz a reversão recusar", () => {
    const m = manifestoValido();
    const e = estadoLimpo(m);
    e.movimentos[m.linhas[0].legacy_cashflow_id].status = "confirmado";
    expect(planoRollback(m, e).ok).toBe(false);
  });

  it("SIX-AK. um pagamento que ganhou vencimento faz a reversão recusar", () => {
    const m = manifestoValido();
    const e = estadoLimpo(m);
    (e.pagamentos[m.linhas[1].target_payment_id] as Record<string, unknown>).due_date = "2026-09-01";
    expect(planoRollback(m, e).ok).toBe(false);
  });

  it("SIX-AL. 🔴 recusa é tudo-ou-nada: uma linha suja pára as seis", () => {
    const m = manifestoValido();
    const e = estadoLimpo(m);
    e.pagamentos[m.linhas[5].target_payment_id].status = "pago";
    const p = planoRollback(m, e);
    expect(p.ok).toBe(false);
    expect(p.passos).toBeUndefined();   // nem um passo é proposto
  });

  it("SIX-AM. desligar vem antes de apagar", () => {
    // Apagar o pagamento com o movimento ainda a apontar-lhe deixaria um
    // vínculo partido no intervalo.
    const m = manifestoValido();
    const passo = planoRollback(m, estadoLimpo(m)).passos[0];
    expect(Object.keys(passo)).toEqual(["desligar", "apagar_pagamento"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Disciplina do executor
// ═══════════════════════════════════════════════════════════════════════════

describe("guardas permanentes do executor", () => {
  const cli = () => ler("scripts/repairs/six-pending-obligations.mjs");

  it("SIX-AN. 🔴 só duas colunas do movimento são escritas", () => {
    expect(CAMPOS_ESCRITOS_NO_MOVIMENTO).toEqual(["reference_type", "reference_id"]);
    // E o UPDATE real escreve essas, e só essas.
    const upd = cli().match(/UPDATE public\.cash_flow_entries[\s\S]*?WHERE/)![0];
    expect(upd).toMatch(/SET reference_type = \$1, reference_id = \$2/);
    for (const proibido of ["amount", "date", "description", "status =", "created_at"]) {
      expect(upd.split("WHERE")[0], proibido).not.toContain(proibido);
    }
  });

  it("SIX-AO. 🔴 DELETE_COUNT = 0 — o caminho para a frente não apaga nada", () => {
    const s = cli();
    const forward = s.slice(s.indexOf("async function aplicar"), s.indexOf("async function reverter"));
    expect(forward).not.toMatch(/DELETE/i);
  });

  it("SIX-AP. o UPDATE é condicional ao estado que o manifesto viu", () => {
    // Sem estas condições, executar um manifesto velho escreveria por cima do
    // que entretanto aconteceu, em silêncio.
    const upd = cli().match(/UPDATE public\.cash_flow_entries[\s\S]*?\[ORIGEM_PAGAMENTO/)![0];
    expect(upd).toMatch(/reference_type IS NULL/);
    expect(upd).toMatch(/status = 'pendente'/);
    expect(upd).toMatch(/amount::text = \$5/);
    expect(cli()).toMatch(/upd\.rowCount !== 1/);
  });

  it("SIX-AQ. escrever exige as quatro coisas juntas", () => {
    const s = cli();
    expect(s).toMatch(/--confirm-production/);
    expect(s).toMatch(/if \(!OPCOES\.manifesto\) morrer/);
    expect(s).toMatch(/if \(!OPCOES\.manifestoSha\) morrer/);
  });

  it("SIX-AR. 🔴 um alvo não identificado é recusado, não assumido", () => {
    // O buraco da #78: a confirmação só era exigida quando o project ref era
    // legível, portanto uma URL estranha escrevia sem confirmar nada.
    const s = cli();
    const f = s.slice(s.indexOf("function identificarAlvo"), s.indexOf("// ─── Leitura"));
    expect(f).toMatch(/tipo: "ilegivel"/);
    expect(f).toMatch(/tipo: "desconhecido"/);
    expect(s).toMatch(/alvo\.tipo === "ilegivel" \|\| alvo\.tipo === "desconhecido"\) morrer/);
  });

  it("SIX-AS. SSL só é desligado para o ensaio local", () => {
    const s = cli();
    const f = s.slice(s.indexOf("function identificarAlvo"), s.indexOf("// ─── Leitura"));
    expect(f).toMatch(/tipo: "producao", ref, ssl: \{ rejectUnauthorized: false \}/);
    expect(f).toMatch(/tipo: "ensaio", ref: null, ssl: false/);
  });

  it("SIX-AT. 🔴 nenhuma credencial pode sair numa mensagem", () => {
    const s = cli();
    expect(s).toMatch(/function sanitizar/);
    expect(s).toMatch(/postgres\(\?:ql\)\?:\\\/\\\/\[\^\\s"'\]\+/);   // a rede de segurança
    expect(s).toMatch(/console\.error\(`\\n⛔ \$\{sanitizar\(mensagem\)\}/);
  });

  it("SIX-AU. 🔴 o parser de .env.local ignora linhas sem `KEY=`", () => {
    // Foi uma linha destas, tratada como par chave/valor, que expôs uma
    // password num diagnóstico. A credencial foi rodada; o parser mudou.
    const s = cli();
    const f = s.slice(s.indexOf("function lerEnvLocal"), s.indexOf("// ─── Alvo"));
    expect(f).toMatch(/if \(i < 1\) continue;/);
    expect(f).toMatch(/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$/);
  });

  it("SIX-AV. um número diferente de 6 aborta antes de qualquer escrita", () => {
    expect(cli()).toMatch(/candidatos\.length !== ESPERADAS/);
    expect(ESPERADAS).toBe(6);
  });

  it("SIX-AW. os manifestos são escritos fora do repositório", () => {
    // Um manifesto com ids reais de produção não entra no Git.
    expect(cli()).toMatch(/saida: valor\("--out"\) \?\? path\.join\(ROOT, "\.\.", "manifests"\)/);
    expect(fs.existsSync(path.join(ROOT, "manifests"))).toBe(false);
  });

  it("SIX-AX. a reparação depende da 079, e o ensaio prova-o com ela aplicada", () => {
    // Sem a 079, ligar um movimento pendente a um pagamento deixá-lo-ia preso
    // em `pendente` no dia em que fosse pago. A ordem das duas coisas não é
    // negociável, e o ensaio aplica as duas migrations.
    const ensaio = ler("scripts/rehearse-six-repair.mjs");
    expect(ensaio).toMatch(/079_reuse_pending_cashflow_on_payment\.sql/);
    expect(ensaio).toMatch(/mark_payment_paid/);
  });
});
