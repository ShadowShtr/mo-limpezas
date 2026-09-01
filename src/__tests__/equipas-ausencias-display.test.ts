import { describe, expect, it } from "vitest";
import { absenceDisplay, absenceTypeLabel } from "@/lib/equipas/ausencias";

describe("ausências na equipa efetiva", () => {
  it("um dia termina com regresso no dia seguinte", () => {
    expect(absenceDisplay({
      collaborator_id: "p1",
      absence_type: "ferias",
      starts_on: "2026-09-01",
      ends_on: "2026-09-01",
    })).toEqual({
      typeLabel: "Férias",
      departureLabel: "01/09",
      returnLabel: "02/09",
    });
  });

  it("multi-day usa o primeiro dia ausente e regresso depois do último", () => {
    expect(absenceDisplay({
      collaborator_id: "p1",
      absence_type: "formacao",
      starts_on: "2026-09-01",
      ends_on: "2026-09-07",
    })).toEqual({
      typeLabel: "Formação",
      departureLabel: "01/09",
      returnLabel: "08/09",
    });
  });

  it("cruzar ano mostra o ano para não ficar ambíguo", () => {
    expect(absenceDisplay({
      collaborator_id: "p1",
      absence_type: "doenca_com_baixa",
      starts_on: "2026-12-31",
      ends_on: "2026-12-31",
    })).toEqual({
      typeLabel: "Doença com baixa",
      departureLabel: "31/12/2026",
      returnLabel: "01/01/2027",
    });
  });

  it("o label usa absence_type, nunca o id da pessoa", () => {
    expect(absenceTypeLabel("pessoal_justificado")).toBe("Ausência pessoal justificada");
    expect(absenceTypeLabel("id-de-pessoa-que-nao-e-tipo")).toBe("Ausente");
  });
});
