// ============================================================================
// 078 — fundação de mutation, change event e sequência por empresa (P0I)
// ============================================================================
//
// Corre a migration REAL, lida do ficheiro versionado, contra PGlite. Nunca
// toca em produção.
//
// A 078 não cria um outbox novo: adota o esqueleto que o incidente de
// 2026-08-05 deixou materializado e vazio em produção. Por isso os testes
// centrais não são «as tabelas foram criadas», são:
//
//   · o caminho de base nova e o caminho de produção legada terminam no
//     MESMO fingerprint canónico;
//   · um shape que não reconhecemos aborta em vez de ser «corrigido»;
//   · uma única linha nas tabelas legadas aborta antes de qualquer DROP.
//
// ---------------------------------------------------------------------------
// O que PGlite prova, e o que não prova
// ---------------------------------------------------------------------------
//
// PGlite é Postgres real, mas de **uma só ligação**: não há forma de ter duas
// sessões concorrentes. Duas instâncias são bases independentes — verificado.
// O daemon do Docker não está a correr nesta máquina, portanto também não há
// Postgres descartável.
//
// Consequência, declarada e não disfarçada:
//
//   SEQUENCE_MONOTONIC_SINGLE_SESSION = PROVEN
//   SEQUENCE_UNIQUENESS_CONSTRAINT    = PROVEN
//   SEQUENCE_TWO_CONNECTION_RACE      = NOT_PROVEN
//
// A distinção importa. `FOR UPDATE` é o que evita a colisão; `UNIQUE
// (company_id, sequence)` é o que a torna impossível de gravar. A segunda é
// testável aqui e é a garantia final — mas dizer que a serialização está
// provada exigiria duas ligações a sério.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();
const FICHEIRO = "078_domain_mutation_change_event_foundation.sql";
const SQL_078 = fs.readFileSync(path.join(RAIZ, "supabase", "migrations", FICHEIRO), "utf8");

const EMPRESA_A = "11111111-1111-1111-1111-111111111111";
const EMPRESA_B = "22222222-2222-2222-2222-222222222222";

/** Base mínima: só `companies`, que é o alvo das chaves estrangeiras. */
async function baseNova() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);

    -- O ledger com a 077 registada: a 078 exige o predecessor.
    CREATE TABLE public._migrations (
      name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public._migrations (name, checksum)
    VALUES ('077_secure_migrations_ledger.sql', 'checksum-077');
  `);
  await db.query("INSERT INTO public.companies (id, name) VALUES ($1,$2), ($3,$4)",
    [EMPRESA_A, "Mó", EMPRESA_B, "Outra"]);
  return db;
}

/**
 * O esqueleto órfão, exatamente como a caracterização o encontrou:
 * `affected_range tstzrange`, `delivered_at`, e `domain_mutations` sem
 * `operation`/`request_hash`/`completed_at`.
 */
async function producaoLegada(over: { extraColuna?: string } = {}) {
  const db = await baseNova();
  await db.exec(`
    CREATE TABLE public.company_change_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      sequence bigint NOT NULL,
      mutation_id uuid NOT NULL,
      domain text NOT NULL,
      event_type text NOT NULL,
      entity_ids uuid[] NOT NULL,
      scopes text[] NOT NULL,
      affected_range tstzrange,
      payload jsonb NOT NULL,
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
      ${over.extraColuna ? `, ${over.extraColuna}` : ""}
    );

    CREATE TABLE public.domain_mutations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      mutation_id uuid NOT NULL,
      domain text NOT NULL,
      status text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    GRANT ALL ON TABLE public.company_change_events TO anon, authenticated;
    GRANT ALL ON TABLE public.domain_mutations TO anon, authenticated;
  `);
  return db;
}

/** As RPCs de negócio em quarentena — a 078 não lhes pode tocar. */
async function comRpcOrfas(db: PGlite) {
  await db.exec(`
    CREATE FUNCTION public.delete_client_atomic(
      p_company_id uuid, p_client_id uuid, p_actor uuid,
      p_mutation_id uuid, p_expected_revision int
    ) RETURNS jsonb LANGUAGE plpgsql AS $f$
    BEGIN RETURN jsonb_build_object('ok', true, 'origem', 'orfa'); END $f$;

    CREATE FUNCTION public.set_invoice_status_atomic(
      p_company_id uuid, p_invoice_id uuid, p_status text, p_payment_method text,
      p_actor uuid, p_mutation_id uuid, p_expected_revision int
    ) RETURNS jsonb LANGUAGE plpgsql AS $f$
    BEGIN RETURN jsonb_build_object('ok', true, 'origem', 'orfa'); END $f$;
  `);
  return db;
}

const aplicar = (db: PGlite) => db.exec(SQL_078);

/** Base sem o ledger, ou com a 077 por registar — para provar a pré-condição. */
async function semPredecessor({ comLedger = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  `);
  if (comLedger) {
    await db.exec(`CREATE TABLE public._migrations (
      name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now());`);
  }
  return db;
}

