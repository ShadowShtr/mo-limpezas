import { describe, it, expect } from "vitest";
import {
  buildSearchUrl,
  composeAddress,
  formatCoord,
  parseAddress,
  roundCoord,
} from "@/lib/geocoding";

describe("buildSearchUrl", () => {
  it("acrescenta Portugal e restringe o país", () => {
    const url = buildSearchUrl("Rua das Flores 10");
    expect(url).toContain(encodeURIComponent("Rua das Flores 10, Portugal"));
    expect(url).toContain("countrycodes=pt");
    expect(url).toContain("addressdetails=1");
  });

  it("não duplica Portugal quando já vem na pesquisa", () => {
    const url = buildSearchUrl("Lisboa, Portugal");
    expect(url).toContain(encodeURIComponent("Lisboa, Portugal"));
    expect(url).not.toContain(encodeURIComponent("Portugal, Portugal"));
  });

  it("escapa caracteres que partiriam o URL", () => {
    const url = buildSearchUrl("Rua & Nº 3?");
    expect(url).not.toMatch(/[?&]q=[^&]*&(?!format)/);
    expect(url).toContain("%26");
  });
});

describe("parseAddress", () => {
  it("usa os campos alternativos quando não há road/city", () => {
    expect(parseAddress({ pedestrian: "Largo do Chiado", suburb: "Misericórdia" })).toEqual({
      road: "Largo do Chiado",
      houseNumber: "",
      postalCode: "",
      city: "Misericórdia",
    });
  });

  it("nunca devolve undefined para um resultado vazio ou nulo", () => {
    expect(parseAddress(null)).toEqual({ road: "", houseNumber: "", postalCode: "", city: "" });
    expect(parseAddress(undefined)).toEqual({ road: "", houseNumber: "", postalCode: "", city: "" });
  });

  it("prefere road a pedestrian e city a municipality", () => {
    const parsed = parseAddress({
      road: "Rua A",
      pedestrian: "Rua B",
      city: "Lisboa",
      municipality: "Grande Lisboa",
      house_number: "10",
      postcode: "1200-001",
    });
    expect(parsed).toEqual({ road: "Rua A", houseNumber: "10", postalCode: "1200-001", city: "Lisboa" });
  });
});

describe("composeAddress", () => {
  it("junta rua, número, complemento, código postal e cidade", () => {
    expect(
      composeAddress({
        road: "Rua das Flores",
        houseNumber: "10",
        complement: "2º Dto",
        postalCode: "1150-007",
        city: "Lisboa",
      }),
    ).toBe("Rua das Flores 10, 2º Dto, 1150-007 Lisboa");
  });

  it("omite as partes em falta sem deixar vírgulas soltas", () => {
    expect(composeAddress({ road: "Rua A", houseNumber: "", postalCode: "", city: "Alenquer" })).toBe(
      "Rua A, Alenquer",
    );
    expect(composeAddress({ road: "", houseNumber: "", postalCode: "", city: "" })).toBe("");
  });

  it("ignora espaços em branco à volta dos campos", () => {
    expect(composeAddress({ road: "  Rua A  ", houseNumber: " 3 ", postalCode: " ", city: " Vialonga " })).toBe(
      "Rua A 3, Vialonga",
    );
  });
});

describe("roundCoord / formatCoord", () => {
  it("arredonda a 6 casas decimais", () => {
    expect(roundCoord(38.72234567891)).toBe(38.722346);
    expect(roundCoord(-9.1)).toBe(-9.1);
  });

  it("formata sempre com 6 casas, mesmo em valores redondos", () => {
    expect(formatCoord(38.7, -9)).toBe("38.700000, -9.000000");
  });
});
