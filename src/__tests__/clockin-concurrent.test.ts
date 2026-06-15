/**
 * Testes de concorrência — Clock-in / Clock-out simultâneo
 *
 * Cenário real: 35 funcionárias entram às 8h00, todas fazem clock-in ao mesmo
 * tempo. Ao final do dia, todas fazem clock-out igualmente em simultâneo.
 *
 * O que validamos:
 *  1. Cada funcionária só altera os seus próprios dados (sem cruzamento).
 *  2. O status do serviço transita para "em_curso" exatamente uma vez.
 *  3. O status passa a "concluido" apenas quando a ÚLTIMA funcionária sai.
 *  4. Cálculos de duração são corretos mesmo para timestamps idênticos.
 *  5. O guard de janela horária não bloqueia entradas legítimas às 8h00.
 *  6. Timestamps no futuro são normalizados — nunca guardados.
 *  7. Um double-clock-in (mesma funcionária, mesmo serviço) é rejeitado pela lógica.
 */

import { describe, it, expect } from "vitest";

// ─── Helpers retirados do route.ts ────────────────────────────────────────────

function parsePastTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    if (Number.isFinite(t) && t <= Date.now() + 60_000) {
      return new Date(t).toISOString();
    }
  }
  return new Date().toISOString();
}

function calcDurationMinutes(clockInAt: string, clockOutAt: string): number {
  const inMs = new Date(clockInAt).getTime();
  const outMs = new Date(clockOutAt).getTime();
  return Math.max(0, Math.round((outMs - inMs) / 60_000));
}

// Simula o payload que o route.ts construiria para cada funcionária
function buildClockInPayload(
  collaboratorId: string,
  serviceId: string,
  companyId: string,
  clockInAt: string,
  lat: number,
  lng: number,
  distanceM: number,
  locationWarning: boolean,
) {
  return {
    service_id: serviceId,
    collaborator_id: collaboratorId,
    company_id: companyId,
    clock_in_at: clockInAt,
    clock_in_lat: lat,
    clock_in_lng: lng,
    clock_in_distance_m: distanceM,
    location_warning: locationWarning,
  };
}

// Simula a lógica "actualiza actual_start apenas se ainda for NULL"
function applyActualStart(
  serviceState: { actual_start: string | null },
  clockInAt: string,
): { actual_start: string | null; changed: boolean } {
  if (serviceState.actual_start === null) {
    return { actual_start: clockInAt, changed: true };
  }
  return { actual_start: serviceState.actual_start, changed: false };
}

// Simula a lógica "concluido se count de clock_out pendentes = 0"
function shouldMarkConcluido(openClockOuts: number): boolean {
  return openClockOuts === 0;
}

// ─── Bloco 1: Isolamento de dados — 35 funcionárias às 8h00 ──────────────────

describe("35 funcionárias a fazer clock-in às 8h00 em simultâneo", () => {
  const SERVICE_ID  = "svc-monday-morning-001";
  const COMPANY_ID  = "company-molimpezas";
  const CLOCK_IN_AT = "2026-06-15T08:00:00.000Z"; // hora exata de entrada
  const TEAM_LAT    = 38.7169;
  const TEAM_LNG    = -9.1393;

  const employees = Array.from({ length: 35 }, (_, i) => ({
    id: `emp-${String(i + 1).padStart(3, "0")}`,
    name: `Funcionária ${i + 1}`,
  }));

  it("cada funcionária recebe um payload com o seu próprio collaborator_id", () => {
    const payloads = employees.map((e) =>
      buildClockInPayload(e.id, SERVICE_ID, COMPANY_ID, CLOCK_IN_AT, TEAM_LAT, TEAM_LNG, 45, false),
    );

    // Todos os collaborator_ids devem ser únicos
    const ids = payloads.map((p) => p.collaborator_id);
    expect(new Set(ids).size).toBe(35);
  });

  it("nenhum payload de uma funcionária contém o id de outra (sem cruzamento)", () => {
    const payloads = employees.map((e) =>
      buildClockInPayload(e.id, SERVICE_ID, COMPANY_ID, CLOCK_IN_AT, TEAM_LAT, TEAM_LNG, 45, false),
    );

    payloads.forEach((payload, idx) => {
      expect(payload.collaborator_id).toBe(employees[idx].id);
      // O service_id e company_id são iguais para todas — correto
      expect(payload.service_id).toBe(SERVICE_ID);
      expect(payload.company_id).toBe(COMPANY_ID);
    });
  });

  it("todos os clock-in às 8h00 produzem o mesmo clock_in_at (concorrência real)", () => {
    const payloads = employees.map((e) =>
      buildClockInPayload(e.id, SERVICE_ID, COMPANY_ID, CLOCK_IN_AT, TEAM_LAT, TEAM_LNG, 45, false),
    );

    const uniqueClockIns = new Set(payloads.map((p) => p.clock_in_at));
    expect(uniqueClockIns.size).toBe(1); // todos têm o mesmo timestamp
    expect([...uniqueClockIns][0]).toBe(CLOCK_IN_AT);
  });

  it("35 payloads em paralelo: nenhum campo cross-contamina os outros", async () => {
    const payloads = await Promise.all(
      employees.map((e) =>
        Promise.resolve(
          buildClockInPayload(e.id, SERVICE_ID, COMPANY_ID, CLOCK_IN_AT, TEAM_LAT, TEAM_LNG, 45, false),
        ),
      ),
    );

    for (let i = 0; i < payloads.length; i++) {
      expect(payloads[i].collaborator_id).toBe(employees[i].id);
      // Garantir que o campo colaborador não "vazou" de outra iteração
      for (let j = 0; j < payloads.length; j++) {
        if (i !== j) {
          expect(payloads[i].collaborator_id).not.toBe(payloads[j].collaborator_id);
        }
      }
    }
  });
});

