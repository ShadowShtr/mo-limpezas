// ============================================================================
// MIGRATIONS BLOQUEADAS — o que o runner não pode aplicar por arrasto
// ============================================================================
//
// Funções puras, sem I/O e sem base de dados. Existem por causa de uma lacuna
// concreta no runner:
//
//     pending = ficheiros sem linha no ledger
//     for (const file of pending) executar
//
// «Pendente» era a única categoria. Uma migration deliberadamente congelada —
// a 070 — é indistinguível de uma migration que ainda não teve oportunidade de
// correr, e por isso entrava na fila do `--apply` normal. Criar a 077 e correr
// o comando de sempre executaria a 070 primeiro, sem ninguém a ter pedido.
//
// ---------------------------------------------------------------------------
// Porque é que isto não é `if (file.startsWith("070"))`
// ---------------------------------------------------------------------------
//
// Uma condição escrita no runner é invisível: não aparece em diff nenhum
// quando alguém a remove «para desbloquear», não tem motivo anexado, e não
// sobrevive a um refactor. A decisão de não aplicar uma migration é uma
// decisão de operação, não um detalhe de implementação — por isso vive em
// `supabase/migration-policy.json`, versionada, com motivo e evidência, ao
// lado das exceções de checksum que já lá estavam.
//
// ---------------------------------------------------------------------------
// BLOCKED_PENDING não é «aplicada» nem «ignorada»
// ---------------------------------------------------------------------------
//
// Uma migration bloqueada continua **ausente do ledger** e continua a aparecer
// em todos os relatórios, com o motivo. O que ela não faz é ser elegível.
//
// Chamar-lhe «ignorada» convidaria a esquecê-la; marcá-la como aplicada seria
// pior — transformaria «não executámos a 070» em «o ledger diz que executámos
// a 070», que é uma mentira gravada numa tabela que existe precisamente para
// não mentir.
// ============================================================================

/** Estado de uma migration pendente que a política proíbe de aplicar. */
export const BLOCKED_PENDING = "BLOCKED_PENDING";

/**
 * Valida a forma das entradas de `blockedMigrations`.
 *
 * Uma entrada malformada não pode degradar em «nada bloqueado» — seria a
 * falha silenciosa mais cara possível neste módulo: o bloqueio desapareceria
 * e a migration voltaria à fila sem aviso. Lança.
 */
export function assertValidBlockedEntries(entries) {
  if (entries == null) return;
  if (!Array.isArray(entries)) {
    throw new Error("migration-policy.json: blockedMigrations tem de ser uma lista.");
  }
  const vistos = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("migration-policy.json: cada entrada de blockedMigrations tem de ser um objeto.");
    }
    if (typeof entry.migration !== "string" || !entry.migration.endsWith(".sql")) {
      throw new Error(
        `migration-policy.json: blockedMigrations.migration tem de ser um nome de ficheiro .sql (recebido: ${JSON.stringify(entry.migration)}).`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(
        `migration-policy.json: ${entry.migration} está bloqueada sem motivo. Um bloqueio sem motivo não sobrevive a quem o encontrar daqui a seis meses.`,
      );
    }
    if (vistos.has(entry.migration)) {
      throw new Error(`migration-policy.json: ${entry.migration} aparece duas vezes em blockedMigrations.`);
    }
    vistos.add(entry.migration);
  }
}

/** Conjunto de nomes bloqueados, para consultas rápidas. */
export function blockedNames(entries) {
  return new Set((entries ?? []).map((e) => e.migration));
}

/** A entrada completa (com motivo) de uma migration, ou `null`. */
export function findBlockedEntry(entries, file) {
  return (entries ?? []).find((e) => e.migration === file) ?? null;
}

export function isBlocked(entries, file) {
  return findBlockedEntry(entries, file) !== null;
}

/**
 * Separa as pendentes entre as que a política proíbe e as que podem correr.
 *
 * Devolve as duas listas — nunca só as elegíveis. Quem chama tem de continuar
 * a poder mostrar as bloqueadas: uma migration que desaparece do relatório é
 * uma decisão que se perde.
 */
export function splitBlocked(entries, pending) {
  const nomes = blockedNames(entries);
  const blocked = [];
  const eligible = [];
  for (const file of pending) {
    if (nomes.has(file)) blocked.push(file);
    else eligible.push(file);
  }
  return { blocked, eligible };
}

/**
 * Resolve `--only <ficheiro>` contra a realidade.
 *
 * 🔴 Correspondência **exata**, nunca prefixo nem substring. `--only 077`
 *    parece inofensivo até existirem `077_a.sql` e `077_b.sql`, ou até um
 *    prefixo apanhar mais do que se pensava. Numa operação que escreve em
 *    produção, «provavelmente era esta que ele queria» não é um resultado
 *    aceitável.
 *
 * Devolve um resultado discriminado — nunca lança e nunca assume.
 */
export function resolveOnlyTarget({ only, files, appliedNames, blockedEntries }) {
  if (!only) return { kind: "none" };

  if (!only.endsWith(".sql")) {
    return {
      kind: "invalid",
      error: `--only exige o nome exato do ficheiro, terminado em .sql (recebido: "${only}").`,
    };
  }

  const exatos = files.filter((f) => f === only);
  if (exatos.length === 0) {
    // Ajuda a distinguir «enganei-me no nome» de «o ficheiro não existe»,
    // sem nunca escolher por quem chamou.
    const parecidos = files.filter((f) => f.startsWith(only.replace(/\.sql$/, "")));
    const dica = parecidos.length > 0 ? ` Existem: ${parecidos.join(", ")}.` : "";
    return { kind: "invalid", error: `--only ${only}: ficheiro não encontrado.${dica}` };
  }

  const bloqueada = findBlockedEntry(blockedEntries, only);
  if (bloqueada) {
    return {
      kind: "blocked",
      error: `--only ${only}: esta migration está BLOCKED_PENDING e não pode ser aplicada. Motivo: ${bloqueada.reason}`,
    };
  }

  if (appliedNames.has(only)) return { kind: "already-applied", file: only };

  return { kind: "target", file: only };
}
