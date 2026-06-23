// ============================================================
// Importa o Fluxo de Caixa de Junho (Mó Limpezas) para cash_flow_entries.
// Fonte: pacote mo_limpezas_CODEX_FLUXO_CAIXA_JUNHO_CSV_SIMPLES
//   07_fluxo_caixa_receitas.csv  -> type "entrada"
//   08_fluxo_caixa_gastos.csv    -> type "saida"
//
// Uso:  node scripts/import-fluxo-junho.mjs --dir <pasta-csv> [--dry] [--force]
//   --dry   : só analisa e mostra o resumo, não escreve nada
//   --force : importa mesmo que já exista o marcador de importação
//
// Mantém nomes, datas, valores, categorias, descrições e estados como estão.
// A categoria original (fora do enum da BD) é preservada em `notes`.
// Requer .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";

config({ path: "./.env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const COMPANY = "00000000-0000-0000-0000-000000000001";
const CREATED_BY = "03def8bb-f7ae-4963-9a7d-78292b867d73"; // Vitor Medina (admin)
const YEAR = 2026, MONTH = 6;
const MARKER = "import:fluxo-junho";

const args = process.argv.slice(2);
const dir = args[args.indexOf("--dir") + 1];
const dry = args.includes("--dry");
const force = args.includes("--force");
if (!dir || dir.startsWith("--")) {
  console.error("Uso: node scripts/import-fluxo-junho.mjs --dir <pasta-csv> [--dry] [--force]");
  process.exit(1);
}

// Categoria original (CSV) -> enum da BD cash_flow_entries
const CAT_RECEITA = { "Prestação de serviços": "faturacao", "ATL": "outro", "Pessoal": "outro" };
const CAT_GASTO = {
  "Ordenado": "salario",
  "comissao/imposto": "despesa", "Pessoal": "despesa", "Gasoleo": "despesa", "seguro": "despesa",
  "Material": "despesa", "Uber": "despesa", "Via verde": "despesa", "DESPESA": "despesa", "Renda": "despesa",
  "Parceria": "fornecedor", "Outros": "outro",
};

function parseValor(raw) {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // formato esperado: inteiro ou decimal com ponto (ex.: 86.74). vírgula => malformado
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

function readCsv(file) {
  const text = readFileSync(join(dir, file), "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const rows = lines.slice(1).map((l) => l.split(";"));
  return rows;
}

function build(file, type) {
  const rows = readCsv(file);
  const entries = [];
  const errors = [];
  let skippedTotais = 0;
  for (const c of rows) {
    const source_row = (c[0] ?? "").trim();
    const dia = (c[1] ?? "").trim();
    const categoria = (c[2] ?? "").trim();
    const descricao = (c[3] ?? "").trim();
    const valorRaw = (c[4] ?? "").trim();
    const statusRaw = (c[5] ?? "").trim();
    const pgto = type === "saida" ? (c[6] ?? "").trim() : "";

    // linha de total ou vazia (sem dia e sem descrição)
    if (!dia && !descricao) { skippedTotais++; continue; }

    const valor = parseValor(valorRaw);
    if (!dia || !descricao || valor === null || Number.isNaN(valor) || valor <= 0) {
      errors.push({ source_row, motivo: !dia ? "sem DIA" : !descricao ? "sem descrição"
        : valor === null ? "sem valor" : Number.isNaN(valor) ? `valor inválido "${valorRaw}"` : "valor <= 0" });
      continue;
    }
    const diaN = parseInt(dia, 10);
    if (!(diaN >= 1 && diaN <= 30)) { errors.push({ source_row, motivo: `DIA fora do mês "${dia}"` }); continue; }

    const map = type === "entrada" ? CAT_RECEITA : CAT_GASTO;
    const category = map[categoria] ?? (type === "entrada" ? "outro" : "despesa");
    const status = /receb|pago/i.test(statusRaw) ? "confirmado" : "confirmado";
    const date = `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(diaN).padStart(2, "0")}`;

    const notesParts = [MARKER, `tipo:${type === "entrada" ? "receita" : "gasto"}`,
      `cat:${categoria || "—"}`, `row:${source_row}`, `status:${statusRaw || "—"}`];
    if (pgto) notesParts.push(`pgto:${pgto}`);

    entries.push({
      company_id: COMPANY,
      type,
      amount: valor,
      description: descricao,
      category,
      date,
      status,
      notes: notesParts.join(" | "),
      created_by: CREATED_BY,
    });
  }
  return { entries, errors, skippedTotais };
}

const receitas = build("07_fluxo_caixa_receitas.csv", "entrada");
const gastos = build("08_fluxo_caixa_gastos.csv", "saida");

const sum = (a) => Math.round(a.reduce((s, e) => s + e.amount, 0) * 100) / 100;
console.log("== ANÁLISE ==");
console.log(`Receitas: ${receitas.entries.length} linhas válidas | total €${sum(receitas.entries)} | erros ${receitas.errors.length} | totais/vazias ignoradas ${receitas.skippedTotais}`);
console.log(`Gastos  : ${gastos.entries.length} linhas válidas | total €${sum(gastos.entries)} | erros ${gastos.errors.length} | totais/vazias ignoradas ${gastos.skippedTotais}`);
if (receitas.errors.length) console.log("Erros receitas:", receitas.errors);
if (gastos.errors.length) console.log("Erros gastos:", gastos.errors);

if (dry) { console.log("\n--dry: nada foi escrito."); process.exit(0); }

// guard anti-duplicação
const { data: existing } = await sb.from("cash_flow_entries").select("id").like("notes", `%${MARKER}%`).limit(1);
if (existing?.length && !force) {
  console.error("\nJá existe importação com este marcador. Use --force para repetir (vai duplicar).");
  process.exit(1);
}

const all = [...receitas.entries, ...gastos.entries];
let inserted = 0;
for (let i = 0; i < all.length; i += 500) {
  const { data, error } = await sb.from("cash_flow_entries").insert(all.slice(i, i + 500)).select("id");
  if (error) { console.error(`Erro de inserção @${i}:`, error.message); process.exit(1); }
  inserted += data.length;
}
console.log(`\n== IMPORTAÇÃO CONCLUÍDA ==\nInseridas ${inserted} entradas (${receitas.entries.length} receitas + ${gastos.entries.length} gastos).`);
