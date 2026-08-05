// ============================================================================
// GUARDAS DE SEGURANÇA DO RUNNER — argumentos e confirmação de produção
// ============================================================================
// Funções puras, sem I/O — scripts/run-migrations.mjs importa e usa; testadas
// diretamente em src/__tests__/migration-runner-guards.test.ts, sem ligar a
// nenhuma base. Ver AGENTS.md (REGRA ZERO, secção 9) e
// docs/PRODUCTION-RUNBOOK.md (secção 8) para a política que isto implementa:
// dry-run por padrão, --apply obrigatório para escrever, confirmação extra
// do projeto antes de qualquer escrita, flags desconhecidas rejeitadas,
// combinações contraditórias bloqueadas.
// ============================================================================

export const KNOWN_FLAGS = Object.freeze([
  "--dry-run",
  "--apply",
  "--baseline",
  "--seed",
  "--confirm-production",
]);

/**
 * Parsing puro dos argumentos da CLI. `--confirm-production` consome o
 * argumento seguinte como valor (ex.: `--confirm-production abcxyz`).
 */
export function parseArgs(argv) {
  const unknownArgs = [];
  let confirmProductionValue = null;
  let dryRun = false;
  let apply = false;
  let baseline = false;
  let seed = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm-production") {
      confirmProductionValue = argv[i + 1] ?? null;
      i++; // consome o valor, não é uma flag independente
      continue;
    }
    if (!KNOWN_FLAGS.includes(arg)) {
      unknownArgs.push(arg);
      continue;
    }
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--baseline") baseline = true;
    else if (arg === "--seed") seed = true;
  }

  return { dryRun, apply, baseline, seed, confirmProductionValue, unknownArgs };
}

/**
 * Validação das combinações de flags — não decide nada sobre a base de
 * dados, só sobre a intenção declarada na linha de comandos.
 *
 * Regras (REGRA ZERO / runbook secção 8):
 *   - flags desconhecidas: rejeitado;
 *   - --dry-run e --apply juntos: contraditório, rejeitado;
 *   - --baseline e --seed juntos: contraditório, rejeitado;
 *   - --baseline ou --seed sem --apply: rejeitado (escrevem no ledger/dados,
 *     não fazem sentido como "dry-run implícito");
 *   - --confirm-production sem --apply: rejeitado — não é um erro de
 *     segurança (dry-run não escreve de qualquer forma), mas é quase
 *     sempre um engano de quem chama (esqueceu --apply, ou achou que
 *     --confirm-production por si só faz algo). Falhar alto e claro em
 *     vez de silenciosamente correr um dry-run que não foi o pedido;
 *   - sem nenhuma flag: comportamento válido — dry-run (decidido por quem
 *     chama, este validador só confirma que não há flags contraditórias).
 */
export function validateArgCombination(parsed) {
  if (parsed.unknownArgs.length > 0) {
    return { ok: false, error: `Argumentos não suportados: ${parsed.unknownArgs.join(", ")}` };
  }
  if (parsed.dryRun && parsed.apply) {
    return { ok: false, error: "--dry-run e --apply são mutuamente exclusivos." };
  }
  if (parsed.baseline && parsed.seed) {
    return { ok: false, error: "--baseline e --seed não podem ser combinados." };
  }
  if ((parsed.baseline || parsed.seed) && !parsed.apply) {
    return {
      ok: false,
      error: "--baseline e --seed exigem --apply explícito (escrevem no ledger/dados, não há dry-run implícito para eles).",
    };
  }
  if (parsed.confirmProductionValue !== null && !parsed.apply) {
    return {
      ok: false,
      error: "--confirm-production sem --apply não faz sentido — falta --apply, ou --confirm-production está a mais.",
    };
  }
  return { ok: true };
}

/**
 * Sem --apply, o runner é SEMPRE dry-run — mesmo sem `--dry-run` explícito.
 * Este é o desenho "seguro por omissão": esquecer uma flag nunca escreve.
 */
export function effectiveMode(parsed) {
  return parsed.apply ? "apply" : "dry-run";
}

/** Extrai o project ref de uma URL do Supabase (https://<ref>.supabase.co). */
export function resolveProjectRef(supabaseUrl) {
  const match = String(supabaseUrl ?? "").match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co/i);
  return match?.[1] ?? null;
}

/**
 * "Identidade" da ligação para conferir contra o project ref: hostname +
 * username decodificado. Necessário porque uma connection string via
 * pooler do Supabase (`aws-x-region.pooler.supabase.com`) NÃO tem o
 * project ref no hostname — vem no username (`postgres.<ref>`). Uma
 * ligação direta (`db.<ref>.supabase.co`) tem o ref no próprio hostname.
 * Juntar os dois cobre as duas formas sem ter de adivinhar qual está em uso.
 */
export function dbIdentityFromUrl(dbUrl) {
  const parsed = new URL(dbUrl);
  return `${parsed.hostname} ${decodeURIComponent(parsed.username)}`;
}

/**
 * Confirmação obrigatória antes de qualquer --apply: o projeto identificado
 * por NEXT_PUBLIC_SUPABASE_URL tem de aparecer na identidade da ligação
 * (host + username de SUPABASE_DB_URL — ver dbIdentityFromUrl), e quem
 * chamou tem de repetir esse project ref exato em --confirm-production.
 * As três coisas têm de coincidir — não basta uma delas.
 */
export function validateProductionConfirmation({ apply, confirmProductionValue, projectRef, dbIdentity }) {
  if (!apply) return { ok: true }; // dry-run nunca precisa disto
  if (!projectRef) {
    return { ok: false, error: "NEXT_PUBLIC_SUPABASE_URL não definida — não é possível confirmar o projeto antes de escrever." };
  }
  if (!dbIdentity || !dbIdentity.includes(projectRef)) {
    return { ok: false, error: "SUPABASE_DB_URL não corresponde ao projeto de NEXT_PUBLIC_SUPABASE_URL — abortando por segurança." };
  }
  if (confirmProductionValue !== projectRef) {
    return { ok: false, error: `--apply exige --confirm-production ${projectRef} (o project ref exato, visível acima).` };
  }
  return { ok: true };
}
