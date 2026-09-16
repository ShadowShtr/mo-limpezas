// ============================================================================
// CRM — o funil, e a promessa de que o código e a base dizem a mesma coisa
// ============================================================================
//
// Duas famílias de teste, com valor muito diferente:
//
//   · as regras puras (transições, pesos, etiquetas) — provam-se aqui, sem
//     base de dados, porque são código puro;
//
//   · a paridade com a migration 101 — lê o SQL e compara as listas. 🔴 Isto
//     **não** prova que a tabela existe em produção, e não é essa a intenção:
//     `crm-leads-schema.pg.test.ts` é que aplica a migration a um Postgres a
//     sério. O que este bloco apanha é a divergência que nasce depois, quando
//     alguém acrescenta um estado num sítio e esquece o outro — e a interface
//     passa a oferecer um valor que a base recusa.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_COLORS,
  LEAD_STAGE_WEIGHTS,
  CLOSED_STAGES,
  allowedTransitions,
  canTransition,
  isClosedStage,
  isLeadStage,
  requiresLostReason,
  requiresConversion,
  type LeadStage,
} from "@/lib/crm/stages";
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_LOST_REASONS,
  LEAD_LOST_REASON_LABELS,
  LEAD_VALUE_KINDS,
  LEAD_INTERACTION_KINDS,
  MANUAL_INTERACTION_KINDS,
  isLeadSource,
  isLeadLostReason,
  isLeadValueKind,
  isLeadInteractionKind,
} from "@/lib/crm/sources";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/101_crm_leads.sql"),
  "utf8",
);

/**
 * Extrai a lista de um `CHECK (... IN ('a', 'b'))` pelo nome da coluna.
 *
 * Deliberadamente simples: se a migration mudar de forma ao ponto de isto
 * deixar de casar, o teste falha por não encontrar nada — que é o
 * comportamento certo. Um extractor esperto que encontrasse "qualquer coisa"
 * daria verde sobre uma leitura errada.
 */
