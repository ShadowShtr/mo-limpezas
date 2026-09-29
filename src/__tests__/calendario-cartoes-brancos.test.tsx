// @vitest-environment jsdom
// Calendário: todos os cartões de serviço têm fundo branco, em qualquer estado.
// O estado continua visível por um ponto de cor ao lado do nome do cliente
// (em curso, concluído, cancelado, falta); o agendado não precisa dele.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceBlock } from "@/app/(dashboard)/dashboard/calendario/_components/service-block";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const servico = (status: string) => ({
  id: `s-${status}`,
  status,
  scheduled_start: "2026-09-29T09:00:00",
  scheduled_end: "2026-09-29T11:00:00",
  client_name: `Cliente ${status}`,
  location_name: "Local",
  location_address: "Rua X, Lisboa",
  team_name: "Equipa A",
  team_color: "#0E9F6E",
  notes: null,
  payment_status: null,
  location_has_key: false,
  location_has_access_code: false,
  canSeeFinancials: true,
});

/** O elemento mais interior com exactamente este texto (não o contentor). */
const folha = (raiz: HTMLElement, texto: string) =>
  [...raiz.querySelectorAll<HTMLElement>("span")].filter((e) => e.textContent === texto && e.children.length === 0)[0]!;

async function mostrar(status: string) {
  await act(async () => {
    root.render(
      <DndContext>
        <ServiceBlock service={servico(status) as never} slotHeight={20} startHour={7} teamId="t1" />
      </DndContext>,
    );
  });
  return host.querySelector<HTMLElement>('[role="button"]')!;
}

describe("calendário — cartões com fundo branco", () => {
  for (const status of ["agendado", "em_curso", "concluido", "cancelado", "falta"]) {
    it(`${status}: fundo branco`, async () => {
      const cartao = await mostrar(status);
      expect(cartao.style.backgroundColor).toBe("rgb(255, 255, 255)");
    });
  }

  it("🔴 texto como nos cartões de Prédios: cores do design system, sem transparência", async () => {
    const cartao = await mostrar("agendado");
    const nome = folha(cartao, "Cliente agendado");
    // jsdom descarta `var(...)` em `style.color`; o atributo guarda-o tal e qual.
    expect(nome.getAttribute("style")).toContain("color: var(--color-text-main)");
    for (const el of cartao.querySelectorAll<HTMLElement>("span")) expect(el.style.opacity).toBe("");
    expect(cartao.className).not.toContain("brightness");
  });

  it("🔴 equipa em etiqueta com a cor da equipa e texto branco, como nos Prédios", async () => {
    const cartao = await mostrar("agendado");
    const etiqueta = folha(cartao, "Equipa A");
    expect(etiqueta.style.backgroundColor).toBe("rgb(14, 159, 110)");
    expect(etiqueta.className).toContain("text-white");
    expect(cartao.getAttribute("style")).toContain("var(--color-border)");
  });

  it("agendado não leva ponto de estado", async () => {
    await mostrar("agendado");
    expect(host.querySelector("[data-status-dot]")).toBeNull();
  });

  for (const [status, cor, rotulo] of [
    ["em_curso", "rgb(245, 158, 11)", "Em curso"],
    ["concluido", "rgb(148, 163, 184)", "Concluído"],
    ["cancelado", "rgb(220, 38, 38)", "Cancelado"],
    ["falta", "rgb(220, 38, 38)", "Falta"],
  ] as const) {
    it(`${status}: o estado continua visível pelo ponto de cor`, async () => {
      await mostrar(status);
      const ponto = host.querySelector<HTMLElement>(`[data-status-dot="${status}"]`);
      expect(ponto).not.toBeNull();
      expect(ponto!.style.backgroundColor).toBe(cor);
      expect(ponto!.getAttribute("title")).toBe(rotulo);
    });
  }
});

// A grelha por trás dos cartões também é branca: as colunas das equipas não
// tinham fundo e mostravam o cinzento da página; a de Prédios tinha um cinzento
// translúcido próprio. Guarda estática — o render do calendário inteiro exige
// dados e contexto que este teste não precisa de montar.
describe("calendário — fundo da grelha branco", () => {
  const ler = (f: string) => readFileSync(join(process.cwd(), "src/app/(dashboard)/dashboard/calendario/_components", f), "utf8");
  it("contentor da grelha e colunas das equipas com bg-white", () => {
    const v = ler("calendar-view.tsx");
    expect(v).toMatch(/className="flex-1 overflow-auto calendar-scroll bg-white"/);
    expect(v).toMatch(/className="flex-1 relative border-l border-\[var\(--color-border\)\] cursor-crosshair bg-white"/);
  });
  it("coluna de Prédios sem o cinzento translúcido", () => {
    const b = ler("buildings-column.tsx");
    expect(b).not.toContain("bg-[var(--color-background)]/40");
  });
});
