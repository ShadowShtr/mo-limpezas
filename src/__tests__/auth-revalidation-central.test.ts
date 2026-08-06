// ============================================================================
// Autenticação, autorização e revalidação central — Task T06
// ============================================================================
// Fecha o fluxo completo da action piloto: ActionResult (T05) + guard central
// + revalidação central.
//
// Duas coisas que estes testes protegem e que não são óbvias:
//
//   1. `guard.error` continua a existir. Dezenas de actions ainda fazem
//      `return { ok: false, error: guard.error }`. O código novo é aditivo —
//      se o campo desaparecer antes da migração terminar, elas quebram.
//
//   2. A ramificação é por `guard.code`, nunca pelo texto de `guard.error`.
//      A mensagem que o utilizador deve ver depende da action: a de
//      configurações diz "Sem permissão para alterar configurações.", não
//      "Sem permissão.". Comparar texto tornaria a lógica refém da redação.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

const readNormalized = (p: string) =>
  fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/**
 * Remove comentários antes de procurar padrões no código.
 *
 * Sem isto, uma asserção como "não contém `guard.error`" falha por causa do
 * comentário que explica precisamente porque não se deve usar `guard.error` —
 * o teste estaria a medir a documentação, não o código.
 */
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const settingsAction = semComentarios(
  readNormalized(path.join(ROOT, "src/app/actions/settings.ts")),
);

// ---------------------------------------------------------------------------
// Parte A — requireProfile devolve código estável
// ---------------------------------------------------------------------------

const getUser = vi.fn();
const single = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single }),
      }),
    }),
  }),
}));

beforeEach(() => {
  getUser.mockReset();
  single.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requireProfile — códigos estáveis", () => {
  it("sem sessão devolve UNAUTHENTICATED, e mantém error", async () => {
    const { requireProfile, AUTH_GUARD_CODES } = await import("@/lib/auth-guard");

    getUser.mockResolvedValue({ data: { user: null } });

    const guard = await requireProfile();

    expect(guard.ok).toBe(false);
    if (guard.ok) return;

    expect(guard.code).toBe(AUTH_GUARD_CODES.UNAUTHENTICATED);
    expect(guard.error).toBe("Não autenticado.");
  });

  it("perfil inexistente devolve PROFILE_NOT_FOUND, e mantém error", async () => {
    const { requireProfile, AUTH_GUARD_CODES } = await import("@/lib/auth-guard");

    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    single.mockResolvedValue({ data: null });

    const guard = await requireProfile();

    expect(guard.ok).toBe(false);
    if (guard.ok) return;

    expect(guard.code).toBe(AUTH_GUARD_CODES.PROFILE_NOT_FOUND);
    expect(guard.error).toBe("Perfil não encontrado.");
  });

  it("role não permitida devolve FORBIDDEN, e mantém error", async () => {
    const { requireProfile, AUTH_GUARD_CODES } = await import("@/lib/auth-guard");

    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    single.mockResolvedValue({
      data: { id: "u1", company_id: "empresa-a", role: "colaborador" },
    });

    const guard = await requireProfile({ roles: ["admin", "gestor"] });

    expect(guard.ok).toBe(false);
    if (guard.ok) return;

    expect(guard.code).toBe(AUTH_GUARD_CODES.FORBIDDEN);
    expect(guard.error).toBe("Sem permissão.");
  });

  it("sucesso devolve o company_id da sessão e o admin client", async () => {
    const { requireProfile } = await import("@/lib/auth-guard");

    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    single.mockResolvedValue({
      data: { id: "u1", company_id: "empresa-a", role: "admin" },
    });

    const guard = await requireProfile({ roles: ["admin", "gestor"] });

    expect(guard.ok).toBe(true);
    if (!guard.ok) return;

    expect(guard.profile.company_id).toBe("empresa-a");
    expect(guard.admin).toBeDefined();
    // Sucesso não traz campos de falha.
    expect("code" in guard).toBe(false);
    expect("error" in guard).toBe(false);
  });

  it("os códigos são únicos e iguais à sua chave", async () => {
    const { AUTH_GUARD_CODES } = await import("@/lib/auth-guard");

    const entradas = Object.entries(AUTH_GUARD_CODES);
    const valores = entradas.map(([, v]) => v);

    expect(new Set(valores).size).toBe(valores.length);
    for (const [chave, valor] of entradas) expect(valor).toBe(chave);
  });
});