/** Fingerprint canónico: colunas, tipos e nulidade, ordenados. */
async function fingerprint(db: PGlite, tabela: string) {
  const r = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`, [tabela],
  );
  return r.rows.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`);
}

const assinaturas = async (db: PGlite, nome: string) => {
  const r = await db.query<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1 ORDER BY sig`, [nome],
  );
  return r.rows.map((x) => x.sig);
};

const privilegios = async (db: PGlite, tabela: string, role: string) => {
  const r = await db.query<{ privilege_type: string }>(
    `SELECT privilege_type FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name=$1 AND grantee=$2`, [tabela, role],
  );
  return r.rows.map((x) => x.privilege_type);
};

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — os dois caminhos terminam no mesmo sítio
// ═══════════════════════════════════════════════════════════════════════════

describe("A+B+E. base nova e produção legada convergem", () => {
  it("A. base nova → estrutura canónica", async () => {
    const db = await baseNova();
    await aplicar(db);

    expect(await fingerprint(db, "company_change_events")).toEqual([
      "affected_from:date:YES", "affected_to:date:YES",
      "company_id:uuid:NO", "created_at:timestamp with time zone:NO",
      "domain:text:NO", "entity_ids:ARRAY:NO", "event_type:text:NO",
      "id:uuid:NO", "mutation_id:uuid:NO", "payload:jsonb:NO",
      "scopes:ARRAY:NO", "sequence:bigint:NO",
    ]);
  });

  it("B. produção legada → mesma estrutura canónica", async () => {
    const db = await producaoLegada();
    await aplicar(db);

    const f = await fingerprint(db, "company_change_events");
    expect(f).not.toContain("affected_range:tstzrange:YES");
    expect(f).not.toContain("delivered_at:timestamp with time zone:YES");
    expect(f).toContain("affected_from:date:YES");
    expect(f).toContain("affected_to:date:YES");
  });

  it("🔴 os dois caminhos produzem fingerprints idênticos", async () => {
    // Se divergirem, uma base nova e a produção deixam de ser o mesmo sistema —
    // e o replay das migrations do zero deixa de provar o que se pensa.
    const nova = await baseNova(); await aplicar(nova);
    const legada = await producaoLegada(); await aplicar(legada);

    for (const t of ["company_change_events", "domain_mutations", "company_sync_state"]) {
      expect(await fingerprint(legada, t), t).toEqual(await fingerprint(nova, t));
    }
  });

  it("AA. domain_mutations ganha operation, request_hash e completed_at", async () => {
    const db = await producaoLegada();
    await aplicar(db);
    const f = await fingerprint(db, "domain_mutations");
    expect(f).toContain("operation:text:NO");
    expect(f).toContain("request_hash:text:NO");
    expect(f).toContain("completed_at:timestamp with time zone:NO");
    expect(f).toContain("entity_id:uuid:YES");
  });

  it("E. company_sync_state é criada", async () => {
    const db = await producaoLegada();
    await aplicar(db);
    expect(await fingerprint(db, "company_sync_state")).toEqual([
      "company_id:uuid:NO", "sequence:bigint:NO", "updated_at:timestamp with time zone:NO",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — os guards, que são a razão de isto ser seguro
// ═══════════════════════════════════════════════════════════════════════════

describe("C+D. a migration recusa-se a adivinhar", () => {
  it("D. 🔴 uma única linha em company_change_events aborta antes de qualquer DROP", async () => {
    const db = await producaoLegada();
    await db.query(
      `INSERT INTO public.company_change_events
       (company_id, sequence, mutation_id, domain, event_type, entity_ids, scopes, payload)
       VALUES ($1, 1, gen_random_uuid(), 'contracts', 'x', '{}', '{}', '{}')`, [EMPRESA_A],
    );

    await expect(aplicar(db)).rejects.toThrow(/NONEMPTY_LEGACY_TABLE/);

    // E a coluna antiga continua lá — nada ficou a meio.
    expect(await fingerprint(db, "company_change_events")).toContain("affected_range:tstzrange:YES");
  });

  it("D2. 🔴 uma linha em domain_mutations aborta do mesmo modo", async () => {
    const db = await producaoLegada();
    await db.query(
      `INSERT INTO public.domain_mutations (company_id, mutation_id, domain, status, result)
       VALUES ($1, gen_random_uuid(), 'contracts', 'succeeded', '{}')`, [EMPRESA_A],
    );

    await expect(aplicar(db)).rejects.toThrow(/NONEMPTY_LEGACY_TABLE/);
    expect(await fingerprint(db, "domain_mutations")).not.toContain("request_hash:text:NO");
  });

  it("C. 🔴 shape desconhecido aborta em vez de ser «corrigido»", async () => {
    // Uma coluna obrigatória que não esperávamos significa que a base não é a
    // que caracterizámos. Fazer caber seria adivinhar.
    const db = await producaoLegada({ extraColuna: "coluna_inesperada text NOT NULL DEFAULT 'x'" });
    // A coluna extra por si não dispara — o que dispara é qualquer divergência
    // nas que verificamos. Trocamos o tipo de uma delas:
    await db.exec("ALTER TABLE public.company_change_events ALTER COLUMN domain TYPE varchar(50);");

    await expect(aplicar(db)).rejects.toThrow(/LEGACY_SCHEMA_UNEXPECTED/);
  });

  it("C2. coluna esperada em falta aborta", async () => {
    const db = await producaoLegada();
    await db.exec("ALTER TABLE public.company_change_events DROP COLUMN delivered_at;");
    await expect(aplicar(db)).rejects.toThrow(/LEGACY_SCHEMA_UNEXPECTED[\s\S]*delivered_at/);
  });

  it("C3. domain_mutations já canonicalizada por outro caminho aborta", async () => {
    const db = await producaoLegada();
    await db.exec("ALTER TABLE public.domain_mutations ADD COLUMN request_hash text;");
    await expect(aplicar(db)).rejects.toThrow(/LEGACY_SCHEMA_UNEXPECTED/);
  });

  it("V. zero linhas de negócio tocadas", async () => {
    const db = await producaoLegada();
    await db.query("INSERT INTO public.companies (id, name) VALUES ($1,$2)",
      ["33333333-3333-3333-3333-333333333333", "Terceira"]);
    const antes = await db.query("SELECT id, name FROM public.companies ORDER BY id");
    await aplicar(db);
    const depois = await db.query("SELECT id, name FROM public.companies ORDER BY id");
    expect(depois.rows).toEqual(antes.rows);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — idempotência: o recibo
// ═══════════════════════════════════════════════════════════════════════════

describe("H+I. domain_mutations distingue retry de reutilização", () => {
  let db: PGlite;
  beforeEach(async () => { db = await producaoLegada(); await aplicar(db); });

  const completar = (mut: string, op: string, hash: string) =>
    db.query(`SELECT public.complete_domain_mutation($1,$2,'contracts',$3,$4,'succeeded','{"n":1}'::jsonb) AS r`,
      [EMPRESA_A, mut, op, hash]);

  const procurar = (mut: string, op: string, hash: string) =>
    db.query<{ r: unknown }>(`SELECT public.find_or_conflict_domain_mutation($1,$2,$3,$4) AS r`,
      [EMPRESA_A, mut, op, hash]);

  it("primeira vez: não há recibo", async () => {
    const r = await procurar("aaaaaaaa-0000-0000-0000-000000000001", "create_contract", "h1");
    expect(r.rows[0].r).toBeNull();
  });

  it("H. mesmo comando → devolve o resultado guardado", async () => {
    const m = "aaaaaaaa-0000-0000-0000-000000000002";
    await completar(m, "create_contract", "h1");
    const r = await procurar(m, "create_contract", "h1");
    const j = r.rows[0].r as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.replay).toBe(true);
    expect(j.result).toEqual({ n: 1 });
  });

  it("I. 🔴 mesmo mutation_id, payload diferente → MUTATION_REUSE_CONFLICT", async () => {
    // É este o caso que a tabela órfã não conseguia detetar: sem request_hash,
    // uma reutilização de id era indistinguível de um retry legítimo.
    const m = "aaaaaaaa-0000-0000-0000-000000000003";
    await completar(m, "create_contract", "h1");
    const r = await procurar(m, "create_contract", "OUTRO_HASH");
    const j = r.rows[0].r as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(j.code).toBe("MUTATION_REUSE_CONFLICT");
  });

  it("I2. mesma chave, operação diferente → também é conflito", async () => {
    const m = "aaaaaaaa-0000-0000-0000-000000000004";
    await completar(m, "create_contract", "h1");
    const j = (await procurar(m, "delete_contract", "h1")).rows[0].r as Record<string, unknown>;
    expect(j.code).toBe("MUTATION_REUSE_CONFLICT");
  });

  it("O. UNIQUE(company_id, mutation_id) impede dois recibos", async () => {
    const m = "aaaaaaaa-0000-0000-0000-000000000005";
    await completar(m, "create_contract", "h1");
    await expect(completar(m, "create_contract", "h1")).rejects.toThrow(/duplicate key|unique/i);
  });

  it("17. sem request_hash o recibo é recusado", async () => {
    await expect(
      db.query(`SELECT public.complete_domain_mutation($1,$2,'contracts','create_contract','','succeeded')`,
        [EMPRESA_A, "aaaaaaaa-0000-0000-0000-000000000006"]),
    ).rejects.toThrow(/REQUEST_HASH_REQUIRED/);
  });

  it("15. status limita-se a succeeded e rejected", async () => {
    await expect(
      db.query(`SELECT public.complete_domain_mutation($1,$2,'contracts','x','h','processing')`,
        [EMPRESA_A, "aaaaaaaa-0000-0000-0000-000000000007"]),
    ).rejects.toThrow(/status_check|violates check/i);
  });

  it("16. operation segue o formato canónico", async () => {
    await expect(
      db.query(`SELECT public.complete_domain_mutation($1,$2,'contracts','Create Contract','h','succeeded')`,
        [EMPRESA_A, "aaaaaaaa-0000-0000-0000-000000000008"]),
    ).rejects.toThrow(/operation_check|violates check/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — o evento e a sequência
// ═══════════════════════════════════════════════════════════════════════════

describe("M+N+U. company_change_events é append-only", () => {
  let db: PGlite;
  beforeEach(async () => { db = await producaoLegada(); await aplicar(db); });

  const registar = (empresa: string, mut: string, payload = '{"a":1}') =>
    db.query<{ r: Record<string, unknown> }>(
      `SELECT public.record_company_change_event($1,$2,'contracts','contract_updated',
              ARRAY[]::uuid[], ARRAY['contracts','calendar'], NULL, NULL, $3::jsonb) AS r`,
      [empresa, mut, payload],
    );

  it("primeiro evento de uma empresa começa em 1", async () => {
    const r = await registar(EMPRESA_A, "bbbbbbbb-0000-0000-0000-000000000001");
    expect(r.rows[0].r.sequence).toBe(1);
    expect(r.rows[0].r.replay).toBe(false);
  });

  it("F. a sequência é monotónica dentro da empresa", async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await registar(EMPRESA_A, `bbbbbbbb-0000-0000-0000-00000000000${i}`);
      expect(r.rows[0].r.sequence).toBe(i);
    }
  });

  it("G. empresas diferentes têm sequências independentes", async () => {
    await registar(EMPRESA_A, "cccccccc-0000-0000-0000-000000000001");
    await registar(EMPRESA_A, "cccccccc-0000-0000-0000-000000000002");
    const b = await registar(EMPRESA_B, "cccccccc-0000-0000-0000-000000000003");
    expect(b.rows[0].r.sequence).toBe(1);
  });

  it("M+U. 🔴 replay devolve o evento existente e NÃO o reescreve", async () => {
    const m = "dddddddd-0000-0000-0000-000000000001";
    const primeiro = await registar(EMPRESA_A, m, '{"original":true}');
    const segundo = await registar(EMPRESA_A, m, '{"diferente":true}');

    expect(segundo.rows[0].r.replay).toBe(true);
    expect(segundo.rows[0].r.sequence).toBe(primeiro.rows[0].r.sequence);

    const guardado = await db.query<{ payload: unknown; n: string }>(
      `SELECT payload, count(*) OVER () AS n FROM public.company_change_events WHERE mutation_id=$1`, [m],
    );
    expect(guardado.rows).toHaveLength(1);
    expect(guardado.rows[0].payload).toEqual({ original: true });
  });

  it("N. UNIQUE(company_id, sequence) — a garantia final da sequência", async () => {
    // Se duas sessões concorrentes calculassem o mesmo número, esta constraint
    // aborta uma delas. É o que torna a sequência confiável mesmo sem provar a
    // serialização com duas ligações.
    await registar(EMPRESA_A, "eeeeeeee-0000-0000-0000-000000000001");
    await expect(db.query(
      `INSERT INTO public.company_change_events
       (company_id, sequence, mutation_id, domain, event_type, entity_ids, scopes, payload)
       VALUES ($1, 1, gen_random_uuid(), 'x', 'y', '{}', '{}', '{}')`, [EMPRESA_A],
    )).rejects.toThrow(/duplicate key|unique/i);
  });

  it("P. intervalo de datas incoerente é recusado", async () => {
    const mau = (from: string | null, to: string | null) => db.query(
      `INSERT INTO public.company_change_events
       (company_id, sequence, mutation_id, domain, event_type, entity_ids, scopes, payload, affected_from, affected_to)
       VALUES ($1, 99, gen_random_uuid(), 'x','y','{}','{}','{}', $2::date, $3::date)`,
      [EMPRESA_A, from, to],
    );
    await expect(mau("2026-09-10", "2026-09-01")).rejects.toThrow(/affected_range_check|violates check/i);
    await expect(mau("2026-09-01", null)).rejects.toThrow(/affected_range_check|violates check/i);
    await expect(mau(null, "2026-09-01")).rejects.toThrow(/affected_range_check|violates check/i);
  });

  it("P2. ambos nulos é válido", async () => {
    await expect(registar(EMPRESA_A, "ffffffff-0000-0000-0000-000000000001")).resolves.toBeTruthy();
  });

  it("28. o evento não substitui o recibo — são coisas diferentes", async () => {
    const m = "99999999-0000-0000-0000-000000000001";
    await registar(EMPRESA_A, m);
    const recibo = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.domain_mutations WHERE mutation_id=$1`, [m]);
    expect(recibo.rows[0].n).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE E — transação: tudo ou nada
