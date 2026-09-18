// ============================================================================
// Dois ecrãs, uma regra — e a ordem segura das operações
// ============================================================================
//
// 🔴 O defeito que este ficheiro fecha.
//
//    Havia dois fluxos de desativação a divergir:
//
//      lista  → `desativarColaborador()`  banía E escrevia `status`
//      ficha  → `desativarAcesso()`       só banía
//
//    Enquanto `status` era decoração, a diferença não se via. Com a 101c
//    passou a ser o que a base consulta: quem fosse desativado pela ficha
//    ficava com `status = 'ativo'`, e o token antigo continuava a trabalhar.
//    A desativação parecia feita no ecrã e não estava no sistema.
//
//    E ao contrário: quem fosse tirado pela lista e «reativado» pela ficha
//    ficava com a conta desbanida e `status = 'inativo'` — entrava e era
//    recusado em tudo.
//
// ----------------------------------------------------------------------------
// A ORDEM, QUE É O MIOLO
// ----------------------------------------------------------------------------
//
// Auth e Postgres não partilham transação. Alguma ordem de falha deixa sempre
// metade feita; a escolha é QUAL metade.
//
//   DESATIVAR → `status` primeiro, ban depois.
//     status ✓ / ban ✗ → não faz nada no sistema, mas ainda autentica. FECHADO.
//     ban ✓ / status ✗ → token antigo continua a ler e escrever. ABERTO.
//
//   REATIVAR → unban primeiro, `status` depois.
//     unban ✓ / status ✗ → entra e é recusado em tudo. FECHADO.
//     status ✓ / unban ✗ → token antigo RECUPERA autorização. ABERTO.
//
// Uma regra só: o que FECHA vai primeiro, o que ABRE vai por último. É isso
// que estes ensaios fixam — não o resultado feliz, que qualquer ordem dá.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ESTADO_ATIVO, ESTADO_DE_SAIDA } from "@/domain/collaborators/access-state";

/** A sequência de operações, na ordem em que aconteceram. */
const passos: string[] = [];
/** O estado que a base tem neste momento. */
let statusNaBase: string | null = "ativo";

let falhaBan = false;
let falhaUnban = false;
let falhaUpdate = false;
/** O `select` de confirmação devolve outra coisa — update que não bateu. */
let confirmacaoDivergente = false;
let contaExiste = true;

const ALVO = "perfil-da-ana";
const CONTA = "auth-user-da-ana";
const EMPRESA = "empresa-1";

function builder(table: string) {
  const b: Record<string, unknown> = {};
  let colunas = "";
  let payload: Record<string, unknown> | null = null;

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (nome === "select" && typeof args[0] === "string") colunas = args[0];
    if (nome === "update") {
      payload = args[0] as Record<string, unknown>;
      passos.push(`update:${String(payload.status)}`);
      if (!falhaUpdate) statusNaBase = String(payload.status);
    }
    return b;
  };
  for (const n of ["select", "update", "insert", "delete", "eq", "in", "order", "limit"]) {
    b[n] = encadeia(n);
  }

  b.single = async () => {
    if (table !== "profiles") return { data: null, error: null };
    if (colunas.includes("auth_user_id")) {
      return { data: { id: ALVO, auth_user_id: CONTA }, error: null };
    }
    return { data: { id: ALVO, company_id: EMPRESA, status: statusNaBase }, error: null };
  };
  b.maybeSingle = async () => {
    if (table !== "profiles") return { data: null, error: null };
    if (colunas.trim() === "status") {
      return {
        data: { status: confirmacaoDivergente ? "outra-coisa" : statusNaBase },
        error: null,
      };
    }
    if (colunas.includes("auth_user_id")) {
      return { data: { id: ALVO, auth_user_id: CONTA }, error: null };
    }
    return { data: { id: ALVO, company_id: EMPRESA, status: statusNaBase }, error: null };
  };
  b.then = (r: (v: unknown) => unknown) => {
    if (payload && falhaUpdate) {
      return Promise.resolve({ data: null, error: { message: "escrita recusada" } }).then(r);
    }
    return Promise.resolve({ data: null, error: null }).then(r);
  };
  return b;
}

const auth = {
  admin: {
    getUserById: async () => ({
      data: { user: contaExiste ? { id: CONTA } : null },
      error: null,
    }),
    updateUserById: async (_id: string, attrs: { ban_duration?: string }) => {
      const banir = attrs.ban_duration !== "none";
      passos.push(banir ? "ban" : "unban");
      if (banir && falhaBan) return { error: { message: "auth em baixo" } };
      if (!banir && falhaUnban) return { error: { message: "auth em baixo" } };
      return { error: null };
    },
  },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => builder(t), auth }),
}));

beforeEach(() => {
  passos.length = 0;
  statusNaBase = "ativo";
  falhaBan = false;
  falhaUnban = false;
  falhaUpdate = false;
  confirmacaoDivergente = false;
  contaExiste = true;
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const admin = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t), auth } as any;
};

