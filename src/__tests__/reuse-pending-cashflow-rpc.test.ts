// ============================================================================
// 079 — marcar como pago reutiliza o movimento pendente que já existe
// ============================================================================
//
// O buraco, em duas linhas: a 073 termina o `INSERT` do movimento com
// `ON CONFLICT ... DO NOTHING`. Isso impede o duplicado — e continua a
// impedi-lo — mas assume que o único movimento que pode colidir é um que a
// própria RPC criou, logo já `confirmado`.
//
// Deixa de ser verdade no momento em que um movimento pode estar ligado a um
// pagamento **antes** de ele ser pago. É o desenho da reparação das 6
// obrigações que hoje vivem em `cash_flow_entries` como saídas pendentes: em
// vez de criar um movimento novo — o que duplicaria a despesa — liga-se o que
// já lá está. Com a 073 sozinha, marcar esse pagamento como pago dava:
//
//     pagamento → pago       ✅
//     movimento → pendente   ❌   e ficava assim para sempre, sem erro nenhum
//
// Corre contra PGlite (Postgres real, em memória), com o CHECK e o índice
// carregados dos ficheiros versionados. Nunca toca na base de produção.
//
// ---------------------------------------------------------------------------
// O que esta suite NÃO consegue provar
// ---------------------------------------------------------------------------
// **Concorrência (RPC14).** PGlite só aceita uma ligação; provar `FOR UPDATE`
// com uma ligação é provar nada. Essa parte vive em `scripts/rehearse-079.mjs`,
// que levanta um Postgres a sério em contentor, mede o bloqueio real da segunda
// chamada e destrói o contentor no fim. Dizer aqui que a concorrência está
// coberta seria a mentira mais cara desta suite.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();
const MIGRACOES = path.join(RAIZ, "supabase", "migrations");

const ler = (p: string) => fs.readFileSync(path.join(RAIZ, p), "utf8").replace(/\r\n/g, "\n");
const sql = (ficheiro: string) => fs.readFileSync(path.join(MIGRACOES, ficheiro), "utf8");
const sqlRollback = (ficheiro: string) =>
  fs.readFileSync(path.join(MIGRACOES, "rollback", ficheiro), "utf8");

const M073 = "073_payment_to_cashflow.sql";
const M079 = "079_reuse_pending_cashflow_on_payment.sql";
const M079_DOWN = "079_reuse_pending_cashflow_on_payment.down.sql";

const EMPRESA = "11111111-1111-1111-1111-111111111111";
const OUTRA_EMPRESA = "22222222-2222-2222-2222-222222222222";
const CATEGORIA = "33333333-3333-3333-3333-333333333333";
const PAGO_EM = "2026-08-26";
const DATA_LEGADA = "2026-07-10";

let contador = 0;
const novoId = () => `aaaaaaaa-0000-4000-8000-${String(++contador).padStart(12, "0")}`;

// ═══════════════════════════════════════════════════════════════════════════
// Base
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A cadeia de constraints que produção tem, dos ficheiros que a criaram:
 * `20260608_new_features` (cash_flow_entries), `037` (pagamentos), `024` (o
 * índice de identidade), `049`+`075` (o CHECK de `reference_type`) e `071`
 * (`expense_category_id`, `financial_periods`).
 */
