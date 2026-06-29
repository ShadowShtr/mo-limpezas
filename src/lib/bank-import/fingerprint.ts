import { createHash } from "crypto";
import { deburr, parseAmount, type NormalizedTransaction } from "./normalize";

/**
 * Extrai o saldo da linha (coluna "Saldo"/"Balance") a partir do raw_data.
 * O saldo é praticamente único por movimento (muda a cada transação), por isso
 * é o melhor discriminador para distinguir movimentos legítimos idênticos.
 */
function extractBalance(raw: Record<string, string> | null | undefined): string | null {
  if (!raw) return null;
  for (const [k, v] of Object.entries(raw)) {
    const dk = deburr(k);
    if (dk.includes("saldo") || dk.includes("balance")) {
      const n = parseAmount(v);
      if (n != null) return n.toFixed(2);
    }
  }
  return null;
}

/**
 * Gera um fingerprint determinístico de um movimento bancário para detetar
 * duplicados (mesmo ficheiro reimportado ou períodos sobrepostos).
 *
 * IMPORTANTE: data+valor+descrição NÃO chegam — um extrato real tem vários
 * movimentos legítimos idênticos (ex.: 8× "Pagamento Brisa 9,00€" no mesmo dia).
 * Para os distinguir usamos um discriminador:
 *   - o SALDO da linha, se existir (único por movimento); ou
 *   - o índice de ocorrência da linha dentro do ficheiro (0,1,2…).
 * Assim, reimportar o mesmo ficheiro reproduz os mesmos fingerprints (duplicado),
 * mas movimentos genuinamente repetidos ficam com fingerprints diferentes.
 */
export function transactionFingerprint(tx: NormalizedTransaction, occurrenceIndex = 0): string {
  const desc = tx.description.toLowerCase().replace(/\s+/g, " ").trim();
  const ref = (tx.reference ?? "").toLowerCase().trim();
  const balance = extractBalance(tx.raw_data);
  const discriminator = balance != null ? `b:${balance}` : `i:${occurrenceIndex}`;
  const parts = [
    tx.transaction_date,
    tx.amount.toFixed(2),
    tx.direction,
    desc,
    ref,
    discriminator,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** SHA-256 do conteúdo bruto do ficheiro (anti-reimportação do mesmo ficheiro). */
export function fileHash(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}