function valoresDoCheck(coluna: string): string[] {
  // 🔴 O `\\b` inicial não é decoração. Sem ele, procurar `kind` casava dentro
  //    de `estimated_value_kind` e devolvia a lista errada — o teste ficava
  //    verde a comparar a coisa errada com a coisa errada.
  const re = new RegExp(`\\b${coluna}\\b[\\s\\S]{0,400}?IN \\(([^)]*)\\)`, "m");
  const m = SQL.match(re);
  if (!m) throw new Error(`CHECK de ${coluna} não encontrado na 101`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("CRM — paridade entre o código e a migration 101", () => {
  it("os estados do funil são exactamente os do CHECK", () => {
    expect([...LEAD_STAGES].sort()).toEqual(valoresDoCheck("stage").sort());
  });

  it("as origens são exactamente as do CHECK", () => {
    expect([...LEAD_SOURCES].sort()).toEqual(valoresDoCheck("source").sort());
  });

  it("os motivos de perda são exactamente os do CHECK", () => {
    expect([...LEAD_LOST_REASONS].sort()).toEqual(valoresDoCheck("lost_reason").sort());
  });

  it("a natureza do valor é exactamente a do CHECK", () => {
    expect([...LEAD_VALUE_KINDS].sort()).toEqual(valoresDoCheck("estimated_value_kind").sort());
  });

  it("os tipos de interacção são exactamente os do CHECK", () => {
    expect([...LEAD_INTERACTION_KINDS].sort()).toEqual(valoresDoCheck("kind").sort());
  });
});

describe("CRM — cada valor tem etiqueta, e nenhuma sobra", () => {
  it("todos os estados têm etiqueta e cor", () => {
    for (const s of LEAD_STAGES) {
      expect(LEAD_STAGE_LABELS[s], `estado ${s} sem etiqueta`).toBeTruthy();
      expect(LEAD_STAGE_COLORS[s], `estado ${s} sem cor`).toBeTruthy();
    }
    expect(Object.keys(LEAD_STAGE_LABELS).sort()).toEqual([...LEAD_STAGES].sort());
  });

  it("todas as origens e motivos têm etiqueta", () => {
    expect(Object.keys(LEAD_SOURCE_LABELS).sort()).toEqual([...LEAD_SOURCES].sort());
    expect(Object.keys(LEAD_LOST_REASON_LABELS).sort()).toEqual([...LEAD_LOST_REASONS].sort());
  });

  it("as etiquetas estão em português, não no valor cru", () => {
    expect(LEAD_STAGE_LABELS.orcamento_enviado).toBe("Orçamento enviado");
    expect(LEAD_SOURCE_LABELS.recomendacao).toBe("Recomendação");
    expect(LEAD_LOST_REASON_LABELS.escolheu_concorrente).toBe("Escolheu outra empresa");
  });
});

describe("CRM — as guardas de tipo recusam o que não conhecem", () => {
  it("aceitam o que é válido", () => {
    expect(isLeadStage("ganho")).toBe(true);
    expect(isLeadSource("passagem")).toBe(true);
    expect(isLeadLostReason("preco")).toBe(true);
    expect(isLeadValueKind("mensal")).toBe(true);
    expect(isLeadInteractionKind("sistema")).toBe(true);
  });

  it("recusam valores inventados, e tudo o que não é string", () => {
    expect(isLeadStage("fechado")).toBe(false);
    expect(isLeadSource("tiktok")).toBe(false);
    expect(isLeadLostReason("porque sim")).toBe(false);
    expect(isLeadValueKind("anual")).toBe(false);
    for (const v of [null, undefined, 42, {}, [], true]) {
      expect(isLeadStage(v)).toBe(false);
      expect(isLeadSource(v)).toBe(false);
    }
  });
});

describe("CRM — as transições do funil", () => {
  it("🔴 'ganho' é terminal: a conversão já criou um cliente real", () => {
    expect(allowedTransitions("ganho")).toHaveLength(0);
    for (const destino of LEAD_STAGES) {
      expect(canTransition("ganho", destino), `ganho → ${destino} devia ser recusado`).toBe(false);
    }
  });

  it("uma lead perdida pode voltar ao funil — o cliente reaparece meses depois", () => {
    expect(canTransition("perdido", "contactado")).toBe(true);
    expect(canTransition("perdido", "orcamento_enviado")).toBe(true);
  });

  it("não é uma escada: dá para ir de contactado direto a orçamento, sem visita", () => {
    expect(canTransition("contactado", "orcamento_enviado")).toBe(true);
  });

  it("nenhum estado transita para si próprio — arrastar para a coluna onde já está não é mudança", () => {
    for (const s of LEAD_STAGES) {
      expect(canTransition(s, s), `${s} → ${s} devia ser recusado`).toBe(false);
    }
  });

  it("todo o destino oferecido é um estado real", () => {
    for (const s of LEAD_STAGES) {
      for (const destino of allowedTransitions(s)) {
        expect(isLeadStage(destino)).toBe(true);
      }
    }
  });

  it("qualquer estado aberto consegue chegar a ganho e a perdido", () => {
    for (const s of LEAD_STAGES) {
      if (isClosedStage(s)) continue;
      expect(canTransition(s, "ganho"), `${s} devia poder ser ganho`).toBe(true);
      expect(canTransition(s, "perdido"), `${s} devia poder ser perdido`).toBe(true);
    }
  });
});

describe("CRM — o que cada estado exige", () => {
  it("espelha os CHECK da 101: perder exige motivo, ganhar exige conversão", () => {
    expect(requiresLostReason("perdido")).toBe(true);
    expect(requiresConversion("ganho")).toBe(true);

    for (const s of LEAD_STAGES) {
      if (s === "perdido") continue;
      expect(requiresLostReason(s), `${s} não devia exigir motivo`).toBe(false);
    }
    for (const s of LEAD_STAGES) {
      if (s === "ganho") continue;
      expect(requiresConversion(s), `${s} não devia exigir conversão`).toBe(false);
    }
  });

  it("os estados fechados são exactamente ganho e perdido", () => {
    expect([...CLOSED_STAGES].sort()).toEqual(["ganho", "perdido"]);
    expect(isClosedStage("novo")).toBe(false);
  });
});

describe("CRM — os pesos do funil", () => {
  it("todos os estados têm peso, entre 0 e 1", () => {
    for (const s of LEAD_STAGES) {
      const p = LEAD_STAGE_WEIGHTS[s];
      expect(p, `estado ${s} sem peso`).toBeTypeOf("number");
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("ganho vale tudo e perdido vale zero", () => {
    expect(LEAD_STAGE_WEIGHTS.ganho).toBe(1);
    expect(LEAD_STAGE_WEIGHTS.perdido).toBe(0);
  });

  it("avançar no funil nunca vale menos do que o passo anterior", () => {
    const ordem: LeadStage[] = ["novo", "contactado", "visita_agendada", "orcamento_enviado", "ganho"];
    for (let i = 1; i < ordem.length; i++) {
      expect(
        LEAD_STAGE_WEIGHTS[ordem[i]],
        `${ordem[i]} devia valer pelo menos tanto como ${ordem[i - 1]}`,
      ).toBeGreaterThan(LEAD_STAGE_WEIGHTS[ordem[i - 1]]);
    }
  });
});

describe("CRM — o diário de contactos", () => {
  it("🔴 'sistema' não se escolhe à mão: é prova do que o sistema fez", () => {
    expect(MANUAL_INTERACTION_KINDS).not.toContain("sistema");
    expect(LEAD_INTERACTION_KINDS).toContain("sistema");
  });

  it("tudo o resto pode ser registado por uma pessoa", () => {
    expect(MANUAL_INTERACTION_KINDS).toHaveLength(LEAD_INTERACTION_KINDS.length - 1);
  });
});