describe("compatibilidade — consumidores antigos não quebram", () => {
  it("o campo error continua a existir em todas as falhas", () => {
    const guardSource = semComentarios(
      readNormalized(path.join(ROOT, "src/lib/auth-guard.ts")),
    );

    // Cada `ok: false` tem de trazer `code` E `error`.
    const falhas = guardSource.match(/ok:\s*false,[\s\S]{0,200}?\}/g) ?? [];

    expect(falhas.length).toBeGreaterThanOrEqual(3);

    for (const falha of falhas) {
      expect(falha, `falha sem code: ${falha}`).toMatch(/code:/);
      expect(falha, `falha sem error: ${falha}`).toMatch(/error:/);
    }
  });

  it("as actions que ainda usam guard.error continuam a poder fazê-lo", () => {
    // Prova de que o campo não é decorativo: há consumidores reais.
    const actionsDir = path.join(ROOT, "src/app/actions");

    const usam = fs
      .readdirSync(actionsDir)
      .filter((n) => n.endsWith(".ts"))
      .filter((n) =>
        /guard\.error/.test(readNormalized(path.join(actionsDir, n))),
      );

    expect(usam.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Parte B — o piloto usa o guard central
// ---------------------------------------------------------------------------

describe("piloto — saveCompanySettings usa o guard central", () => {
  it("não cria clientes de Supabase diretamente", () => {
    expect(settingsAction).not.toMatch(/createClient\(\)/);
    expect(settingsAction).not.toMatch(/createAdminClient\(\)/);
    expect(settingsAction).not.toMatch(/from "@\/lib\/supabase\//);
  });

  it("não vai buscar o profile à mão", () => {
    expect(settingsAction).not.toMatch(/from\(["']profiles["']\)/);
    expect(settingsAction).not.toMatch(/auth\.getUser\(\)/);
  });

  it("usa o company_id da sessão, nunca um vindo do cliente", () => {
    expect(settingsAction).toMatch(/guard\.profile\.company_id/);

    // O tipo de entrada da action não tem company_id, e o schema também não —
    // não há por onde o browser o injetar.
    expect(settingsAction).not.toMatch(/company_id:\s*z\./);
    expect(settingsAction).not.toMatch(/settings\.company_id/);
  });

  it("usa o admin client que o guard devolve", () => {
    expect(settingsAction).toMatch(/const \{ admin \} = guard/);
  });

  it("ramifica por código, nunca pelo texto de guard.error", () => {
    expect(settingsAction).toMatch(/guard\.code === AUTH_GUARD_CODES\./);
    expect(settingsAction).not.toMatch(/guard\.error/);
  });

  it("mapeia os três códigos do guard para códigos de ActionResult", () => {
    expect(settingsAction).toMatch(
      /AUTH_GUARD_CODES\.UNAUTHENTICATED[\s\S]{0,200}ACTION_ERROR_CODES\.UNAUTHENTICATED/,
    );
    expect(settingsAction).toMatch(
      /AUTH_GUARD_CODES\.PROFILE_NOT_FOUND[\s\S]{0,200}ACTION_ERROR_CODES\.NOT_FOUND/,
    );
    expect(settingsAction).toMatch(/ACTION_ERROR_CODES\.FORBIDDEN/);
  });

  it("as mensagens visíveis continuam exatamente as mesmas", () => {
    for (const mensagem of [
      "Não autenticado.",
      "Perfil não encontrado.",
      "Sem permissão para alterar configurações.",
    ]) {
      expect(settingsAction).toContain(mensagem);
    }
  });
});

// ---------------------------------------------------------------------------
// Parte C — revalidação central
// ---------------------------------------------------------------------------

describe("revalidação central", () => {
  it("o piloto não chama revalidatePath diretamente", () => {
    expect(settingsAction).not.toMatch(/revalidatePath\s*\(/);
    expect(settingsAction).not.toMatch(/from "next\/cache"/);
  });

  it("o piloto revalida exatamente configurações e relatórios", () => {
    expect(settingsAction).toMatch(
      /revalidateBusinessPaths\(\{\s*scopes:\s*\["configuracoes",\s*"relatorios"\]\s*\}\)/,
    );
  });

  it("o helper central conhece os dois escopos novos", async () => {
    const revalidatePath = vi.fn();

    vi.doMock("next/cache", () => ({ revalidatePath }));
    vi.resetModules();

    const { revalidateBusinessPaths } = await import(
      "@/lib/revalidate-business"
    );

    revalidateBusinessPaths({ scopes: ["configuracoes", "relatorios"] });

    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/configuracoes");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/relatorios");
    expect(revalidatePath).toHaveBeenCalledTimes(2);

    vi.doUnmock("next/cache");
    vi.resetModules();
  });

  it("um escopo não pedido não é revalidado", async () => {
    const revalidatePath = vi.fn();

    vi.doMock("next/cache", () => ({ revalidatePath }));
    vi.resetModules();

    const { revalidateBusinessPaths } = await import(
      "@/lib/revalidate-business"
    );

    revalidateBusinessPaths({ scopes: ["configuracoes"] });

    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/configuracoes");
    expect(revalidatePath).not.toHaveBeenCalledWith("/dashboard/relatorios");
    expect(revalidatePath).not.toHaveBeenCalledWith("/dashboard/calendario");

    vi.doUnmock("next/cache");
    vi.resetModules();
  });

  it("os escopos antigos continuam a funcionar", () => {
    const helper = readNormalized(
      path.join(ROOT, "src/lib/revalidate-business.ts"),
    );

    for (const escopo of [
      "clientes",
      "calendario",
      "contratos",
      "cobrancas",
      "financeiro",
      "locais",
    ]) {
      expect(helper).toContain(`"${escopo}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Limite do escopo desta PR
// ---------------------------------------------------------------------------

describe("nenhuma outra action foi migrada nesta PR", () => {
  it("settings.ts é a única action sem revalidatePath direto", () => {
    // As outras 23 continuam como estavam — a centralização em massa é uma
    // task futura, e misturá-la aqui tornaria esta PR irrevisível.
    const actionsDir = path.join(ROOT, "src/app/actions");

    const comRevalidateDireto = fs
      .readdirSync(actionsDir)
      .filter((n) => n.endsWith(".ts"))
      .filter((n) =>
        /\brevalidatePath\s*\(/.test(readNormalized(path.join(actionsDir, n))),
      );

    expect(comRevalidateDireto).not.toContain("settings.ts");
    expect(comRevalidateDireto.length).toBeGreaterThan(0);
  });

  it("settings.ts é a única action a usar ActionResult", () => {
    const actionsDir = path.join(ROOT, "src/app/actions");

    const comActionResult = fs
      .readdirSync(actionsDir)
      .filter((n) => n.endsWith(".ts"))
      .filter((n) =>
        /from "@\/lib\/action-result"/.test(
          readNormalized(path.join(actionsDir, n)),
        ),
      );

    expect(comActionResult).toEqual(["settings.ts"]);
  });
});
