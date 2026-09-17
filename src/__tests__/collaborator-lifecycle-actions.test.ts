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
//    O defeito antigo não era uma verificação em falta; eram nove UPDATEs que
//    corriam ANTES de se saber se o DELETE ia passar. Por isso o que aqui se
//    mede não é «recusou?», é «recusou sem ter tocado em nada?». Um teste que
//    só olhasse para `res.ok === false` daria verde ao código antigo, que
//    também devolvia erro — depois de já ter apagado autoria.
//
// 🔴 O id do perfil e o id da conta são DIFERENTES em todo este ficheiro.
//
//    Não é um detalhe do fixture. O repositório tem dois modelos de identidade
//    a coexistir, e enquanto os mocks usavam o mesmo número para os dois, um
//    `getUserById(profileId)` escrito por engano passava nos testes e banía a
//    conta errada em produção no dia em que `auth_user_id` entrasse. Aqui,
//    quem confundir os dois falha.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INVENTARIO_FK_PERFIS } from "@/domain/collaborators/lifecycle";
import { ESTADO_DE_SAIDA } from "@/domain/collaborators/access-state";

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

const EMPRESA = "empresa-1";
const OUTRA = "empresa-2";
const GESTORA = "gestora-1";
const ALVO = "perfil-da-ana";
/** 🔴 Deliberadamente diferente de `ALVO`. Ver a nota no topo. */
const CONTA_DA_ANA = "auth-user-da-ana";

/** Como a base responde quando se lhe pede `auth_user_id`. */
type ModeloIdentidade = "coluna" | "coluna-sem-conta" | "legado" | "erro";

let modelo: ModeloIdentidade = "coluna";
let actorRole = "admin";
let actorCompany = EMPRESA;
let alvoCompany = EMPRESA;
let alvoStatus = "ativo";
/** O estado que a leitura de confirmação devolve depois do UPDATE. */
let estadoConfirmado: string | null = null;
let falhaUpdatePerfil = false;

/**
 * As respostas de `profiles` decidem-se pelas COLUNAS pedidas, não pela ordem
 * das chamadas.
 *
 * A versão anterior devolvia por ordem — primeira chamada é quem pede,
 * segunda é o alvo — e partiu-se assim que a action passou a ler mais duas
 * vezes (identidade e confirmação). Um mock que conta chamadas obriga a
 * reescrevê-lo sempre que o código lê mais uma coisa, e o que ele mede
 * silenciosamente deixa de ser o que o código faz.
 */
