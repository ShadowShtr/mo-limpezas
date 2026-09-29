// @vitest-environment jsdom
// Calendário: todos os cartões de serviço têm fundo branco, em qualquer estado.
// O estado continua visível por um ponto de cor ao lado do nome do cliente
// (em curso, concluído, cancelado, falta); o agendado não precisa dele.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DndContext } from "@dnd-kit/core";
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
