// ============================================================================
// AVISOS — elegibilidade, ordem e entrega em lotes
// ============================================================================
// As regras que decidem o que aparece no ecrã, testadas sem base nem React.
//
// 🔴 A regra que este ficheiro protege acima de todas: **nada é marcado como
//    lido sem o utilizador confirmar**. O backlog resolve-se entregando três
//    de cada vez, não gravando `read_at` que nunca aconteceu.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  AUTOMATIC_RELEASE_BATCH_SIZE,
  UPDATE_NOTICES_SYSTEM_ACTIVATED_AT,
  releaseElegivel,
  releasesPorMostrar,
  selecionarCiclo,
} from "@/domain/update-notices/eligibility";
import type { NoticeForDisplay, ReleaseNote } from "@/domain/update-notices/types";
import { RELEASE_NOTES } from "@/release-notes";

const ACTIVATED = "2026-08-19T00:00:00.000Z";

function nota(key: string, publishedAt: string): ReleaseNote {
  return { key, publishedAt, kind: "novidade", title: `T ${key}`, message: `M ${key}` };
}

function display(key: string, publishedAt: string, source: "release" | "manual"): NoticeForDisplay {
  return { key, publishedAt, kind: "aviso", title: key, message: key, source };
}

describe("elegibilidade — dois cortes, não um", () => {
  it("nota posterior ao perfil e à activação é elegível", () => {
    expect(releaseElegivel(nota("a", "2026-08-20T10:00:00Z"), "2026-01-01T00:00:00Z", ACTIVATED)).toBe(true);
  });

  it("🔴 perfil criado depois da nota não a recebe", () => {
    // Quem entrou hoje não precisa de saber o que mudou antes de existir.
    expect(releaseElegivel(nota("a", "2026-08-20T10:00:00Z"), "2026-08-25T00:00:00Z", ACTIVATED)).toBe(false);
  });

  it("🔴 nota anterior à activação do sistema não chega a ninguém", () => {
    // Sem este corte, o primeiro arranque despejava changelog histórico que
    // nunca ninguém esperou receber.
    expect(releaseElegivel(nota("a", "2026-05-01T10:00:00Z"), "2026-01-01T00:00:00Z", ACTIVATED)).toBe(false);
  });

  it("vale o mais tardio dos dois cortes", () => {
    const perfilAntigo = "2026-01-01T00:00:00Z";
    const perfilNovo = "2026-09-01T00:00:00Z";
    const n = nota("a", "2026-08-20T10:00:00Z");
    expect(releaseElegivel(n, perfilAntigo, ACTIVATED)).toBe(true);
    expect(releaseElegivel(n, perfilNovo, ACTIVATED)).toBe(false);
  });

  it("data inválida não é elegível — nunca por omissão", () => {
    expect(releaseElegivel(nota("a", "não é data"), "2026-01-01T00:00:00Z", ACTIVATED)).toBe(false);
  });

  it("a constante de activação existe e é uma data real", () => {
    expect(Number.isNaN(Date.parse(UPDATE_NOTICES_SYSTEM_ACTIVATED_AT))).toBe(false);
  });
});

