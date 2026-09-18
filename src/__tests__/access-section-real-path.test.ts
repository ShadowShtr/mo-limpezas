// ============================================================================
// A ficha do colaborador mostra o estado REAL do acesso
// ============================================================================
//
// 🔴 O defeito.
//
//    `estadoAcesso()` só devolvia «desativado» quando `conta.disabled` era
//    verdadeiro. E a página chamava-a assim:
//
//        estadoAcesso(pessoa, profile.auth_user_id
//          ? { must_change_password: ... }
//          : null)
//
//    `disabled` nunca era enviado. Logo:
//
//      · «desativado» era INALCANÇÁVEL naquele ecrã;
//      · o botão «Reativar acesso» podia nunca aparecer;
//      · o cartão dizia «Ativo» ao lado de um perfil marcado Inativo, na mesma
//        página.
//
//    Um estado de interface derivado de um campo que ninguém carregou não é um
//    estado — é um valor por omissão com aspecto de facto.
//
// Este ficheiro percorre o CAMINHO REAL: `lerEstadoDeAcesso` vai buscar as
// duas fontes autoritativas (o `status` do perfil e o banimento no Auth), e a
// desativação/reativação passam pelas actions verdadeiras. Nada de injectar
// «desativado» por fora para o ecrã ter o que mostrar.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALVO = "perfil-da-ana";
const CONTA = "auth-user-da-ana";
const EMPRESA = "empresa-1";
const ACTOR = "gestora-1";

/** O que a base tem, e que as operações vão mudando. */
let statusNaBase = "ativo";
let banidoAte: string | null = null;
let trocaPendente = false;

const getUser = vi.fn();

function builder(table: string) {
  const b: Record<string, unknown> = {};
  let colunas = "";

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (nome === "select" && typeof args[0] === "string") colunas = args[0];
    if (nome === "update") {
      const payload = args[0] as { status?: string } | undefined;
      if (payload?.status) statusNaBase = payload.status;
    }
    return b;
  };
  for (const n of ["select", "update", "insert", "delete", "eq", "in", "is", "order", "limit"]) {
    b[n] = encadeia(n);
  }

  const resposta = () => {
    if (table !== "profiles") return { data: null, error: null };
    // Quem pede — o resolver canónico e o guard da lista pedem `role`.
    if (colunas.includes("role")) {
      return {
        data: { id: ACTOR, company_id: EMPRESA, role: "admin", status: "ativo", auth_user_id: ACTOR },
        error: null,
      };
    }
    if (colunas.includes("auth_user_id")) {
      return { data: { id: ALVO, auth_user_id: CONTA }, error: null };
    }
    if (colunas.trim() === "status") return { data: { status: statusNaBase }, error: null };
    if (colunas.includes("must_change_password")) {
      return { data: { must_change_password: trocaPendente }, error: null };
    }
    if (colunas.includes("full_name")) {
      return {
        data: { id: ALVO, company_id: EMPRESA, full_name: "Ana Silva", status: statusNaBase },
        error: null,
      };
    }
    return { data: { id: ALVO }, error: null };
  };

  b.single = async () => resposta();
  b.maybeSingle = async () => resposta();
  b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
  return b;
}

const auth = {
  admin: {
    getUserById: async () => ({
      data: { user: { id: CONTA, banned_until: banidoAte } },
      error: null,
    }),
    updateUserById: async (_id: string, attrs: { ban_duration?: string }) => {
      // O mock representa o banimento como o Supabase o representa: uma data.
      banidoAte = attrs.ban_duration === "none"
        ? null
        : new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
      return { error: null };
    },
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => builder(t), auth }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ auditLog: async () => {} }));

beforeEach(() => {
  statusNaBase = "ativo";
  banidoAte = null;
  trocaPendente = false;
  getUser.mockReset().mockResolvedValue({ data: { user: { id: ACTOR } } });
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

/** O que a página faz para saber o que mostrar. */
const estadoNoEcra = async () => {
  const { lerEstadoDeAcesso } = await import("@/lib/collaborators/read-access-state");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return lerEstadoDeAcesso(
    createAdminClient(),
    { id: ALVO, company_id: EMPRESA, full_name: "Ana Silva", auth_user_id: CONTA },
    statusNaBase,
  );
};

const desativarPelaFicha = async () => {
  const { desativarAcesso } = await import("@/app/actions/collaborator-access");
  return desativarAcesso(ALVO);
};
const reativarPelaFicha = async () => {
  const { reativarAcesso } = await import("@/app/actions/collaborator-access");
  return reativarAcesso(ALVO);
};

// ---------------------------------------------------------------------------
describe("o caminho real da ficha", () => {
  it("começa por mostrar Ativo", async () => {
    expect(await estadoNoEcra()).toBe("ativo");
  });

  it("🔴 desativar → recarregar → mostra DESATIVADO", async () => {
    const res = await desativarPelaFicha();
    expect(res.ok).toBe(true);

    // «Recarregar» é voltar a ler das fontes, exactamente como o servidor faz.
    expect(await estadoNoEcra()).toBe("desativado");
  });

  it("🔴 e é isso que torna «Reativar acesso» alcançável", async () => {
    await desativarPelaFicha();
    const estado = await estadoNoEcra();

    // O botão de reactivar só existe neste estado. Com o defeito antigo, o
    // estado nunca chegava aqui e o botão nunca aparecia.
    expect(estado).toBe("desativado");
  });

  it("reativar → recarregar → volta a ATIVO", async () => {
    await desativarPelaFicha();
    expect(await estadoNoEcra()).toBe("desativado");

    const res = await reativarPelaFicha();
    expect(res.ok).toBe(true);
    expect(await estadoNoEcra()).toBe("ativo");
  });

  it("🔴 o cartão não diz «Ativo» com o perfil marcado inativo", async () => {
    // O caso que a página mostrava errado: `status` inativo, conta sem
    // banimento (por exemplo, desativada por outra via). As duas fontes
    // contam, e a mais restritiva ganha.
    statusNaBase = "inativo";
    banidoAte = null;
    expect(await estadoNoEcra()).toBe("desativado");
  });

  it("suspenso também é desativado, aos olhos do ecrã", async () => {
    statusNaBase = "suspenso";
    expect(await estadoNoEcra()).toBe("desativado");
  });

  it("uma pessoa sem conta continua a aparecer como «sem acesso»", async () => {
    const { lerEstadoDeAcesso } = await import("@/lib/collaborators/read-access-state");
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const estado = await lerEstadoDeAcesso(
      createAdminClient(),
      { id: ALVO, company_id: EMPRESA, full_name: "Ana Silva", auth_user_id: null },
      "ativo",
    );
    expect(estado).toBe("sem_acesso");
  });

  it("troca de senha pendente continua a distinguir-se de desativado", async () => {
    trocaPendente = true;
    expect(await estadoNoEcra()).toBe("troca_pendente");
  });
});

// ---------------------------------------------------------------------------
describe("os dois ecrãs chegam ao mesmo estado", () => {
  it("🔴 desativar pela LISTA também deixa a ficha a dizer desativado", async () => {
    // Era aqui que os dois fluxos divergiam: a lista escrevia `status`, a
    // ficha só banía, e cada ecrã lia uma metade diferente da verdade.
    const { desativarColaborador } = await import("@/app/actions/colaboradores");
    const res = await desativarColaborador(ALVO, EMPRESA);
    expect(res.ok).toBe(true);

    expect(await estadoNoEcra()).toBe("desativado");
  });
});
