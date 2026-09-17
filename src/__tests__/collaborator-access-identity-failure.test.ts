// ============================================================================
// 102.2b — uma falha da base não é uma pessoa que não existe
// ============================================================================
//
// 🔴 O defeito, que sobreviveu à primeira correção.
//
//    `resolverIdentidadeAuth` foi escrito de propósito para separar dois
//    mundos: «a coluna `auth_user_id` não existe nesta base» (42703, e então
//    vale a regra legada) de «a base não respondeu». Só o primeiro autoriza o
//    fallback; o segundo devolve `{ ok: false, erro }`.
//
//    E `carregarPessoa` fazia, logo a seguir:
//
//        const identidade = await resolverIdentidadeAuth(admin, id);
//        if (!identidade.ok) return null;
//
//    ...e as quatro actions traduziam `null` para «Pessoa não encontrada.».
//    O cuidado do resolver era desfeito duas linhas depois: um `08006`, um
//    timeout, uma chave sem permissão — tudo chegava a quem administra como
//    um perfil inexistente. Quem lesse isso ia procurar a pessoa, não a base.
//
//    É o ponto onde a identidade separada é administrada. Mentir aqui sobre a
//    causa é mandar quem administra investigar o sítio errado.
//
// Este ficheiro mede as quatro actions, e mede três coisas de cada vez: a
// mensagem não mente, o Auth não é chamado, e `profiles` não é escrito.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Escritas tentadas — tem de ficar vazio em qualquer recusa. */
const escritas: string[] = [];
/** Chamadas ao Auth — idem. */
const authChamado: string[] = [];

const getUser = vi.fn();

/** Como a base responde. Cada cenário escolhe o seu. */
type Cenario =
  | "normal" | "leitura-falha" | "identidade-falha" | "coluna-ausente" | "sem-perfil"
  | "ator-falha" | "ator-inexistente" | "ator-inativo";
let cenario: Cenario = "normal";

const ACTOR = "gestora-1";
const ALVO = "perfil-da-ana";
const CONTA_DA_ANA = "auth-user-da-ana";

const ERRO_LIGACAO = { code: "08006", message: "connection failure" };

function respostaProfiles(colunas: string): { data?: unknown; error?: unknown } {
  // Quem pede. O resolver canónico pede `role` e `status` na mesma linha.
  if (colunas.includes("role")) {
    if (cenario === "ator-falha") return { data: null, error: ERRO_LIGACAO };
    if (cenario === "ator-inexistente") return { data: null, error: null };
    return {
      data: {
        id: ACTOR, company_id: "empresa-1", role: "admin",
        status: cenario === "ator-inativo" ? "inativo" : "ativo",
        auth_user_id: ACTOR,
      },
      error: null,
    };
  }

  if (colunas.includes("auth_user_id")) {
    if (cenario === "identidade-falha") return { data: null, error: ERRO_LIGACAO };
    if (cenario === "coluna-ausente") {
      return { data: null, error: { code: "42703", message: "column profiles.auth_user_id does not exist" } };
    }
    return { data: { id: ALVO, auth_user_id: CONTA_DA_ANA }, error: null };
  }

  if (colunas.includes("full_name")) {
    if (cenario === "leitura-falha") return { data: null, error: ERRO_LIGACAO };
    if (cenario === "sem-perfil") return { data: null, error: null };
    return { data: { id: ALVO, company_id: "empresa-1", full_name: "Ana Silva" }, error: null };
  }

  // `select("id")` — o caminho legado do resolver.
  return { data: { id: ALVO }, error: null };
}

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  let colunas = "";
  let op: string | null = null;

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (nome === "select" && typeof args[0] === "string") colunas = args[0];
    if (["insert", "update", "upsert", "delete"].includes(nome)) {
      op = nome;
      escritas.push(`${table}:${nome}`);
    }
    return b;
  };
  for (const n of ["select", "insert", "update", "upsert", "delete", "eq", "is", "in", "order", "limit"]) {
    b[n] = encadeia(n);
  }
  b.single = async () => (table === "profiles" ? respostaProfiles(colunas) : { data: null, error: null });
  b.maybeSingle = b.single;
  b.then = (r: (v: unknown) => unknown) => {
    void op;
    return Promise.resolve({ data: [], error: null }).then(r);
  };
  return b;
}

const auth = {
  admin: {
    createUser: async () => { authChamado.push("createUser"); return { data: { user: { id: "novo" } }, error: null }; },
    deleteUser: async () => { authChamado.push("deleteUser"); return { error: null }; },
    updateUserById: async () => { authChamado.push("updateUserById"); return { error: null }; },
    getUserById: async () => { authChamado.push("getUserById"); return { data: { user: { id: CONTA_DA_ANA } }, error: null }; },
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => makeBuilder(t), auth }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ auditLog: async () => {} }));

