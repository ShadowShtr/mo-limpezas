// ============================================================================
// O CHECK de `reference_type` contra o que as RPCs realmente escrevem
// ============================================================================
// Origem (2026-08-18): bug de produção — «marco o pagamento como pago e não
// atualiza». A causa não estava na UI nem na RPC, mas na incompatibilidade
// entre duas migrations que ninguém tinha cruzado:
//
//     049  → CHECK reference_type IN ('invoice','payroll','service_payment')
//     073  → INSERT ... reference_type = 'fixed_variable_payment'
//
// A RPC violava o CHECK, a transacção inteira era revertida, e o utilizador via
// o pagamento continuar pendente sem explicação nenhuma.
//
// Os testes existentes da 073 não apanharam isto porque montavam a tabela
// `cash_flow_entries` para o cenário, sem reproduzir a cadeia de constraints
// que produção tem. Aqui a cadeia é aplicada por ordem, a partir dos ficheiros
// versionados reais — é isso que torna o teste capaz de ver o defeito.
//
// Corre contra PGlite (Postgres real, em memória). Nunca toca na base.
// ============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();
const MIGRACOES = path.join(RAIZ, "supabase", "migrations");

function sql(ficheiro: string): string {
  return fs.readFileSync(path.join(MIGRACOES, ficheiro), "utf8");
}

const M075 = "075_cash_flow_fixed_variable_payment_reference.sql";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const PAYMENT = "22222222-2222-2222-2222-222222222222";

/**
 * Base mínima com a cadeia de constraints que produção tem.
 *
 * As tabelas são recriadas em vez de correr todas as migrations históricas
 * (muitas dependem de `auth`, RLS e extensões que o PGlite não tem). O que
 * importa é fiel: o CHECK vem do ficheiro real da 049, e o índice único do
 * ficheiro real da 024.
 */
async function baseAntesDa075() {
  const db = new PGlite();

  await db.exec(`
    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      type text NOT NULL CHECK (type IN ('entrada','saida')),
      category text,
      description text NOT NULL,
      amount numeric(10,2) NOT NULL,
      date date NOT NULL,
      status text NOT NULL DEFAULT 'pendente',
      reference_type text CHECK (reference_type IN ('invoice','payroll')),
      reference_id uuid,
      expense_category_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      description text NOT NULL,
      amount numeric(10,2),
      status text NOT NULL DEFAULT 'pendente',
      paid_at timestamptz,
      expense_category_id uuid,
      period_year int,
      period_month int
    );
  `);

  // 024 — o índice de identidade económica, do ficheiro real.
  await db.exec(sql("024_cash_flow_reference_integrity.sql"));

  // 049 — o CHECK que produção tem hoje, do ficheiro real.
  await db.exec(sql("049_cash_flow_service_payment_reference.sql"));

  await db.query(
    `INSERT INTO public.fixed_variable_payments (id, company_id, description, amount, status, period_year, period_month)
     VALUES ($1, $2, 'Renda do armazém', 250.00, 'pendente', 2026, 8)`,
    [PAYMENT, COMPANY],
  );

  return db;
}

/** O que a RPC da 073 faz, reduzido ao que colide com o CHECK. */
async function inserirComoA073(db: PGlite) {
  return db.query(
    `INSERT INTO public.cash_flow_entries
       (company_id, type, category, description, amount, date,
        reference_type, reference_id, status)
     VALUES ($1, 'saida', 'despesa', 'Renda do armazém', 250.00, '2026-08-18',
             'fixed_variable_payment', $2, 'confirmado')
     RETURNING id`,
    [COMPANY, PAYMENT],
  );
}

/**
 * A mesma base, mas com a **RPC real** da 073 instalada a partir do ficheiro
 * versionado — não uma reimplementação.
 *
 * 🔴 Porque isto importa: `inserirComoA073` acima é um INSERT reduzido. Prova
 *    o conflito com o CHECK e o índice da 024, mas não exercita o
 *    `ON CONFLICT … DO NOTHING` + `SELECT` de recuperação que torna a RPC
 *    idempotente. Uma unique violation não é idempotência da RPC — é o
 *    contrário do que ela faz.
 */
async function baseComRpcReal() {
  const db = await baseAntesDa075();

  // Dependência mínima da 071 para a 073: `is_financial_period_open` lê daqui.
  await db.exec(`
    CREATE TABLE public.financial_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      year smallint NOT NULL,
      month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month)
    );
  `);

  // A 073 REAL, do ficheiro versionado.
  await db.exec(sql("073_payment_to_cashflow.sql"));
  return db;
}

