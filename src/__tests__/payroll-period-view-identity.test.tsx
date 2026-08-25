// @vitest-environment jsdom
// ============================================================================
// FOLHA — a vista mensal muda quando o mês muda (integração da P0M)
// ============================================================================
//
// A #76 corrigiu quatro vistas do Financeiro e deixou a Folha de fora, de
// propósito: a P0A estava a blindar o estado da folha em paralelo, e mexer nas
// duas coisas ao mesmo tempo tornaria impossível dizer qual delas mudou o quê.
// Esta é a peça que faltava.
//
// O defeito é o mesmo das outras quatro:
//
//     const [records, setRecords] = useState<PayrollRecord[]>(initialRecords);
//
// `useState(prop)` só lê o valor na montagem. Sem `key` no boundary, mudar de
// mês entrega Julho ao componente e o ecrã continua a mostrar Agosto.
//
// Na Folha há um segundo estado que torna isto pior do que uma lista errada:
//
//     const [selected, setSelected] = useState<Set<string>>(new Set());
//
// `selected` guarda **ids de registos de folha**. Sem remontagem, uma seleção
// feita em Agosto sobrevive à navegação para Julho, e o botão de aprovar
// atuaria sobre ids que já não estão no ecrã. Não é um problema de aparência.
//
// ---------------------------------------------------------------------------
// A prova passa pela página real
// ---------------------------------------------------------------------------
//
// Um teste que passasse a `key` a partir de si próprio provaria como o React
// funciona, não que `page.tsx` a passa. Por isso o helper abaixo extrai a key
// do ficheiro da página; apagar a linha lá torna estes testes vermelhos.
// ============================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const PAGINA = "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx";
const CLIENTE = "src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client.tsx";
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

// Navegar é ler. Se alguma destas for chamada só por mudar de mês, o teste 6
// apanha-o.
vi.mock("@/app/actions/payroll", () => ({
  calculateAndSavePayroll: vi.fn(),
  approvePayrollRecords: vi.fn(),
  markPayrollPaid: vi.fn(),
  adjustPayrollRecord: vi.fn(),
  getPayrollRecords: vi.fn(async () => ({ ok: false, error: "não usado" })),
}));

// A forma vem do tipo real — inventá-la deixaria o teste a passar sobre uma
// estrutura que a aplicação não produz.
type Registo = import("@/app/actions/payroll").PayrollRecord;

const registo = (id: string, full_name: string, ano: number, mes: number): Registo => ({
  id,
  collaborator_id: "c-" + id,
  full_name,
  avatar_url: null,
  period_year: ano,
  period_month: mes,
  contracted_hours: 176,
  worked_hours: 176,
  overtime_hours: 0,
  absence_hours: 0,
  days_worked: 22,
  hourly_rate: 5,
  gross_salary: 880,
  meal_allowance: 211.2,
  overtime_bonus: 0,
  absence_deductions: 0,
  other_deductions: 0,
  other_additions: 0,
  net_salary: 1091.2,
  notes: null,
  status: "rascunho",
  paid_at: null,
});

interface Mes {
  ano: number;
  mes: number;
  registos: Registo[];
}

const AGOSTO: Mes = { ano: 2026, mes: 8, registos: [registo("ago-1", "Ana de AGOSTO", 2026, 8)] };
const JULHO: Mes = { ano: 2026, mes: 7, registos: [registo("jul-1", "Rita de JULHO", 2026, 7)] };

// Sem isto o React avisa que o ambiente não suporta `act(...)` e deixa de
// aplicar as suas garantias — as atualizações podiam ficar por processar e um
// teste passaria por não ter chegado a renderizar o mês novo.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

// ---------------------------------------------------------------------------
// A ponte: a key vem da página, não do teste
// ---------------------------------------------------------------------------
function aberturaDoBoundary(): string {
  const fonte = ler(PAGINA);
  const inicio = fonte.indexOf("<PayrollClient");
  if (inicio < 0) throw new Error("boundary <PayrollClient> não encontrado na página");
  const fim = fonte.indexOf("/>", inicio);
  return fonte.slice(inicio, fim < 0 ? undefined : fim);
}

function keyQueAPaginaPassa(ano: number, mes: number): string | undefined {
  const m = aberturaDoBoundary().match(/\bkey=\{([^}]+)\}/);
  if (!m) return undefined; // a página não dá identidade ao boundary

  const expressao = m[1].trim();
  // Uma key derivada de outra coisa não é a correção acordada — falhar é
  // melhor do que passar por acidente.
  if (expressao !== "period.key") {
    throw new Error("key inesperada no boundary da Folha: " + expressao);
  }
  return ano + "-" + String(mes).padStart(2, "0");
}