async function base() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.expense_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      name text NOT NULL,
      color text
    );

    CREATE TABLE public.financial_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      year smallint NOT NULL,
      month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month)
    );

    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      type text NOT NULL CHECK (type IN ('entrada','saida')),
      amount numeric(10,2) NOT NULL,
      description text NOT NULL,
      category text DEFAULT 'outro'
        CHECK (category IN ('faturacao','salario','despesa','fornecedor','outro')),
      date date NOT NULL,
      reference_id uuid,
      reference_type text,
      status text NOT NULL DEFAULT 'confirmado'
        CHECK (status IN ('pendente','confirmado')),
      notes text,
      created_by uuid,
      created_at timestamptz DEFAULT now(),
      expense_category_id uuid
    );

    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('fixo','variavel')),
      description text NOT NULL,
      amount numeric(10,2),
      due_date date,
      status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
      recurring boolean NOT NULL DEFAULT false,
      period_year integer NOT NULL,
      period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
      paid_at timestamptz,
      notes text,
      created_at timestamptz DEFAULT now(),
      expense_category_id uuid
    );
  `);

  await db.exec(sql("024_cash_flow_reference_integrity.sql"));
  await db.exec(sql("049_cash_flow_service_payment_reference.sql"));
  await db.exec(sql("075_cash_flow_fixed_variable_payment_reference.sql"));
  await db.exec(sql(M073));

  await db.query(
    `INSERT INTO public.expense_categories (id, company_id, name, color)
     VALUES ($1, $2, 'Fornecedores', 'violet')`,
    [CATEGORIA, EMPRESA],
  );
  return db;
}

async function comA079() {
  const db = await base();
  await db.exec(sql(M079));
  return db;
}

async function criarPagamento(db: PGlite, over: Record<string, unknown> = {}) {
  const id = novoId();
  const o = {
    company_id: EMPRESA, amount: "153.75", expense_category_id: null,
    period_year: 2026, period_month: 8, ...over,
  };
  await db.query(
    `INSERT INTO public.fixed_variable_payments
       (id, company_id, kind, description, amount, status, period_year, period_month, expense_category_id)
     VALUES ($1, $2, 'variavel', 'Factura de fornecedor', $3, 'pendente', $4, $5, $6)`,
    [id, o.company_id, o.amount, o.period_year, o.period_month, o.expense_category_id],
  );
  return id;
}

async function criarMovimentoLigado(db: PGlite, pagamentoId: string, over: Record<string, unknown> = {}) {
  const id = novoId();
  const o = {
    type: "saida", amount: "153.75", category: "despesa", status: "pendente",
    expense_category_id: null, date: DATA_LEGADA, notes: "lançamento legado", ...over,
  };
  await db.query(
    `INSERT INTO public.cash_flow_entries
       (id, company_id, type, amount, description, category, date,
        reference_type, reference_id, status, expense_category_id, notes)
     VALUES ($1, $2, $3, $4, 'Factura de fornecedor', $5, $6,
             'fixed_variable_payment', $7, $8, $9, $10)`,
    [id, EMPRESA, o.type, o.amount, o.category, o.date, pagamentoId,
     o.status, o.expense_category_id, o.notes],
  );
  return id;
}

interface Mov {
  id: string; status: string; date: string; amount: string;
  expense_category_id: string | null; created_at: string; notes: string | null;
}

async function movimentos(db: PGlite, pagamentoId: string): Promise<Mov[]> {
  const { rows } = await db.query<Mov>(
    `SELECT id::text, status, date::text, amount::text,
            expense_category_id::text, created_at::text, notes
       FROM public.cash_flow_entries
      WHERE reference_type = 'fixed_variable_payment' AND reference_id = $1`,
    [pagamentoId],
  );
  return rows;
}

async function estadoPagamento(db: PGlite, id: string) {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM public.fixed_variable_payments WHERE id = $1`, [id],
  );
  return rows[0].status;
}

