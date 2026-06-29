import { createHash } from "crypto";
import type { NormalizedTransaction } from "./normalize";

/**
 * Gera um fingerprint determinístico de um movimento bancário para detetar
 * duplicados (mesmo movimento importado duas vezes, ainda que de ficheiros
 * diferentes). Usa data + valor + direção + descrição/referência normalizadas.
 *
 * NÃO inclui a conta/empresa — esses entram na unique index da BD.
 */
export function transactionFingerprint(tx: NormalizedTransaction): string {
  const desc = tx.description.toLowerCase().replace(/\s+/g, " ").trim();
  const ref = (tx.reference ?? "").toLowerCase().trim();
  const parts = [
    tx.transaction_date,
    tx.amount.toFixed(2),
    tx.direction,
    desc,
    ref,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** SHA-256 do conteúdo bruto do ficheiro (anti-reimportação do mesmo ficheiro). */
export function fileHash(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}
