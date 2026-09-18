// ============================================================================
// A eliminação física de um perfil está fechada
// ============================================================================
//
// 🔴 O defeito, e porque é que a recusa é a correcção certa por agora.
//
//    `deleteColaborador` corria nove `UPDATE`s a pôr a autoria a NULL —
//    serviços, contratos, faltas, férias, faturas, folha — e só depois chamava
//    `deleteUser`.
//
//    O catálogo tem QUARENTA E OITO colunas a apontar para `profiles`. As
//    outras trinta e nove não eram anuladas, e são elas que fazem o
//    `deleteUser` falhar: fluxo de caixa, pagamentos fixos, períodos
//    financeiros, conciliação bancária, tarefas de gestão, documentos e o funil
//    de leads.
//
//    Quando falhava, os nove primeiros já estavam gravados — cada um
//    confirma-se sozinho, porque a chave administrativa fala por HTTP e não há
//    transação a envolvê-los:
//
//        PROFILE_EXISTS = YES   e   HISTORY_PARTIALLY_CLEARED = YES
//
//    O perfil ficava, e uma fatura fechada deixava de saber quem a emitiu.
//
// ----------------------------------------------------------------------------
// O que estes ensaios medem
// ----------------------------------------------------------------------------
//
// Não é «devolveu erro». O código antigo também devolvia erro — depois de já
// ter apagado autoria. O que se mede é **que não escreveu nada**.
//
// Um teste que olhasse só para `res.ok === false` daria verde ao defeito.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface OpDb { table: string; op: string }

const dbOps: OpDb[] = [];
const getUser = vi.fn();
const deleteUser = vi.fn();
const updateUserById = vi.fn();

const EMPRESA = "empresa-1";
const OUTRA = "empresa-2";
const GESTORA = "gestora-1";
const ALVO = "colab-1";

let actorRole = "admin";
let actorCompany = EMPRESA;
let alvoCompany = EMPRESA;

function builder(table: string) {
  const b: Record<string, unknown> = {};
  let colunas = "";

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (nome === "select" && typeof args[0] === "string") colunas = args[0];
    if (["insert", "update", "upsert", "delete"].includes(nome)) {
      dbOps.push({ table, op: nome });
    }
    return b;
  };
  for (const n of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit"]) {
    b[n] = encadeia(n);
  }

  b.single = async () => {
    if (table !== "profiles") return { data: null, error: null };
    if (colunas.includes("full_name")) {
      return { data: { id: ALVO, company_id: alvoCompany, full_name: "Ana Silva" }, error: null };
    }
    return { data: { company_id: actorCompany, role: actorRole }, error: null };
  };
  b.maybeSingle = b.single;
  b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r);
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => builder(t),
    auth: { admin: { deleteUser, updateUserById } },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/** As escritas registadas — o que tem de ficar vazio. */
const escritas = () => dbOps.filter((o) => ["insert", "update", "upsert", "delete"].includes(o.op));

beforeEach(() => {
  dbOps.length = 0;
  getUser.mockReset().mockResolvedValue({ data: { user: { id: GESTORA } } });
  deleteUser.mockReset().mockResolvedValue({ error: null });
  updateUserById.mockReset().mockResolvedValue({ error: null });
  actorRole = "admin";
  actorCompany = EMPRESA;
  alvoCompany = EMPRESA;
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const apagar = async (id = ALVO, empresa = EMPRESA) => {
  const { deleteColaborador } = await import("@/app/actions/colaboradores");
  return deleteColaborador(id, empresa);
};

// ---------------------------------------------------------------------------
describe("deleteColaborador recusa, e não escreve", () => {
  it("🔴 recusa mesmo com permissões e empresa certas", async () => {
    const res = await apagar();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("não pode ser eliminada definitivamente");
  });

  it("🔴 não anula uma única autoria — zero escritas", async () => {
    await apagar();

    // A asserção que o código antigo falharia: ele escrevia nove vezes antes
    // de chegar ao `deleteUser`.
    expect(escritas()).toEqual([]);
  });

  it("🔴 não chama o Auth", async () => {
    await apagar();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("aponta o caminho que existe — retirar o acesso", async () => {
    const res = await apagar();
    if (res.ok) return;
    // Uma recusa sem alternativa é um beco. Quem está a tentar dar saída a
    // alguém precisa de saber por onde se faz.
    expect(res.error).toMatch(/acesso/i);
  });
});

// ---------------------------------------------------------------------------
describe("a autorização continua a decidir primeiro", () => {
  it("sem sessão", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect(await apagar()).toMatchObject({ ok: false, error: "Não autenticado." });
    expect(escritas()).toEqual([]);
  });

  it("um colaborador comum não pode", async () => {
    actorRole = "colaborador";
    expect(await apagar()).toMatchObject({ ok: false, error: "Sem permissão." });
  });

  it("empresa do pedido diferente da da sessão", async () => {
    expect(await apagar(ALVO, OUTRA)).toMatchObject({ ok: false, error: "Empresa inválida." });
  });

  it("alvo de outra empresa", async () => {
    alvoCompany = OUTRA;
    expect(await apagar()).toMatchObject({ ok: false, error: "Colaboradora inválida." });
  });

  it("ninguém se apaga a si própria", async () => {
    expect(await apagar(GESTORA)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
describe("o caminho destrutivo não voltou", () => {
  const fonte = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const bruto = fs.readFileSync(
      path.join(process.cwd(), "src/app/actions/colaboradores.ts"), "utf8",
    );
    // Só o executável: os comentários EXPLICAM o padrão antigo, e uma guarda
    // que os lesse ficaria vermelha por causa da própria explicação.
    return bruto
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith("--") && !l.trimStart().startsWith("//")
        && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
  };

  it("🔴 nenhum `update` põe uma coluna de autoria a NULL", () => {
    const codigo = fonte();
    for (const coluna of ["created_by", "cancelled_by", "approved_by", "replaced_by", "reviewed_by"]) {
      expect(
        codigo.includes(`${coluna}: null`),
        `voltou a anular ${coluna} — é o defeito de origem`,
      ).toBe(false);
    }
  });

  it("🔴 `deleteUser` não é chamado em lado nenhum deste ficheiro", () => {
    expect(fonte()).not.toMatch(/auth\.admin\.deleteUser/);
  });

  it("a lista de colaboradores já não tem botão de eliminar", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const tabela = fs.readFileSync(
      path.join(process.cwd(),
        "src/app/(dashboard)/dashboard/colaboradores/_components/table.tsx"), "utf8",
    );
    expect(tabela).not.toMatch(/deleteColaborador/);
    expect(tabela).not.toMatch(/Excluir colaboradora/);
  });
});
