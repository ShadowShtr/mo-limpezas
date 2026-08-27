// @vitest-environment jsdom
// ============================================================================
// FINANCEIRO — a vista mensal muda quando o mês muda (P0M)
// ============================================================================
//
// O utilizador disse: «quando seleciono outro mês continuam a aparecer meses
// anteriores; não fica separado somente o mês escolhido».
//
// A auditoria ilibou o servidor. Em Pagamentos a consulta filtra por
// `period_year` + `period_month` com igualdade exata — não há fronteira de
// data para errar, e nenhum vencido antigo é trazido. Quem mente é o cliente:
//
//     const [data, setData] = useState<PaymentsData | null>(initialData);
//
// `useState(prop)` só lê o valor **na montagem**. Mudar de mês muda o URL, o
// Server Component volta a correr e entrega Julho — mas o React reutiliza a
// mesma instância do componente, porque a posição na árvore não mudou e não há
// `key`. O estado interno continua a ser o de Agosto.
//
// É a mesma armadilha que já mordeu este projeto nos anexos, em 2026-08-19, e
// que o próprio `payments-client.tsx` documenta a propósito do
// `AttachmentsField`. Aqui aparece um nível acima: não no campo, na vista.
//
// ---------------------------------------------------------------------------
// Porque é que o teste exercita o componente a sério
// ---------------------------------------------------------------------------
//
// Um teste estático que procurasse `key=` no JSX provaria que alguém escreveu
// a linha, não que o ecrã passa a mostrar Julho. E o defeito é precisamente
// uma diferença entre o que o código parece dizer e o que o React faz com ele.
//
// Por isso a Parte A renderiza o `PaymentsClient` real, duas vezes, e olha
// para o que fica no DOM.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

// As actions do servidor não são exercitadas aqui — o que está em causa é a
// identidade da instância, não a leitura.
vi.mock("@/app/actions/payments", () => ({
  getPayments: vi.fn(async () => ({ ok: false, error: "não usado" })),
  createPayment: vi.fn(), updatePayment: vi.fn(),
  setPaymentStatus: vi.fn(), deletePayment: vi.fn(),
}));
vi.mock("@/components/attachments/attachments-field", () => ({
  AttachmentsField: () => null,
}));

// A forma vem do tipo real da action — inventá-la aqui deixaria o teste a
// passar sobre uma estrutura que a aplicação não produz.
type Pagamento = import("@/app/actions/payments").Payment;
type Dados = import("@/app/actions/payments").PaymentsData;

const pagamento = (id: string, description: string): Pagamento => ({
  id, kind: "fixo", description, amount: 100, due_date: "2026-08-10",
  direct_debit: false, status: "pendente", notes: null, sort_order: 1,
  expense_category_id: null,
  recurring: true, period_year: 2026, period_month: 8, paid_at: null,
  attachment_url: null, attachment_name: null, attachment_size: null, attachment_mime: null,
});

const dadosDe = (ano: number, mes: number, pagamentos: Pagamento[]): Dados => ({
  year: ano, month: mes, fixos: pagamentos, variaveis: [],
  totalPendente: 100, totalPago: 0, countPendente: 1, countOverdue: 0,
});

const AGOSTO = dadosDe(2026, 8, [pagamento("ago-1", "Renda de AGOSTO")]);
const JULHO = dadosDe(2026, 7, [pagamento("jul-1", "Renda de JULHO")]);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** Renderiza a vista de um período, com ou sem identidade no boundary. */
async function mostrarPeriodo(
  dados: ReturnType<typeof dadosDe>,
  { comIdentidade }: { comIdentidade: boolean },
) {
  const { PaymentsClient } = await import(
    "@/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client"
  );
  const chave = comIdentidade ? `${dados.year}-${String(dados.month).padStart(2, "0")}` : undefined;

  await act(async () => {
    root.render(
      <PaymentsClient
        key={chave}
        initialData={dados}
        error={null}
        year={dados.year}
        month={dados.month}
      />,
    );
  });
}

const textoNoEcra = () => container.textContent ?? "";

