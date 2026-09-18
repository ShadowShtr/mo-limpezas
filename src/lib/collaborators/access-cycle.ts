// ============================================================================
// Tirar e devolver acesso — uma implementação, dois ecrãs
// ============================================================================
//
// 🔴 O defeito que este ficheiro fecha.
//
//    Havia DOIS fluxos de desativação, e divergiam:
//
//      lista de colaboradores → `desativarColaborador()`
//         bane a conta E escreve `profiles.status = 'inativo'`
//
//      ficha individual → `desativarAcesso()`
//         bane a conta, e mais nada
//
//    Enquanto `status` era decoração, a diferença passava despercebida. Com a
//    101c deixou de ser: `status` é o que a RLS consulta. Alguém desativado
//    pela ficha ficava com `status = 'ativo'`, e o JWT antigo continuava a
//    resolver na base — a desativação parecia feita e não estava.
//
//    E ao contrário: alguém tirado pela lista e «reativado» pela ficha ficava
//    com a conta desbanida e `status = 'inativo'`. Entrava, e era recusado em
//    tudo.
//
//    Dois caminhos para a mesma decisão acabam sempre assim. Este módulo é o
//    único sítio onde a decisão vive; os dois ecrãs chamam-no.
//
// ============================================================================
// A MÁQUINA DE ESTADOS, E A ORDEM SEGURA
// ============================================================================
//
// O acesso de uma pessoa é decidido por DUAS coisas em sistemas diferentes,
// que não partilham transação:
//
//   · a conta no Auth — banida ou não. Decide se um login NOVO acontece.
//   · `profiles.status`  — decide se um pedido JÁ AUTENTICADO é autorizado,
//     na aplicação (`requireProfile`, layouts, proxy) e na base (101c).
//
// Um token emitido antes continua válido até ao `exp`. Logo:
//
//   BAN sozinho  → não revoga quem já está dentro.
//   STATUS sozinho → revoga quem já está dentro, mas deixa entrar de novo.
//
// Como não há transação comum, alguma ordem de falha deixa metade feita. A
// escolha não é evitar isso — é escolher QUAL metade.
//
// ----------------------------------------------------------------------------
// DESATIVAR: `status` PRIMEIRO, ban depois
// ----------------------------------------------------------------------------
//
//   status ✓ / ban ✗  → não entra em lado nenhum (a base recusa), mas ainda
//                       consegue autenticar-se. Autentica e não faz nada.
//                       FECHADO.
//   ban ✓ / status ✗  → não faz login novo, mas o token antigo continua a ler
//                       e a escrever. ABERTO.
//
// Portanto `status` primeiro. É o oposto da ordem que este projeto tinha antes
// da 101c, e a inversão é deliberada: antes, `status` não fechava nada e o ban
// era a única defesa real; agora `status` é a defesa real.
//
// ----------------------------------------------------------------------------
// REATIVAR: unban PRIMEIRO, `status` depois
// ----------------------------------------------------------------------------
//
//   unban ✓ / status ✗ → entra, e é recusado em tudo. FECHADO.
//   status ✓ / unban ✗ → um token antigo ainda válido RECUPERA autorização
//                        sobre uma conta que era suposto continuar sem acesso.
//                        ABERTO.
//
// Ou seja, a mesma regra dos dois lados: **o que FECHA vai primeiro, o que
// ABRE vai por último.** Uma falha a meio deixa sempre menos acesso do que o
// pretendido, nunca mais.
//
// ----------------------------------------------------------------------------
// FALHA PARCIAL NUNCA É SUCESSO
// ----------------------------------------------------------------------------
//
// Quando o segundo passo falha, a operação devolve erro — e diz que ficou a
// meio, para quem lê saber que tem de repetir em vez de assumir que acabou.
// Repetir é seguro: as duas operações são idempotentes.
//
// UNKNOWN_STATE = FAIL_CLOSED.
// ============================================================================

import type { createAdminClient } from "@/lib/supabase/admin";
import { ESTADO_ATIVO, ESTADO_DE_SAIDA } from "@/domain/collaborators/access-state";
import { resolverIdentidadeAuth } from "@/lib/collaborators/auth-identity";

type AdminClient = ReturnType<typeof createAdminClient>;

/** Um banimento longo é como o Supabase representa «não entra». */
const BANIMENTO_LONGO = "876000h";

export type CicloAcessoOk = {
  ok: true;
  /** A conta existia e foi mesmo banida/desbanida. */
  tocouNaConta: boolean;
};

export type CicloAcessoErro = {
  ok: false;
  codigo:
    | "IDENTIDADE_FALHOU"
    | "ESTADO_NAO_GRAVADO"
    | "ESTADO_NAO_CONFIRMADO"
    | "AUTH_FALHOU";
  erro: string;
  /**
   * A operação mexeu em alguma coisa antes de falhar.
   *
   * Importa para a mensagem: «nada foi alterado, repita» e «ficou a meio,
   * repita» mandam fazer o mesmo, mas descrevem situações diferentes, e quem
   * administra tem direito a saber qual é.
   */
  parcial: boolean;
};

export type ResultadoCicloAcesso = CicloAcessoOk | CicloAcessoErro;

interface Alvo {
  profileId: string;
  companyId: string;
}

