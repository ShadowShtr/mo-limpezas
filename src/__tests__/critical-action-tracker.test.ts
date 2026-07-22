import { describe, expect, it } from "vitest";
import {
  beginCriticalAction,
  endCriticalAction,
  hasCriticalActionInFlight,
} from "@/lib/critical-action-tracker";

// Cobre o contador partilhado que a atualização automática do PWA
// (pwa-register.tsx) usa para nunca recarregar a app a meio de um
// clock-in/out (ver critical-action-tracker.ts e clock-button.tsx).

describe("critical-action-tracker", () => {
  it("começa sem nenhuma ação em curso", () => {
    expect(hasCriticalActionInFlight()).toBe(false);
  });

  it("marca em curso entre begin e end", () => {
    beginCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(true);
    endCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(false);
  });

  it("suporta ações sobrepostas (só liberta quando todas terminarem)", () => {
    beginCriticalAction();
    beginCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(true);
    endCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(true); // ainda há uma em curso
    endCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(false);
  });

  it("nunca fica negativo com end a mais (chamada extra por engano)", () => {
    endCriticalAction();
    endCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(false);
    beginCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(true);
    endCriticalAction();
    expect(hasCriticalActionInFlight()).toBe(false);
  });
});