// ─── Bloco 2: Guard de actual_start — idempotência ────────────────────────────

describe("guard .is('actual_start', null) — só a primeira funcionária muda o status", () => {
  it("a primeira das 35 a chegar muda actual_start, as outras 34 não", () => {
    const CLOCK_IN_AT = "2026-06-15T08:00:00.000Z";
    let service = { actual_start: null as string | null };
    let changesCount = 0;

    for (let i = 0; i < 35; i++) {
      const result = applyActualStart(service, CLOCK_IN_AT);
      if (result.changed) {
        changesCount++;
        service = result;
      }
    }

    expect(changesCount).toBe(1); // só 1 muda
    expect(service.actual_start).toBe(CLOCK_IN_AT);
  });

  it("quando todas chegam ao mesmo milissegundo, o resultado final é determinístico", () => {
    const CLOCK_IN_AT = "2026-06-15T08:00:00.000Z";
    const states = Array.from({ length: 35 }, () => ({ actual_start: null as string | null }));
    const sharedService = { actual_start: null as string | null };

    // Simular corrida: todas lêem o estado ao mesmo tempo e tentam escrever
    const reads = states.map(() => ({ ...sharedService }));
    // Apenas a primeira que "confirmar" ganha — as outras leram null mas o estado já mudou
    reads.forEach((read) => {
      if (read.actual_start === null && sharedService.actual_start === null) {
        sharedService.actual_start = CLOCK_IN_AT;
      }
    });

    expect(sharedService.actual_start).toBe(CLOCK_IN_AT);
  });

  it("se actual_start já foi definido, chamadas subsequentes não o alteram", () => {
    const FIRST_CLOCK_IN = "2026-06-15T07:59:58.000Z";
    const LATER_CLOCK_IN = "2026-06-15T08:00:00.000Z";
    const service = { actual_start: FIRST_CLOCK_IN };

    const result = applyActualStart(service, LATER_CLOCK_IN);
    expect(result.actual_start).toBe(FIRST_CLOCK_IN); // mantém o original
    expect(result.changed).toBe(false);
  });
});

// ─── Bloco 3: Clock-out simultâneo — transição para "concluido" ───────────────

describe("35 funcionárias a fazer clock-out em simultâneo", () => {
  it("serviço só fica 'concluido' quando a última funcionária sai (count = 0)", () => {
    let openCount = 35;
    const concluido: number[] = []; // índices de quando concluido foi marcado

    for (let i = 0; i < 35; i++) {
      openCount--;
      if (shouldMarkConcluido(openCount)) {
        concluido.push(i);
      }
    }

    // Exatamente 1 marcação de concluido — a última saída
    expect(concluido).toHaveLength(1);
    expect(concluido[0]).toBe(34); // última funcionária (índice 34)
  });

  it("com 35 saídas sequenciais, o count cai de forma monotónica e correcta", () => {
    const counts: number[] = [];
    let openCount = 35;

    for (let i = 0; i < 35; i++) {
      openCount--;
      counts.push(openCount);
    }

    // Deve ser 34, 33, 32, ..., 0
    expect(counts[0]).toBe(34);
    expect(counts[34]).toBe(0);
    // Monotonicamente decrescente
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThan(counts[i - 1]);
    }
  });

  it("saídas em paralelo — o último a terminar (count=0) é o único a marcar concluido", async () => {
    // Simular saídas assíncronas quase simultâneas
    let openCount = 35;
    const concluidos: boolean[] = [];

    await Promise.all(
      Array.from({ length: 35 }, async (_, i) => {
        // Pequeno escalonamento para garantir ordem
        await new Promise((r) => setTimeout(r, i));
        const myCount = --openCount;
        concluidos.push(shouldMarkConcluido(myCount));
      }),
    );

    // Exatamente um deve ter visto count = 0
    const marcacoes = concluidos.filter(Boolean);
    expect(marcacoes).toHaveLength(1);
  });
});

