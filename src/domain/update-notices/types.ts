// ============================================================================
// AVISOS DE ATUALIZAÇÃO — contrato partilhado
// ============================================================================
// Duas fontes, um só contrato:
//
//   · **notas de release** — ficheiros em `src/release-notes/`, versionados
//     com o código que descrevem;
//   · **avisos manuais** — linhas em `app_notices`, escritas pelo painel.
//
// Convergem nesta forma para que a UI e a regra de leitura sejam as mesmas.
// Ter dois caminhos de apresentação seria ter duas maneiras de um aviso não
// aparecer.
// ============================================================================

export const NOTICE_KINDS = ["correcao", "novidade", "aviso", "manutencao"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export function isNoticeKind(v: unknown): v is NoticeKind {
  return typeof v === "string" && (NOTICE_KINDS as readonly string[]).includes(v);
}

export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  correcao: "Correção",
  novidade: "Novidade",
  aviso: "Aviso",
  manutencao: "Manutenção",
};

/** Uma nota de versão, versionada em código com a alteração que descreve. */
export interface ReleaseNote {
  /** Identidade estável. É por aqui que a leitura liga — nunca mudar. */
  key: string;
  /** ISO. Data em que a alteração chegou aos utilizadores. */
  publishedAt: string;
  kind: NoticeKind;
  title: string;
  /**
   * Uma ou duas frases, em linguagem de quem usa o sistema.
   *
   * 🔴 Sem migrations, RPCs, constraints, RLS ou nomes de ficheiros. Quem lê
   *    isto quer saber o que mudou para si, não como foi feito.
   */
  message: string;
}

/**
 * A retirada de uma nota que já foi publicada.
 *
 * 🔴 Porque é que isto existe em vez de um `withdrawn: true` na própria nota.
 *
 *    Uma nota publicada é imutável: a `key` liga ao registo de leitura de cada
 *    perfil, e mexer nela faz o aviso reaparecer a quem já o confirmou. Uma
 *    nota apagada é pior ainda — desaparece o que alguém disse ter lido.
 *
 *    Mas às vezes uma nota deixa de ser verdade. Anunciou uma alteração que foi
 *    revertida, e continuar a mostrá-la é dizer às pessoas que o sistema faz
 *    uma coisa que não faz.
 *
 *    A retirada é um artefacto **separado** e também imutável. A nota original
 *    fica onde está, byte a byte, como registo do que foi anunciado; a retirada
 *    diz que deixou de ser oferecida. O histórico distingue «existiu» de «ainda
 *    deve ser mostrado», e nenhum registo de leitura é tocado.
 */
export interface ReleaseNoteWithdrawal {
  /** A `key` da nota retirada. Tem de corresponder a uma nota que existe. */
  key: string;
  /** ISO. Quando deixou de ser oferecida. */
  withdrawnAt: string;
  /**
   * Porquê, para quem mantém o sistema. **Não é mostrado a ninguém** — a
   * pessoa que usa o sistema recebe uma nota nova a dizer o que é verdade
   * agora, não uma explicação de porque é que a antiga deixou de o ser.
   */
  reason: string;
}

/** O que a UI mostra, venha de código ou da base. */
export interface NoticeForDisplay {
  key: string;
  kind: NoticeKind;
  title: string;
  message: string;
  publishedAt: string;
  /** `manual` tem prioridade e não conta para o lote — ver `selecionarCiclo`. */
  source: "release" | "manual";
}

export const AUDIENCES = ["all", "companies", "profiles"] as const;
export type NoticeAudience = (typeof AUDIENCES)[number];

export function isNoticeAudience(v: unknown): v is NoticeAudience {
  return typeof v === "string" && (AUDIENCES as readonly string[]).includes(v);
}

/** Limites de conteúdo — validados no servidor, não só no formulário. */
export const NOTICE_TITLE_MAX = 80;
export const NOTICE_MESSAGE_MAX = 400;
