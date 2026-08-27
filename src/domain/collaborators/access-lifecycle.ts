/**
 * Dar, tirar e devolver acesso a uma pessoa que já existe.
 *
 * ---------------------------------------------------------------------------
 * O problema que domina tudo o resto
 * ---------------------------------------------------------------------------
 *
 * Criar a conta e ligá-la à pessoa são escritas em **dois sistemas
 * diferentes**: o Auth do Supabase e a base de dados. Não há transação que
 * abranja os dois. Entre uma e outra pode falhar a rede, o processo, ou o
 * próprio Auth.
 *
 * Há duas maneiras de isso correr mal, e são assimétricas:
 *
 *   · **conta criada, ligação falhada** — fica uma conta capaz de autenticar
 *     que não pertence a ninguém. É a pior das duas: alguém entra e o sistema
 *     não sabe quem é. Tem de ser desfeita.
 *
 *   · **conta não criada** — a pessoa continua exactamente como estava, sem
 *     acesso. Não é dano nenhum; é a operação não ter acontecido. Nunca se
 *     apaga a pessoa por causa disto.
 *
 * A ordem certa é a que torna a primeira reparável: criar a conta, ligar, e se
 * a ligação falhar **desfazer a conta**. Ligar primeiro seria pior — ficaria um
 * perfil a apontar para uma conta que não existe.
 *
 * ---------------------------------------------------------------------------
 * O que não se faz
 * ---------------------------------------------------------------------------
 *
 * Nunca se guarda uma password em claro, nem se escreve uma num registo. O
 * administrador define uma senha temporária e vê-a **naquele momento**, porque
 * tem de a comunicar à pessoa; a partir daí ninguém a consulta — nem ele.
 */

/** Uma pessoa, como a base a conhece. */
export interface Pessoa {
  id: string;
  company_id: string;
  full_name: string;
  auth_user_id: string | null;
}

/** Quem está a fazer a operação. */
export interface Actor {
  profile_id: string;
  company_id: string;
  role: string;
}

export type Decisao =
  | { permitido: true }
  | { permitido: false; codigo: string; motivo: string };

const PODEM_GERIR_ACESSO = ["admin", "gestor"] as const;

/**
 * Pode este actor mexer no acesso desta pessoa?
 *
 * 🔴 A empresa é verificada **aqui**, no servidor, contra a empresa do actor —
 *    nunca contra um valor que tenha vindo do browser. Um administrador da
 *    empresa A não toca em ninguém da empresa B, e a interface não é
 *    autoridade nenhuma sobre isso.
 */
export function podeGerirAcesso(actor: Actor, alvo: Pessoa): Decisao {
  if (!(PODEM_GERIR_ACESSO as readonly string[]).includes(actor.role)) {
    return {
      permitido: false,
      codigo: "ACCESS_MANAGEMENT_FORBIDDEN",
      motivo: "Só um administrador ou gestor pode gerir acessos.",
    };
  }
  if (actor.company_id !== alvo.company_id) {
    return {
      permitido: false,
      codigo: "CROSS_COMPANY_BLOCKED",
      motivo: "Esta pessoa é de outra empresa.",
    };
  }
  return { permitido: true };
}

/**
 * O estado do acesso, como o perfil o mostra.
 *
 * `disabled` distingue-se de `sem acesso` de propósito: uma pessoa a quem o
 * acesso foi retirado teve-o, e voltar a dar-lho é reactivar a mesma conta —
 * não criar outra.
 */
export type EstadoAcesso = "sem_acesso" | "ativo" | "desativado" | "troca_pendente";

export function estadoAcesso(
  pessoa: Pessoa,
  conta: { disabled?: boolean; must_change_password?: boolean } | null,
): EstadoAcesso {
  if (pessoa.auth_user_id === null || conta === null) return "sem_acesso";
  if (conta.disabled) return "desativado";
  if (conta.must_change_password) return "troca_pendente";
  return "ativo";
}

/**
 * Criar acesso é uma operação **nova**, não a repetição de outra.
 *
 * Se a pessoa já tem conta, não se cria uma segunda: seriam duas identidades
 * para a mesma pessoa, e a partir daí ninguém sabe qual é a verdadeira. Dois
 * administradores a carregar no botão ao mesmo tempo caem aqui, e o segundo é
 * recusado — a garantia final é o índice único em `auth_user_id`, mas recusar
 * antes evita criar a conta para depois a apagar.
 */
export function podeCriarAcesso(actor: Actor, alvo: Pessoa): Decisao {
  const base = podeGerirAcesso(actor, alvo);
  if (!base.permitido) return base;
  if (alvo.auth_user_id !== null) {
    return {
      permitido: false,
      codigo: "ACCESS_ALREADY_EXISTS",
      motivo: "Esta pessoa já tem acesso ao sistema.",
    };
  }
  return { permitido: true };
}