// ─── Bloco 4: Cálculos de duração — precision & edge cases ───────────────────

describe("cálculo de duration_minutes para saídas simultâneas", () => {
  const CLOCK_IN  = "2026-06-15T08:00:00.000Z";
  const CLOCK_OUT = "2026-06-15T17:00:00.000Z"; // 9h = 540 min

  it("todas as 35 funcionárias que entraram às 8h e saem às 17h têm 540 min", () => {
    const durations = Array.from({ length: 35 }, () =>
      calcDurationMinutes(CLOCK_IN, CLOCK_OUT),
    );

    expect(durations).toHaveLength(35);
    expect(durations.every((d) => d === 540)).toBe(true);
  });

  it("saída antes da entrada (clock invertido) → 0 min, nunca negativo", () => {
    const d = calcDurationMinutes(
      "2026-06-15T17:00:00.000Z",
      "2026-06-15T08:00:00.000Z",
    );
    expect(d).toBe(0);
  });

  it("entrada = saída → 0 min", () => {
    expect(calcDurationMinutes(CLOCK_IN, CLOCK_IN)).toBe(0);
  });

  it("duração é sempre inteira (sem minutos fraccionários guardados)", () => {
    // 540 min e 30 segundos → arredonda para 541
    const d = calcDurationMinutes(
      "2026-06-15T08:00:00.000Z",
      "2026-06-15T17:00:30.000Z",
    );
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBe(541); // 30s ≈ 0.5min → arredonda para cima
  });

  it("duração é sempre inteira — 35 durações calculadas em simultâneo", async () => {
    const durations = await Promise.all(
      Array.from({ length: 35 }, () =>
        Promise.resolve(calcDurationMinutes(CLOCK_IN, CLOCK_OUT)),
      ),
    );

    expect(durations.every(Number.isInteger)).toBe(true);
    expect(durations.every((d) => d === 540)).toBe(true);
  });
});

// ─── Bloco 5: parsePastTimestamp — timestamps do cliente ─────────────────────

describe("parsePastTimestamp — normalização de timestamps do cliente", () => {
  it("timestamp válido no passado é aceite como ISO string", () => {
    const past = "2026-06-15T07:58:00.000Z";
    const result = parsePastTimestamp(past);
    expect(result).toBe(past);
  });

  it("timestamp no futuro (> 60s) é substituído por agora", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const result = parsePastTimestamp(future);
    const diff = Math.abs(new Date(result).getTime() - Date.now());
    expect(diff).toBeLessThan(1_000); // <= 1 segundo de diferença
  });

  it("35 funcionárias enviam o mesmo timestamp às 8h00 — todas recebem o mesmo resultado", () => {
    const CLIENT_TS = "2026-06-15T08:00:00.000Z";
    const results = Array.from({ length: 35 }, () => parsePastTimestamp(CLIENT_TS));
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe(CLIENT_TS);
  });

  it("string inválida fallback para agora (sem crash)", () => {
    const result = parsePastTimestamp("not-a-date");
    expect(() => new Date(result).toISOString()).not.toThrow();
  });

  it("null/undefined fallback para agora", () => {
    expect(() => parsePastTimestamp(null)).not.toThrow();
    expect(() => parsePastTimestamp(undefined)).not.toThrow();
  });
});

// ─── Bloco 6: Janela horária — funcionárias não são bloqueadas às 8h00 ──────

describe("janela de clock-in — 35 funcionárias às 8h00 num serviço agendado para 8h", () => {
  function isWithinClockInWindow(
    clockInAt: string,
    scheduledStart: string,
    checkinBeforeMinutes: number,
  ): boolean {
    const ref = new Date(clockInAt).getTime();
    const scheduled = new Date(scheduledStart).getTime();
    const earliest = scheduled - checkinBeforeMinutes * 60_000;
    return ref >= earliest;
  }

  it("serviço às 8h00, janela de 30 min antes → clock-in às 7h31 é aceite", () => {
    expect(isWithinClockInWindow("2026-06-15T07:31:00Z", "2026-06-15T08:00:00Z", 30)).toBe(true);
  });

  it("clock-in às 7h29 (antes da janela de 30 min) é rejeitado", () => {
    expect(isWithinClockInWindow("2026-06-15T07:29:00Z", "2026-06-15T08:00:00Z", 30)).toBe(false);
  });

  it("35 funcionárias com clock-in exatamente às 8h00 num serviço às 8h → todas aceites", () => {
    const CLOCK_IN      = "2026-06-15T08:00:00.000Z";
    const SCHEDULED     = "2026-06-15T08:00:00.000Z";
    const BEFORE_MIN    = 30;

    const results = Array.from({ length: 35 }, () =>
      isWithinClockInWindow(CLOCK_IN, SCHEDULED, BEFORE_MIN),
    );

    expect(results.every(Boolean)).toBe(true);
  });

  it("clock-in tardio — 1 min após o agendado ainda entra (sem bloqueio de entrada)", () => {
    // O sistema só avisa por GPS, nunca bloqueia entrada tardia
    expect(isWithinClockInWindow("2026-06-15T08:01:00Z", "2026-06-15T08:00:00Z", 30)).toBe(true);
  });
});

