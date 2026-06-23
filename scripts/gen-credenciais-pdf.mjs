// Gera um PDF bonito (1 cartão por pessoa) a partir de CREDENCIAIS_COLABORADORES.local.md
// Uso: node scripts/gen-credenciais-pdf.mjs
import { readFileSync, writeFileSync } from "fs";
import { jsPDF } from "jspdf";

const SRC = "./CREDENCIAIS_COLABORADORES.local.md";
const OUT = "./Credenciais_Colaboradores.pdf";

// ── Ler e parsear a tabela markdown ───────────────────────────────────────────
const lines = readFileSync(SRC, "utf8").split(/\r?\n/);
const rows = [];
for (const l of lines) {
  if (!l.trim().startsWith("|")) continue;
  const cols = l.split("|").map((c) => c.trim());
  // remove vazios das pontas
  const c = cols.filter((_, i) => i !== 0 && i !== cols.length - 1);
  if (c.length < 5) continue;
  const [nome, login, tipo, papel, senha] = c;
  if (nome === "Nome" || nome.startsWith("---")) continue; // cabeçalho/separador
  rows.push({ nome, login, papel, senha: senha.replace(/`/g, "") });
}

// ── PDF ───────────────────────────────────────────────────────────────────────
const doc = new jsPDF({ unit: "mm", format: "a4" });
const PAGE_W = 210, PAGE_H = 297;
const M = 12, GAP = 8;
const COLS = 2;
const CARD_W = (PAGE_W - M * 2 - GAP) / COLS;
const CARD_H = 74;
const ROW_GAP = 7;

const GREEN = [22, 163, 74];
const DARK = [15, 23, 42];
const MUT = [100, 116, 139];

function header() {
  doc.setFillColor(...GREEN);
  doc.rect(0, 0, PAGE_W, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("Mó Limpezas — Acessos das colaboradoras", M, 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.text("Entrega individual. Cada pessoa deve trocar a senha em 'Recuperar password'.", M, 19);
}

function card(x, y, r) {
  // contorno
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, CARD_W, CARD_H, 3, 3, "FD");
  // faixa verde topo
  doc.setFillColor(...GREEN);
  doc.roundedRect(x, y, CARD_W, 10, 3, 3, "F");
  doc.setFillColor(...GREEN);
  doc.rect(x, y + 5, CARD_W, 5, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("ACESSO À APP", x + 5, y + 6.6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.text(r.papel.toUpperCase(), x + CARD_W - 5, y + 6.6, { align: "right" });

  // Nome
  doc.setTextColor(...DARK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(doc.splitTextToSize(r.nome, CARD_W - 10)[0], x + 5, y + 18);

  // Login
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUT);
  doc.text("Utilizador", x + 5, y + 26);
  doc.setTextColor(...DARK);
  doc.setFont("courier", "normal");
  doc.setFontSize(9.5);
  doc.text(doc.splitTextToSize(r.login, CARD_W - 10), x + 5, y + 31);

  // Senha (caixa destacada)
  doc.setDrawColor(...GREEN);
  doc.setFillColor(240, 253, 244);
  doc.roundedRect(x + 5, y + 36, CARD_W - 10, 14, 2, 2, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUT);
  doc.text("Senha", x + 8, y + 41);
  doc.setFont("courier", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...GREEN);
  doc.text(r.senha, x + 8, y + 47.5);

  // Mensagem pronta a copiar
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(...MUT);
  const msg = `Ola ${r.nome.split(" ")[0]}, o teu acesso a app Mo Limpezas — Utilizador: ${r.login} | Senha: ${r.senha}`;
  doc.text(doc.splitTextToSize(msg, CARD_W - 10), x + 5, y + 56);
}

let i = 0;
const perPage = COLS * Math.floor((PAGE_H - 26 - M) / (CARD_H + ROW_GAP));
for (const r of rows) {
  const posInPage = i % perPage;
  if (posInPage === 0) {
    if (i > 0) doc.addPage();
    header();
  }
  const col = posInPage % COLS;
  const rowIdx = Math.floor(posInPage / COLS);
  const x = M + col * (CARD_W + GAP);
  const y = 26 + rowIdx * (CARD_H + ROW_GAP);
  card(x, y, r);
  i++;
}

writeFileSync(OUT, Buffer.from(doc.output("arraybuffer")));
console.log(`PDF gerado: ${OUT} — ${rows.length} cartões.`);
