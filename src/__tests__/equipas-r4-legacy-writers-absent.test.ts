import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("Equipas R4 — writers legados ausentes", () => {
  it("src/app/actions/equipas.ts não existe", () => {
    expect(existsSync(join(ROOT, "src", "app", "actions", "equipas.ts"))).toBe(false);
  });

  it("vehicles.ts não exporta writers individuais de vehicle_allocations", () => {
    const src = readFileSync(join(ROOT, "src", "app", "actions", "vehicles.ts"), "utf8");
    expect(src).not.toMatch(/export\s+async\s+function\s+upsertAllocation\b/);
    expect(src).not.toMatch(/export\s+async\s+function\s+removeAllocation\b/);
  });
});
