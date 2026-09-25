/**
 * 106-B — a identidade do runtime é a mesma que a da base.
 *
 * 🔴 O que isto existe para impedir.
 *
 *    `criarAcesso()` cria a conta de Auth com um UUID NOVO e grava-o em
 *    `profiles.auth_user_id`. Não mexe em `profiles.id`. Logo, uma pessoa a
 *    quem se dê acesso a partir de agora fica com `profiles.id != auth.uid()`.
 *
 *    Quatro sítios do runtime procuravam `profiles.id = user.id`. Para essa
 *    pessoa devolveriam «perfil não encontrado», enquanto a base — que resolve
 *    pelas duas convenções desde a 101b — a encontra sem problema.
 *
 *    Produção tem 29 ligações e as 29 ainda usam a convenção antiga. Isso não
 *    prova que o caminho novo funciona: prova que ainda não foi exercido.
 *
 * 🔴 A precedência tem de bater com `public.get_my_profile_id()`, incluindo o
 *    detalhe que é fácil perder: o `NOT EXISTS` do ramo legado da função NÃO
 *    filtra por estado. Ver o ensaio C-bis.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolverPerfilAutenticado, MOTIVO_SEM_PERFIL,
} from "@/lib/auth/resolve-profile";

const UID = "11111111-1111-1111-1111-111111111111";

type Linha = Record<string, unknown> | null;

/**
 * Um cliente falso que responde conforme a coluna consultada.
 *
 * 🔴 Regista por que coluna foi perguntado, e por que ordem. Sem isso, um
 *    ensaio que passasse com um `OR` cego seria indistinguível de um que
 *    passa com a precedência certa.
 */
function admin(resposta: {
  auth_user_id?: { data: Linha; error?: unknown };
  id?: { data: Linha; error?: unknown };
}) {
  const consultas: string[] = [];
  const cliente = {
    from: () => ({
      select: () => ({
        eq: (coluna: string) => {
          consultas.push(coluna);
          const r = resposta[coluna as "id" | "auth_user_id"];
          return {
            maybeSingle: async () =>
              ({ data: r?.data ?? null, error: r?.error ?? null }),
          };
        },
      }),
    }),
  };
  return { cliente, consultas };
}

const chamar = (a: ReturnType<typeof admin>) =>
  resolverPerfilAutenticado<{ id: string; status: string }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.cliente as any, UID, "id");

beforeEach(() => { vi.restoreAllMocks(); });

describe("106-B — resolução canónica de identidade", () => {
  it("🔴 A. a convenção antiga continua a funcionar", async () => {
    const a = admin({
      auth_user_id: { data: null },
      id: { data: { id: UID, status: "ativo" } },
    });

    const r = await chamar(a);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.perfil.id).toBe(UID);
    // A ligação explícita é perguntada PRIMEIRO, sempre.
    expect(a.consultas).toEqual(["auth_user_id", "id"]);
  });

  it("🔴 B. profiles.id != auth.uid() com ligação por auth_user_id resolve", async () => {
    // 🔴 Este é o formato que `criarAcesso()` produz hoje. Com a consulta
    //    antiga por `id`, esta pessoa não existia para o runtime.
    const a = admin({
      auth_user_id: { data: { id: "perfil-outro", status: "ativo" } },
      id: { data: null },
    });

    const r = await chamar(a);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.perfil.id).toBe("perfil-outro");
    // E nem sequer chegou a perguntar pela convenção antiga.
    expect(a.consultas).toEqual(["auth_user_id"]);
  });

  it("🔴 C. havendo as duas, ganha auth_user_id — como na base", async () => {
    const a = admin({
      auth_user_id: { data: { id: "ligado", status: "ativo" } },
      id: { data: { id: UID, status: "ativo" } },
    });

    const r = await chamar(a);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.perfil.id).toBe("ligado");
    expect(r.perfil.id).not.toBe(UID);
    expect(a.consultas).toEqual(["auth_user_id"]);
  });

  it("🔴 C-bis. ligação suspensa NÃO cai para a linha legada activa", async () => {
    // 🔴 O detalhe que um `OR` perderia.
    //
    //    Na função da base, o `NOT EXISTS` do ramo legado não filtra por
    //    estado: basta EXISTIR uma ligação por `auth_user_id` para o ramo
    //    legado ficar bloqueado. A pessoa não «cai» para a linha antiga — fica
    //    sem identidade.
    //
    //    Um `OR` entre as duas condições devolveria a linha legada activa e
    //    daria acesso a quem a base recusa.
    const a = admin({
      auth_user_id: { data: { id: "ligado", status: "suspenso" } },
      id: { data: { id: UID, status: "ativo" } },
    });

    const r = await chamar(a);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe(MOTIVO_SEM_PERFIL.INATIVO);
    // Nunca se perguntou pela linha legada.
    expect(a.consultas).toEqual(["auth_user_id"]);
  });

  it("🔴 D. ligado e suspenso não autoriza", async () => {
    const a = admin({ auth_user_id: { data: { id: "x", status: "suspenso" } } });
    const r = await chamar(a);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe(MOTIVO_SEM_PERFIL.INATIVO);
  });

  it("🔴 sem linha nenhuma: NAO_ENCONTRADO, e não INATIVO", async () => {
    const a = admin({ auth_user_id: { data: null }, id: { data: null } });
    const r = await chamar(a);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe(MOTIVO_SEM_PERFIL.NAO_ENCONTRADO);
  });

  it("🔴 erro de leitura NÃO vira ausência — fail closed", async () => {
    // 🔴 Se um erro na primeira consulta fosse tratado como «não existe», uma
    //    falha transitória empurrava a pessoa para o caminho legado. Com a
    //    linha legada activa, isso daria acesso que a base recusa.
    const a = admin({
      auth_user_id: { data: null, error: { message: "rede" } },
      id: { data: { id: UID, status: "ativo" } },
    });

    const r = await chamar(a);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe(MOTIVO_SEM_PERFIL.ERRO_DE_LEITURA);
    expect(a.consultas).toEqual(["auth_user_id"]);
  });

  it("🔴 status é sempre pedido, mesmo que o chamador o esqueça", async () => {
    // Sem isto, um `select` sem `status` fazia `estadoAutoriza(undefined)`
    // recusar toda a gente — ou, pior numa versão futura, deixar passar.
    let usado = "";
    const cliente = {
      from: () => ({
        select: (campos: string) => { usado = campos; return {
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }; },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolverPerfilAutenticado(cliente as any, UID, "id, company_id");
    expect(usado).toContain("status");
  });
});