describe("🔴 entrega em lotes — sem parede, sem leituras falsas", () => {
  it("três releases por ciclo, as mais recentes primeiro", () => {
    const muitas = Array.from({ length: 14 }, (_, i) =>
      display(`r${i}`, `2026-08-${String(i + 1).padStart(2, "0")}T10:00:00Z`, "release"),
    );

    const ciclo = selecionarCiclo(muitas);

    expect(ciclo).toHaveLength(AUTOMATIC_RELEASE_BATCH_SIZE);
    // As três mais recentes: r13, r12, r11.
    expect(ciclo.map((n) => n.key)).toEqual(["r13", "r12", "r11"]);
  });

  it("as restantes continuam por ler — não são marcadas nem descartadas", () => {
    const muitas = Array.from({ length: 14 }, (_, i) =>
      display(`r${i}`, `2026-08-${String(i + 1).padStart(2, "0")}T10:00:00Z`, "release"),
    );

    const ciclo = selecionarCiclo(muitas);
    const mostradas = new Set(ciclo.map((n) => n.key));
    const porMostrar = muitas.filter((n) => !mostradas.has(n.key));

    // 11 continuam na fonte. `selecionarCiclo` é pura: não escreve nada.
    expect(porMostrar).toHaveLength(11);
  });

  it("🔴 avisos manuais vêm todos e não contam para o lote", () => {
    const entrada = [
      ...Array.from({ length: 10 }, (_, i) => display(`r${i}`, `2026-08-${String(i + 1).padStart(2, "0")}T10:00:00Z`, "release")),
      display("m1", "2026-08-20T10:00:00Z", "manual"),
      display("m2", "2026-08-21T10:00:00Z", "manual"),
      display("m3", "2026-08-22T10:00:00Z", "manual"),
      display("m4", "2026-08-23T10:00:00Z", "manual"),
    ];

    const ciclo = selecionarCiclo(entrada);

    // 4 manuais + 3 releases. Se alguém publicou para uma conta, tem de chegar.
    expect(ciclo.filter((n) => n.source === "manual")).toHaveLength(4);
    expect(ciclo.filter((n) => n.source === "release")).toHaveLength(3);
  });

  it("manuais aparecem antes das releases", () => {
    const ciclo = selecionarCiclo([
      display("r1", "2026-08-25T10:00:00Z", "release"),
      display("m1", "2026-08-20T10:00:00Z", "manual"),
    ]);
    // Mesmo sendo mais antigo, o manual vem primeiro.
    expect(ciclo[0].key).toBe("m1");
  });

  it("a ordem é determinística quando as datas empatam", () => {
    const mesmaData = "2026-08-20T10:00:00Z";
    const a = selecionarCiclo([display("zz", mesmaData, "release"), display("aa", mesmaData, "release")]);
    const b = selecionarCiclo([display("aa", mesmaData, "release"), display("zz", mesmaData, "release")]);
    expect(a.map((n) => n.key)).toEqual(b.map((n) => n.key));
  });

  it("nada por ler devolve lista vazia", () => {
    expect(selecionarCiclo([])).toEqual([]);
  });
});

describe("releasesPorMostrar — leitura e elegibilidade juntas", () => {
  const notas = [
    nota("a", "2026-08-20T10:00:00Z"),
    nota("b", "2026-08-21T10:00:00Z"),
    nota("c", "2026-05-01T10:00:00Z"), // anterior à activação
  ];

  it("exclui as já lidas", () => {
    const r = releasesPorMostrar(notas, "2026-01-01T00:00:00Z", new Set(["a"]), ACTIVATED);
    expect(r.map((n) => n.key)).toEqual(["b"]);
  });

  it("exclui as anteriores à activação", () => {
    const r = releasesPorMostrar(notas, "2026-01-01T00:00:00Z", new Set(), ACTIVATED);
    expect(r.map((n) => n.key).sort()).toEqual(["a", "b"]);
  });

  it("marca a origem como release", () => {
    const r = releasesPorMostrar(notas, "2026-01-01T00:00:00Z", new Set(), ACTIVATED);
    expect(r.every((n) => n.source === "release")).toBe(true);
  });
});

describe("as notas versionadas", () => {
  it("🔴 as chaves são únicas — duas notas com a mesma key partilhariam a leitura", () => {
    const chaves = RELEASE_NOTES.map((n) => n.key);
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it("todas têm data válida, título e mensagem", () => {
    for (const n of RELEASE_NOTES) {
      expect(Number.isNaN(Date.parse(n.publishedAt)), `${n.key}: data inválida`).toBe(false);
      expect(n.title.trim().length, `${n.key}: sem título`).toBeGreaterThan(0);
      expect(n.message.trim().length, `${n.key}: sem mensagem`).toBeGreaterThan(0);
    }
  });

  it("🔴 nenhuma nota expõe detalhe técnico a quem usa o sistema", () => {
    // «Corrigimos a marcação de pagamentos» é útil. «ALTER TABLE
    // cash_flow_entries DROP CONSTRAINT» não é, e assusta sem informar.
    const proibido = /migration|constraint|RLS|RPC|checksum|\bSQL\b|schema|commit|deploy/i;
    for (const n of RELEASE_NOTES) {
      expect(proibido.test(n.title), `${n.key}: título com jargão`).toBe(false);
      expect(proibido.test(n.message), `${n.key}: mensagem com jargão`).toBe(false);
    }
  });

  it("a primeira nota é a do Financeiro e anexos", () => {
    const primeira = RELEASE_NOTES.find((n) => n.key === "2026-08-19-financeiro-e-anexos");
    expect(primeira).toBeDefined();
    expect(primeira?.title).toBe("Financeiro e anexos mais estáveis");
  });
});