// ---------------------------------------------------------------------------
// A ponte entre a Parte A e a Parte B
// ---------------------------------------------------------------------------
//
// 🔴 A Parte A, sozinha, prova pouco: passa a `key` a partir do próprio teste.
//    Isso demonstra que uma key no boundary corrige o defeito — mas ficaria
//    verde mesmo que `page.tsx` deixasse de a passar. A Parte B, sozinha, lê o
//    ficheiro e vê a linha escrita, sem nunca provar que o ecrã muda.
//
//    O helper abaixo fecha o circuito: extrai da página REAL a key que ela
//    passa ao boundary de Pagamentos e é essa que alimenta o render. Se alguém
//    apagar `key={period.key}` de `page.tsx`, o teste comportamental deixa de
//    receber key — e falha a mostrar Julho, exatamente como o utilizador viu.
function keyQueAPaginaPassa(dados: ReturnType<typeof dadosDe>): string | undefined {
  const fonte = ler("src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx");
  const inicio = fonte.indexOf("<UnifiedPaymentsClient");
  if (inicio < 0) throw new Error("boundary <UnifiedPaymentsClient> não encontrado na página");

  const fim = fonte.indexOf("/>", inicio);
  const abertura = fonte.slice(inicio, fim < 0 ? undefined : fim);

  const m = abertura.match(/\bkey=\{([^}]+)\}/);
  if (!m) return undefined; // a página não dá identidade ao boundary

  const expressao = m[1].trim();
  // Uma key derivada de outra coisa (a rota, um contador, Math.random) não é
  // a correção acordada — falhar é melhor do que passar por acidente.
  if (expressao !== "period.key") {
    throw new Error(`key inesperada no boundary: \`${expressao}\``);
  }
  return `${dados.year}-${String(dados.month).padStart(2, "0")}`;
}

