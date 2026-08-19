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
