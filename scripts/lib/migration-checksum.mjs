// ============================================================================
// CHECKSUM DE MIGRAÇÕES — histórico misto de EOL, futuro normalizado
// ============================================================================
// Contexto: o ledger public._migrations mistura checksums calculados sobre
// LF e sobre CRLF, ficheiro a ficheiro, sem padrão por intervalo — resultado
// de anos de checkouts em máquinas/OS diferentes antes de existir qualquer
// .gitattributes. Mapeamento completo em
// docs/atomicidade-audit/migration-checksum-map-2026-08-05.md.
//
// Regra:
//   - Migrações HISTÓRICAS (já no ledger): aceites se o checksum guardado
//     corresponder aos bytes tal como estão em disco (RAW), ou à mesma
//     migração normalizada para LF, ou normalizada para CRLF. Só uma
//     alteração real de conteúdo (nenhuma das três bater) continua a falhar.
//   - Migrações NOVAS (ainda não aplicadas): o checksum gravado no ledger é
//     sempre sobre o conteúdo normalizado para LF, independentemente do
//     sistema operativo do checkout — elimina a dependência de
//     core.autocrlf/.gitattributes para tudo o que vier depois de 065.
// ============================================================================

import { createHash } from "crypto";

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function normalizeToLF(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeToCRLF(text) {
  return normalizeToLF(text).replace(/\n/g, "\r\n");
}

/** Checksum RAW, sem qualquer normalização — o que o runner sempre calculou. */
export function rawChecksum(fileContent) {
  return sha256Hex(fileContent);
}

/**
 * Uma migração histórica é válida se o checksum do ledger corresponder ao
 * RAW, ao LF-normalizado, ou ao CRLF-normalizado do ficheiro atual.
 */
export function historicalChecksumMatches(storedChecksum, fileContent) {
  if (!storedChecksum) return false;
  if (rawChecksum(fileContent) === storedChecksum) return true;
  if (sha256Hex(normalizeToLF(fileContent)) === storedChecksum) return true;
  if (sha256Hex(normalizeToCRLF(fileContent)) === storedChecksum) return true;
  return false;
}

/** Checksum a gravar para uma migração nova: sempre sobre LF normalizado. */
export function checksumForNewMigration(fileContent) {
  return sha256Hex(normalizeToLF(fileContent));
}

// ============================================================================
// EXCEÇÕES DE CHECKSUM CONHECIDAS (supabase/migration-policy.json →
// knownChecksumExceptions)
// ============================================================================
// Cobre o caso raro em que uma migração histórica foi editada depois de
// aplicada (violação já cometida, não reversível sem inventar conteúdo) e o
// checksum do ledger não corresponde a nenhuma representação RAW/LF/CRLF do
// ficheiro atual. Ver docs/atomicidade-audit/migration-checksum-map-2026-08-05.md
// para o caso concreto (022_storage_bucket_collaborator_documents.sql).
//
// A exceção é estreita por desenho: só se aplica quando o checksum do ledger
// E o checksum LF-normalizado do ficheiro atual coincidem exatamente com o
// que está pinado na política. Qualquer alteração futura ao ficheiro — ou ao
// ledger — invalida a exceção e o --dry-run volta a falhar normalmente.

/** Nenhum ficheiro pode ter mais de uma entrada em knownChecksumExceptions. */
export function assertNoDuplicateExceptions(exceptions) {
  const seen = new Set();
  for (const exception of exceptions ?? []) {
    if (seen.has(exception.migration)) {
      throw new Error(`Exceção de checksum duplicada/ambígua para ${exception.migration}`);
    }
    seen.add(exception.migration);
  }
}

export function findKnownException(exceptions, fileName) {
  return (exceptions ?? []).find((exception) => exception.migration === fileName) ?? null;
}

/**
 * Verdadeiro só quando os três valores batem exatamente: nome da migração
 * (já garantido por findKnownException), checksum do ledger, e checksum
 * LF-normalizado do ficheiro tal como está agora em disco.
 */
export function knownExceptionMatches(exception, storedChecksum, fileContent) {
  if (!exception) return false;
  if (typeof exception.ledgerChecksum !== "string" || exception.ledgerChecksum !== storedChecksum) return false;
  if (typeof exception.acceptedNormalizedLfChecksum !== "string") return false;
  return sha256Hex(normalizeToLF(fileContent)) === exception.acceptedNormalizedLfChecksum;
}
