// ============================================================================
// 078 — serialização da sequência com DUAS ligações reais (P0I-hardening)
// ============================================================================
//
// Este ficheiro existe porque uma prova estava em falta e eu não a queria
// deixar como está.
//
// O PGlite é Postgres a sério, mas de uma só ligação: consegue provar que a
// sequência é monotónica dentro de uma sessão e que `UNIQUE(company_id,
// sequence)` impede um duplicado. Não consegue provar aquilo para que
// `next_company_sequence` foi escrita — que **duas transações simultâneas**
// obtêm números diferentes sem que nenhuma falhe.
//
// A distinção não é académica:
//
//   «a constraint impede corrupção»   → uma das duas requests rebenta
//   «as duas serializam»              → as duas passam, com N e N+1
//
// A primeira é uma rede de segurança. A segunda é o comportamento pretendido.
// Aceitar a primeira como prova da segunda seria dizer que um sistema que
// falha metade dos pedidos concorrentes está correto.
//
// ---------------------------------------------------------------------------
// Como corre
// ---------------------------------------------------------------------------
//
// Precisa de um Postgres real com duas ligações. No CI vem de um service
// container (ver .github/workflows/quality.yml). Localmente, define
// `TEST_DATABASE_URL` e corre; sem essa variável o ficheiro é ignorado, para
// não falhar em máquinas sem Postgres.
//
// A base é descartável e criada do zero em cada execução. Nunca toca em
// produção — há uma verificação explícita disso mais abaixo.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// `pg` não traz tipos e `@types/pg` não está instalado. Acrescentar uma
// dependência só para tipar um ficheiro de teste seria alargar a superfície do
// projeto pela razão errada — a forma que este teste usa cabe em cinco linhas.
interface Ligacao {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}
interface ModuloPg { Client: new (config: { connectionString?: string }) => Ligacao }

const pg = createRequire(import.meta.url)("pg") as ModuloPg;

const URL_TESTE = process.env.TEST_DATABASE_URL;

const RAIZ = process.cwd();
const SQL_078 = fs.readFileSync(
  path.join(RAIZ, "supabase", "migrations", "078_domain_mutation_change_event_foundation.sql"),
  "utf8",
);

const EMPRESA_A = "11111111-1111-1111-1111-111111111111";
const EMPRESA_B = "22222222-2222-2222-2222-222222222222";

