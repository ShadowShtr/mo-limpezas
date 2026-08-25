// @vitest-environment jsdom
// ============================================================================
// FOLHA — identidade das LINHAS da tabela
// ============================================================================
//
// Duas identidades diferentes convivem nesta vista, e não se substituem:
//
//   `period.key`  identidade da vista mensal inteira (ver
//                 `payroll-period-view-identity.test.tsx`)
//   `r.id`        identidade de cada linha dentro dessa vista
//
// Este ficheiro trata da segunda.
//
// ---------------------------------------------------------------------------
// O defeito
// ---------------------------------------------------------------------------
//
// A tabela devolvia isto do `map`:
//
//     pag.pageItems.map((r) => (
//       <>
//         <tr key={r.id}> ... </tr>
//         {expandedId === r.id && <tr key={`${r.id}-detail`}> ... </tr>}
//       </>
//     ))
//
// O elemento que o `map` devolve é o **fragmento**, e era ele que precisava de
// `key`. As keys lá dentro não contam: o React nunca chega a vê-las como
// identidade da lista, porque a lista é feita de fragmentos.
//
// Sem identidade estável, o React reconcilia as linhas por posição. Numa
// tabela onde cada linha tem caixa de seleção, expansão e um botão de editar
// que abre o registo, reordenar ou filtrar podia associar estado da interface
// à colaboradora errada. Não é um aviso cosmético de consola.
//
// ---------------------------------------------------------------------------
// Porque é que o teste escuta a consola
// ---------------------------------------------------------------------------
//
// Um teste que procurasse `<Fragment key=` no ficheiro provaria que alguém
// escreveu a linha. O React é a única autoridade sobre se a lista tem
// identidade — por isso o que se afirma aqui é o que ele diz ao renderizar.
// O guard estrutural no fim é apenas rede de segurança, não a prova principal.
// ============================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const CLIENTE = "src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client.tsx";
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

vi.mock("@/app/actions/payroll", () => ({
  calculateAndSavePayroll: vi.fn(),
  approvePayrollRecords: vi.fn(),
  markPayrollPaid: vi.fn(),
  adjustPayrollRecord: vi.fn(),
  getPayrollRecords: vi.fn(async () => ({ ok: false, error: "não usado" })),
}));

type Registo = import("@/app/actions/payroll").PayrollRecord;

const registo = (id: string, full_name: string): Registo => ({
  id,
  collaborator_id: "c-" + id,
  full_name,
  avatar_url: null,
  period_year: 2026,
  period_month: 8,
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

// Três linhas: uma lista de um só elemento não obriga o React a falar de
// identidade.
const REGISTOS = [
  registo("r-1", "Ana Primeira"),
  registo("r-2", "Beatriz Segunda"),
  registo("r-3", "Carla Terceira"),
];

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let avisos: string[];
let consolaErro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  // O React entrega os avisos de identidade por `console.error`. Guardá-los em
  // vez de os silenciar: o teste precisa de os ler, e esconder um aviso é
  // precisamente como este defeito sobreviveu tanto tempo.
  avisos = [];
  consolaErro = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    avisos.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consolaErro.mockRestore();
});

async function renderizar(registos: Registo[]) {
  const { PayrollClient } = await import(
    "@/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client"
  );
  await act(async () => {
    root.render(
      <PayrollClient
        initialRecords={registos}
        companyId="empresa-1"
        mesParam="2026-08"
        year={2026}
        month={8}
        mesLabel="8/2026"
        needsCalculation={false}
        expectedRecords={registos.length}
      />,
    );
  });
}

/** Avisos de identidade de lista, seja qual for a redação da versão do React. */
const avisosDeKey = () =>
  avisos.filter((a) => /unique "?key"?|unique key|key.*prop/i.test(a) && /list|child/i.test(a));

// ═══════════════════════════════════════════════════════════════════════════
// A prova: o próprio React
// ═══════════════════════════════════════════════════════════════════════════

describe("linhas da Folha têm identidade estável", () => {
  it("1. 🔴 renderizar três registos não produz aviso de key em falta", async () => {
    await renderizar(REGISTOS);

    // A mensagem completa fica visível se falhar — é a que explica o defeito.
    expect(avisosDeKey(), avisosDeKey().join("\n")).toHaveLength(0);
  });

  it("2. as três colaboradoras aparecem", async () => {
    await renderizar(REGISTOS);
    const texto = container.textContent ?? "";
    for (const r of REGISTOS) expect(texto).toContain(r.full_name);
  });

  it("3. nenhum outro aviso do React fica por explicar", async () => {
    // Não é sobre keys, mas evita que este ficheiro passe a esconder ruído
    // novo: se aparecer um aviso diferente, alguém tem de o olhar.
    await renderizar(REGISTOS);
    const inesperados = avisos.filter((a) => !/unique "?key"?/i.test(a));
    expect(inesperados, inesperados.join("\n")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rede de segurança estrutural
// ═══════════════════════════════════════════════════════════════════════════

describe("guarda estrutural da identidade das linhas", () => {
  it("4. o elemento devolvido pelo map leva key={r.id}", () => {
    const fonte = ler(CLIENTE);
    const i = fonte.indexOf("pag.pageItems.map(");
    expect(i, "map das linhas não encontrado").toBeGreaterThan(-1);

    // O primeiro elemento aberto depois do `map` é o que a lista vê.
    const depois = fonte.slice(i, i + 400);
    const primeiro = depois.match(/=>\s*\(\s*\n\s*<([A-Za-z.]*)([^>]*)>/);
    expect(primeiro, "não foi possível ler o elemento devolvido pelo map").not.toBeNull();

    const atributos = primeiro?.[2] ?? "";
    expect(atributos, "o filho direto do map tem de levar key={r.id}").toMatch(
      /\bkey=\{r\.id\}/,
    );
  });

  it("5. a identidade da linha é r.id, nunca a posição", () => {
    const fonte = ler(CLIENTE);
    // `key={i}`/`key={index}` reintroduziria o mesmo problema com outra cara:
    // a lista voltaria a ser reconciliada por posição.
    expect(fonte).not.toMatch(/\bkey=\{\s*(i|idx|index)\s*\}/);
  });

  it("6. a identidade mensal da vista continua noutra camada", () => {
    // `period.key` e `r.id` resolvem problemas diferentes; corrigir um nunca
    // pode ter substituído o outro.
    const pagina = ler("src/app/(dashboard)/dashboard/folha-pagamento/page.tsx");
    expect(pagina).toMatch(/\bkey=\{period\.key\}/);
  });
});
