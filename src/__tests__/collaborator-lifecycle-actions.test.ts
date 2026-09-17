// ============================================================================
// Saída de um colaborador — a fronteira de confiança das actions
// ============================================================================
//
// `collaborator-lifecycle-postgres.test.ts` prova o que a BASE faz. Este prova
// o que as ACTIONS fazem antes de lá chegarem: quem pode pedir, sobre quem, e
// — o essencial — que uma recusa não escreve absolutamente nada.
//
// 🔴 A afirmação central deste ficheiro é uma ausência.
//
//    O defeito antigo não era uma verificação em falta; era nove UPDATEs que
//    corriam ANTES de se saber se o DELETE ia passar. Por isso o que aqui se
//    mede não é «recusou?», é «recusou sem ter tocado em nada?». Um teste que
//    só olhasse para `res.ok === false` daria verde ao código antigo, que
//    também devolvia erro — depois de já ter apagado autoria.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INVENTARIO_FK_PERFIS } from "@/domain/collaborators/lifecycle";

interface OpDb { table: string; op: string; payload: unknown }

const dbOps: OpDb[] = [];
/** Cada contagem pedida, na forma `tabela.coluna` — a cobertura da sondagem. */
const sondagens: string[] = [];
const getUser = vi.fn();
const deleteUser = vi.fn();
const updateUserById = vi.fn();
const getUserById = vi.fn();

/** Contagens por tabela para a sondagem. Ausente = zero. */
let contagens: Record<string, number> = {};
/** Tabelas cuja contagem falha, para medir o fail-closed. */
let falham: Set<string> = new Set();
/** Linhas devolvidas por `.single()`, por tabela. */
let singles: Record<string, { data?: unknown; error?: unknown }> = {};

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  let op: string | null = null;
  let payload: unknown = null;
  let contagem = false;
  let colunaFiltrada: string | null = null;

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (nome === "eq" && typeof args[0] === "string") colunaFiltrada = args[0];
    if (["insert", "update", "upsert", "delete"].includes(nome)) {
      op = nome;
      payload = args[0] ?? null;
    }
    // `select("*", { count: "exact", head: true })` é a sondagem; qualquer
    // outro `select` é leitura normal.
    if (nome === "select" && (args[1] as { head?: boolean } | undefined)?.head) contagem = true;
    return builder;
  };
  for (const nome of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit"]) {
    builder[nome] = encadeia(nome);
  }

  const registar = () => { if (op) dbOps.push({ table, op, payload }); };

  builder.single = async () => { registar(); return singles[table] ?? { data: null, error: null }; };
  builder.maybeSingle = builder.single;
  builder.then = (r: (v: unknown) => unknown) => {
    registar();
    if (contagem) {
      sondagens.push(`${table}.${colunaFiltrada}`);
      if (falham.has(table)) {
        return Promise.resolve({ count: null, error: { message: "ligação perdida" } }).then(r);
      }
      return Promise.resolve({ count: contagens[table] ?? 0, error: null }).then(r);
    }
    return Promise.resolve({ data: null, error: null }).then(r);
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => makeBuilder(t),
    auth: { admin: { deleteUser, updateUserById, getUserById } },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ auditLog: async () => {} }));

const EMPRESA = "empresa-1";
const OUTRA = "empresa-2";
const GESTORA = "gestora-1";
const ALVO = "colab-1";

/** Todas as escritas registadas — o que tem de ficar vazio numa recusa. */
const escritas = () => dbOps.filter((o) => ["insert", "update", "upsert", "delete"].includes(o.op));

function cenario(over: {
  actorRole?: string;
  actorCompany?: string;
  alvoCompany?: string;
  alvoStatus?: string;
} = {}) {
  singles = {
    profiles: { data: null, error: null },
  };
  // `profiles.single()` é pedido duas vezes: primeiro quem pede, depois sobre
  // quem. O mock devolve por ordem de chamada.
  const sequencia = [
    { data: { company_id: over.actorCompany ?? EMPRESA, role: over.actorRole ?? "admin" }, error: null },
    {
      data: {
        id: ALVO,
        company_id: over.alvoCompany ?? EMPRESA,
        full_name: "Ana Silva",
        status: over.alvoStatus ?? "ativo",
      },
      error: null,
    },
  ];
  let i = 0;
  singles = new Proxy({} as Record<string, { data?: unknown; error?: unknown }>, {
    get: (_t, prop) => (prop === "profiles" ? sequencia[Math.min(i++, 1)] : { data: null, error: null }),
    has: () => true,
  });
  contagens = {};
  falham = new Set();
}