interface MarkRow {
  payment_id: string;
  cash_entry_id: string | null;
  ja_estava_pago: boolean;
}

function marcarPago(db: PGlite) {
  return db.query<MarkRow>(
    "SELECT * FROM public.mark_payment_paid($1, $2, $3)",
    [COMPANY, PAYMENT, "2026-08-18"],
  );
}

async function estadoPagamento(db: PGlite) {
  const { rows } = await db.query<{ status: string; paid_at: string | null }>(
    "SELECT status, paid_at FROM public.fixed_variable_payments WHERE id = $1",
    [PAYMENT],
  );
  return rows[0];
}

async function contarMovimentos(db: PGlite) {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.cash_flow_entries
      WHERE reference_type = 'fixed_variable_payment' AND reference_id = $1`,
    [PAYMENT],
  );
  return rows[0].n;
}

describe("🔴 a causa provada — antes da 075", () => {
  it("a 073 escreve `fixed_variable_payment`", () => {
    const s = sql("073_payment_to_cashflow.sql");
    expect(s).toContain("'fixed_variable_payment'");
  });

  it("a 049 não o permite", () => {
    const s = sql("049_cash_flow_service_payment_reference.sql");
    expect(s).toContain("CHECK (reference_type IN ('invoice', 'payroll', 'service_payment'))");
    expect(s).not.toContain("fixed_variable_payment");
  });

  it("🔴 o INSERT da RPC é REJEITADO pelo CHECK — é isto que o utilizador via", async () => {
    const db = await baseAntesDa075();
    await expect(inserirComoA073(db)).rejects.toThrow(/violates check constraint|check constraint/i);

    // E o efeito visível: nenhum movimento de caixa criado.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM public.cash_flow_entries");
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("depois da 075", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await baseAntesDa075();
    await db.exec(sql(M075));
  });

  it("o INSERT da RPC passa e cria exactamente um movimento", async () => {
    const { rows } = await inserirComoA073(db);
    expect(rows).toHaveLength(1);

    const { rows: total } = await db.query(
      `SELECT count(*)::int AS n FROM public.cash_flow_entries
        WHERE reference_type = 'fixed_variable_payment' AND reference_id = $1`,
      [PAYMENT],
    );
    expect(total[0]).toEqual({ n: 1 });
  });

  it("o movimento tem a forma que a 073 declara", async () => {
    const { rows } = await db.query(
      `SELECT type, category, status, reference_type, reference_id
         FROM public.cash_flow_entries WHERE reference_id = $1`,
      [PAYMENT],
    );
    expect(rows[0]).toMatchObject({
      type: "saida",
      category: "despesa",
      status: "confirmado",
      reference_type: "fixed_variable_payment",
      reference_id: PAYMENT,
    });
  });

  // 🔴 A protecção do índice da 024 — um INSERT cru repetido é rejeitado.
  //    Isto NÃO é a idempotência da RPC: ver o bloco da RPC real abaixo.
  it("UNIQUE_INDEX_PROTECTION: um INSERT cru repetido é rejeitado", async () => {
    await expect(inserirComoA073(db)).rejects.toThrow(/duplicate key|unique/i);
    expect(await contarMovimentos(db)).toBe(1);
  });
});

// ── A RPC REAL, contra o schema acumulado ───────────────────────────────────
//
// O que os blocos acima não provam: que `public.mark_payment_paid()` — o
// ficheiro versionado da 073, não uma reimplementação — se comporta como
// declarado. É a diferença entre «testámos algo equivalente à RPC» e
// «executámos a RPC».

describe("🔴 a RPC real ANTES da 075", () => {
  it("mark_payment_paid falha pelo CHECK e reverte tudo", async () => {
    const db = await baseComRpcReal();

    await expect(marcarPago(db)).rejects.toThrow(/check constraint|violates/i);

    // ATOMIC_ROLLBACK: o UPDATE do pagamento acontece ANTES do INSERT dentro da
    // mesma função. Se o rollback não fosse total, o pagamento ficaria "pago"
    // sem movimento nenhum — o pior estado possível.
    const p = await estadoPagamento(db);
    expect(p.status).toBe("pendente");
    expect(p.paid_at).toBeNull();
    expect(await contarMovimentos(db)).toBe(0);
  });
});

describe("a RPC real DEPOIS da 075", () => {
  let db: PGlite;
  let primeiroCashEntryId: string | null = null;

  beforeAll(async () => {
    db = await baseComRpcReal();
    await db.exec(sql(M075));
  });

  it("mark_payment_paid marca o pagamento e cria um movimento", async () => {
    const { rows } = await marcarPago(db);
    expect(rows).toHaveLength(1);
    primeiroCashEntryId = rows[0].cash_entry_id;
    expect(primeiroCashEntryId).toBeTruthy();
    // Primeira marcação: não estava pago antes.
    expect(rows[0].ja_estava_pago).toBe(false);

    const p = await estadoPagamento(db);
    expect(p.status).toBe("pago");
    expect(p.paid_at).not.toBeNull();
    expect(await contarMovimentos(db)).toBe(1);
  });

  it("o movimento tem a forma que a 073 declara", async () => {
    const { rows } = await db.query(
      `SELECT type, category, status, reference_type, reference_id, amount::text AS amount
         FROM public.cash_flow_entries WHERE reference_id = $1`,
      [PAYMENT],
    );
    expect(rows[0]).toMatchObject({
      type: "saida",
      category: "despesa",
      status: "confirmado",
      reference_type: "fixed_variable_payment",
      reference_id: PAYMENT,
      amount: "250.00",
    });
  });

  // 🔴 RPC_IDEMPOTENCY — distinto de UNIQUE_INDEX_PROTECTION.
  //    O índice garante unicidade; o `ON CONFLICT DO NOTHING` + `SELECT` da
  //    RPC transforma essa unicidade em idempotência funcional: a segunda
  //    chamada devolve o mesmo movimento em vez de um erro.
  it("🔴 RPC_IDEMPOTENCY: a segunda chamada NÃO falha e devolve o mesmo movimento", async () => {
    const { rows } = await marcarPago(db);

    expect(rows).toHaveLength(1);
    expect(rows[0].cash_entry_id).toBe(primeiroCashEntryId);
    expect(rows[0].ja_estava_pago).toBe(true);
    expect(await contarMovimentos(db)).toBe(1);
  });

  it("🔴 unmark_payment_paid remove só o movimento com esta origem", async () => {
    // Um movimento manual gémeo: mesma empresa, valor, data e descrição, mas
    // sem origem. Apagar por semelhança levá-lo-ia à frente.
    await db.query(
      `INSERT INTO public.cash_flow_entries
         (company_id, type, category, description, amount, date, status)
       VALUES ($1, 'saida', 'despesa', 'Renda do armazém', 250.00, '2026-08-18', 'confirmado')`,
      [COMPANY],
    );

    const { rows } = await db.query<{ movimentos_removidos: number }>(
      "SELECT * FROM public.unmark_payment_paid($1, $2)",
      [COMPANY, PAYMENT],
    );
    expect(rows[0].movimentos_removidos).toBe(1);

    const p = await estadoPagamento(db);
    expect(p.status).toBe("pendente");
    expect(p.paid_at).toBeNull();

    // O movimento com origem saiu…
    expect(await contarMovimentos(db)).toBe(0);
    // …e o manual sobreviveu.
    const { rows: total } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.cash_flow_entries",
    );
    expect(total[0].n).toBe(1);
  });

  it("depois de desmarcar, marcar de novo volta a criar exactamente um", async () => {
    const { rows } = await marcarPago(db);
    expect(rows[0].ja_estava_pago).toBe(false);
    expect(await contarMovimentos(db)).toBe(1);
  });
});

describe("a 075 não estreita o que já era aceite", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await baseAntesDa075();
    await db.exec(sql(M075));
  });

  it.each(["invoice", "payroll", "service_payment", "fixed_variable_payment"])(
    "aceita %s",
    async (tipo) => {
      const { rows } = await db.query(
        `INSERT INTO public.cash_flow_entries
           (company_id, type, description, amount, date, reference_type, reference_id)
         VALUES ($1, 'saida', 'x', 1.00, '2026-08-18', $2, gen_random_uuid())
         RETURNING id`,
        [COMPANY, tipo],
      );
      expect(rows).toHaveLength(1);
    },
  );

  it("aceita NULL — comportamento histórico preservado", async () => {
    const { rows } = await db.query(
      `INSERT INTO public.cash_flow_entries
         (company_id, type, description, amount, date, reference_type, reference_id)
       VALUES ($1, 'saida', 'manual', 1.00, '2026-08-18', NULL, NULL)
       RETURNING id`,
      [COMPANY],
    );
    expect(rows).toHaveLength(1);
  });

  it("🔴 continua a rejeitar um tipo arbitrário", async () => {
    await expect(
      db.query(
        `INSERT INTO public.cash_flow_entries
           (company_id, type, description, amount, date, reference_type, reference_id)
         VALUES ($1, 'saida', 'x', 1.00, '2026-08-18', 'tipo_inventado', gen_random_uuid())`,
        [COMPANY],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});

// ── Guard permanente ────────────────────────────────────────────────────────
//
// O que falhou aqui foi a ausência de um cruzamento: ninguém verificava se o
// que as RPCs escrevem cabe no CHECK do schema. Isto passa a ser verificado.

describe("🔴 RPC_REFERENCE_TYPE_SCHEMA_MISMATCH = 0", () => {
  /**
   * O CHECK em vigor é o da migration mais recente que o redefine.
   *
   * 🔴 A ordem é a do runner (`readdirSync().sort()`), mas as migrations com
   *    nome por data (`20260608_*`) ordenam depois das numeradas sem serem
   *    posteriores. As que redefinem este CHECK são todas numeradas (049, 075),
   *    por isso ordena-se por prefixo numérico e ignoram-se as datadas — que
   *    apenas criam a tabela, com o CHECK original inline.
   */
  function tiposPermitidos(): Set<string> {
    const numeradas = fs
      .readdirSync(MIGRACOES)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort();

    let ultimo = "";
    for (const f of numeradas) {
      const s = fs.readFileSync(path.join(MIGRACOES, f), "utf8");
      if (/ADD CONSTRAINT\s+cash_flow_entries_reference_type_check/i.test(s)) ultimo = s;
    }
    if (!ultimo) throw new Error("nenhuma migration redefine o CHECK de reference_type");

    // O corpo do último `ADD CONSTRAINT`, sem comentários — o rollback
    // documentado no fim da 075 está comentado e não vale como CHECK em vigor.
    const semComentarios = ultimo
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const bloco = semComentarios.slice(semComentarios.lastIndexOf("ADD CONSTRAINT"));
    const corpo = bloco.slice(0, bloco.indexOf(";"));
    return new Set([...corpo.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  }

  function extrairTiposReferenceType(conteudo: string): string[] {
    return [
      ...conteudo.matchAll(/(?<![\w.])reference_type\s*(?:=|,)\s*'([a-z_]+)'/g),
    ].map((m) => m[1]);
  }

  /** O que as migrations escrevem como `reference_type` em cash_flow_entries. */
  function tiposEscritos(): Map<string, string[]> {
    const usos = new Map<string, string[]>();
    for (const f of fs.readdirSync(MIGRACOES).filter((x) => x.endsWith(".sql"))) {
      const s = fs.readFileSync(path.join(MIGRACOES, f), "utf8");
      // Só linhas que atribuem/comparam um literal a reference_type.
      for (const tipo of extrairTiposReferenceType(s)) {
        usos.set(tipo, [...(usos.get(tipo) ?? []), f]);
      }
    }
    return usos;
  }

  it("extrai apenas literais atribuídos ao identificador reference_type", () => {
    expect(extrairTiposReferenceType("reference_type = 'payroll'")).toEqual(["payroll"]);
    expect(extrairTiposReferenceType("reference_type = 'tipo_inventado'")).toEqual([
      "tipo_inventado",
    ]);
    expect(extrairTiposReferenceType("v_cash.reference_type, 'reference_id'")).toEqual([]);
    expect(
      extrairTiposReferenceType(
        "jsonb_build_object('reference_type', v_cash.reference_type, 'reference_id', v_cash.reference_id)",
      ),
    ).toEqual([]);
  });

  it("todo o `reference_type` escrito pelas migrations cabe no CHECK", () => {
    const permitidos = tiposPermitidos();
    const escritos = tiposEscritos();

    const foraDoCheck: string[] = [];
    for (const [tipo, ficheiros] of escritos) {
      if (!permitidos.has(tipo)) foraDoCheck.push(`${tipo} (em ${ficheiros.join(", ")})`);
    }

    expect(
      foraDoCheck,
      "um reference_type escrito que o CHECK não permite — foi exactamente isto que partiu o «marcar como pago»",
    ).toEqual([]);
  });

  it("o CHECK em vigor inclui os quatro tipos conhecidos", () => {
    const p = tiposPermitidos();
    for (const t of ["invoice", "payroll", "service_payment", "fixed_variable_payment"]) {
      expect(p.has(t), `${t} em falta no CHECK`).toBe(true);
    }
  });
});