/** Definir senha, desativar e reativar exigem que já haja conta. */
export function exigeAcessoExistente(
  actor: Actor, alvo: Pessoa, operacao: string,
): Decisao {
  const base = podeGerirAcesso(actor, alvo);
  if (!base.permitido) return base;
  if (alvo.auth_user_id === null) {
    return {
      permitido: false,
      codigo: "ACCESS_NOT_FOUND",
      motivo: `Esta pessoa não tem acesso ao sistema (${operacao}).`,
    };
  }
  return { permitido: true };
}

/**
 * O identificador com que a pessoa entra.
 *
 * 🔴 Não é o email dela, e não deve parecer um.
 *
 *    O Auth exige um endereço para criar a conta. Usar o email pessoal — se o
 *    tivermos — misturaria duas coisas: o sítio onde se fala com a pessoa e a
 *    forma como ela entra na aplicação. Mudar de email deixaria de poder
 *    entrar; e quem não tem email não poderia ter acesso.
 *
 *    Gera-se um identificador técnico, num domínio que ninguém confunde com
 *    correio real, derivado do id da pessoa — estável, único, e que não revela
 *    o nome dela a quem veja a lista de contas.
 */
export const AUTH_IDENTIFIER_DOMAIN = "acesso.interno.invalid";

export function identificadorDeAutenticacao(pessoaId: string): string {
  return `u-${pessoaId}@${AUTH_IDENTIFIER_DOMAIN}`;
}

/** Um identificador técnico nunca deve ser mostrado como contacto. */
export function eIdentificadorTecnico(valor: string | null): boolean {
  return typeof valor === "string" && valor.endsWith(`@${AUTH_IDENTIFIER_DOMAIN}`);
}

export type ValidacaoSenha = { ok: true } | { ok: false; erro: string };

/**
 * A senha temporária é escrita por uma pessoa e comunicada a outra. O mínimo
 * exigido é que não seja trivial de adivinhar por quem esteja a tentar.
 */
export function validarSenhaTemporaria(senha: unknown): ValidacaoSenha {
  if (typeof senha !== "string" || senha.length === 0) {
    return { ok: false, erro: "A senha temporária é obrigatória." };
  }
  if (senha.length < 8) {
    return { ok: false, erro: "A senha temporária tem de ter pelo menos 8 caracteres." };
  }
  if (senha.length > 72) {
    // Limite do bcrypt: o que passa daqui é silenciosamente ignorado, e uma
    // senha truncada em silêncio é mais fraca do que quem a escreveu julga.
    return { ok: false, erro: "A senha temporária não pode ter mais de 72 caracteres." };
  }
  if (!/[a-zA-Z]/.test(senha) || !/[0-9]/.test(senha)) {
    return { ok: false, erro: "A senha temporária tem de ter letras e números." };
  }
  return { ok: true };
}

/**
 * O que se guarda depois de definir uma senha.
 *
 * 🔴 A senha **não** está aqui, e é esse o ponto. Guarda-se que houve uma
 *    definição, quem a fez e quando — nunca o valor. Um registo que contivesse
 *    a senha tornaria a base num sítio onde as senhas se leem.
 */
export interface RegistoDeSenha {
  profile_id: string;
  actor_profile_id: string;
  must_change_password: true;
  at: string;
}

export function registoDeSenha(
  alvo: Pessoa, actor: Actor, agora: string,
): RegistoDeSenha {
  return {
    profile_id: alvo.id,
    actor_profile_id: actor.profile_id,
    must_change_password: true,
    at: agora,
  };
}

/**
 * O que fazer quando a conta foi criada mas a ligação falhou.
 *
 * Não é uma opção entre várias: é a única resposta correcta. Deixar a conta de
 * pé seria deixar uma identidade capaz de autenticar sem dono — e a próxima
 * tentativa de criar acesso encontraria o identificador já ocupado, sem forma
 * de saber se pertence a alguém.
 */
export function compensacaoNecessaria(
  contaCriada: boolean, ligacaoGravada: boolean,
): "apagar_conta" | "nada" {
  return contaCriada && !ligacaoGravada ? "apagar_conta" : "nada";
}

/**
 * E quando a criação da conta falha: a pessoa fica como estava.
 *
 * Existe como função para que a regra tenha um sítio e um teste. Apagar a
 * pessoa porque o Auth não respondeu seria destruir a folha, os documentos e o
 * histórico dela por causa de uma falha de rede.
 */
export function falhaDeContaApagaPessoa(): boolean {
  return false;
}