beforeEach(() => {
  dbOps.length = 0;
  sondagens.length = 0;
  getUser.mockReset().mockResolvedValue({ data: { user: { id: GESTORA } } });
  deleteUser.mockReset().mockResolvedValue({ error: null });
  updateUserById.mockReset().mockResolvedValue({ error: null });
  getUserById.mockReset().mockResolvedValue({ data: { user: { id: ALVO } } });
  cenario();
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const apagar = async (id = ALVO, empresa = EMPRESA) => {
  const { deleteColaborador } = await import("@/app/actions/colaboradores");
  return deleteColaborador(id, empresa);
};
const desativar = async (id = ALVO, empresa = EMPRESA) => {
  const { desativarColaborador } = await import("@/app/actions/colaboradores");
  return desativarColaborador(id, empresa);
};
const avaliar = async (id = ALVO, empresa = EMPRESA) => {
  const { avaliarSaidaColaborador } = await import("@/app/actions/colaboradores");
  return avaliarSaidaColaborador(id, empresa);
};

// ---------------------------------------------------------------------------
describe("quem pode dar saída", () => {
  it("sem sessão, nada acontece", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await apagar();
    expect(res.ok).toBe(false);
    expect(escritas()).toEqual([]);
  });

  it("um colaborador comum não pode", async () => {
    cenario({ actorRole: "colaborador" });
    const res = await apagar();
    expect(res).toMatchObject({ ok: false, error: "Sem permissão." });
    expect(escritas()).toEqual([]);
  });

  it("um gestor pode", async () => {
    cenario({ actorRole: "gestor" });
    const res = await apagar();
    expect(res.ok).toBe(true);
  });

  it("não se apaga alguém de outra empresa", async () => {
    cenario({ alvoCompany: OUTRA });
    const res = await apagar();
    expect(res).toMatchObject({ ok: false, error: "Colaboradora inválida." });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("nem se finge que a empresa é outra", async () => {
    // O `companyId` vem do browser. A empresa que vale é a de quem está
    // autenticado, lida da base.
    const res = await apagar(ALVO, OUTRA);
    expect(res).toMatchObject({ ok: false, error: "Empresa inválida." });
    expect(escritas()).toEqual([]);
  });

  it("ninguém se apaga a si própria", async () => {
    const res = await apagar(GESTORA);
    expect(res).toMatchObject({ ok: false });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("nem se desativa a si própria — seria trancar a porta por dentro", async () => {
    const res = await desativar(GESTORA);
    expect(res).toMatchObject({ ok: false });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("a recusa não escreve nada", () => {
  it("com histórico, recusa e não anula uma única autoria", async () => {
    contagens = { cash_flow_entries: 3, services: 12 };
    const res = await apagar();

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ codigo: "TEM_HISTORICO" });
    // 🔴 A afirmação que o código antigo falharia: zero escritas.
    expect(escritas()).toEqual([]);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("uma sondagem que falha recusa — não se apaga na dúvida", async () => {
    falham = new Set(["management_tasks"]);
    const res = await apagar();
    expect(res).toMatchObject({ ok: false, codigo: "SONDAGEM_FALHADA" });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("sonda TODAS as referências do inventário, não um subconjunto", async () => {
    await apagar();

    // 🔴 Igualdade com o inventário, e não «pelo menos as nove antigas».
    //    O defeito era exactamente um subconjunto: nove de quarenta e seis.
    //    Uma asserção de inclusão daria verde ao código que se está a
    //    substituir.
    const esperado = INVENTARIO_FK_PERFIS.map((r) => `${r.tabela}.${r.coluna}`).sort();
    expect([...sondagens].sort()).toEqual(esperado);
    expect(esperado.length).toBe(46);
  });

  it("sem histórico, elimina — e só então", async () => {
    const res = await apagar();
    expect(res.ok).toBe(true);
    expect(deleteUser).toHaveBeenCalledWith(ALVO);
    // A única escrita é o apagar da linha do perfil, para o caso de não haver
    // conta de acesso a cascatar.
    expect(escritas().map((o) => `${o.table}:${o.op}`)).toEqual(["profiles:delete"]);
  });
});

// ---------------------------------------------------------------------------
describe("desativar", () => {
  it("bane a conta ANTES de marcar o estado", async () => {
    const ordem: string[] = [];
    updateUserById.mockImplementation(async () => { ordem.push("ban"); return { error: null }; });

    const res = await desativar();
    expect(res.ok).toBe(true);

    const estado = dbOps.find((o) => o.op === "update");
    expect((estado?.payload as { status: string }).status).toBe("inativo");
    expect(ordem).toEqual(["ban"]);
    expect(updateUserById).toHaveBeenCalledWith(ALVO, { ban_duration: "876000h" });
  });

  it("se o banimento falhar, o estado não muda — a pessoa não fica «inativa» a conseguir entrar", async () => {
    updateUserById.mockResolvedValue({ error: { message: "auth em baixo" } });
    const res = await desativar();
    expect(res.ok).toBe(false);
    expect(escritas()).toEqual([]);
  });

  it("um perfil sem conta de acesso desativa na mesma", async () => {
    getUserById.mockResolvedValue({ data: { user: null } });
    const res = await desativar();
    expect(res.ok).toBe(true);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(escritas().map((o) => `${o.table}:${o.op}`)).toEqual(["profiles:update"]);
  });

  it("desativar nunca apaga nada", async () => {
    contagens = { payroll_records: 24, timesheets: 300 };
    const res = await desativar();
    expect(res.ok).toBe(true);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(escritas().every((o) => o.op === "update")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("avaliação, antes de decidir", () => {
  it("conta o que existe e explica-o em português", async () => {
    contagens = { payroll_records: 12, timesheets: 40 };
    const res = await avaliar();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.veredicto.elegivel).toBe(false);
    expect(res.areas.map((a) => a.area)).toContain("payroll");
    expect(res.explicacao).toContain("folha de pagamento");
    // Avaliar é ler. Não escreve.
    expect(escritas()).toEqual([]);
  });

  it("um perfil limpo é declarado elegível", async () => {
    const res = await avaliar();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.veredicto.elegivel).toBe(true);
    expect(res.explicacao).toContain("sem perder nada");
  });
});