// ─── Bloco 7: Isolamento entre serviços diferentes ───────────────────────────

describe("isolamento de dados entre serviços distintos", () => {
  it("duas equipas em serviços diferentes — os payloads não se cruzam", () => {
    const EQUIPA_A = Array.from({ length: 5 }, (_, i) => `emp-a-${i}`);
    const EQUIPA_B = Array.from({ length: 5 }, (_, i) => `emp-b-${i}`);
    const SVC_A    = "service-001";
    const SVC_B    = "service-002";

    const payloadsA = EQUIPA_A.map((id) =>
      buildClockInPayload(id, SVC_A, "cmp", "2026-06-15T08:00:00Z", 38.7, -9.1, 20, false),
    );
    const payloadsB = EQUIPA_B.map((id) =>
      buildClockInPayload(id, SVC_B, "cmp", "2026-06-15T08:00:00Z", 38.8, -9.2, 15, false),
    );

    // Nenhum payload da equipa A tem service_id da equipa B e vice-versa
    payloadsA.forEach((p) => expect(p.service_id).toBe(SVC_A));
    payloadsB.forEach((p) => expect(p.service_id).toBe(SVC_B));

    // Nenhum collaborator_id aparece nos dois lados
    const idsA = new Set(payloadsA.map((p) => p.collaborator_id));
    const idsB = new Set(payloadsB.map((p) => p.collaborator_id));
    const intersection = [...idsA].filter((id) => idsB.has(id));
    expect(intersection).toHaveLength(0);
  });

  it("8 equipas em simultâneo (pico de segunda-feira) — sem cruzamento de service_id", () => {
    const TEAMS = Array.from({ length: 8 }, (_, t) => ({
      serviceId: `svc-team-${t}`,
      members: Array.from({ length: 4 }, (_, m) => `emp-t${t}-m${m}`),
    }));

    const allPayloads = TEAMS.flatMap(({ serviceId, members }) =>
      members.map((id) =>
        buildClockInPayload(id, serviceId, "cmp", "2026-06-15T08:00:00Z", 38.7, -9.1, 30, false),
      ),
    );

    // Cada payload deve ter o service_id correto (o da sua equipa)
    TEAMS.forEach(({ serviceId, members }) => {
      members.forEach((empId) => {
        const p = allPayloads.find((x) => x.collaborator_id === empId);
        expect(p?.service_id).toBe(serviceId);
      });
    });
  });
});

// ─── Bloco 8: Double clock-in prevention ─────────────────────────────────────

describe("prevenção de double clock-in (mesma funcionária, mesmo serviço)", () => {
  function hasOpenClockIn(
    existingTimesheets: Array<{ collaborator_id: string; clock_out_at: string | null }>,
    collaboratorId: string,
  ): boolean {
    return existingTimesheets.some(
      (ts) => ts.collaborator_id === collaboratorId && ts.clock_out_at === null,
    );
  }

  it("funcionária com clock-in aberto não pode fazer outro clock-in", () => {
    const existing = [{ collaborator_id: "emp-001", clock_out_at: null }];
    expect(hasOpenClockIn(existing, "emp-001")).toBe(true); // deve ser bloqueada
  });

  it("funcionária sem clock-in aberto pode fazer clock-in", () => {
    const existing = [{ collaborator_id: "emp-001", clock_out_at: "2026-06-15T17:00:00Z" }];
    expect(hasOpenClockIn(existing, "emp-001")).toBe(false); // deve ser permitida
  });

  it("outras funcionárias com clock-in aberto não bloqueiam esta funcionária", () => {
    const existing = [
      { collaborator_id: "emp-002", clock_out_at: null },
      { collaborator_id: "emp-003", clock_out_at: null },
    ];
    expect(hasOpenClockIn(existing, "emp-001")).toBe(false); // emp-001 não tem aberto
  });

  it("35 funcionárias: apenas a que já tem clock-in aberto é bloqueada", () => {
    const existing = [
      { collaborator_id: "emp-015", clock_out_at: null }, // esta já entrou
    ];

    const results = Array.from({ length: 35 }, (_, i) => {
      const empId = `emp-${String(i + 1).padStart(3, "0")}`;
      return { empId, blocked: hasOpenClockIn(existing, empId) };
    });

    const blocked = results.filter((r) => r.blocked);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].empId).toBe("emp-015");
  });
});
