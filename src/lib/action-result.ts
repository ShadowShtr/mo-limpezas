// ============================================================================
// Formato único de resultado das Server Actions — Task T05
// ============================================================================
// Origem: docs/PLANO-MESTRE.md, secção 26.
//
// O problema: cada action foi criada de forma independente e devolve uma
// estrutura própria. O inventário da T00 encontrou mais de dez formas
// diferentes de dizer "correu bem" ou "correu mal", e mensagens de erro sem
// código estável — o que obriga a interface a comparar texto para decidir o
// que fazer, e torna impossível tratar um erro de forma uniforme.
//
// Este módulo é a **única** fonte desse formato. Não criar um segundo.
//
// ---------------------------------------------------------------------------
// Adoção gradual
// ---------------------------------------------------------------------------
// As actions migram uma área de cada vez, nunca todas de uma vez, e nunca numa
// PR que também mude comportamento. A regra por migração é:
//
//   1. inventariar os consumidores da action (componentes, toasts,
//      redirecionamentos, testes);
//   2. migrar a action e os seus consumidores na mesma PR;
//   3. preservar as mensagens de negócio existentes — o utilizador não deve
//      notar a mudança;
//   4. não expor mensagens internas (Supabase, stack traces) ao utilizador.
//
// Enquanto houver actions por migrar, os dois formatos coexistem. Isso é
// esperado e temporário — o que não pode acontecer é nascer um terceiro.
// ============================================================================

/**
 * Códigos de erro estáveis.
 *
 * "Estável" quer dizer: a interface pode ramificar por `code` sem medo de que
 * uma reformulação da mensagem lhe quebre a lógica. A mensagem é para ler; o
 * código é para decidir.
 *
 * Para acrescentar um código novo, acrescentar aqui — não inventar um literal
 * solto numa action, senão deixa de haver lista.
 */
export const ACTION_ERROR_CODES = {
  /** Não há sessão. */
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /** Há sessão, mas o ator não pode fazer isto. */
  FORBIDDEN: "FORBIDDEN",
  /** O recurso não existe, ou não é visível para este ator. */
  NOT_FOUND: "NOT_FOUND",
  /** A entrada não passou na validação. Costuma trazer `fieldErrors`. */
  VALIDATION: "VALIDATION",
  /** O estado mudou entretanto, ou colide com outro registo. */
  CONFLICT: "CONFLICT",
  /** Regra de negócio recusou a operação. */
  BUSINESS_RULE: "BUSINESS_RULE",
  /** A escrita falhou por razão técnica. Detalhe fica no log, não no ecrã. */
  PERSISTENCE: "PERSISTENCE",
  /** Falha inesperada. Detalhe fica no log, não no ecrã. */
  INTERNAL: "INTERNAL",
} as const;

export type ActionErrorCode =
  (typeof ACTION_ERROR_CODES)[keyof typeof ACTION_ERROR_CODES];

export type ActionSuccess<T> = {
  ok: true;
  data: T;
};

export type ActionFailure = {
  ok: false;
  error: {
    code: ActionErrorCode;
    /** Mensagem legível, em português, para mostrar ao utilizador. */
    message: string;
    /** Erros por campo, quando a falha é de validação. */
    fieldErrors?: Record<string, string[]>;
  };
};

/**
 * União discriminada por `ok`. A interface distingue os dois casos com
 * `if (result.ok)` — nunca por presença de campos.
 */
export type ActionResult<T> = ActionSuccess<T> | ActionFailure;

/** Mensagem genérica para falhas cuja causa não deve chegar ao utilizador. */
const MENSAGEM_INTERNA =
  "Não foi possível concluir a operação. Tenta novamente.";

export function actionSuccess<T>(data: T): ActionSuccess<T> {
  return { ok: true, data };
}

export function actionFailure(
  code: ActionErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ActionFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      // `fieldErrors: undefined` e a ausência da chave não são a mesma coisa
      // quando o resultado é serializado ou comparado — a chave só existe
      // quando há erros de campo.
      ...(fieldErrors ? { fieldErrors } : {}),
    },
  };
}

/**
 * Falha de validação a partir de um `safeParse` do Zod.
 *
 * Guarda a primeira mensagem como `message` (é o que a interface mostra hoje)
 * e mantém o mapa completo em `fieldErrors`, para os formulários poderem
 * assinalar campo a campo quando quiserem.
 */
export function validationFailure(issues: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): ActionFailure {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of issues.issues) {
    const campo = issue.path.map(String).join(".");
    if (!campo) continue;
    (fieldErrors[campo] ??= []).push(issue.message);
  }

  const primeira = issues.issues[0]?.message ?? "Dados inválidos.";

  return actionFailure(
    ACTION_ERROR_CODES.VALIDATION,
    primeira,
    Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
  );
}

/**
 * Falha técnica: o detalhe real vai para o log do servidor, e o utilizador
 * recebe uma mensagem genérica.
 *
 * Existe porque hoje várias actions devolvem `error.message` do Supabase
 * diretamente ao ecrã — o que expõe nomes de tabelas, colunas e restrições a
 * quem não tem nada com isso, e ainda por cima não ajuda o utilizador.
 */
export function internalFailure(
  contexto: string,
  causa: unknown,
  code: Extract<
    ActionErrorCode,
    "INTERNAL" | "PERSISTENCE"
  > = ACTION_ERROR_CODES.INTERNAL,
): ActionFailure {
  console.error(`[action:${contexto}]`, causa);

  return actionFailure(code, MENSAGEM_INTERNA);
}
