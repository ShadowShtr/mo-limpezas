// ============================================================================
// 102.1 — a saída tem de valer JÁ, não quando o token expirar
// ============================================================================
//
// 🔴 A promessa que a interface fazia e o sistema não cumpria.
//
//    «Dar saída» banía a conta no Auth e escrevia `status = 'inativo'`. A
//    interface dizia «a pessoa deixa de entrar». Nenhuma das duas coisas
//    fechava a porta a quem já estava dentro:
//
//      · banir impede um login NOVO. O access token emitido antes continua
//        válido até ao `exp` — quem estivesse com a aplicação aberta seguia a
//        marcar pontos, a fechar serviços e a mexer no financeiro;
//
//      · `status` não era lido por política RLS nenhuma (zero de 93), nem
//        pelo guard das actions, nem pelos layouts. Era decoração de lista.
//
//    O ensaio decisivo deste ficheiro é `sessão ainda válida`: o utilizador
//    autentica-se com sucesso — `getUser` devolve-o, como devolveria com um
//    JWT por expirar — e mesmo assim a operação protegida é recusada.
//
//    Sem essa verificação, o teste abaixo passaria com o código antigo, e é
//    isso que o torna a prova e não uma repetição da UI.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ESTADOS_SEM_ACESSO,
  ESTADO_DE_SAIDA,
  perfilPodeEntrar,
} from "@/domain/collaborators/access-state";

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — a regra, pura
// ═══════════════════════════════════════════════════════════════════════════

describe("quem pode entrar", () => {
  it("deixa entrar quem está ativo", () => {
    expect(perfilPodeEntrar("ativo")).toBe(true);
  });

  it("recusa todos os estados de saída que o sistema sabe escrever", () => {
    for (const estado of ESTADOS_SEM_ACESSO) {
      expect(perfilPodeEntrar(estado), estado).toBe(false);
    }
  });

  it("o estado que a saída escreve é um dos que não deixa entrar", () => {
    // Amarra as duas pontas: se alguém mudar `ESTADO_DE_SAIDA` para um valor
    // que não esteja na lista, a saída volta a não fechar nada — em silêncio.
    expect(ESTADOS_SEM_ACESSO).toContain(ESTADO_DE_SAIDA);
    expect(perfilPodeEntrar(ESTADO_DE_SAIDA)).toBe(false);
  });

  it("não se importa com maiúsculas nem espaços", () => {
    expect(perfilPodeEntrar("  Inativo  ")).toBe(false);
    expect(perfilPodeEntrar("INATIVO")).toBe(false);
  });

  it("🔴 `null` deixa entrar — e é de propósito", () => {
    // `profiles.status` é anulável. Uma linha sem estado é uma pessoa cujo
    // estado ninguém escreveu, não uma pessoa que levou saída. Fechar na
    // ausência trancava fora quem nunca foi tocado, num sistema em uso real.
    expect(perfilPodeEntrar(null)).toBe(true);
    expect(perfilPodeEntrar(undefined)).toBe(true);
    expect(perfilPodeEntrar("")).toBe(true);
  });

  it("um estado desconhecido deixa entrar, em vez de trancar meia empresa", () => {
    expect(perfilPodeEntrar("ferias")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — uma sessão válida de quem já saiu
// ═══════════════════════════════════════════════════════════════════════════

const getUser = vi.fn();
/** O perfil que a base devolve para quem está autenticado. */
let perfilNaBase: Record<string, unknown> | null = null;
/** Escritas tentadas — tem de ficar vazio quando o acesso é recusado. */
const escritas: string[] = [];

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const passa = (nome: string) => () => {
    if (["insert", "update", "upsert", "delete"].includes(nome)) escritas.push(`${table}:${nome}`);
    return b;
  };
  for (const n of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit"]) {
    b[n] = passa(n);
  }
  b.single = async () => ({ data: table === "profiles" ? perfilNaBase : null, error: null });
  b.maybeSingle = b.single;
  b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r);
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => builder(t) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const UTILIZADOR = "colab-que-saiu";

beforeEach(() => {
  escritas.length = 0;
  // 🔴 Sessão VÁLIDA. É este o ponto: o Auth ainda aceita o token.
  getUser.mockReset().mockResolvedValue({ data: { user: { id: UTILIZADOR } } });
  perfilNaBase = {
    id: UTILIZADOR,
    company_id: "empresa-1",
    role: "gestor",
    status: "ativo",
  };
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const guard = async (opts?: { roles?: string[] }) => {
  const { requireProfile } = await import("@/lib/auth-guard");
  return requireProfile(opts);
};

describe("o guard das actions", () => {
  it("deixa passar enquanto a pessoa cá trabalha", async () => {
    const g = await guard();
    expect(g.ok).toBe(true);
  });

  it("🔴 recusa no pedido seguinte à saída, com a sessão ainda válida", async () => {
    perfilNaBase = { ...perfilNaBase, status: ESTADO_DE_SAIDA };

    const g = await guard();
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.code).toBe("INACTIVE");
    // E não «Sem permissão.», que mandaria a pessoa pedir mais acessos.
    expect(g.error).not.toBe("Sem permissão.");
  });

  it("o estado decide antes do papel", async () => {
    // Uma gestora que saiu não recebe «Sem permissão.» por causa do papel:
    // recebe «o teu acesso foi desativado», que é a verdade.
    perfilNaBase = { ...perfilNaBase, role: "admin", status: ESTADO_DE_SAIDA };
    const g = await guard({ roles: ["admin"] });
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.code).toBe("INACTIVE");
  });

  it("um perfil sem estado continua a passar", async () => {
    perfilNaBase = { ...perfilNaBase, status: null };
    expect((await guard()).ok).toBe(true);
  });
});

describe("uma operação protegida, ponta a ponta", () => {
  const criarTarefa = async () => {
    const { createManagementTask } = await import("@/app/actions/management-tasks");
    return createManagementTask("empresa-1", { title: "Tarefa depois da saída" });
  };

  it("passa enquanto a pessoa cá trabalha", async () => {
    await criarTarefa();
    expect(escritas).toContain("management_tasks:insert");
  });

  it("🔴 é recusada de imediato depois da saída — e não escreve nada", async () => {
    perfilNaBase = { ...perfilNaBase, status: ESTADO_DE_SAIDA };

    const res = await criarTarefa();
    expect(res.ok).toBe(false);
    // A prova que interessa: a escrita nem chegou a ser tentada. Não é uma
    // mensagem de erro por cima de um efeito que aconteceu à mesma.
    expect(escritas).toEqual([]);
  });
});