/** Escreve `status` e confirma por leitura que ficou mesmo. */
async function gravarEstado(
  admin: AdminClient,
  { profileId, companyId }: Alvo,
  estado: string,
): Promise<{ ok: true } | { ok: false; codigo: CicloAcessoErro["codigo"]; erro: string }> {
  const { error } = await admin
    .from("profiles").update({ status: estado })
    .eq("id", profileId).eq("company_id", companyId);
  if (error) return { ok: false, codigo: "ESTADO_NAO_GRAVADO", erro: error.message };

  // Um `update` sem erro que não encontrou linha nenhuma devolve sucesso.
  // Dar a operação por feita sobre isso seria registar uma coisa que não
  // aconteceu.
  const { data, error: erroLeitura } = await admin
    .from("profiles").select("status").eq("id", profileId).maybeSingle();
  if (erroLeitura || !data || (data as { status?: string | null }).status !== estado) {
    return {
      ok: false,
      codigo: "ESTADO_NAO_CONFIRMADO",
      erro: erroLeitura?.message ?? "o perfil não ficou com o estado esperado",
    };
  }
  return { ok: true };
}

/**
 * Onde está a conta desta pessoa — uma LEITURA, feita antes de qualquer escrita.
 *
 * 🔴 Resolver a identidade primeiro não contraria a regra da ordem; completa-a.
 *
 *    A regra é sobre as ESCRITAS: o que fecha vai primeiro, o que abre vai por
 *    último. Uma leitura não fecha nem abre nada.
 *
 *    E resolver antes evita o caso feio: sem isto, uma falha a ler a
 *    identidade acontecia DEPOIS de `status` já estar gravado, e a operação
 *    falhava tendo escrito. Se já se sabe que não se pode concluir, é melhor
 *    saber antes de mexer em alguma coisa.
 */
async function localizarConta(
  admin: AdminClient,
  profileId: string,
): Promise<{ ok: true; authUserId: string | null } | { ok: false; erro: string }> {
  const identidade = await resolverIdentidadeAuth(admin, profileId);
  if (!identidade.ok) return { ok: false, erro: identidade.erro };

  // Um perfil pode nunca ter tido conta — foi criado com o nome e mais nada.
  // Não é avaria, e não impede a operação.
  if (!identidade.authUserId) return { ok: true, authUserId: null };

  const { data: conta } = await admin.auth.admin.getUserById(identidade.authUserId);
  return { ok: true, authUserId: conta?.user ? identidade.authUserId : null };
}

/** Bane ou desbane uma conta já localizada. */
async function mexerNaConta(
  admin: AdminClient,
  authUserId: string,
  acao: "banir" | "desbanir",
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const { error } = await admin.auth.admin.updateUserById(authUserId, {
    ban_duration: acao === "banir" ? BANIMENTO_LONGO : "none",
  });
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

/**
 * Tirar o acesso: `status` primeiro, ban depois.
 *
 * Ver a máquina de estados no topo. O passo que FECHA vem primeiro.
 */
export async function tirarAcesso(
  admin: AdminClient,
  alvo: Alvo,
): Promise<ResultadoCicloAcesso> {
  // 0. Saber onde está a conta. É leitura — não mexe em nada, e se falhar a
  //    operação aborta sem ter escrito.
  const conta = await localizarConta(admin, alvo.profileId);
  if (!conta.ok) {
    return { ok: false, codigo: "IDENTIDADE_FALHOU", erro: conta.erro, parcial: false };
  }

  // 1. Revogar a autorização. É isto que corta quem já está dentro.
  const estado = await gravarEstado(admin, alvo, ESTADO_DE_SAIDA);
  if (!estado.ok) {
    return { ok: false, codigo: estado.codigo, erro: estado.erro, parcial: false };
  }

  // 2. Fechar a porta a logins novos.
  if (conta.authUserId) {
    const ban = await mexerNaConta(admin, conta.authUserId, "banir");
    if (!ban.ok) {
      return {
        ok: false,
        codigo: "AUTH_FALHOU",
        erro: `O acesso foi revogado, mas a conta não ficou bloqueada: ${ban.erro}. `
          + "A pessoa já não consegue fazer nada no sistema, mas ainda consegue "
          + "autenticar-se — repita para fechar também isso.",
        parcial: true,
      };
    }
  }

  return { ok: true, tocouNaConta: conta.authUserId !== null };
}

/**
 * Devolver o acesso: unban primeiro, `status` depois.
 *
 * 🔴 A ordem inversa da desativação, e pela mesma razão. Pôr `status = 'ativo'`
 *    antes do unban devolveria autorização a um token antigo ainda válido,
 *    sobre uma conta que continuaria bloqueada — mais acesso do que o
 *    pretendido, que é o único erro que esta ordem não pode cometer.
 */
export async function devolverAcesso(
  admin: AdminClient,
  alvo: Alvo,
): Promise<ResultadoCicloAcesso> {
  const conta = await localizarConta(admin, alvo.profileId);
  if (!conta.ok) {
    return { ok: false, codigo: "IDENTIDADE_FALHOU", erro: conta.erro, parcial: false };
  }

  // 1. Abrir a porta. Quem entrar agora continua sem autorização nenhuma.
  if (conta.authUserId) {
    const unban = await mexerNaConta(admin, conta.authUserId, "desbanir");
    if (!unban.ok) {
      return { ok: false, codigo: "AUTH_FALHOU", erro: unban.erro, parcial: false };
    }
  }

  // 2. Conceder a autorização. É o último passo de propósito.
  const estado = await gravarEstado(admin, alvo, ESTADO_ATIVO);
  if (!estado.ok) {
    return {
      ok: false,
      codigo: estado.codigo,
      erro: `A conta foi desbloqueada, mas o perfil não ficou activo: ${estado.erro}. `
        + "A pessoa consegue entrar e continua sem permissões — repita.",
      parcial: true,
    };
  }

  return { ok: true, tocouNaConta: conta.authUserId !== null };
}
