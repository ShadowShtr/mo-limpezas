// ============================================================================
// PARIDADE DE SCHEMA DA pgcrypto — a extensão vive em `extensions`, não em `public`
// ============================================================================
//
// O false green que isto fecha, e porque é que passou despercebido.
//
// Num projeto Supabase a `pgcrypto` é instalada no schema `extensions`:
//
//     to_regprocedure('public.digest(bytea,text)')      →  NULL
//     to_regprocedure('extensions.digest(bytea,text)')  →  PRESENTE
//
// A 094 pedia `public.digest(bytea,text)` na precondição e chamava
// `public.digest(...)` no cálculo do hash do pedido. Contra produção isso
// pararia a migration — depois de 090..093 já terem sido aplicadas, que é o
// pior momento possível para uma cadeia parar.
//
// Não foi apanhado porque as suites faziam `CREATE EXTENSION pgcrypto` sem
// `WITH SCHEMA extensions`. Num PostgreSQL descartável isso instala `digest`
// em `public`, e a 094 passava contra um pré-estado que NÃO é o do Supabase.
// O ensaio confirmava a migration contra uma forma que produção não tem.
//
// Este ficheiro fixa as duas metades:
//
//   1. o layout real reproduzido à letra — `digest` em `extensions`, ausente
//      de `public` — e a 094 corrigida a aplicar-se contra ele;
//   2. a REGRESSÃO: a forma antiga (`public.digest`) recusada contra esse mesmo
//      layout. Sem esta metade, provaríamos apenas que a versão nova funciona,
//      e não que a antiga estava errada — e nada impediria alguém de a repor.
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `pgcparity-${process.pid}`;
const ler = (f: string) => readFileSync(join(ROOT, f), "utf8");

let container: PostgresContainer;
let pool: pg.Pool;

/**
 * O layout do Supabase, e não o do `CREATE EXTENSION` por omissão: a extensão
 * é criada explicitamente em `extensions`, e `public` fica sem `digest`.
 */
async function layoutSupabase() {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS extensions CASCADE;
    CREATE SCHEMA public;
    CREATE SCHEMA extensions;
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  `);
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "pgcparity",
    serverFlags: ["shared_buffers=16MB", "max_connections=15", "work_mem=1MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 3 });
  await layoutSupabase();
}, 180_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

describe("pgcrypto — o schema real do Supabase", () => {
  it("🔴 o layout de produção: digest em `extensions`, ausente de `public`", async () => {
    const { rows } = await pool.query(`
      SELECT to_regprocedure('public.digest(bytea,text)')::text      AS publico,
             to_regprocedure('extensions.digest(bytea,text)')::text  AS extensao
    `);
    expect(rows[0].publico).toBeNull();
    expect(rows[0].extensao).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A regressão, fixada pela negativa.
  //
  // Reproduz a forma ANTIGA da 094 — o que o ficheiro dizia antes desta ronda
  // — contra o layout real. Tem de ser recusada. Se algum dia passar, alguém
  // repôs a dependência de `public.digest` e o defeito voltou.
  // ─────────────────────────────────────────────────────────────────────────
  it("🔴 PRE_FIX: a precondição antiga (`public.digest`) RECUSA neste layout", async () => {
    await expect(
      pool.query(`
        DO $pre$
        BEGIN
          IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN
            RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: pgcrypto.digest(bytea,text) ausente';
          END IF;
        END
        $pre$;
      `),
    ).rejects.toThrow(/INVOICES_PERIOD_094_PRECONDITION_FAILED/);
  });

  it("🔴 PRE_FIX: a chamada antiga `public.digest(...)` não resolve neste layout", async () => {
    await expect(
      pool.query(`SELECT encode(public.digest(convert_to('x', 'UTF8'), 'sha256'::text), 'hex')`),
    ).rejects.toThrow(/function public\.digest.* does not exist/i);
  });

  it("POST_FIX: a precondição qualificada aceita este layout", async () => {
    await pool.query(`
      DO $pos$
      BEGIN
        IF to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
          RAISE EXCEPTION 'INVOICES_PERIOD_094_PRECONDITION_FAILED: extensions.digest(bytea,text) ausente';
        END IF;
      END
      $pos$;
    `);
  });

  it("POST_FIX: `extensions.digest(...)` produz o sha256 esperado", async () => {
    const { rows } = await pool.query(
      `SELECT encode(extensions.digest(convert_to($1, 'UTF8'), 'sha256'::text), 'hex') AS h`,
      ["mo-limpezas"],
    );
    // O mesmo valor que `sha256` do PostgreSQL 11+ dá para a mesma entrada: o
    // ponto não é o dígito, é que a função chamada é de facto sha256 e não
    // outra coisa com o mesmo nome.
    const { rows: nativo } = await pool.query(
      `SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h`,
      ["mo-limpezas"],
    );
    expect(rows[0].h).toBe(nativo[0].h);
  });
});

describe("094 — aplica-se contra o layout real do Supabase", () => {
  it("🔴 a 094 corrigida não depende de `public.digest`", () => {
    const sql = ler("supabase/migrations/094_invoices_period_atomic.sql");

    // Sem comentários: uma menção numa nota explicativa não é uma dependência.
    const codigo = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");

    expect(codigo).not.toContain("public.digest(");
    expect(codigo).toContain("extensions.digest(");
    expect(codigo).toContain("to_regprocedure('extensions.digest(bytea,text)')");
  });

  it("🔴 nenhuma migration da stack 090..097 depende de `public.digest`", () => {
    for (const n of ["090", "091", "092", "093", "094", "095", "096", "097"]) {
      const ficheiro = `supabase/migrations/${n}_`;
      const nome = readdirSync(join(ROOT, "supabase/migrations"))
        .find((f: string) => f.startsWith(n + "_"));
      if (!nome) continue;
      const codigo = ler(`supabase/migrations/${nome}`)
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");
      expect(codigo, `${ficheiro} não pode depender de public.digest`).not.toContain("public.digest(");
    }
  });

  it("🔴 o search_path da função NÃO foi alargado para mascarar a dependência", () => {
    const sql = ler("supabase/migrations/094_invoices_period_atomic.sql");
    // A qualificação é explícita; acrescentar `extensions` ao search_path
    // esconderia a dependência em vez de a declarar.
    expect(sql).not.toMatch(/SET search_path\s*=\s*[^\n]*extensions/);
  });

  it("🔴 não foi criado wrapper `public.digest` para contornar o problema", () => {
    const sql = ler("supabase/migrations/094_invoices_period_atomic.sql");
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.digest/i);
  });
});
