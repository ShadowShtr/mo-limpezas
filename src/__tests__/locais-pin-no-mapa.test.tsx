// @vitest-environment jsdom
// ============================================================================
// LOCAIS — marcar o ponto à mão quando a morada não é encontrada
// ============================================================================
// O problema real: a pesquisa de morada (Nominatim/OSM) não encontra muitas
// moradas de Portugal — vielas, prédios sem número, zonas industriais. Sem
// coordenadas, o botão "Navegar" da app abre o Google Maps só com o texto da
// morada e a equipa pode não chegar ao sítio.
//
// Três coisas que só um teste de comportamento prova, e que uma leitura do
// ficheiro não distinguiria de código partido:
//
//   1. o pin marcado à mão chega mesmo ao payload de gravação, em `lat`/`lng`,
//      sem nenhum outro campo se perder pelo caminho;
//   2. quando a pesquisa não devolve nada, o texto que a gestora escreveu é
//      preservado como morada — não pode ser substituído por vazio só porque
//      os campos estruturados ficaram por preencher;
//   3. o contador "sem ponto no mapa" conta ausência de coordenadas, e não
//      qualquer outra coisa parecida.
//
// O `PinPicker` é substituído por um duplo: o componente real monta um mapa
// MapLibre, que precisa de WebGL e não existe em jsdom. O que interessa provar
// aqui é o contrato entre ele e o formulário — `onChange(lat, lng)` —, não o
// desenho do mapa.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Payload = Record<string, unknown>;

const createLocation = vi.fn<(input: Payload) => Promise<{ ok: true }>>(
  async () => ({ ok: true as const }),
);
const updateLocation = vi.fn<(id: string, input: Payload) => Promise<{ ok: true }>>(
  async () => ({ ok: true as const }),
);

vi.mock("@/app/actions/locations", () => ({
  createLocation: (input: Payload) => createLocation(input),
  updateLocation: (id: string, input: Payload) => updateLocation(id, input),
  deleteLocation: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

// Duplo do mapa: um botão que marca o ponto, tal como o toque no mapa real.
vi.mock("@/components/map/pin-picker", () => ({
  PinPicker: ({ onChange }: { onChange: (lat: number, lng: number) => void }) => (
    <button type="button" data-testid="marcar-pin" onClick={() => onChange(38.712345, -9.139876)}>
      marcar
    </button>
  ),
}));

// Sem isto o React avisa a cada `act(...)` que o ambiente não o suporta, e o
// ruído esconde o que os ensaios estão mesmo a dizer.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLIENTES = [{ id: "cli-1", name: "Cliente A" }];

let container: HTMLDivElement;
let root: Root;

function limpar() {
  if (root) act(() => root.unmount());
  container?.remove();
}

function porTexto(texto: string): HTMLElement | null {
  return Array.from(container.querySelectorAll("button, span, p")).find(
    (el) => el.textContent?.includes(texto),
  ) as HTMLElement | null;
}

function escrever(el: HTMLInputElement, valor: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, valor);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // A pesquisa não encontra nada — é exatamente o caso que motivou a
  // funcionalidade. Sem isto o componente iria à rede a sério.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  limpar();
  vi.unstubAllGlobals();
});

async function abrirFicha(local?: Record<string, unknown>) {
  const { LocalSheet } = await import(
    "@/app/(dashboard)/dashboard/locais/_components/sheet"
  );
  await act(async () => {
    root.render(
      <LocalSheet
        trigger={<button>abrir</button>}
        companyId="empresa-1"
        clientes={CLIENTES}
        local={local as never}
      />,
    );
  });
  const abrir = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "abrir",
  )!;
  await act(async () => { abrir.click(); });
}

/** Sem ponto marcado o mapa já vem aberto — é esse o ponto desta ficha. Só
 *  clica no que abre quando, por alguma razão, ele estiver fechado. */
async function abrirMapa() {
  if (document.querySelector('[data-testid="marcar-pin"]')) return;
  const botao = Array.from(document.querySelectorAll("button")).find((b) =>
    ["Marcar no mapa", "Ver / corrigir pin", "Abrir mapa"].some((t) => b.textContent?.includes(t)),
  );
  if (!botao) throw new Error("não há forma de abrir o mapa a partir da ficha do local");
  await act(async () => { botao.click(); });
}

