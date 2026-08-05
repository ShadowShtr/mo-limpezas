import { describe, expect, it } from "vitest";
import {
  historicalChecksumMatches,
  checksumForNewMigration,
  sha256Hex,
  normalizeToLF,
  normalizeToCRLF,
  rawChecksum,
  assertNoDuplicateExceptions,
  findKnownException,
  knownExceptionMatches,
} from "../../scripts/lib/migration-checksum.mjs";

// Ver docs/atomicidade-audit/migration-checksum-map-2026-08-05.md para o
// mapeamento completo que motivou esta regra: o ledger public._migrations
// mistura checksums calculados sobre LF e sobre CRLF, ficheiro a ficheiro,
// sem padrão por intervalo — resultado de checkouts em máquinas diferentes
// ao longo dos anos, antes de existir .gitattributes.

const SQL = "SELECT 1;\nSELECT 2;\n";
const SQL_CRLF = SQL.replace(/\n/g, "\r\n");

describe("migration-checksum", () => {
  it("normaliza CRLF para LF sem alterar conteúdo semântico", () => {
    expect(normalizeToLF(SQL_CRLF)).toBe(SQL);
    expect(normalizeToLF(SQL)).toBe(SQL);
  });

  it("normaliza LF para CRLF sem alterar conteúdo semântico", () => {
    expect(normalizeToCRLF(SQL)).toBe(SQL_CRLF);
    expect(normalizeToCRLF(SQL_CRLF)).toBe(SQL_CRLF);
  });

  it("migração histórica gravada em LF é aceite quando o checkout produz CRLF", () => {
    const storedChecksum = sha256Hex(SQL); // ledger calculado sobre LF (ex.: 001-013)
    expect(historicalChecksumMatches(storedChecksum, SQL_CRLF)).toBe(true);
  });

  it("migração histórica gravada em CRLF é aceite quando o checkout produz LF", () => {
    const storedChecksum = sha256Hex(SQL_CRLF); // ledger calculado sobre CRLF (ex.: 014-017)
    expect(historicalChecksumMatches(storedChecksum, SQL)).toBe(true);
  });

  it("migração histórica gravada em RAW puro continua aceite (comportamento anterior preservado)", () => {
    const storedChecksum = rawChecksum(SQL);
    expect(historicalChecksumMatches(storedChecksum, SQL)).toBe(true);
  });

  it("migração nova grava sempre o checksum sobre LF normalizado, independente do checkout", () => {
    const fromLF = checksumForNewMigration(SQL);
    const fromCRLF = checksumForNewMigration(SQL_CRLF);
    expect(fromLF).toBe(fromCRLF);
    expect(fromLF).toBe(sha256Hex(SQL));
  });

  it("checksum de migração nova bate com historicalChecksumMatches em qualquer checkout futuro", () => {
    const stored = checksumForNewMigration(SQL);
    expect(historicalChecksumMatches(stored, SQL)).toBe(true);
    expect(historicalChecksumMatches(stored, SQL_CRLF)).toBe(true);
  });

  it("alteração real de SQL (não apenas EOL) continua rejeitada em qualquer representação", () => {
    const stored = sha256Hex(SQL);
    const tampered = SQL.replace("SELECT 2;", "SELECT 3;");
    const tamperedCRLF = normalizeToCRLF(tampered);

    expect(historicalChecksumMatches(stored, tampered)).toBe(false);
    expect(historicalChecksumMatches(stored, tamperedCRLF)).toBe(false);
  });

  it("checksum nulo/ausente no ledger nunca é tratado como correspondência", () => {
    expect(historicalChecksumMatches(null as unknown as string, SQL)).toBe(false);
    expect(historicalChecksumMatches(undefined as unknown as string, SQL)).toBe(false);
    expect(historicalChecksumMatches("", SQL)).toBe(false);
  });

  it("022 restaurada seria aceite se batesse com o checksum do ledger em qualquer EOL (regressão do caso real)", () => {
    // A investigação real (docs/atomicidade-audit/migration-checksum-map-2026-08-05.md)
    // mostrou que NENHUMA versão em git de 022_storage_bucket_collaborator_documents.sql
    // bate com o checksum do ledger, em nenhuma das três representações — por isso o
    // ficheiro foi deixado como está, e não "corrigido" às cegas. Este teste fixa a
    // garantia inversa: se um dia o conteúdo exato for encontrado, a verificação aceita-o
    // independentemente do EOL do checkout que o produzir.
    const originalApplied = "-- bucket collaborator-documents\nSELECT 'exemplo';\n";
    const storedChecksum = sha256Hex(originalApplied);

    expect(historicalChecksumMatches(storedChecksum, originalApplied)).toBe(true);
    expect(historicalChecksumMatches(storedChecksum, normalizeToCRLF(originalApplied))).toBe(true);
    // mas uma versão com conteúdo realmente diferente (como o 022 atual vs. o ledger) falha:
    expect(historicalChecksumMatches(storedChecksum, originalApplied.replace("exemplo", "outro"))).toBe(false);
  });
});