// `describe.skipIf` mantém o ficheiro válido onde não há Postgres, em vez de
// o transformar num falso verde silencioso: quando corre, corre a sério.
describe.skipIf(!URL_TESTE)("sequência por empresa com duas ligações reais", () => {
  let a: Ligacao;
  let b: Ligacao;

  beforeAll(async () => {
    // 🔴 Uma salvaguarda que não custa nada e evita a pior classe de engano:
    //    este ficheiro cria e apaga tabelas.
    if (/supabase\.co|supabase\.in/.test(URL_TESTE!)) {
      throw new Error("TEST_DATABASE_URL aponta para um Supabase. Este teste cria e apaga tabelas.");
    }

    const setup = new pg.Client({ connectionString: URL_TESTE });
    await setup.connect();
    await setup.query(`
      DROP TABLE IF EXISTS public.company_change_events, public.domain_mutations,
                           public.company_sync_state, public.companies, public._migrations CASCADE;
      DROP FUNCTION IF EXISTS public.next_company_sequence(uuid);
      DROP FUNCTION IF EXISTS public.lock_domain_mutation(uuid, uuid);

      CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
      INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B');

      CREATE TABLE public._migrations (
        name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public._migrations (name, checksum)
      VALUES ('077_secure_migrations_ledger.sql', 'checksum-077');
    `.replace("$1", `'${EMPRESA_A}'`).replace("$2", `'${EMPRESA_B}'`));

    await setup.query(SQL_078);
    await setup.end();

    a = new pg.Client({ connectionString: URL_TESTE });
    b = new pg.Client({ connectionString: URL_TESTE });
    await a.connect();
    await b.connect();
  }, 60_000);

  afterAll(async () => {
    await a?.end().catch(() => {});
    await b?.end().catch(() => {});
  });

  it("🔴 duas transações simultâneas na MESMA empresa obtêm N e N+1 — sem falhas", async () => {
    // O overlap é real: ambas abrem transação antes de qualquer uma pedir a
    // sequência. Sem serialização, as duas leriam o mesmo valor.
    await a.query("BEGIN");
    await b.query("BEGIN");

    const pedidoA = a.query<{ next_company_sequence: string }>(
      "SELECT public.next_company_sequence($1)", [EMPRESA_A]);

    // Dar tempo a que A tenha mesmo o lock antes de B pedir — é assim que se
    // força a contenção em vez de esperar que o acaso a produza.
    await new Promise((r) => setTimeout(r, 120));

    const pedidoB = b.query<{ next_company_sequence: string }>(
      "SELECT public.next_company_sequence($1)", [EMPRESA_A]);

    const [rA] = await Promise.all([pedidoA]);
    await a.query("COMMIT");
    const rB = await pedidoB;
    await b.query("COMMIT");

    const seqA = Number(rA.rows[0].next_company_sequence);
    const seqB = Number(rB.rows[0].next_company_sequence);

    // Nenhuma rebentou, e os números são distintos e consecutivos.
    expect(new Set([seqA, seqB]).size).toBe(2);
    expect(Math.abs(seqA - seqB)).toBe(1);
    expect(Math.min(seqA, seqB)).toBe(1);
  }, 30_000);

  it("nenhuma das duas falha com unique violation nem com deadlock", async () => {
    // O ponto do teste anterior dito ao contrário: a serialização é o
    // comportamento, não o acidente evitado pela constraint.
    const resultados = await Promise.allSettled([
      (async () => {
        await a.query("BEGIN");
        const r = await a.query("SELECT public.next_company_sequence($1)", [EMPRESA_A]);
        await a.query("COMMIT");
        return r;
      })(),
      (async () => {
        await b.query("BEGIN");
        const r = await b.query("SELECT public.next_company_sequence($1)", [EMPRESA_A]);
        await b.query("COMMIT");
        return r;
      })(),
    ]);

    const falhas = resultados.filter((r) => r.status === "rejected");
    expect(falhas.map((f) => (f as PromiseRejectedResult).reason?.message ?? "")).toEqual([]);
  }, 30_000);

  it("dez pedidos concorrentes produzem dez números distintos e contíguos", async () => {
    const ligacoes: Ligacao[] = await Promise.all(
      Array.from({ length: 10 }, async (): Promise<Ligacao> => {
        const c = new pg.Client({ connectionString: URL_TESTE });
        await c.connect();
        return c;
      }),
    );

    try {
      const antes = await a.query<{ sequence: string }>(
        "SELECT sequence FROM public.company_sync_state WHERE company_id = $1", [EMPRESA_B]);
      const base = Number(antes.rows[0]?.sequence ?? 0);

      const nums = await Promise.all(ligacoes.map(async (c: Ligacao) => {
        const r = await c.query<{ next_company_sequence: string }>(
          "SELECT public.next_company_sequence($1)", [EMPRESA_B]);
        return Number(r.rows[0].next_company_sequence);
      }));

      expect(new Set(nums).size).toBe(10);
      expect([...nums].sort((x, y) => x - y))
        .toEqual(Array.from({ length: 10 }, (_, i) => base + i + 1));
    } finally {
      await Promise.all(ligacoes.map((c: Ligacao) => c.end().catch(() => {})));
    }
  }, 60_000);

  it("empresas diferentes não se bloqueiam entre si", async () => {
    // Se o lock fosse global, isto serializaria sem necessidade — e a
    // fundação passaria a ser um estrangulamento para todo o sistema.
    await a.query("BEGIN");
    await a.query("SELECT public.next_company_sequence($1)", [EMPRESA_A]);

    // B pede para OUTRA empresa enquanto A ainda tem a sua transação aberta.
    const inicio = Date.now();
    await b.query("BEGIN");
    await b.query("SELECT public.next_company_sequence($1)", [EMPRESA_B]);
    await b.query("COMMIT");
    const decorrido = Date.now() - inicio;

    await a.query("COMMIT");

    // Não esperou pelo commit de A.
    expect(decorrido).toBeLessThan(2000);
  }, 30_000);

  it("🔴 a mesma mutation concorrente serializa no advisory lock", async () => {
    const mut = "abcdabcd-0000-0000-0000-000000000001";

    await a.query("BEGIN");
    await a.query("SELECT public.lock_domain_mutation($1, $2)", [EMPRESA_A, mut]);

    let bEntrou = false;
    const pedidoB = (async () => {
      await b.query("BEGIN");
      await b.query("SELECT public.lock_domain_mutation($1, $2)", [EMPRESA_A, mut]);
      bEntrou = true;
      await b.query("COMMIT");
    })();

    await new Promise((r) => setTimeout(r, 300));
    // B ainda está à espera: é isto que dá sentido ao replay idempotente —
    // sem a espera, as duas fariam o trabalho de negócio em paralelo.
    expect(bEntrou).toBe(false);

    await a.query("COMMIT");
    await pedidoB;
    expect(bEntrou).toBe(true);
  }, 30_000);

  it("o recibo continua único sob concorrência", async () => {
    const mut = "abcdabcd-0000-0000-0000-000000000002";
    const gravar = (c: Ligacao) => c.query(
      `SELECT public.complete_domain_mutation($1,$2,'contracts','create_contract','h','succeeded')`,
      [EMPRESA_A, mut]);

    const r = await Promise.allSettled([gravar(a), gravar(b)]);
    const oks = r.filter((x) => x.status === "fulfilled");
    expect(oks).toHaveLength(1);

    const total = await a.query<{ n: string }>(
      "SELECT count(*) AS n FROM public.domain_mutations WHERE mutation_id = $1", [mut]);
    expect(Number(total.rows[0].n)).toBe(1);
  }, 30_000);
});