/** A pesquisa espera 420ms antes de ir à rede. Deixar esse temporizador
 *  disparar fora de `act` fazia o React avisar a cada ensaio — e o aviso
 *  escondia o que os ensaios estavam mesmo a dizer. Esperar por ele também
 *  torna o caminho "não encontrei nada" determinístico, em vez de acidental. */
async function aguardarPesquisa() {
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
}

async function marcarPin() {
  const marcar = document.querySelector('[data-testid="marcar-pin"]') as HTMLButtonElement | null;
  if (!marcar) throw new Error("o mapa não está montado");
  await act(async () => { marcar.click(); });
}

async function submeter() {
  const form = document.getElementById("local-form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** O painel monta-se num portal, fora do `container`. */
function campoPorEtiqueta(etiqueta: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const label = labels.find((l) => l.textContent?.includes(etiqueta));
  const campo = label?.parentElement?.querySelector("input");
  if (!campo) throw new Error(`campo "${etiqueta}" não encontrado`);
  return campo as HTMLInputElement;
}

describe("o mapa tem de estar à vista, não escondido atrás de um link", () => {
  // 🔴 Origem: a dona abriu "Novo local", escreveu a morada, e disse
  //    «não aparece o ponto para abrir e marcar no mapa». O mapa estava lá —
  //    fechado atrás de um link de texto pequeno, ao lado de uma etiqueta.
  //    Quem tem exatamente o problema que isto resolve não o encontrava.
  it("🔴 num local novo o mapa aparece sem ser preciso descobrir nada", async () => {
    await abrirFicha();
    expect(
      document.querySelector('[data-testid="marcar-pin"]'),
      "sem ponto marcado, o mapa tem de estar aberto de origem",
    ).toBeTruthy();
  });

  it("🔴 ao editar um local antigo sem coordenadas, também abre logo", async () => {
    await abrirFicha({
      id: "loc-9", name: "Escritório", address: "Rua Antiga 4", lat: null, lng: null,
      hourly_rate: null, fixed_price: null, pricing_type: "hourly", active: true,
      client_id: "cli-1", access_code: null, instructions: null, has_key: false, key_label: null,
    });
    expect(document.querySelector('[data-testid="marcar-pin"]')).toBeTruthy();
  });

  it("com o ponto já marcado recolhe, para não alongar o painel à toa", async () => {
    await abrirFicha({
      id: "loc-1", name: "Escritório", address: "Rua A", lat: 38.7, lng: -9.1,
      hourly_rate: null, fixed_price: null, pricing_type: "hourly", active: true,
      client_id: "cli-1", access_code: null, instructions: null, has_key: false, key_label: null,
    });
    expect(document.querySelector('[data-testid="marcar-pin"]')).toBeFalsy();
    expect(
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Ver / corrigir pin"),
      ),
      "mas continua a haver como voltar lá",
    ).toBe(true);
  });

  it("🔴 marcar o ponto no mapa não fecha o mapa debaixo da mão de quem o usa", async () => {
    await abrirFicha();
    await marcarPin();
    expect(
      document.querySelector('[data-testid="marcar-pin"]'),
      "passou a haver ponto, mas quem o marcou estava a olhar para o mapa",
    ).toBeTruthy();
  });
});

describe("criar um local cuja morada a pesquisa não encontra", () => {
  it("🔴 grava as coordenadas do pin marcado à mão", async () => {
    await abrirFicha();

    escrever(campoPorEtiqueta("Nome do local"), "Prédio sem número");
    escrever(campoPorEtiqueta("Pesquisar morada"), "Travessa do Pinheiro, Alenquer");
    await aguardarPesquisa();

    await abrirMapa();
    await marcarPin();
    await submeter();

    expect(createLocation).toHaveBeenCalledTimes(1);
    const payload = createLocation.mock.calls[0][0];
    expect(payload.lat).toBe(38.712345);
    expect(payload.lng).toBe(-9.139876);
  });

  it("🔴 preserva o texto escrito como morada quando não há sugestões", async () => {
    await abrirFicha();

    escrever(campoPorEtiqueta("Nome do local"), "Prédio sem número");
    escrever(campoPorEtiqueta("Pesquisar morada"), "Travessa do Pinheiro, Alenquer");
    await aguardarPesquisa();

    await abrirMapa();
    await marcarPin();
    await submeter();

    const payload = createLocation.mock.calls[0][0];
    expect(payload.address).toBe("Travessa do Pinheiro, Alenquer");
  });

  it("não perde os outros campos do local ao marcar o pin", async () => {
    await abrirFicha();

    escrever(campoPorEtiqueta("Nome do local"), "Prédio sem número");
    escrever(campoPorEtiqueta("Pesquisar morada"), "Travessa do Pinheiro");
    escrever(campoPorEtiqueta("Código do prédio"), "1234#");
    await aguardarPesquisa();

    await abrirMapa();
    await marcarPin();
    await submeter();

    const payload = createLocation.mock.calls[0][0];
    expect(payload.name).toBe("Prédio sem número");
    expect(payload.access_code).toBe("1234#");
    expect(payload.client_id).toBe("cli-1");
    expect(payload.company_id).toBe("empresa-1");
    expect(payload.active).toBe(true);
  });
});

describe("editar um local antigo que ficou sem coordenadas", () => {
  const ANTIGO = {
    id: "loc-9",
    name: "Escritório",
    address: "Rua Antiga 4, Lisboa",
    lat: null,
    lng: null,
    hourly_rate: 12,
    fixed_price: null,
    pricing_type: "hourly" as const,
    active: true,
    client_id: "cli-1",
    access_code: null,
    instructions: null,
    has_key: false,
    key_label: null,
  };

  it("🔴 passa a ter lat/lng sem trocar de registo nem perder a morada", async () => {
    await abrirFicha(ANTIGO);

    await abrirMapa();
    await marcarPin();
    await submeter();

    expect(updateLocation).toHaveBeenCalledTimes(1);
    const [id, payload] = updateLocation.mock.calls[0];
    expect(id, "o local editado é o mesmo registo").toBe("loc-9");
    expect(payload.lat).toBe(38.712345);
    expect(payload.lng).toBe(-9.139876);
    expect(payload.address).toBe("Rua Antiga 4, Lisboa");
    expect(payload.hourly_rate).toBe(12);
  });
});

describe("contador de locais sem ponto no mapa", () => {
  const base = {
    hourly_rate: null, fixed_price: null, pricing_type: "hourly" as const, active: true,
    client_id: "cli-1", access_code: null, instructions: null, has_key: false, key_label: null,
  };
  const LOCAIS = [
    { ...base, id: "a", name: "Com pin", address: "Rua A", lat: 38.7, lng: -9.1 },
    { ...base, id: "b", name: "Sem pin", address: "Rua B", lat: null, lng: null },
    { ...base, id: "c", name: "Também sem", address: "Rua C", lat: null, lng: null },
  ];

  async function montarTabela() {
    const { LocaisTable } = await import(
      "@/app/(dashboard)/dashboard/locais/_components/table"
    );
    await act(async () => {
      root.render(<LocaisTable locais={LOCAIS} clientes={CLIENTES} companyId="empresa-1" />);
    });
  }

  it("conta apenas os que não têm coordenadas", async () => {
    await montarTabela();
    expect(porTexto("2 sem ponto no mapa")).toBeTruthy();
  });

  it("🔴 filtrar mostra só os locais sem coordenadas", async () => {
    await montarTabela();
    const botao = porTexto("2 sem ponto no mapa") as HTMLButtonElement;
    await act(async () => { botao.click(); });

    const linhas = Array.from(container.querySelectorAll("tbody tr"));
    const nomes = linhas.map((l) => l.textContent ?? "");
    expect(nomes.some((n) => n.includes("Sem pin"))).toBe(true);
    expect(nomes.some((n) => n.includes("Também sem"))).toBe(true);
    expect(nomes.some((n) => n.includes("Com pin"))).toBe(false);
  });
});