function respostaProfiles(colunas: string): { data?: unknown; error?: unknown } {
  if (colunas.includes("auth_user_id")) {
    if (modelo === "erro") return { data: null, error: { code: "08006", message: "base em baixo" } };
    if (modelo === "legado") {
      // O PostgREST quando a coluna não existe nesta base.
      return { data: null, error: { code: "42703", message: 'column profiles.auth_user_id does not exist' } };
    }
    return {
      data: { id: ALVO, auth_user_id: modelo === "coluna-sem-conta" ? null : CONTA_DA_ANA },
      error: null,
    };
  }
  if (colunas.includes("full_name")) {
    return { data: { id: ALVO, company_id: alvoCompany, full_name: "Ana Silva", status: alvoStatus }, error: null };
  }
  if (colunas.trim() === "status") {
    return { data: estadoConfirmado === null ? null : { status: estadoConfirmado }, error: null };
  }
  if (colunas.includes("role")) {
    return { data: { company_id: actorCompany, role: actorRole }, error: null };
  }
  // `select("id")` — o caminho legado do resolver.
  return { data: { id: ALVO }, error: null };
}

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  let op: string | null = null;
  let payload: unknown = null;
  let contagem = false;
  let colunas = "";
  let colunaFiltrada: string | null = null;

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (nome === "eq" && typeof args[0] === "string") colunaFiltrada = args[0];
    if (["insert", "update", "upsert", "delete"].includes(nome)) {
      op = nome;
      payload = args[0] ?? null;
    }
    if (nome === "select") {
      colunas = typeof args[0] === "string" ? args[0] : "";
      // `select("*", { count: "exact", head: true })` é a sondagem; qualquer
      // outro `select` é leitura normal.
      if ((args[1] as { head?: boolean } | undefined)?.head) contagem = true;
    }
    return builder;
  };
  for (const nome of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit"]) {
    builder[nome] = encadeia(nome);
  }

  const registar = () => { if (op) dbOps.push({ table, op, payload }); };

  builder.single = async () => {
    registar();
    return table === "profiles" ? respostaProfiles(colunas) : { data: null, error: null };
  };
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
    if (op === "update" && table === "profiles" && falhaUpdatePerfil) {
      return Promise.resolve({ data: null, error: { message: "escrita recusada" } }).then(r);
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

/** Todas as escritas registadas — o que tem de ficar vazio numa recusa. */
const escritas = () => dbOps.filter((o) => ["insert", "update", "upsert", "delete"].includes(o.op));

beforeEach(() => {
  dbOps.length = 0;
  sondagens.length = 0;
  getUser.mockReset().mockResolvedValue({ data: { user: { id: GESTORA } } });
  deleteUser.mockReset().mockResolvedValue({ error: null });
  updateUserById.mockReset().mockResolvedValue({ error: null });
  getUserById.mockReset().mockResolvedValue({ data: { user: { id: CONTA_DA_ANA } } });
  contagens = {};
  falham = new Set();
  modelo = "coluna";
  actorRole = "admin";
  actorCompany = EMPRESA;
  alvoCompany = EMPRESA;
  alvoStatus = "ativo";
  estadoConfirmado = ESTADO_DE_SAIDA;
  falhaUpdatePerfil = false;
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
    expect((await desativar()).ok).toBe(false);
    expect(escritas()).toEqual([]);
  });

  it("um colaborador comum não pode", async () => {
    actorRole = "colaborador";
    expect(await desativar()).toMatchObject({ ok: false, error: "Sem permissão." });
    expect(escritas()).toEqual([]);
  });

  it("um gestor pode", async () => {
    actorRole = "gestor";
    expect((await desativar()).ok).toBe(true);
  });

  it("não se opera sobre alguém de outra empresa", async () => {
    alvoCompany = OUTRA;
    expect(await desativar()).toMatchObject({ ok: false, error: "Colaboradora inválida." });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("nem se finge que a empresa é outra", async () => {
    // O `companyId` vem do browser. A empresa que vale é a de quem está
    // autenticado, lida da base.
    expect(await desativar(ALVO, OUTRA)).toMatchObject({ ok: false, error: "Empresa inválida." });
    expect(escritas()).toEqual([]);
  });

  it("ninguém se apaga a si própria", async () => {
    expect(await apagar(GESTORA)).toMatchObject({ ok: false });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("nem se desativa a si própria — seria trancar a porta por dentro", async () => {
    expect(await desativar(GESTORA)).toMatchObject({ ok: false });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("102.2 — a identidade da conta vem do resolver", () => {
  it("bane a CONTA, não o perfil", async () => {
    expect((await desativar()).ok).toBe(true);
    // 🔴 Se alguém voltar a escrever `updateUserById(id)`, isto fica vermelho.
    expect(updateUserById).toHaveBeenCalledWith(CONTA_DA_ANA, { ban_duration: "876000h" });
    expect(getUserById).toHaveBeenCalledWith(CONTA_DA_ANA);
  });

  it("no modelo legado, a conta é o próprio perfil — e isso é dito, não assumido", async () => {
    modelo = "legado";
    expect((await desativar()).ok).toBe(true);
    expect(updateUserById).toHaveBeenCalledWith(ALVO, { ban_duration: "876000h" });
  });

  it("um perfil sem conta desativa na mesma", async () => {
    modelo = "coluna-sem-conta";
    const res = await desativar();
    expect(res.ok).toBe(true);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(escritas().map((o) => `${o.table}:${o.op}`)).toEqual(["profiles:update"]);
  });

  it("🔴 uma falha de leitura não é lida como «modelo legado»", async () => {
    // Tratar qualquer erro como «então é o modelo antigo» faria uma base em
    // baixo parecer uma base velha, e a operação seguiria com o id errado.
    modelo = "erro";
    const res = await desativar();
    expect(res.ok).toBe(false);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("desativar", () => {
  it("bane a conta ANTES de marcar o estado", async () => {
    const ordem: string[] = [];
    updateUserById.mockImplementation(async () => { ordem.push("ban"); return { error: null }; });

    expect((await desativar()).ok).toBe(true);

    const estado = dbOps.find((o) => o.op === "update");
    expect((estado?.payload as { status: string }).status).toBe(ESTADO_DE_SAIDA);
    expect(ordem).toEqual(["ban"]);
  });

  it("se o banimento falhar, o estado não muda", async () => {
    updateUserById.mockResolvedValue({ error: { message: "auth em baixo" } });
    expect((await desativar()).ok).toBe(false);
    expect(escritas()).toEqual([]);
  });

  it("🔴 se o estado não ficar gravado, a operação FALHA — mesmo com a conta banida", async () => {
    // O banimento sozinho não tira o acesso a quem já está autenticado. É o
    // `status` que o guard lê a cada pedido. Dizer «acesso retirado» com essa
    // escrita falhada seria repetir a promessa que a 102.1 veio desfazer.
    falhaUpdatePerfil = true;
    const res = await desativar();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("não ficou gravado");
    expect(res.error).toContain("sessão aberta");
  });

  it("🔴 um update que não encontrou linha nenhuma não conta como saída", async () => {
    // Um `update` sem erro que não bateu em nada devolve sucesso. Auditar
    // «desativado» sobre isso seria registar uma coisa que não aconteceu.
    estadoConfirmado = null;
    const res = await desativar();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("não ficou confirmada");
  });

  it("nem uma confirmação com o estado errado", async () => {
    estadoConfirmado = "ativo";
    expect((await desativar()).ok).toBe(false);
  });

  it("desativar nunca apaga nada", async () => {
    contagens = { payroll_records: 24, notifications: 300 };
    expect((await desativar()).ok).toBe(true);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(escritas().every((o) => o.op === "update")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("102.3 — a eliminação física está suspensa", () => {
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
    expect(await apagar()).toMatchObject({ ok: false, codigo: "SONDAGEM_FALHADA" });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("sonda TODAS as referências do inventário, não um subconjunto", async () => {
    await apagar();

    // 🔴 Igualdade com o inventário, e não «pelo menos as nove antigas».
    //    O defeito era exactamente um subconjunto: nove de quarenta e seis.
    const esperado = INVENTARIO_FK_PERFIS.map((r) => `${r.tabela}.${r.coluna}`).sort();
    expect([...sondagens].sort()).toEqual(esperado);
    expect(esperado.length).toBe(48);
  });

  it("🔴 mesmo sem UM único registo, recusa — e não chama o Auth", async () => {
    // A corrida entre sondar e apagar não é fechável fora da base: entre o
    // veredicto e o DELETE pode nascer uma relação que as catorze FKs em
    // CASCADE levariam sem aviso. Provado em
    // `collaborator-lifecycle-postgres.test.ts`.
    const res = await apagar();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res).toMatchObject({ codigo: "ELIMINACAO_SUSPENSA" });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("a recusa por suspensão não se confunde com a recusa por histórico", async () => {
    contagens = { services: 1 };
    expect(await apagar()).toMatchObject({ codigo: "TEM_HISTORICO" });
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

  it("diz à interface que a eliminação está suspensa — a interface não o adivinha", async () => {
    const res = await avaliar();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.veredicto.elegivel).toBe(true);
    expect(res.eliminacaoSuspensa).toBe(true);
  });
});
