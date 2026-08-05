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
//
// 2026-08-05 (revisão pós-incidente, PR #32): a primeira versão desta guarda
// comparava a identidade da ligação (host+username) com o project ref via
// `.includes()` — correspondência por SUBSTRING, não exata. Isso aceitaria
// indevidamente um projeto "abc123-extra" ao confirmar apenas "abc123".
// Substituído por extração ESTRUTURADA do ref (regex ancorada ao formato
// exato de host/username do Supabase) seguida de comparação `===`. Ver
// extractDbProjectRef().
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
  const match = String(supabaseUrl ?? "").match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match?.[1] ?? null;
}

/**
 * Extrai o project ref de SUPABASE_DB_URL por ESTRUTURA, nunca por
 * substring — cobre as duas formas de ligação do Supabase:
 *   - direta:  hostname = db.<ref>.supabase.co        → ref no hostname;
 *   - pooler:  username = postgres.<ref>               → ref no username
 *              (o hostname do pooler, aws-x-region.pooler.supabase.com,
 *              é PARTILHADO entre projetos — nunca contém o ref).
 * Cada regex é ancorada (^...$) ao formato completo do segmento — um host
 * como "db.abc123-extra.supabase.co" ou um username como
 * "postgres.abc123-extra" NÃO batem, porque o ref inteiro tem de ser o
 * único conteúdo do grupo, sem sobra antes/depois. Devolve null se nenhuma
 * das duas formas bater (ligação em formato inesperado — quem chamar deve
 * tratar isso como "não foi possível confirmar", nunca como "ok").
 */
export function extractDbProjectRef(dbUrl) {
  const parsed = new URL(dbUrl);
  const host = parsed.hostname;
  const username = decodeURIComponent(parsed.username);

  const directMatch = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (directMatch) return directMatch[1];

  const poolerMatch = username.match(/^postgres\.([a-z0-9]+)$/i);
  if (poolerMatch) return poolerMatch[1];

  return null;
}

/**
 * Confirmação obrigatória antes de qualquer --apply: o project ref extraído
 * estruturalmente de SUPABASE_DB_URL (dbProjectRef — ver
 * extractDbProjectRef) tem de ser EXATAMENTE igual ao de
 * NEXT_PUBLIC_SUPABASE_URL, e quem chamou tem de repetir esse mesmo ref
 * exato em --confirm-production. As três coisas têm de coincidir por
 * igualdade estrita — nunca por substring, prefixo ou sufixo.
 */
export function validateProductionConfirmation({ apply, confirmProductionValue, projectRef, dbProjectRef }) {
  if (!apply) return { ok: true }; // dry-run nunca precisa disto
  if (!projectRef) {
    return { ok: false, error: "NEXT_PUBLIC_SUPABASE_URL não definida — não é possível confirmar o projeto antes de escrever." };
  }
  if (!dbProjectRef) {
    return {
      ok: false,
      error: "Não foi possível extrair o project ref de SUPABASE_DB_URL (nem formato direto db.<ref>.supabase.co, nem pooler postgres.<ref>) — abortando por segurança.",
    };
  }
  if (dbProjectRef !== projectRef) {
    return { ok: false, error: "SUPABASE_DB_URL não corresponde ao projeto de NEXT_PUBLIC_SUPABASE_URL — abortando por segurança." };
  }
  if (confirmProductionValue !== projectRef) {
    return { ok: false, error: `--apply exige --confirm-production ${projectRef} (o project ref exato, visível acima).` };
  }
  return { ok: true };
}
