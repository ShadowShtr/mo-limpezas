// ============================================================================
// PAGAMENTOS — categoria nos modais e menu de ações que não empurra a tabela
// ============================================================================
//
// Duas coisas que o utilizador viu no ecrã:
//
//   1. «Novo pagamento fixo» não mostrava Categoria, apesar de a coluna
//      `expense_category_id` existir em produção e de haver 14 categorias
//      no catálogo. O armazenamento estava lá; faltava o caminho até ele.
//
//   2. Clicar nos «⋯» fazia aparecer uma barra de rolagem horizontal e, nas
//      últimas linhas, cortava o menu. O menu era `absolute` dentro do
//      `TableWrap`, que tem `overflow-x-auto`: abri-lo aumentava o conteúdo
//      do contentor.
//
// 🔴 Nada disto exigiu migration. A coluna já existia — os tipos locais é que
//    estavam desatualizados e diziam que não. Verificar contra a base em vez
//    de acreditar no ficheiro de tipos foi o que evitou uma migration inútil.
// ============================================================================
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const CLIENTE = "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx";
const PAGINA = "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx";
const ACTIONS = "src/app/actions/payments.ts";
const TIPOS = "src/types/database.ts";
const PRIMITIVES = "src/components/financeiro/v2/primitives.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// Categoria
// ═══════════════════════════════════════════════════════════════════════════