// ═══════════════════════════════════════════════════════════════════════════

describe("J+K+L. falha em qualquer passo reverte tudo", () => {
  it("J. rollback da transação de negócio não deixa recibo, evento nem sequência", async () => {
    const db = await producaoLegada();
    await aplicar(db);

    await db.exec("BEGIN");
    await db.query(
      `SELECT public.record_company_change_event($1,$2,'contracts','x',ARRAY[]::uuid[],ARRAY['contracts'])`,
      [EMPRESA_A, "aaaa1111-0000-0000-0000-000000000001"]);
    await db.query(
      `SELECT public.complete_domain_mutation($1,$2,'contracts','create_contract','h','succeeded')`,
      [EMPRESA_A, "aaaa1111-0000-0000-0000-000000000001"]);
    await db.exec("ROLLBACK");

    for (const t of ["company_change_events", "domain_mutations"]) {
      const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t}`);
      expect(r.rows[0].n, t).toBe(0);
    }
    const seq = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.company_sync_state WHERE sequence > 0`);
    expect(seq.rows[0].n).toBe(0);
  });

  it("K+L. falha do recibo reverte também o evento", async () => {
    const db = await producaoLegada();
    await aplicar(db);
    const m = "aaaa2222-0000-0000-0000-000000000001";

    await db.exec("BEGIN");
    await db.query(`SELECT public.record_company_change_event($1,$2,'contracts','x')`, [EMPRESA_A, m]);
    try {
      // status inválido → viola o CHECK
      await db.query(
        `SELECT public.complete_domain_mutation($1,$2,'contracts','create_contract','h','estado_invalido')`,
        [EMPRESA_A, m]);
    } catch { /* esperado */ }
    await db.exec("ROLLBACK");

    const ev = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.company_change_events`);
    expect(ev.rows[0].n).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE F — segurança e quarentena
// ═══════════════════════════════════════════════════════════════════════════

describe("Q+R+S. o browser não vê nada disto", () => {
  let db: PGlite;
  beforeEach(async () => { db = await producaoLegada(); await aplicar(db); });

  it("PUBLIC, anon e authenticated ficam sem privilégios nas três tabelas", async () => {
    for (const t of ["company_change_events", "domain_mutations", "company_sync_state"]) {
      expect(await privilegios(db, t, "anon"), `${t}/anon`).toEqual([]);
      expect(await privilegios(db, t, "authenticated"), `${t}/authenticated`).toEqual([]);
    }
  });

  it("RLS ligada nas três", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname IN ('company_change_events','domain_mutations','company_sync_state')`);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });

  it("anon não consegue ler os eventos", async () => {
    await db.exec("SET ROLE anon;");
    await expect(db.query("SELECT * FROM public.company_change_events")).rejects.toThrow(/permission denied/);
    await db.exec("RESET ROLE;");
  });

  it("os helpers internos não são executáveis por anon/authenticated", async () => {
    for (const f of ["next_company_sequence", "record_company_change_event"]) {
      const r = await db.query<{ ok: boolean }>(
        `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS ok
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname=$1`, [f]);
      expect(r.rows.every((x) => x.ok === false), f).toBe(true);
    }
  });
});

