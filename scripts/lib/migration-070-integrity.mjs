/**
 * Integridade do SQL da migration 070, para o ensaio de rollback.
 *
 * Módulo puro (sem I/O, sem process.exit) para poder ser testado a sério —
 * `scripts/verify-profile-guards.mjs` lê o ficheiro e delega aqui a decisão de
 * o executar ou não.
 *
 * Existe porque o ensaio EXECUTA o ficheiro da migration tal e qual, para não
 * haver duas cópias do mesmo SQL. Executar um ficheiro às cegas é que não:
 * se a 070 deixar de conter os objetos esperados, ou passar a conter
 * instruções que tocam em dados ou em estrutura de tabelas, o ensaio tem de
 * recusar antes de ligar à base.
 */

export const TRIGGER_070 = "trg_guard_profile_managed_fields";
export const FUNCAO_070 = "fn_guard_profile_managed_fields";

/** Objetos sem os quais o ensaio não prova nada. */
const EXIGIDOS = [
  {
    padrao: new RegExp(`CREATE OR REPLACE FUNCTION public\\.${FUNCAO_070}\\s*\\(`),
    descricao: `função public.${FUNCAO_070}`,
  },
  {
    padrao: new RegExp(`CREATE TRIGGER ${TRIGGER_070}\\s`),
    descricao: `trigger ${TRIGGER_070}`,
  },
  {
    padrao: /BEFORE UPDATE ON public\.profiles/,
    descricao: "trigger BEFORE UPDATE em public.profiles",
  },
];

/**
 * Instruções que a 070 nunca deve conter fora de comentário. As secções de
 * rollback e de verificação do ficheiro são comentários SQL e têm de continuar
 * a sê-lo — é isso que torna seguro executar o ficheiro inteiro.
 */
const PROIBIDOS = [
  { padrao: /\bALTER\s+TABLE\b/i, descricao: "ALTER TABLE" },
  { padrao: /\bDROP\s+TABLE\b/i, descricao: "DROP TABLE" },
  { padrao: /\bDROP\s+SCHEMA\b/i, descricao: "DROP SCHEMA" },
  { padrao: /\bTRUNCATE\b/i, descricao: "TRUNCATE" },
  { padrao: /\bDELETE\s+FROM\b/i, descricao: "DELETE FROM" },
  { padrao: /\bINSERT\s+INTO\b/i, descricao: "INSERT INTO" },
  { padrao: /\bUPDATE\s+\w+\s+SET\b/i, descricao: "UPDATE ... SET" },
];

/** Remove as linhas de comentário, para só analisar o que Postgres executa. */
export function apenasExecutavel(sql) {
  return sql
    .split(/\r?\n/)
    .filter((linha) => !/^\s*--/.test(linha))
    .join("\n");
}

/**
 * @param {string|null|undefined} sql conteúdo do ficheiro da migration
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validarMigration070(sql) {
  if (sql == null) {
    return { ok: false, error: "Migration não encontrada." };
  }

  if (sql.trim().length === 0) {
    return { ok: false, error: "Migration vazia." };
  }

  for (const { padrao, descricao } of EXIGIDOS) {
    if (!padrao.test(sql)) {
      return {
        ok: false,
        error: `A migration não contém ${descricao}. O ensaio deixaria de provar o que a 070 faz.`,
      };
    }
  }

  const executavel = apenasExecutavel(sql);

  for (const { padrao, descricao } of PROIBIDOS) {
    if (padrao.test(executavel)) {
      return {
        ok: false,
        error: `A migration contém uma instrução executável fora do esperado (${descricao}). O ensaio recusa-se a executá-la.`,
      };
    }
  }

  return { ok: true };
}
