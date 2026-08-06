/**
 * Decide se o verificador de guardas de `profiles` pode correr contra uma base.
 *
 * Módulo puro (sem I/O, sem `process.exit`) para poder ser testado a sério —
 * `scripts/verify-profile-guards.mjs` limita-se a ler os argumentos e a
 * obedecer ao veredito.
 *
 * ---------------------------------------------------------------------------
 * A contradição que isto resolve
 * ---------------------------------------------------------------------------
 * A primeira versão recusava correr quando o project ref da `--database-url`
 * era igual ao de `NEXT_PUBLIC_SUPABASE_URL`. Mas o procedimento de ensaio
 * (`docs/PRODUCTION-RUNBOOK.md`) manda apontar AMBAS as variáveis ao projeto
 * descartável — porque o runner de migrations exige que coincidam. Seguindo o
 * runbook à letra, o verificador recusava-se a correr contra a própria base de
 * ensaio, e o ensaio nunca poderia acontecer.
 *
 * A regra correta separa duas perguntas que estavam confundidas:
 *
 *   - "qual é a base alvo?"        → `--database-url`
 *   - "qual é a base proibida?"    → `--forbid-project-ref`
 *
 * `NEXT_PUBLIC_SUPABASE_URL` deixa de servir de proibição por omissão quando há
 * flag explícita: durante o ensaio essa variável aponta, legitimamente, para o
 * projeto descartável. Sem flag, continua a valer como rede de segurança.
 *
 * Havia ainda um segundo defeito, mais silencioso: a condição só disparava
 * quando os dois refs eram identificáveis. Uma URL de onde não se conseguisse
 * extrair o ref passava sem verificação nenhuma. Agora um alvo não
 * identificável é motivo de recusa, não de passagem.
 */

/**
 * Extrai o project ref de uma URL de ligação Postgres do Supabase.
 * Mesmo formato usado por `scripts/lib/migration-runner-guards.mjs`.
 */
export function extractDbProjectRef(dbUrl) {
  let parsed;

  try {
    parsed = new URL(dbUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname;
  const username = decodeURIComponent(parsed.username);

  const direct = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (direct) return direct[1];

  if (/^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(host)) {
    const pooler = username.match(/^postgres\.([a-z0-9]+)$/i);
    if (pooler) return pooler[1];
  }

  return null;
}

/** Extrai o project ref de uma URL pública `https://<ref>.supabase.co`. */
export function extractPublicProjectRef(url) {
  if (!url) return null;
  const match = String(url).match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match ? match[1] : null;
}

/**
 * @param {object} entrada
 * @param {string|null|undefined} entrada.databaseUrl        valor de --database-url
 * @param {boolean}               entrada.disposable         --i-know-this-database-is-disposable
 * @param {string|null|undefined} entrada.forbidProjectRef   valor de --forbid-project-ref
 * @param {string|null|undefined} entrada.configuredSupabaseUrl  NEXT_PUBLIC_SUPABASE_URL
 * @returns {{ ok: true, targetRef: string, protectedRef: string, protectedSource: "flag"|"env" }
 *          | { ok: false, error: string }}
 */
export function resolveTargetGuard({
  databaseUrl,
  disposable,
  forbidProjectRef,
  configuredSupabaseUrl,
}) {
  if (!databaseUrl) {
    return {
      ok: false,
      error:
        "--database-url é obrigatório. Este script nunca lê SUPABASE_DB_URL do ambiente, de propósito.",
    };
  }

  if (!disposable) {
    return {
      ok: false,
      error:
        "--i-know-this-database-is-disposable é obrigatório: este script escreve na base.",
    };
  }

  const targetRef = extractDbProjectRef(databaseUrl);

  if (!targetRef) {
    return {
      ok: false,
      error:
        "Não foi possível identificar o project ref da base alvo a partir de --database-url. " +
        "Sem saber contra que projeto se está a correr, não há como garantir que não é o real.",
    };
  }

  // A flag explícita prevalece: durante o ensaio, NEXT_PUBLIC_SUPABASE_URL
  // aponta legitimamente para a base descartável.
  const refDaFlag = forbidProjectRef ? String(forbidProjectRef).trim() : "";
  const protectedRef =
    refDaFlag || extractPublicProjectRef(configuredSupabaseUrl);

  if (!protectedRef) {
    return {
      ok: false,
      error:
        "Indica --forbid-project-ref <ref-do-projeto-real>, ou define NEXT_PUBLIC_SUPABASE_URL. " +
        "Sem um projeto declarado como proibido, não há proteção nenhuma.",
    };
  }

  if (targetRef === protectedRef) {
    return {
      ok: false,
      error: `A base alvo (${targetRef}) é o projeto protegido. Este script só corre contra uma base descartável.`,
    };
  }

  return {
    ok: true,
    targetRef,
    protectedRef,
    protectedSource: refDaFlag ? "flag" : "env",
  };
}