describe("AB+AC+AD+AE. assinaturas e quarentena", () => {
  it("AB+AC. 🔴 exatamente UMA assinatura de record_company_change_event", async () => {
    // A produção tem uma assinatura sem parâmetros de intervalo; a nova tem-nos.
    // `CREATE OR REPLACE` criaria uma sobrecarga e tornaria cada chamada ambígua.
    const db = await producaoLegada();
    await db.exec(`
      CREATE FUNCTION public.record_company_change_event(
        p_company_id uuid, p_mutation_id uuid, p_domain text, p_event_type text,
        p_entity_ids uuid[], p_scopes text[], p_payload jsonb
      ) RETURNS jsonb LANGUAGE plpgsql AS $f$ BEGIN RETURN '{}'::jsonb; END $f$;
    `);
    expect(await assinaturas(db, "record_company_change_event")).toHaveLength(1);

    await aplicar(db);

    const sigs = await assinaturas(db, "record_company_change_event");
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatch(/date/);
  });

  it("AD+AE. 🔴 as RPCs de negócio órfãs ficam byte a byte intactas", async () => {
    const db = await comRpcOrfas(await producaoLegada());
    const antes = await db.query<{ nome: string; def: string }>(
      `SELECT p.proname AS nome, pg_get_functiondef(p.oid) AS def FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN ('delete_client_atomic','set_invoice_status_atomic')
       ORDER BY p.proname`);

    await aplicar(db);

    const depois = await db.query<{ nome: string; def: string }>(
      `SELECT p.proname AS nome, pg_get_functiondef(p.oid) AS def FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN ('delete_client_atomic','set_invoice_status_atomic')
       ORDER BY p.proname`);

    expect(depois.rows).toEqual(antes.rows);
    expect(depois.rows).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE G — guarda estática sobre o SQL
// ═══════════════════════════════════════════════════════════════════════════

describe("AF+AG. a 078 não faz o que dissemos que não faria", () => {
  const executavel = SQL_078.replace(/^\s*--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * SQL que corre **no momento da migration**.
   *
   * 🔴 Os corpos de `CREATE FUNCTION` saem daqui porque não correm agora —
   *    correm quando uma RPC de negócio futura os chamar.
   *    `record_company_change_event` tem de fazer `INSERT INTO
   *    company_change_events`: é a sua razão de existir. Uma guarda que
   *    confundisse as duas coisas obrigaria a escolher entre proibir backfill
   *    e ter funções que funcionam.
   *
   *    Os blocos `DO` ficam — esses correm mesmo, e é neles que um backfill
   *    disfarçado se poderia esconder.
   */
  const noMomentoDaMigration = executavel
    .replace(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION[\s\S]*?\$\$[\s\S]*?\$\$;/gi, "");

  it("AG. não mexe em publicações Realtime", () => {
    // A pertença atual é desconhecida; acrescentar abriria superfície sem
    // consumidor, remover partiria algo que não conseguimos ver.
    expect(executavel).not.toMatch(/PUBLICATION/i);
  });

  it("AD. não toca nas RPCs de negócio em quarentena", () => {
    for (const f of ["delete_client_atomic", "set_invoice_status_atomic"]) {
      expect(executavel, f).not.toMatch(new RegExp(f));
    }
  });

  it("não há backfill nem conversão de dados no momento da migration", () => {
    expect(noMomentoDaMigration).not.toMatch(/\bINSERT\s+INTO\s+public\.(company_change_events|domain_mutations)\b/i);
    expect(noMomentoDaMigration).not.toMatch(/\bINSERT\s+INTO[\s\S]{0,160}?\bSELECT\b/i);
    expect(noMomentoDaMigration).not.toMatch(/\bTRUNCATE\b/i);
    expect(noMomentoDaMigration).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("as tabelas legadas nunca são actualizadas — nem em runtime", () => {
    // Nenhuma função tem motivo para fazer UPDATE nestas duas: o recibo e o
    // evento são insert-only por desenho.
    expect(executavel).not.toMatch(/\bUPDATE\s+public\.(company_change_events|domain_mutations)\b/i);
  });

  it("a guarda distingue corpo de função de SQL de migration", () => {
    // Prova de que a distinção é real, e não uma desculpa: o INSERT do evento
    // existe no ficheiro e desaparece quando se olha só para o que corre na
    // migration.
    expect(executavel).toMatch(/INSERT INTO public\.company_change_events/);
    expect(noMomentoDaMigration).not.toMatch(/INSERT INTO public\.company_change_events/);
  });

  it("nenhuma RPC de negócio é criada", () => {
    expect(executavel).not.toMatch(/create_contract|update_contract|create_invoice|delete_client/i);
  });

  it("toda função SECURITY DEFINER fixa o search_path", () => {
    const definers = (executavel.match(/SECURITY DEFINER/gi) ?? []).length;
    const paths = (executavel.match(/SET search_path = public, pg_temp/gi) ?? []).length;
    expect(definers).toBeGreaterThan(0);
    expect(paths).toBe(definers);
  });

  it("a guarda não se deixa enganar pelos comentários", () => {
    // O cabeçalho fala de `delete_client_atomic` e de publicação ao explicar
    // o que NÃO faz.
    expect(SQL_078).toMatch(/delete_client_atomic/);
    expect(SQL_078).toMatch(/Realtime/);
    expect(executavel).not.toMatch(/delete_client_atomic/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE H — as três garantias acrescentadas no endurecimento
// ═══════════════════════════════════════════════════════════════════════════

describe("078 exige a 077 antes de correr", () => {
  it("🔴 sem a 077 no ledger, a 078 recusa", async () => {
    // A ordem operacional deixa de depender de alguém se lembrar dela.
    const db = await semPredecessor();
    await expect(aplicar(db)).rejects.toThrow(/REQUIRED_MIGRATION_077_NOT_APPLIED/);
  });

  it("sem sequer a tabela do ledger, também recusa", async () => {
    const db = await semPredecessor({ comLedger: false });
    await expect(aplicar(db)).rejects.toThrow(/REQUIRED_MIGRATION_077_NOT_APPLIED/);
  });

  it("com a 077 registada, passa", async () => {
    const db = await semPredecessor();
    await db.query("INSERT INTO public._migrations (name, checksum) VALUES ($1, $2)",
      ["077_secure_migrations_ledger.sql", "checksum-077"]);
    await expect(aplicar(db)).resolves.not.toThrow();
  });

  it("recusar acontece ANTES de tocar em qualquer coisa", async () => {
    const db = await semPredecessor();
    await aplicar(db).catch(() => {});
    // Nenhuma das tabelas da fundação foi criada.
    for (const t of ["company_change_events", "domain_mutations", "company_sync_state"]) {
      const r = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1`, [t]);
      expect(r.rows[0].n, t).toBe(0);
    }
  });
});

describe("assinaturas desconhecidas fazem a 078 parar, não apagar", () => {
  it("🔴 uma assinatura inesperada aborta em vez de ser removida", async () => {
    // Entre a caracterização e a aplicação alguém pode criar outra função com
    // este nome. «Apareceu algo inesperado, portanto apaguei» é o
    // comportamento errado numa migration que corre sozinha contra produção.
    const db = await producaoLegada();
    await db.exec(`
      CREATE FUNCTION public.record_company_change_event(p_qualquer text)
      RETURNS jsonb LANGUAGE plpgsql AS $f$ BEGIN RETURN '{}'::jsonb; END $f$;
    `);

    await expect(aplicar(db)).rejects.toThrow(/UNKNOWN_FUNCTION_SIGNATURE/);

    // E a função inesperada continua lá — a migration não a destruiu.
    expect(await assinaturas(db, "record_company_change_event")).toHaveLength(1);
  });

  it("a assinatura legada conhecida é reconhecida e removida", async () => {
    const db = await producaoLegada();
    await db.exec(`
      CREATE FUNCTION public.record_company_change_event(
        p_company_id uuid, p_mutation_id uuid, p_domain text, p_event_type text,
        p_entity_ids uuid[], p_scopes text[], p_payload jsonb
      ) RETURNS jsonb LANGUAGE plpgsql AS $f$ BEGIN RETURN '{}'::jsonb; END $f$;
    `);

    await expect(aplicar(db)).resolves.not.toThrow();

    const sigs = await assinaturas(db, "record_company_change_event");
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatch(/date/);
  });

  it("o fingerprint compara tipos, não nomes de argumento", async () => {
    // Nomes podem legitimamente diferir entre versões da mesma função; os
    // tipos são a identidade.
    const db = await producaoLegada();
    await db.exec(`
      CREATE FUNCTION public.record_company_change_event(
        outro_nome_a uuid, outro_nome_b uuid, outro_nome_c text, outro_nome_d text,
        outro_nome_e uuid[], outro_nome_f text[], outro_nome_g jsonb
      ) RETURNS jsonb LANGUAGE plpgsql AS $f$ BEGIN RETURN '{}'::jsonb; END $f$;
    `);
    await expect(aplicar(db)).resolves.not.toThrow();
  });

  it("reaplicar reconhece a própria forma canónica", async () => {
    const db = await producaoLegada();
    await aplicar(db);
    // A segunda passagem encontra a canónica, reconhece-a, e substitui.
    await expect(aplicar(db)).rejects.toThrow(/NONEMPTY_LEGACY_TABLE|LEGACY_SCHEMA_UNEXPECTED/);
    // (a tabela já não tem o shape legado — o que prova que o guard de
    //  shape corre antes, e não que a assinatura foi rejeitada)
  });

  it("nenhuma das cinco funções fica com mais do que uma assinatura", async () => {
    const db = await producaoLegada();
    await aplicar(db);
    for (const f of ["record_company_change_event", "next_company_sequence",
                     "lock_domain_mutation", "find_or_conflict_domain_mutation",
                     "complete_domain_mutation"]) {
      expect(await assinaturas(db, f), f).toHaveLength(1);
    }
  });
});

describe("a guarda estática acompanha o endurecimento", () => {
  const executavel = SQL_078.replace(/^\s*--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("não existe DROP incondicional de funções por nome", () => {
    // A versão anterior fazia `FOR ... LOOP DROP` sem validar nada.
    expect(executavel).toMatch(/UNKNOWN_FUNCTION_SIGNATURE/);
    expect(executavel).toMatch(/oidvectortypes/);
  });

  it("a pré-condição da 077 está presente", () => {
    expect(executavel).toMatch(/REQUIRED_MIGRATION_077_NOT_APPLIED/);
    expect(executavel).toMatch(/077_secure_migrations_ledger\.sql/);
  });

  it("a pré-condição não duplica o checksum da 077", () => {
    // O runner já valida checksums de tudo o que está aplicado; repetir o
    // valor aqui criaria uma segunda cópia da mesma verdade.
    expect(executavel).not.toMatch(/d15ca5f0/);
  });
});
