import { spawnSync } from "node:child_process";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createBarrier, startPostgresContainer } from "./helpers/pg-container";

const docker = (a: string[]) => spawnSync("docker", a, { encoding: "utf8" });
const NAME = `probe-fail-${process.pid}`;

describe("helper de contentor", () => {
  it("isola execuções com o mesmo prefixo e cada stop remove apenas o seu contentor", async () => {
    const first = await startPostgresContainer({ name: `probe-parallel-${process.pid}`, database: "probe_a" });
    const second = await startPostgresContainer({ name: `probe-parallel-${process.pid}`, database: "probe_b" });

    try {
      expect(first.name).not.toBe(second.name);

      const clients = [new pg.Client(first.connection), new pg.Client(first.connection)];
      await Promise.all(clients.map((client) => client.connect()));
      const barrier = createBarrier(2);
      const results = await Promise.all(clients.map(async (client) => {
        await barrier.wait();
        return Number((await client.query("SELECT 1 AS ok")).rows[0].ok);
      }));
      await Promise.all(clients.map((client) => client.end()));
      expect(results).toEqual([1, 1]);

      first.stop();
      const survivor = new pg.Client(second.connection);
      await survivor.connect();
      expect(Number((await survivor.query("SELECT 1 AS ok")).rows[0].ok)).toBe(1);
      await survivor.end();
    } finally {
      first.stop();
      second.stop();
    }
  }, 180_000);

  it("remove o contentor quando a prontidão falha", async () => {
    // Flag inválida: o postgres arranca e morre. O helper deve detectar que o
    // contentor parou, falhar com os logs, e não deixar nada atrás.
    await expect(startPostgresContainer({
      name: NAME, database: "probe", serverFlags: ["shared_buffers=NAO_E_UM_TAMANHO"], readyTimeoutMs: 30_000,
    })).rejects.toThrow();
    const left = docker(["ps", "-aq", "--filter", `name=${NAME}`]).stdout.trim();
    expect(left).toBe("");
  }, 90_000);

  it("uma falha com o mesmo prefixo não remove uma execução existente", async () => {
    const prefix = `probe-owner-${process.pid}`;
    const running = await startPostgresContainer({ name: prefix, database: "owner_ok" });
    try {
      await expect(startPostgresContainer({
        name: prefix,
        database: "owner_fail",
        serverFlags: ["shared_buffers=NAO_E_UM_TAMANHO"],
        readyTimeoutMs: 30_000,
      })).rejects.toThrow();

      const client = new pg.Client(running.connection);
      await client.connect();
      expect(Number((await client.query("SELECT 1 AS ok")).rows[0].ok)).toBe(1);
      await client.end();
    } finally {
      running.stop();
    }
  }, 120_000);
});