describe("categoria nos pagamentos", () => {
  it("1. o tipo da tabela conhece a coluna que a produção tem", () => {
    // Os tipos diziam que a coluna não existia. Diziam mal.
    const t = ler(TIPOS);
    const i = t.indexOf("fixed_variable_payments: {");
    const bloco = t.slice(i, i + 3000);
    for (const seccao of ["Row:", "Insert:", "Update:"]) {
      const linha = bloco.split("\n").find((l) => l.includes(seccao));
      expect(linha, seccao).toContain("expense_category_id");
    }
  });

  it("2. a leitura traz a categoria", () => {
    expect(ler(ACTIONS)).toMatch(/const COLS = "[^"]*expense_category_id/);
  });

  it("3. criar aceita e grava a categoria", () => {
    const a = ler(ACTIONS);
    const i = a.indexOf("export async function createPayment");
    const corpo = a.slice(i, a.indexOf("\n}\n", i));
    expect(corpo).toMatch(/expense_category_id: input\.expense_category_id/);
  });

  it("4. editar aceita a categoria", () => {
    const a = ler(ACTIONS);
    const i = a.indexOf("export async function updatePayment");
    const assinatura = a.slice(i, i + 500);
    expect(assinatura).toMatch(/expense_category_id\?: string \| null/);
  });

  it("5. 🔴 os quatro modais partilham o mesmo formulário, logo o mesmo campo", () => {
    // Fixo e variável, criar e editar, são o mesmo `form` com `kind` diferente.
    // Um campo no formulário cobre os quatro; duas implementações separadas é
    // que dariam divergência.
    const c = ler(CLIENTE);
    expect(c).toMatch(/<Field label="Categoria">/);
    expect(c).toMatch(/expense_category_id: string;/);      // estado do formulário
    expect(c).toMatch(/emptyForm|expense_category_id: ""/); // criar começa vazio
    expect(c).toMatch(/expense_category_id: p\.expense_category_id \?\? ""/); // editar carrega
  });

  it("6. sem categoria continua a ser uma escolha válida", () => {
    const c = ler(CLIENTE);
    expect(c).toMatch(/— sem categoria —/);
    // Vazio vira `null`, não uma categoria inventada.
    expect(c).toMatch(/expense_category_id = form\.expense_category_id === "" \? null/);
  });

  it("7. a categoria vai para as duas actions de escrita", () => {
    // O regex tem de atravessar parênteses: a chamada leva um
    // `form.description.trim()` pelo meio, e um `[^)]*` parava aí.
    const c = ler(CLIENTE);
    const i = c.indexOf("function handleSubmit");
    const corpo = c.slice(i, i + 1800);

    expect(corpo).toMatch(/updatePayment\([\s\S]*?expense_category_id/);
    expect(corpo).toMatch(/createPayment\(\{[\s\S]*?expense_category_id/);
  });

  it("8. o catálogo é reutilizado, não recriado", () => {
    // Já existe `expense_categories` com 14 linhas e uma action que a lê.
    // Uma segunda lista de categorias seria uma taxonomia paralela.
    const p = ler(PAGINA);
    expect(p).toMatch(/getExpenseCategoryCatalog/);
    const c = ler(CLIENTE);
    expect(c).not.toMatch(/const CATEGORIAS\s*=\s*\[/);
    expect(c).not.toMatch(/enum .*Categoria/);
  });

  it("9. o catálogo indisponível não impede registar um pagamento", () => {
    const p = ler(PAGINA);
    expect(p).toMatch(/catalogo\.ok && catalogo\.catalog\.available/);
    expect(p).toMatch(/:\s*\[\]/);
  });

  it("10. 🔴 a categoria não toca na competência", () => {
    // A regra da #77 continua a ser o vencimento, e só ele.
    const a = ler(ACTIONS);
    const i = a.indexOf("export async function createPayment");
    const corpo = a.slice(i, a.indexOf("\n}\n", i));
    expect(corpo).toMatch(/resolveCompetence\(\{[\s\S]*?dueDate: input\.due_date/);
    // A competência nunca é derivada da categoria.
    expect(corpo).toMatch(/p_period_year:\s*competencia\.year/);
    expect(corpo).toMatch(/p_period_month:\s*competencia\.month/);
    expect(corpo).not.toMatch(/p_period_(year|month):\s*[^,\n]*category/i);
  });

  it("11. a etiqueta da categoria não cria uma coluna nova", () => {
    // Uma coluna a mais empurrava a tabela para o scroll horizontal — o mesmo
    // problema que o menu tinha.
    const c = ler(CLIENTE);
    expect(c).toMatch(/nomePorCategoria\.get\(p\.expense_category_id\)/);
    const cabecalhos = (c.match(/<th\b/g) ?? []).length;
    const th = (c.match(/<Th\b/g) ?? []).length;
    expect(cabecalhos + th, "não se acrescentou cabeçalho de coluna").toBeLessThan(40);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Menu de ações
// ═══════════════════════════════════════════════════════════════════════════

describe("menu de ações das linhas", () => {
  const src = () => ler(PRIMITIVES);

  it("12. 🔴 o menu é desenhado fora do contentor que faz scroll", () => {
    const s = src();
    expect(s).toMatch(/createPortal\(/);
    expect(s).toMatch(/document\.body/);
  });

  it("13. 🔴 deixou de ser posicionado por `absolute` dentro da linha", () => {
    // Era isto que aumentava o conteúdo do `TableWrap` e fazia nascer a barra
    // de rolagem horizontal.
    const s = src();
    const i = s.indexOf("export function RowMenu");
    const corpo = s.slice(i, s.indexOf("\n}\n", i));
    expect(corpo).not.toMatch(/className="[^"]*\babsolute\b[^"]*"/);
    expect(corpo).toMatch(/position: "fixed"/);
  });

  it("14. o contentor da tabela mantém o seu scroll horizontal", () => {
    // A correção não pode ser `overflow: visible` — em ecrãs estreitos a
    // tabela precisa mesmo de rolar.
    const s = src();
    const i = s.indexOf("export function TableWrap");
    expect(s.slice(i, i + 300)).toMatch(/overflow-x-auto/);
  });

  it("15. 🔴 vira para cima quando não há espaço em baixo", () => {
    // O caso da última linha da tabela.
    const s = src();
    expect(s).toMatch(/cabeEmBaixo/);
    expect(s).toMatch(/window\.innerHeight/);
  });

  it("16. encosta-se à margem quando não há espaço à direita", () => {
    expect(src()).toMatch(/window\.innerWidth/);
  });

  it("17. fecha ao rolar, em vez de flutuar longe da linha", () => {
    const s = src();
    expect(s).toMatch(/aoRolar/);
    expect(s).toMatch(/addEventListener\("scroll"/);
  });

  it("18. Editar, Marcar e Eliminar continuam todos lá", () => {
    // Recolher não é remover.
    const c = ler(CLIENTE);
    const i = c.indexOf("<RowMenu");
    const bloco = c.slice(i, i + 900);
    expect(bloco).toMatch(/"Editar"/);
    expect(bloco).toMatch(/Marcar como pago|Marcar por pagar/);
    expect(bloco).toMatch(/"Eliminar"/);
  });

  it("19. eliminar continua a pedir confirmação", () => {
    // Cancelar a confirmação não pode escrever nada.
    const c = ler(CLIENTE);
    const i = c.indexOf("function handleDelete");
    const corpo = c.slice(i, i + 400);
    expect(corpo).toMatch(/confirm\(/);
    expect(corpo).toMatch(/if \(!confirm[^)]*\)\) return;/);
  });
});