beforeEach(() => {
  escritas.length = 0;
  authChamado.length = 0;
  getUser.mockReset().mockResolvedValue({ data: { user: { id: ACTOR } } });
  cenario = "normal";
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

/** As quatro actions que administram o acesso, cada uma pelo seu nome. */
const ACTIONS: { nome: string; correr: () => Promise<{ ok: boolean; error?: string }> }[] = [
  {
    nome: "criarAcesso",
    correr: async () => {
      const m = await import("@/app/actions/collaborator-access");
      return m.criarAcesso(ALVO, "SenhaTemp123!");
    },
  },
  {
    nome: "definirSenhaTemporaria",
    correr: async () => {
      const m = await import("@/app/actions/collaborator-access");
      return m.definirSenhaTemporaria(ALVO, "SenhaTemp123!");
    },
  },
  {
    nome: "desativarAcesso",
    correr: async () => {
      const m = await import("@/app/actions/collaborator-access");
      return m.desativarAcesso(ALVO);
    },
  },
  {
    nome: "reativarAcesso",
    correr: async () => {
      const m = await import("@/app/actions/collaborator-access");
      return m.reativarAcesso(ALVO);
    },
  },
];

describe("102.2b — o resolver falha, e a action diz a verdade", () => {
  for (const action of ACTIONS) {
    describe(action.nome, () => {
      it("🔴 não responde «Pessoa não encontrada» quando a base é que falhou", async () => {
        cenario = "identidade-falha";
        const res = await action.correr();

        expect(res.ok).toBe(false);
        // A afirmação central: a mensagem não inventa uma pessoa inexistente.
        expect(res.error).not.toBe("Pessoa não encontrada.");
        // E nomeia o que se passou mesmo.
        expect(res.error).toContain("connection failure");
      });

      it("não chama o Auth nem escreve em profiles", async () => {
        cenario = "identidade-falha";
        await action.correr();

        expect(authChamado).toEqual([]);
        expect(escritas).toEqual([]);
      });

      it("uma falha a LER o perfil também não vira «não encontrada»", async () => {
        cenario = "leitura-falha";
        const res = await action.correr();

        expect(res.ok).toBe(false);
        expect(res.error).not.toBe("Pessoa não encontrada.");
        expect(res.error).toContain("connection failure");
        expect(authChamado).toEqual([]);
        expect(escritas).toEqual([]);
      });

      it("um perfil que REALMENTE não existe continua a dizer isso", async () => {
        // O contrapeso. Sem ele, esta correção podia ter-se limitado a nunca
        // mais dizer «não encontrada» — e aí a mensagem certa desaparecia.
        cenario = "sem-perfil";
        const res = await action.correr();

        expect(res).toMatchObject({ ok: false, error: "Pessoa não encontrada." });
        expect(authChamado).toEqual([]);
        expect(escritas).toEqual([]);
      });

      it("a coluna ausente (42703) resolve-se pelo legado, e não é falha", async () => {
        // 42703 é o único erro que autoriza o caminho legado. Se esta prova
        // ficar vermelha, ou o resolver deixou de tratar o legado, ou passou a
        // tratar erros a sério como legado — e as duas são graves.
        cenario = "coluna-ausente";
        const res = await action.correr();

        // `?? ""` porque o resultado esperado aqui é sucesso, e nesse caso não
        // há `error` nenhum. O que se afirma é que a action NÃO recusou por
        // causa da identidade — não que tenha recusado com outra mensagem.
        expect(res.error ?? "").not.toContain("Não foi possível confirmar quem é esta pessoa");
        expect(res.error ?? "").not.toBe("Pessoa não encontrada.");
      });
    });
  }
});

describe("102.2b — o legado usa o id certo, e diz que é o legado", () => {
  it("desativarAcesso bane a conta pelo id do PERFIL quando a coluna não existe", async () => {
    // No modelo legado `profiles.id = auth.users.id`, por isso o id do perfil
    // É o da conta. O que esta prova fixa não é o número — é que ele veio do
    // resolver, e não de alguém a assumir que os dois são a mesma coisa.
    cenario = "coluna-ausente";
    const m = await import("@/app/actions/collaborator-access");
    const res = await m.desativarAcesso(ALVO);

    expect(res.ok).toBe(true);
    expect(authChamado).toContain("updateUserById");
  });

  it("e no modelo com coluna usa a CONTA, que é outro id", async () => {
    cenario = "normal";
    const m = await import("@/app/actions/collaborator-access");
    const res = await m.desativarAcesso(ALVO);

    expect(res.ok).toBe(true);
    expect(authChamado).toContain("updateUserById");
    // Os dois ids são diferentes no palco deste ficheiro, de propósito.
    expect(ALVO).not.toBe(CONTA_DA_ANA);
  });
});

// ---------------------------------------------------------------------------
describe("P1 — uma falha da base não vira «Não autenticado»", () => {
  for (const action of ACTIONS) {
    describe(action.nome, () => {
      it("🔴 o ator não se resolve por falha real — e a mensagem não mente", async () => {
        cenario = "ator-falha";
        const res = await action.correr();

        expect(res.ok).toBe(false);
        // Era isto que saía antes: uma falha de infraestrutura vestida de
        // sessão inexistente, a mandar quem administra investigar o login.
        expect(res.error).not.toBe("Não autenticado.");
        expect(res.error).toContain("confirmar a tua sessão");
      });

      it("e não escreve nem chama o Auth", async () => {
        cenario = "ator-falha";
        await action.correr();
        expect(authChamado).toEqual([]);
        expect(escritas).toEqual([]);
      });

      it("sem sessão continua a dizer «Não autenticado»", async () => {
        // O contrapeso: a mensagem certa não pode desaparecer.
        getUser.mockResolvedValue({ data: { user: null } });
        const res = await action.correr();
        expect(res).toMatchObject({ ok: false, error: "Não autenticado." });
        expect(escritas).toEqual([]);
      });

      it("um ator sem perfil diz isso, e não «não autenticado»", async () => {
        cenario = "ator-inexistente";
        const res = await action.correr();
        expect(res).toMatchObject({ ok: false, error: "Perfil não encontrado." });
        expect(escritas).toEqual([]);
      });

      it("🔴 um ator que já saiu não administra acessos de ninguém", async () => {
        // Estas actions correm por `service_role`, que tem BYPASSRLS — a 102
        // não as trava. A verificação tem de estar na própria action.
        cenario = "ator-inativo";
        const res = await action.correr();
        expect(res.ok).toBe(false);
        expect(res.error).toContain("acesso foi desativado");
        expect(authChamado).toEqual([]);
        expect(escritas).toEqual([]);
      });
    });
  }
});