const tirar = async () => {
  const { tirarAcesso } = await import("@/lib/collaborators/access-cycle");
  return tirarAcesso(admin(), { profileId: ALVO, companyId: EMPRESA });
};
const devolver = async () => {
  const { devolverAcesso } = await import("@/lib/collaborators/access-cycle");
  return devolverAcesso(admin(), { profileId: ALVO, companyId: EMPRESA });
};

// ---------------------------------------------------------------------------
describe("desativar — `status` primeiro, ban depois", () => {
  it("🔴 a ordem é essa, e não a contrária", async () => {
    const res = await tirar();
    expect(res.ok).toBe(true);

    // Se o ban viesse primeiro, uma falha no `status` deixava um token antigo
    // a trabalhar. Esta asserção é a única coisa que impede a inversão.
    expect(passos).toEqual([`update:${ESTADO_DE_SAIDA}`, "ban"]);
    expect(statusNaBase).toBe(ESTADO_DE_SAIDA);
  });

  it("o estado não grava → falha, e o Auth nem é chamado", async () => {
    falhaUpdate = true;
    const res = await tirar();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.parcial).toBe(false);
    expect(passos).not.toContain("ban");
  });

  it("o estado grava mas não confirma → falha", async () => {
    // Um `update` sem erro que não bateu em linha nenhuma devolve sucesso.
    confirmacaoDivergente = true;
    const res = await tirar();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.codigo).toBe("ESTADO_NAO_CONFIRMADO");
    expect(passos).not.toContain("ban");
  });

  it("🔴 o ban falha → é FALHA PARCIAL, nunca sucesso", async () => {
    falhaBan = true;
    const res = await tirar();

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.parcial).toBe(true);
    // E diz o que ficou feito, para quem lê saber o que repetir.
    expect(res.erro).toContain("revogado");
    // O importante: o acesso JÁ está fechado, mesmo com a falha.
    expect(statusNaBase).toBe(ESTADO_DE_SAIDA);
  });

  it("repetir depois de falha parcial fecha o resto", async () => {
    falhaBan = true;
    await tirar();
    falhaBan = false;
    passos.length = 0;

    const res = await tirar();
    expect(res.ok).toBe(true);
    expect(passos).toEqual([`update:${ESTADO_DE_SAIDA}`, "ban"]);
  });

  it("uma pessoa sem conta desativa na mesma", async () => {
    contaExiste = false;
    const res = await tirar();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tocouNaConta).toBe(false);
    expect(statusNaBase).toBe(ESTADO_DE_SAIDA);
  });
});

// ---------------------------------------------------------------------------
describe("reativar — unban primeiro, `status` depois", () => {
  beforeEach(() => { statusNaBase = ESTADO_DE_SAIDA; });

  it("🔴 a ordem inverte-se, e é de propósito", async () => {
    const res = await devolver();
    expect(res.ok).toBe(true);

    // `status` primeiro devolveria autorização a um token antigo sobre uma
    // conta ainda bloqueada — mais acesso do que o pretendido.
    expect(passos).toEqual(["unban", `update:${ESTADO_ATIVO}`]);
    expect(statusNaBase).toBe(ESTADO_ATIVO);
  });

  it("o unban falha → o estado NÃO passa a ativo", async () => {
    falhaUnban = true;
    const res = await devolver();

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.parcial).toBe(false);
    // 🔴 A asserção que interessa: ninguém recuperou autorização.
    expect(statusNaBase).toBe(ESTADO_DE_SAIDA);
    expect(passos).not.toContain(`update:${ESTADO_ATIVO}`);
  });

  it("o estado falha depois do unban → falha parcial, e fica fechado", async () => {
    falhaUpdate = true;
    const res = await devolver();

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.parcial).toBe(true);
    expect(res.erro).toContain("sem permissões");
    // Entra e não faz nada — o lado seguro.
    expect(statusNaBase).toBe(ESTADO_DE_SAIDA);
  });

  it("repetir depois de falha parcial conclui", async () => {
    falhaUpdate = true;
    await devolver();
    falhaUpdate = false;
    passos.length = 0;

    const res = await devolver();
    expect(res.ok).toBe(true);
    expect(statusNaBase).toBe(ESTADO_ATIVO);
  });
});

// ---------------------------------------------------------------------------
describe("os dois ecrãs chamam a MESMA implementação", () => {
  it("🔴 nem a lista nem a ficha têm a sua própria versão", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

    const lista = ler("src/app/actions/colaboradores.ts");
    const ficha = ler("src/app/actions/collaborator-access.ts");

    // Ambos passam pelo ciclo canónico...
    expect(lista).toContain("tirarAcesso");
    expect(ficha).toContain("tirarAcesso");
    expect(ficha).toContain("devolverAcesso");

    // ...e nenhum volta a escrever `status` nem a banir por sua conta. Era
    // assim que os dois divergiam.
    const semComentarios = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const [nome, fonte] of [["lista", lista], ["ficha", ficha]] as const) {
      const codigo = semComentarios(fonte);
      expect(codigo, `${nome}: ban próprio`).not.toMatch(/ban_duration/);
      expect(codigo, `${nome}: status próprio`).not.toMatch(/update\(\s*\{\s*status:/);
    }
  });
});