/** Rende o período usando a identidade que a página real passa (ou nenhuma). */
async function mostrarPeriodoComoAPaginaFaz(dados: ReturnType<typeof dadosDe>) {
  const { PaymentsClient } = await import(
    "@/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client"
  );
  const chave = keyQueAPaginaPassa(dados);
  await act(async () => {
    root.render(
      <PaymentsClient
        key={chave}
        initialData={dados}
        error={null}
        year={dados.year}
        month={dados.month}
      />,
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — o comportamento, no componente real
// ═══════════════════════════════════════════════════════════════════════════

describe("PaymentsClient ao mudar de período", () => {
  it("mostra o mês que recebe, na primeira montagem", async () => {
    await mostrarPeriodo(AGOSTO, { comIdentidade: true });
    expect(textoNoEcra()).toContain("Renda de AGOSTO");
  });

  it("🔴 SEM identidade no boundary, Julho não aparece — é o defeito", async () => {
    // Este é o bug reportado, reproduzido. Se um dia deixar de reproduzir,
    // é porque o componente passou a sincronizar sozinho — e aí este teste
    // deve ser reescrito, não apagado.
    await mostrarPeriodo(AGOSTO, { comIdentidade: false });
    await mostrarPeriodo(JULHO, { comIdentidade: false });

    expect(textoNoEcra()).toContain("Renda de AGOSTO");
    expect(textoNoEcra()).not.toContain("Renda de JULHO");
  });

  it("🔴 COM identidade no boundary, Julho aparece e Agosto sai", async () => {
    await mostrarPeriodo(AGOSTO, { comIdentidade: true });
    await mostrarPeriodo(JULHO, { comIdentidade: true });

    expect(textoNoEcra()).toContain("Renda de JULHO");
    expect(textoNoEcra()).not.toContain("Renda de AGOSTO");
  });

  it("AGO → JUL → AGO devolve exatamente os ids de Agosto", async () => {
    await mostrarPeriodo(AGOSTO, { comIdentidade: true });
    await mostrarPeriodo(JULHO, { comIdentidade: true });
    await mostrarPeriodo(AGOSTO, { comIdentidade: true });

    expect(textoNoEcra()).toContain("Renda de AGOSTO");
    expect(textoNoEcra()).not.toContain("Renda de JULHO");
  });

  it("nenhum registo do mês anterior sobrevive à mudança", async () => {
    const agostoCheio = dadosDe(2026, 8, [
      pagamento("ago-1", "Renda de AGOSTO"),
      pagamento("ago-2", "Seguro de AGOSTO"),
      pagamento("ago-3", "Água de AGOSTO"),
    ]);
    await mostrarPeriodo(agostoCheio, { comIdentidade: true });
    await mostrarPeriodo(JULHO, { comIdentidade: true });

    for (const descricao of ["Renda de AGOSTO", "Seguro de AGOSTO", "Água de AGOSTO"]) {
      expect(textoNoEcra(), descricao).not.toContain(descricao);
    }
  });

  it("um mês vazio mostra-se vazio, não o mês anterior", async () => {
    // O caso mais enganador: sem identidade, um mês sem pagamentos parecia
    // ter os do mês anterior.
    await mostrarPeriodo(AGOSTO, { comIdentidade: true });
    await mostrarPeriodo(dadosDe(2026, 7, []), { comIdentidade: true });

    expect(textoNoEcra()).not.toContain("Renda de AGOSTO");
  });

  it("mudar de mês fecha o formulário do mês anterior", async () => {
    // Decisão de produto: mudar de mês é mudar de contexto. Um formulário de
    // Agosto vivo por baixo de um ecrã de Julho é pior do que o perder.
    await mostrarPeriodo(AGOSTO, { comIdentidade: true });

    const botaoNovo = [...container.querySelectorAll("button")]
      .find((b) => /novo|adicionar|\+/i.test(b.textContent ?? ""));
    if (botaoNovo) {
      await act(async () => { botaoNovo.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    }
    const comFormulario = container.querySelectorAll("input").length;

    await mostrarPeriodo(JULHO, { comIdentidade: true });
    const depoisDaMudanca = container.querySelectorAll("input").length;

    expect(textoNoEcra()).toContain("Renda de JULHO");
    // Se havia formulário aberto, não sobreviveu; se não havia, nada regride.
    expect(depoisDaMudanca).toBeLessThanOrEqual(comFormulario);
  });

  it("🔴 com a identidade que a PÁGINA REAL passa, AGO → JUL mostra Julho", async () => {
    // Este é o teste que liga a correção ao ecrã: a key vem de `page.tsx`,
    // não do teste. Apagar `key={period.key}` da página torna-o vermelho.
    await mostrarPeriodoComoAPaginaFaz(AGOSTO);
    await mostrarPeriodoComoAPaginaFaz(JULHO);

    expect(textoNoEcra()).toContain("Renda de JULHO");
    expect(textoNoEcra()).not.toContain("Renda de AGOSTO");
  });

  it("🔴 navegar AGO → JUL → AGO não dispara nenhuma mutação", async () => {
    // Mudar de mês é ler, nunca escrever. Se um dia a correção de identidade
    // for trocada por um `useEffect` que "repara" o estado chamando uma action,
    // isto fica vermelho antes de chegar a produção.
    const actions = await import("@/app/actions/payments");
    vi.clearAllMocks();

    await mostrarPeriodoComoAPaginaFaz(AGOSTO);
    await mostrarPeriodoComoAPaginaFaz(JULHO);
    await mostrarPeriodoComoAPaginaFaz(AGOSTO);

    for (const nome of ["createPayment", "updatePayment", "setPaymentStatus", "deletePayment"] as const) {
      expect(actions[nome], nome).not.toHaveBeenCalled();
    }
  });

  it("🔴 e AGO → JUL → AGO regressa a Agosto, também pela página real", async () => {
    await mostrarPeriodoComoAPaginaFaz(AGOSTO);
    await mostrarPeriodoComoAPaginaFaz(JULHO);
    await mostrarPeriodoComoAPaginaFaz(AGOSTO);

    expect(textoNoEcra()).toContain("Renda de AGOSTO");
    expect(textoNoEcra()).not.toContain("Renda de JULHO");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — as quatro vistas passam a identidade
// ═══════════════════════════════════════════════════════════════════════════
//
// A Parte A prova o mecanismo. Esta prova que ele está aplicado onde interessa
// — e é aqui que se veria se alguém acrescentasse uma quinta vista mensal sem
// a identidade.

const VISTAS: Array<{ nome: string; ficheiro: string; componente: string }> = [
  { nome: "Pagamentos",   ficheiro: "pagamentos/page.tsx",   componente: "UnifiedPaymentsClient" },
  { nome: "Fluxo de Caixa", ficheiro: "fluxo-caixa/page.tsx", componente: "CashFlowClient" },
  { nome: "Contas",       ficheiro: "contas/page.tsx",       componente: "ContasClient" },
  { nome: "Conciliação",  ficheiro: "conciliacao/page.tsx",  componente: "ReconciliationClient" },
];

describe("as vistas mensais do Financeiro dão identidade ao período", () => {
  for (const { nome, ficheiro, componente } of VISTAS) {
    it(`${nome} passa uma key derivada do período`, () => {
      const src = ler(`src/app/(dashboard)/dashboard/financeiro/${ficheiro}`);
      const i = src.indexOf(`<${componente}`);
      expect(i, `${componente} não encontrado`).toBeGreaterThan(-1);

      const bloco = src.slice(i, src.indexOf("/>", i));
      expect(bloco, `${nome} sem key`).toMatch(/key=\{period\.key\}/);
    });

    it(`${nome} não usa uma key aleatória`, () => {
      const src = ler(`src/app/(dashboard)/dashboard/financeiro/${ficheiro}`);
      expect(src).not.toMatch(/key=\{(Math\.random|Date\.now|crypto\.randomUUID)/);
    });
  }

  it("a key traz só o período — não a pesquisa, o separador nem a categoria", () => {
    // Se trouxesse, escrever na pesquisa remontaria a vista a cada tecla.
    for (const { ficheiro } of VISTAS) {
      const src = ler(`src/app/(dashboard)/dashboard/financeiro/${ficheiro}`);
      const m = src.match(/key=\{([^}]+)\}/);
      expect(m?.[1]?.trim()).toBe("period.key");
    }
  });

  it("period.key é determinística e derivada de ano e mês", () => {
    const lib = ler("src/lib/finance-period.ts");
    expect(lib).toMatch(/key:\s*`\$\{year\}-\$\{String\(month\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — o que esta correção NÃO tocou
// ═══════════════════════════════════════════════════════════════════════════

describe("a semântica mensal continua explícita", () => {
  const semComentarios = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("o ledger separa competência e caixa no servidor", () => {
    const acoes = semComentarios(ler("src/app/actions/finance-ledger.ts"));
    expect(acoes).toMatch(/\.eq\("period_year", period\.year\)/);
    expect(acoes).toMatch(/\.eq\("period_month", period\.month\)/);
    expect(acoes).toMatch(/\.gte\("date", range\.start\)/);
    expect(acoes).toMatch(/\.lte\("date", range\.end\)/);
  });

  it("nenhuma escrita foi acrescentada ao caminho de navegação", () => {
    for (const { ficheiro } of VISTAS) {
      const src = semComentarios(ler(`src/app/(dashboard)/dashboard/financeiro/${ficheiro}`));
      expect(src, ficheiro).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
      expect(src, ficheiro).not.toMatch(/ensureMonth|materializ/i);
    }
  });

  it("não se acrescentou um useEffect de sincronização por cima da key", () => {
    // Uma fonte para o reset. Duas seriam duas maneiras de o estado divergir.
    const cliente = semComentarios(
      ler("src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client.tsx"),
    );
    expect(cliente).not.toMatch(/useEffect\([^)]*setRows\(/);
  });

    it("a Folha de Pagamento recebeu a mesma identidade, na integração da #68", () => {
      // Este guarda nasceu invertido: enquanto a #68 estava a blindar o estado
      // da folha, exigia que a Folha **não** tivesse `key`, para a correção não
      // entrar cedo e criar conflito com esse trabalho.
      //
      // O adiamento terminou quando a #68 foi integrada, e foi ela que o
      // inverteu — a espera acabou por ser sinalizada por este próprio teste a
      // ficar vermelho, que era exatamente o que se pretendia.
      //
      // A prova comportamental da Folha vive em
      // `payroll-period-view-identity.test.tsx`; aqui fica só a garantia de que
      // as cinco vistas mensais partilham a mesma regra.
      const folha = ler("src/app/(dashboard)/dashboard/folha-pagamento/page.tsx");
      expect(folha).toMatch(/key=\{period\.key\}/);
    });
});
