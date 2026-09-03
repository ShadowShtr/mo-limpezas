import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { startPostgresContainer } from "./helpers/pg-container";

const docker = (a: string[]) => spawnSync("docker", a, { encoding: "utf8" });
const NAME = `probe-fail-${process.pid}`;

describe("helper de contentor", () => {
  it("remove o contentor quando a prontidão falha", async () => {
    // Flag inválida: o postgres arranca e morre. O helper deve detectar que o
    // contentor parou, falhar com os logs, e não deixar nada atrás.
    await expect(startPostgresContainer({
      name: NAME, database: "probe", serverFlags: ["shared_buffers=NAO_E_UM_TAMANHO"], readyTimeoutMs: 30_000,
    })).rejects.toThrow();
    const left = docker(["ps", "-aq", "--filter", `name=${NAME}`]).stdout.trim();
    expect(left).toBe("");
  }, 90_000);
});