describe("knownChecksumExceptions (022)", () => {
  const LEDGER_CHECKSUM = "ledger-checksum-abc";
  const FILE_CONTENT_LF = "-- 022 tal como está hoje\nSELECT 1;\n";
  const APPROVED_LF_CHECKSUM = sha256Hex(FILE_CONTENT_LF);

  const exception = {
    migration: "022_storage_bucket_collaborator_documents.sql",
    ledgerChecksum: LEDGER_CHECKSUM,
    acceptedNormalizedLfChecksum: APPROVED_LF_CHECKSUM,
    reason: "divergência histórica documentada; estado final garantido pela 023.",
    evidence: "docs/atomicidade-audit/migration-checksum-map-2026-08-05.md",
  };

  it("exceção exata é aceite: nome, checksum do ledger e checksum LF do ficheiro batem", () => {
    const found = findKnownException([exception], exception.migration);
    expect(knownExceptionMatches(found, LEDGER_CHECKSUM, FILE_CONTENT_LF)).toBe(true);
    // também aceite se o checkout entregar o mesmo conteúdo em CRLF —
    // a comparação é sempre sobre o LF-normalizado do ficheiro atual.
    expect(knownExceptionMatches(found, LEDGER_CHECKSUM, normalizeToCRLF(FILE_CONTENT_LF))).toBe(true);
  });

  it("checksum do ledger diferente do documentado é rejeitado", () => {
    const found = findKnownException([exception], exception.migration);
    expect(knownExceptionMatches(found, "outro-checksum-qualquer", FILE_CONTENT_LF)).toBe(false);
  });

  it("conteúdo atual diferente do aprovado (LF diferente) é rejeitado — ficheiro mudou de novo", () => {
    const found = findKnownException([exception], exception.migration);
    const changedAgain = FILE_CONTENT_LF.replace("SELECT 1;", "SELECT 2;");
    expect(knownExceptionMatches(found, LEDGER_CHECKSUM, changedAgain)).toBe(false);
  });

  it("migração não listada em knownChecksumExceptions não encontra exceção nenhuma", () => {
    const found = findKnownException([exception], "023_fix_collaborator_documents_upload.sql");
    expect(found).toBeNull();
    expect(knownExceptionMatches(found, LEDGER_CHECKSUM, FILE_CONTENT_LF)).toBe(false);
  });

  it("exceção duplicada para o mesmo ficheiro é rejeitada logo no carregamento da política", () => {
    expect(() => assertNoDuplicateExceptions([exception, { ...exception, reason: "outra versão" }])).toThrow(
      /duplicada|ambígua/i,
    );
  });

  it("lista vazia ou sem duplicados não lança erro", () => {
    expect(() => assertNoDuplicateExceptions([])).not.toThrow();
    expect(() => assertNoDuplicateExceptions([exception])).not.toThrow();
    expect(() =>
      assertNoDuplicateExceptions([exception, { ...exception, migration: "023_fix_collaborator_documents_upload.sql" }]),
    ).not.toThrow();
  });

  it("a política real (supabase/migration-policy.json) não tem exceções duplicadas", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const policy = JSON.parse(fs.readFileSync(path.join(process.cwd(), "supabase/migration-policy.json"), "utf8"));
    expect(() => assertNoDuplicateExceptions(policy.knownChecksumExceptions ?? [])).not.toThrow();
  });
});