async function mostrarMes(p: Mes) {
  const { PayrollClient } = await import(
    "@/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client"
  );
  const chave = keyQueAPaginaPassa(p.ano, p.mes);
  await act(async () => {
    root.render(
      <PayrollClient
        key={chave}
        initialRecords={p.registos}
        companyId="empresa-1"
        mesParam={p.ano + "-" + String(p.mes).padStart(2, "0")}
        year={p.ano}
        month={p.mes}
        mesLabel={p.mes + "/" + p.ano}
        needsCalculation={false}
        expectedRecords={p.registos.length}
      />,
    );
  });
}

const texto = () => container.textContent ?? "";

// ═══════════════════════════════════════════════════════════════════════════
// A identidade mensal, no componente real
// ═══════════════════════════════════════════════════════════════════════════

describe("Folha de Pagamento ao mudar de período", () => {
  it("1. mostra o mês que recebe, na primeira montagem", async () => {
    await mostrarMes(AGOSTO);
    expect(texto()).toContain("Ana de AGOSTO");
  });

  it("2. 🔴 AGO → JUL mostra Julho e larga Agosto", async () => {
    await mostrarMes(AGOSTO);
    await mostrarMes(JULHO);

    expect(texto()).toContain("Rita de JULHO");
    expect(texto()).not.toContain("Ana de AGOSTO");
  });

  it("3. AGO → JUL → AGO volta a mostrar Agosto", async () => {
    await mostrarMes(AGOSTO);
    await mostrarMes(JULHO);
    await mostrarMes(AGOSTO);

    expect(texto()).toContain("Ana de AGOSTO");
    expect(texto()).not.toContain("Rita de JULHO");
  });

  it("4. um mês sem folha calculada mostra-se vazio, não o mês anterior", async () => {
    await mostrarMes(AGOSTO);
    await mostrarMes({ ano: 2026, mes: 7, registos: [] });

    expect(texto()).not.toContain("Ana de AGOSTO");
  });

  it("5. 🔴 a seleção de Agosto não sobrevive à mudança para Julho", async () => {
    // O risco real desta vista: `selected` guarda ids. Uma seleção que
    // atravessasse a mudança de mês deixaria o botão de aprovar a agir sobre
    // registos que já não estão no ecrã.
    await mostrarMes(AGOSTO);

    const caixas = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    for (const c of caixas) {
      await act(async () => {
        c.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    const marcadasEmAgosto = container.querySelectorAll('input[type="checkbox"]:checked').length;

    await mostrarMes(JULHO);
    const marcadasEmJulho = container.querySelectorAll('input[type="checkbox"]:checked').length;

    expect(texto()).toContain("Rita de JULHO");
    // Se havia seleção, não sobreviveu; se não havia, nada regride.
    expect(marcadasEmJulho).toBeLessThanOrEqual(marcadasEmAgosto);
    expect(marcadasEmJulho).toBe(0);
  });

  it("6. 🔴 navegar AGO → JUL → AGO não chama nenhuma ação de escrita", async () => {
    const acoes = await import("@/app/actions/payroll");
    vi.clearAllMocks();

    await mostrarMes(AGOSTO);
    await mostrarMes(JULHO);
    await mostrarMes(AGOSTO);

    const escritas = [
      "calculateAndSavePayroll",
      "approvePayrollRecords",
      "markPayrollPaid",
      "adjustPayrollRecord",
    ] as const;

    for (const nome of escritas) {
      expect(acoes[nome], nome).not.toHaveBeenCalled();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardas permanentes
// ═══════════════════════════════════════════════════════════════════════════

describe("guardas da identidade mensal da Folha", () => {
  it("7. a página passa key={period.key} ao boundary", () => {
    expect(aberturaDoBoundary()).toMatch(/\bkey=\{period\.key\}/);
  });

  it("8. a key traz só o período — não filtro, colaborador nem seleção", () => {
    const m = aberturaDoBoundary().match(/\bkey=\{([^}]+)\}/);
    expect(m?.[1].trim()).toBe("period.key");
  });

  it("9. a correção é remontagem por key, não sincronização por efeito", () => {
    // Um `useEffect` que copiasse `initialRecords` para o estado resolveria o
    // sintoma e deixaria `selected` a atravessar meses na mesma.
    const cliente = ler(CLIENTE);
    expect(cliente).not.toMatch(/useEffect\([\s\S]{0,300}setRecords\(\s*initialRecords/);
  });

  it("10. as quatro vistas da #76 continuam com a sua identidade", () => {
    for (const vista of ["pagamentos", "fluxo-caixa", "contas", "conciliacao"]) {
      const fonte = ler("src/app/(dashboard)/dashboard/financeiro/" + vista + "/page.tsx");
      expect(fonte, vista).toMatch(/\bkey=\{period\.key\}/);
    }
  });
});