async function total(db: PGlite) {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.cash_flow_entries`,
  );
  return rows[0].n;
}

function marcarPago(db: PGlite, pagamentoId: string, empresa = EMPRESA, data = PAGO_EM) {
  return db.query<{ payment_id: string; cash_entry_id: string; ja_estava_pago: boolean }>(
    "SELECT * FROM public.mark_payment_paid($1, $2, $3)", [empresa, pagamentoId, data],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// A prova de mutação: sem a 079, o defeito está lá
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 o defeito, com a 073 sozinha", () => {
  it("um movimento pendente ligado fica preso em `pendente` depois de o pagamento ser pago", async () => {
    // Este é o teste que fica vermelho se alguém apagar a 079. Sem ele, todos
    // os outros passariam à mesma no dia em que a correcção desaparecesse — a
    // 073 já não duplica nada, e «não duplica» é o que quase todos verificam.
    const db = await base();
    const pag = await criarPagamento(db);
    await criarMovimentoLigado(db, pag);

    await marcarPago(db, pag);

    expect(await estadoPagamento(db, pag)).toBe("pago");
    const [m] = await movimentos(db, pag);
    expect(m.status).toBe("pendente");      // 🔴 o dinheiro nunca sai do ecrã
    expect(m.date).toBe(DATA_LEGADA);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Comportamento com a 079
// ═══════════════════════════════════════════════════════════════════════════

describe("com a 079 aplicada", () => {
  let db: PGlite;
  beforeEach(async () => { db = await comA079(); });

  it("RPC01. sem movimento ligado, cria um confirmado com a data do pagamento", async () => {
    const pag = await criarPagamento(db, { expense_category_id: CATEGORIA });
    const r = await marcarPago(db, pag);
    const movs = await movimentos(db, pag);

    expect(movs).toHaveLength(1);
    expect(movs[0].status).toBe("confirmado");
    expect(movs[0].date).toBe(PAGO_EM);
    expect(movs[0].expense_category_id).toBe(CATEGORIA);
    expect(r.rows[0].ja_estava_pago).toBe(false);
  });

  it("RPC02+03. 🔴 com um movimento pendente ligado, converte A MESMA linha", async () => {
    // O caso das 6. Criar um segundo movimento duplicaria a despesa no Fluxo
    // de Caixa; deixar o primeiro pendente esconderia a saída.
    const pag = await criarPagamento(db, { expense_category_id: CATEGORIA });
    const mov = await criarMovimentoLigado(db, pag);
    const antes = (await movimentos(db, pag))[0];
    const totalAntes = await total(db);

    const r = await marcarPago(db, pag);
    const movs = await movimentos(db, pag);

    expect(movs).toHaveLength(1);
    expect(await total(db)).toBe(totalAntes);              // nada nasceu
    expect(movs[0].id).toBe(mov);                          // SAME_CASHFLOW_ID
    expect(movs[0].status).toBe("confirmado");
    expect(movs[0].created_at).toBe(antes.created_at);     // histórico intacto
    expect(movs[0].notes).toBe("lançamento legado");
    expect(r.rows[0].ja_estava_pago).toBe(false);          // houve efeito
    expect(await estadoPagamento(db, pag)).toBe("pago");
  });

  it("RPC12. a data do movimento passa a ser a data efectiva do pagamento", async () => {
    // A data legada era a do registo da factura. Mantê-la diria que o dinheiro
    // saiu num dia em que não saiu, e o mês fechava com o valor no sítio errado.
    const pag = await criarPagamento(db);
    await criarMovimentoLigado(db, pag, { date: DATA_LEGADA });
    await marcarPago(db, pag);
    expect((await movimentos(db, pag))[0].date).toBe(PAGO_EM);
  });

  it("RPC04+05. repetir não cria nada nem muda nada", async () => {
    const pag = await criarPagamento(db);
    const mov = await criarMovimentoLigado(db, pag);
    await marcarPago(db, pag);

    const depoisDaPrimeira = (await movimentos(db, pag))[0];
    const totalAntes = await total(db);

    const r1 = await marcarPago(db, pag);
    const r2 = await marcarPago(db, pag);

    const movs = await movimentos(db, pag);
    expect(movs).toHaveLength(1);
    expect(await total(db)).toBe(totalAntes);
    expect(movs[0].id).toBe(mov);
    expect(movs[0]).toEqual(depoisDaPrimeira);   // linha byte a byte igual
    expect(r1.rows[0].ja_estava_pago).toBe(true);
    expect(r2.rows[0].ja_estava_pago).toBe(true);
  });

  it("RPC10. o snapshot de categoria acompanha o pagamento", async () => {
    const pag = await criarPagamento(db, { expense_category_id: CATEGORIA });
    await criarMovimentoLigado(db, pag, { expense_category_id: null });
    await marcarPago(db, pag);
    expect((await movimentos(db, pag))[0].expense_category_id).toBe(CATEGORIA);
  });

  it("RPC10b. um pagamento sem categoria não apaga a que o movimento tinha", async () => {
    // Destruir informação não ganharia nada: para um movimento ligado quem
    // manda na leitura é o pagamento (ver `effective-expense-category.ts`),
    // portanto o snapshot antigo nunca chega a contradizer o ecrã.
    const pag = await criarPagamento(db, { expense_category_id: null });
    await criarMovimentoLigado(db, pag, { expense_category_id: CATEGORIA });
    await marcarPago(db, pag);
    const [m] = await movimentos(db, pag);
    expect(m.expense_category_id).toBe(CATEGORIA);
    expect(m.status).toBe("confirmado");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardas — nada estranho é aproveitado
// ═══════════════════════════════════════════════════════════════════════════

describe("guardas: falhar fechado", () => {
  let db: PGlite;
  beforeEach(async () => { db = await comA079(); });

  /** Prova que a recusa é total: nem o pagamento nem o movimento mudam. */
  async function recusaSemEfeito(pag: string, padrao: RegExp) {
    const movAntes = await movimentos(db, pag);
    const totalAntes = await total(db);

    await expect(marcarPago(db, pag)).rejects.toThrow(padrao);

    // 🔴 O `UPDATE` do pagamento acontece ANTES do guarda. Se a chamada não
    //    fosse atómica, ficava um pagamento pago sem saída de caixa — que é
    //    exactamente a divergência que tudo isto existe para evitar.
    expect(await estadoPagamento(db, pag)).toBe("pendente");
    expect(await movimentos(db, pag)).toEqual(movAntes);
    expect(await total(db)).toBe(totalAntes);
  }

  it("RPC07+13. valor diferente do pagamento → recusa e reverte tudo", async () => {
    const pag = await criarPagamento(db, { amount: "153.75" });
    await criarMovimentoLigado(db, pag, { amount: "999.99" });
    await recusaSemEfeito(pag, /CASHFLOW_LINK_AMOUNT_MISMATCH/);
  });

  it("RPC08+13. movimento de entrada → recusa e reverte tudo", async () => {
    const pag = await criarPagamento(db);
    await criarMovimentoLigado(db, pag, { type: "entrada", category: "faturacao" });
    await recusaSemEfeito(pag, /CASHFLOW_LINK_TYPE_MISMATCH/);
  });

  it("RPC06. empresa diferente → recusa antes de tocar em nada", async () => {
    const pag = await criarPagamento(db);
    await expect(marcarPago(db, pag, OUTRA_EMPRESA))
      .rejects.toThrow(/inexistente ou de outra empresa/i);
    expect(await estadoPagamento(db, pag)).toBe("pendente");
  });

  it("RPC09. o movimento de outro pagamento não é reciclado", async () => {
    const alheio = await criarPagamento(db);
    await criarMovimentoLigado(db, alheio);
    const meu = await criarPagamento(db);
    const totalAntes = await total(db);

    await marcarPago(db, meu);

    expect(await movimentos(db, meu)).toHaveLength(1);
    expect((await movimentos(db, alheio))[0].status).toBe("pendente");
    expect(await total(db)).toBe(totalAntes + 1);   // criou o seu, não roubou o outro
  });

  it("RPC15. um movimento manual sem origem fica exactamente como estava", async () => {
    const solto = novoId();
    await db.query(
      `INSERT INTO public.cash_flow_entries
         (id, company_id, type, amount, description, category, date, status)
       VALUES ($1, $2, 'saida', 42.00, 'Despesa manual', 'despesa', '2026-08-01', 'pendente')`,
      [solto, EMPRESA],
    );
    const antes = (await db.query(`SELECT * FROM public.cash_flow_entries WHERE id = $1`, [solto])).rows[0];

    const pag = await criarPagamento(db);
    await marcarPago(db, pag);

    const depois = (await db.query(`SELECT * FROM public.cash_flow_entries WHERE id = $1`, [solto])).rows[0];
    expect(depois).toEqual(antes);
  });

  it("o período fechado continua a bloquear", async () => {
    // A 079 não relaxou nada do que a 073 já protegia.
    const pag = await criarPagamento(db);
    await db.query(
      `INSERT INTO public.financial_periods (company_id, year, month, status)
       VALUES ($1, 2026, 8, 'closed')`, [EMPRESA],
    );
    await expect(marcarPago(db, pag)).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect(await estadoPagamento(db, pag)).toBe("pendente");
  });

  it("um pagamento sem valor continua a não gerar movimento", async () => {
    const pag = await criarPagamento(db, { amount: null });
    await expect(marcarPago(db, pag)).rejects.toThrow(/sem valor/i);
    expect(await total(db)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rollback
// ═══════════════════════════════════════════════════════════════════════════

describe("rollback da 079", () => {
  it("repõe o comportamento da 073 — e o defeito volta com ele", async () => {
    // Um rollback que não regredisse o comportamento não teria reposto nada.
    const db = await comA079();
    await db.exec(sqlRollback(M079_DOWN));

    const pag = await criarPagamento(db);
    await criarMovimentoLigado(db, pag);
    await marcarPago(db, pag);

    expect((await movimentos(db, pag))[0].status).toBe("pendente");
  });

  it("e reaplicar a 079 fecha-o outra vez", async () => {
    const db = await comA079();
    await db.exec(sqlRollback(M079_DOWN));
    await db.exec(sql(M079));

    const pag = await criarPagamento(db);
    await criarMovimentoLigado(db, pag);
    await marcarPago(db, pag);

    expect((await movimentos(db, pag))[0].status).toBe("confirmado");
  });

  it("🔴 o corpo do rollback é o da 073, não uma reescrita parecida", async () => {
    // A primeira versão deste rollback tinha cinco linhas de comentário a
    // menos. Passava em todos os testes de comportamento e mesmo assim não era
    // a definição da 073 — o ensaio em Postgres apanhou-o comparando
    // `pg_get_functiondef`. Aqui compara-se o texto, que é o que dá para fazer
    // sem uma base ligada.
    const corpo = (s: string) => {
      const i = s.indexOf("CREATE OR REPLACE FUNCTION public.mark_payment_paid");
      return s.slice(i, s.indexOf("$$;", i) + 3);
    };
    expect(corpo(ler(`supabase/migrations/rollback/${M079_DOWN}`)))
      .toBe(corpo(ler(`supabase/migrations/${M073}`)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardas permanentes sobre os ficheiros
// ═══════════════════════════════════════════════════════════════════════════

describe("disciplina da migration", () => {
  const texto079 = () => ler(`supabase/migrations/${M079}`);

  it("🔴 MIGRATION_DATA_WRITES = 0 — fora da definição da função não há escritas", async () => {
    // Uma migration de função que também mexesse em dados passaria a fazer
    // duas coisas com um só gate. Aqui recorta-se o corpo da função e olha-se
    // para tudo o resto.
    const s = texto079();
    const i = s.indexOf("CREATE OR REPLACE FUNCTION");
    const j = s.indexOf("$fn$;", i) + 5;
    const foraDaFuncao = s.slice(0, i) + s.slice(j);
    const semComentarios = foraDaFuncao
      .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

    expect(semComentarios).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(semComentarios).not.toMatch(/\bUPDATE\s+public\./i);
    expect(semComentarios).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(semComentarios).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("não altera nada do que a 073/075 já garantiam", async () => {
    const semComentarios = texto079()
      .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(semComentarios).not.toMatch(/unmark_payment_paid/);
    expect(semComentarios).not.toMatch(/is_financial_period_open\s*\(\s*p_company_id\s+uuid/);
    expect(semComentarios).not.toMatch(/DROP\s+(INDEX|CONSTRAINT|FUNCTION)/i);
    expect(semComentarios).not.toMatch(/ALTER\s+TABLE/i);
  });

  it("mantém a assinatura que o cliente lê", async () => {
    // `payment-cashflow.ts` lê estes três nomes. Mudá-los obrigaria a um
    // `DROP FUNCTION`, e um DROP a meio de uma migration deixa uma janela em
    // que produção chama uma função que não existe.
    expect(texto079()).toMatch(
      /RETURNS TABLE \(payment_id uuid, cash_entry_id uuid, ja_estava_pago boolean\)/,
    );
    const cliente = ler("src/lib/finance-rpc/payment-cashflow.ts");
    expect(cliente).toMatch(/cash_entry_id/);
    expect(cliente).toMatch(/ja_estava_pago/);
    expect(cliente).toMatch(/mark_payment_paid/);
  });

  it("🔴 a pasta `rollback/` não é apanhada pelo runner de migrations", async () => {
    // O runner faz `readdirSync` não recursivo e filtra por `.sql`. O nome da
    // pasta não termina em `.sql`, portanto nunca entra na lista. Se alguém
    // trocar por uma versão recursiva, este teste fica vermelho antes de o
    // ficheiro de rollback ser aplicado como se fosse uma migration para a
    // frente — que reverteria a 079 no próprio `--apply` que a aplicou.
    const runner = ler("scripts/lib/migration-runner-core.mjs");
    expect(runner).toMatch(/readdirSync\(migrationsDir\)\s*\n?\s*\.filter\(\(f\) => f\.endsWith\("\.sql"\)\)/);
    expect(runner).not.toMatch(/readdirSync\([^)]*recursive:\s*true/);

    const nomes = fs.readdirSync(MIGRACOES).filter((f) => f.endsWith(".sql"));
    expect(nomes).toContain(M079);
    expect(nomes).not.toContain(M079_DOWN);
  });

  it("a 070 continua bloqueada e a 079 não lhe toca", async () => {
    const politica = JSON.parse(ler("supabase/migration-policy.json"));
    expect(politica.blockedMigrations.map((b: { migration: string }) => b.migration))
      .toContain("070_guard_profile_managed_fields.sql");

    // A 079 **menciona** a 070 — num comentário, para dizer que não lhe mexe.
    // O que não pode é executar nada que a envolva. A primeira versão deste
    // teste proibia a palavra e ficava vermelha pelo compromisso escrito, que
    // é o contrário do que se quer verificar.
    const semComentarios = texto079()
      .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(semComentarios).not.toMatch(/070/);
    expect(semComentarios).not.toMatch(/\bprofiles\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O modelo das 6 — o que o domínio já diz hoje
// ═══════════════════════════════════════════════════════════════════════════

describe("o que a reparação das 6 vai precisar, medido no domínio actual", () => {
  it("🔴 o valor de `kind` para uma factura pontual é `variavel`, não `variable`", async () => {
    // O pedido escrevia `kind = variable`. O CHECK da 037 e o tipo da
    // aplicação dizem `variavel`. Um `variable` seria recusado pela base — e
    // só se veria no momento da escrita em produção.
    expect(ler("supabase/migrations/037_fixed_variable_payments.sql"))
      .toMatch(/kind\s+text NOT NULL CHECK \(kind IN \('fixo', 'variavel'\)\)/);
    expect(ler("src/app/actions/payments.ts"))
      .toMatch(/export type PaymentKind = "fixo" \| "variavel"/);
  });

  it("`variavel` não cria recorrência", async () => {
    // §1: «não criar recorrência». O `recurring` já é derivado do `kind`.
    expect(ler("src/app/actions/payments.ts")).toMatch(/recurring: input\.kind === "fixo"/);
  });

  it("🔴 um pagamento sem vencimento nunca aparece «Em atraso»", async () => {
    // §4. Já é assim, nos dois sítios que decidem — não foi preciso mudar nada,
    // mas fica fixado: sem vencimento conhecido não há base para afirmar atraso.
    expect(ler("src/app/actions/payments.ts")).toMatch(/overdue: !!r\.due_date && r\.due_date < today/);
    expect(ler("src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx"))
      .toMatch(/const overdue = p\.status === "pendente" && p\.due_date && p\.due_date < today/);
  });

  it("sem vencimento, a competência é a que estiver gravada — não o mês aberto", async () => {
    // §3. A regra da #77 deriva a competência do `due_date`; sem `due_date` não
    // há nada a derivar, e o `fallback` é o que o chamador passar.
    const c = ler("src/domain/finance/payment-competence.ts");
    expect(c).toMatch(/competenceFromDueDate\(input\.dueDate\) \?\? input\.fallback/);
    expect(c).toMatch(/if \(typeof dueDate !== "string"\) return null;/);
  });
});
