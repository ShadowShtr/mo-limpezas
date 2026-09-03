import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filterClientes } from "@/app/(dashboard)/dashboard/contratos/_components/cliente-search";

const SHEET = fileURLToPath(new URL(
  "../app/(dashboard)/dashboard/contratos/_components/sheet.tsx",
  import.meta.url,
));
const SELECT = fileURLToPath(new URL(
  "../app/(dashboard)/dashboard/contratos/_components/cliente-search-select.tsx",
  import.meta.url,
));

const clientes = [
  { id: "1", name: "João Silva" },
  { id: "2", name: "Maria Silva" },
  { id: "3", name: "Maria dos Santos" },
];

describe("pesquisa local de clientes", () => {
  it("mostra todos os clientes inicialmente", () => {
    expect(filterClientes(clientes, "")).toEqual(clientes);
  });

  it("filtra por substring sem distinguir maiúsculas", () => {
    expect(filterClientes(clientes, "MARIA").map((cliente) => cliente.id)).toEqual(["2", "3"]);
    expect(filterClientes(clientes, "silva").map((cliente) => cliente.id)).toEqual(["1", "2"]);
  });

  it("encontra acentos com uma pesquisa sem acentos", () => {
    expect(filterClientes(clientes, "joao")).toEqual([clientes[0]]);
  });

  it("devolve zero resultados quando não encontra correspondência", () => {
    expect(filterClientes(clientes, "inexistente")).toEqual([]);
  });
});

describe("contrato estrutural do seletor de clientes", () => {
  const sheet = readFileSync(SHEET, "utf8");
  const select = readFileSync(SELECT, "utf8");

  it("seleciona o cliente e limpa o local anterior", () => {
    expect(sheet).toContain("onChange={(id) => { setClienteId(id); setLocalId(\"\"); }}");
  });

  it("mantém a seleção inicial em edição/cópia e suporta cliente fixo", () => {
    expect(sheet).toContain("value={clienteId}");
    expect(sheet).toContain("fixedClientId={fixedClientId}");
    expect(select).toContain("disabled={!!fixedClientId}");
  });

  it("expõe a experiência de teclado e o estado vazio", () => {
    expect(select).toContain('placeholder="Pesquisar cliente..."');
    expect(select).toContain('role="listbox"');
    expect(select).toContain('event.key === "ArrowDown"');
    expect(select).toContain('event.key === "ArrowUp"');
    expect(select).toContain('event.key === "Enter"');
    expect(select).toContain('event.key === "Escape"');
    expect(select).toContain("Nenhum cliente encontrado.");
    expect(select).toContain("max-h-60 overflow-y-auto");
  });
});
