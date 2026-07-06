import { createHash } from "crypto";
import { deburr, parseMoney, type NormalizedTransaction } from "./normalize";

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
      const n = parseMoney(v);
      if (n != null) return n.toFixed(2);
    }
  }
  return null;
}

/**
 * Gera um fingerprint determinístico de um movimento bancário para detetar
 * duplicados (mesmo ficheiro reimportado ou períodos sobrepostos).
 *
 * O hash cobre data + valor + direção + descrição normalizada + referência +
 * um discriminador (saldo da linha, se existir, senão o índice de ocorrência
 * dentro do ficheiro). `company_id`/`bank_account_id` NÃO entram no hash —
 * já servem de âmbito à unique index da BD (`company_id, bank_account_id,
 * fingerprint`), o que é suficiente para isolar o fingerprint por empresa/conta
 * sem duplicar essa informação dentro do próprio hash.
 *
 * IMPORTANTE: data+valor+descrição NÃO chegam — um extrato real tem vários
 * movimentos legítimos idênticos (ex.: 8× "Pagamento Brisa 9,00€" no mesmo dia).
 * Sem o discriminador, reimportar o mesmo ficheiro reproduziria os mesmos
 * fingerprints (correto, é duplicado), mas movimentos genuinamente repetidos
 * ficariam todos com o mesmo fingerprint e só o 1º seria importado — errado.
 */
export function createBankTransactionFingerprint(tx: NormalizedTransaction, occurrenceIndex = 0): string {
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

/**
 * Deteta duplicados DENTRO do próprio ficheiro que está a ser importado
 * (fingerprints que se repetem no mesmo lote, ex.: linha copiada 2x pelo banco).
 * Devolve o conjunto de fingerprints repetidos e quantas ocorrências extra cada um tem.
 */
export function detectInternalDuplicates(fingerprints: string[]): Map<string, number> {
  const seen = new Map<string, number>();
  const duplicates = new Map<string, number>();
  for (const fp of fingerprints) {
    const count = (seen.get(fp) ?? 0) + 1;
    seen.set(fp, count);
    if (count > 1) duplicates.set(fp, count - 1);
  }
  return duplicates;
}

/**
 * Deteta duplicados já existentes na BD, dado o conjunto de fingerprints já
 * gravados para a empresa+conta (o caller busca esse conjunto com um único
 * `select("fingerprint")`, nunca `select("*")`).
 */
export function detectDatabaseDuplicates(fingerprints: string[], existing: Set<string>): Set<string> {
  return new Set(fingerprints.filter((fp) => existing.has(fp)));
}
