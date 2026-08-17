// ============================================================================
// Do card «Prédios» do Financeiro até à edição, num clique
// ============================================================================
//
// Os 146 prédios importados dos PDFs de rota ficaram com a avença por
// preencher de propósito — a folha de valores não deu para casar com
// confiança, e adivinhar valores em produção não era opção.
//
// Corrigi-los um a um só é viável se o caminho for curto. Este é o teste desse
// caminho: o card do Financeiro liga a `Clientes > Prédios` com o prédio já
// aberto em edição, em vez de despejar a pessoa numa lista de 146 para
// procurar aquele que acabou de clicar.
//
// ---------------------------------------------------------------------------
// 🔴 O que estes testes são e não são
// ---------------------------------------------------------------------------
// São leitura da fonte e do href gerado. Não montam React nem clicam em nada —
// não há ambiente de DOM configurado neste projecto. Provam que o link certo é
// construído e que as três peças estão ligadas; não provam o clique.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hrefEditarPredio } from "@/components/financeiro/v2/finance-buildings-card";

const RAIZ = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

const CARD = "src/components/financeiro/v2/finance-buildings-card.tsx";
const PAGE = "src/app/(dashboard)/dashboard/clientes/page.tsx";
const TABS = "src/app/(dashboard)/dashboard/clientes/_components/clientes-tabs.tsx";
const TABELA = "src/app/(dashboard)/dashboard/clientes/_components/predios-table.tsx";
const ACTIONS = "src/app/actions/building-cards.ts";

// ─── 1. O destino ────────────────────────────────────────────────────────────

describe("o link que o card do Financeiro gera", () => {
  it("leva à aba Prédios, com o prédio identificado", () => {
    expect(hrefEditarPredio("abc-123")).toBe(
      "/dashboard/clientes?tab=predios&predio=abc-123",
    );
  });

  it("🔴 escapa o id em vez de o colar no URL", () => {
    // Um id vem da base e não devia ter caracteres estranhos — mas colá-lo em
    // cru é a suposição, não o facto. Um `&` partia o resto dos parâmetros.
    expect(hrefEditarPredio("a&tab=clientes")).toBe(
      "/dashboard/clientes?tab=predios&predio=a%26tab%3Dclientes",
    );
  });

  it("não aponta para uma área nova", () => {
    // Editar prédios já existe em `Clientes > Prédios`. Um segundo formulário
    // para a mesma tabela diverge: um ganha um campo, o outro não.
    expect(hrefEditarPredio("x")).toMatch(/^\/dashboard\/clientes\?/);
  });
});

// ─── 2. O card usa mesmo o link ──────────────────────────────────────────────

describe("o card «Prédios» é clicável, e de forma visível", () => {
  const fonte = ler(CARD);

  it("a linha inteira é o alvo — nome, morada e valor", () => {
    // Um link só no nome obriga a acertar num texto de 12px, e o valor — que é
    // o que a pessoa vem cá corrigir — não seria clicável de todo.
    expect(fonte).toMatch(/<Link[\s\S]{0,200}href=\{hrefEditarPredio\(l\.id\)\}/);
    const linha = fonte.slice(fonte.indexOf("href={hrefEditarPredio(l.id)}"));
    const fim = linha.indexOf("</Link>");
    expect(linha.slice(0, fim)).toContain("{l.nome}");
    expect(linha.slice(0, fim)).toContain("l.morada");
    expect(linha.slice(0, fim)).toContain("fmtEur(l.valor)");
  });

  it("🔴 há uma afordância visível, não só um hover", () => {
    // O contraste do hover não diz que a linha leva a algum lado. Quem não
    // passa o rato por cima nunca descobre que podia clicar.
    expect(fonte).toContain("Editar");
    expect(fonte).toMatch(/<Pencil/);
  });

  it("é alcançável por teclado com foco visível", () => {
    expect(fonte).toMatch(/focus-visible:ring/);
  });

  it("🔴 `null` continua «Sem valor», nunca «0,00 €»", () => {
    expect(fonte).toContain('l.valor === null ? "Sem valor" : fmtEur(l.valor)');
  });

  it("o card mantém o seu próprio scroll", () => {
    // São 146 linhas. Sem isto o card cresce e empurra o Resumo para fora do
    // ecrã — a propriedade de que a referência aprovada mais depende.
    expect(fonte).toMatch(/overflow-y-auto/);
    expect(fonte).toMatch(/maxHeight:\s*\d+/);
  });

  it("usa tokens do sistema que existem mesmo", () => {
    // Escrevi `--finance-violet` e `--finance-hover` à primeira. Nenhum dos
    // dois existe: a cor simplesmente não aparecia, sem erro nenhum.
    const css = ler("src/app/globals.css");
    for (const token of fonte.match(/--finance-[a-z0-9-]+/g) ?? []) {
      expect(css, `${token} não está definido`).toContain(`${token}:`);
    }
  });
});

// ─── 3. O outro lado recebe ──────────────────────────────────────────────────

describe("Clientes abre onde o link mandou", () => {
  it("a página lê tab e predio do URL", () => {
    const fonte = ler(PAGE);
    expect(fonte).toMatch(/searchParams:\s*Promise<\{[^}]*tab\?:\s*string/);
    expect(fonte).toMatch(/params\.tab === "predios" \? "predios" : "clientes"/);
  });

  it("🔴 um prédio que não existe não abre formulário nenhum", () => {
    // Um id velho num favorito não deve dar erro a quem clica: a aba abre na
    // mesma, sem formulário.
    expect(ler(PAGE)).toMatch(/buildingCards\.some\(\(c\) => c\.id === params\.predio\)/);
  });

  it("a aba inicial vem de fora, e não é sempre «Clientes»", () => {
    const fonte = ler(TABS);
    expect(fonte).toMatch(/initialTab\?:\s*"clientes"\s*\|\s*"predios"/);
    expect(fonte).toMatch(/useState<"clientes" \| "predios">\(initialTab\)/);
    expect(fonte).toContain("initialEditId={initialEditBuildingId}");
  });

  it("a tabela abre a edição do prédio recebido", () => {
    const fonte = ler(TABELA);
    expect(fonte).toMatch(/initialEditId\?:\s*string \| null/);
    expect(fonte).toMatch(/openEditForm\(alvo\)/);
  });

  it("🔴 e abre-o uma vez só", () => {
    // Sem a guarda por id, fechar o formulário e o efeito voltar a correr
    // reabria-o — e «Cancelar» deixava de ter efeito, sem erro a explicar.
    const fonte = ler(TABELA);
    expect(fonte).toMatch(/abertoPara\.current === initialEditId/);
    expect(fonte).toMatch(/abertoPara\.current = initialEditId/);
  });

  it("o formulário tem o campo da avença, que é a razão de tudo isto", () => {
    const fonte = ler(TABELA);
    expect(fonte).toMatch(/monthlyValue: valorMensal/);
    expect(fonte).toContain('bruto === "" ? null : Number(bruto)');
  });

  it("🔴 a tabela mostra a avença, e um vazio não vira zero", () => {
    const fonte = ler(TABELA);
    expect(fonte).toContain(">Avença<");
    expect(fonte).toMatch(/monthly_value === null \|\| card\.monthly_value === undefined/);
    expect(fonte).toContain("Sem valor");
  });
});

// ─── 4. Gravar tem de aparecer do outro lado ─────────────────────────────────

describe("gravar um prédio actualiza as duas páginas", () => {
  const fonte = ler(ACTIONS);

  it("🔴 criar e editar revalidam Clientes e Financeiro", () => {
    // O card dos Prédios vive dentro de `/dashboard/financeiro`. Sem revalidar
    // essa rota, a pessoa corrige o valor, volta atrás e vê o número antigo —
    // e a conclusão natural é que a gravação não funcionou.
    for (const nome of ["export async function createBuildingCard", "export async function updateBuildingCard"]) {
      const i = fonte.indexOf(nome);
      expect(i, `${nome} não encontrada`).toBeGreaterThan(-1);
      const corpo = fonte.slice(i, i + 2500);
      expect(corpo, `${nome} sem revalidar clientes`).toContain('revalidatePath("/dashboard/clientes")');
      expect(corpo, `${nome} sem revalidar financeiro`).toContain('revalidatePath("/dashboard/financeiro")');
    }
  });

  it("o valor gravado é o validado, não o texto cru", () => {
    expect(fonte).toMatch(/avenca(Normalizada)?\.valor|avencaNormalizada/);
  });
});

// ─── 5. 🔴 E continuam fora dos KPIs ─────────────────────────────────────────

describe("🔴 os prédios não entram nos números principais", () => {
  it("calcularKpis não recebe prédios sequer", () => {
    // Enquanto 146 dos 146 estiverem sem avença, somá-los daria um total que
    // parece faturação e não é — e ninguém saberia que faltava lá quase tudo.
    //
    // A garantia é estrutural, não uma regra que alguém tem de lembrar: a
    // função não tem por onde os receber.
    const motor = ler("src/domain/finance-v2/aggregate.ts");
    const assinatura = motor.slice(
      motor.indexOf("export function calcularKpis("),
      motor.indexOf("): FinanceKpis {"),
    );
    expect(assinatura).not.toMatch(/predio|building/i);
  });

  it("o card diz em voz alta que está fora dos KPIs", () => {
    const painel = ler("src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx");
    expect(painel).toMatch(/Nenhum valor deste card entra nos KPIs/);
  });

  it("o total do card é `null` quando nenhum valor é conhecido", () => {
    // `totalConhecido: null` → «Total indisponível». Um zero ali diria que os
    // 146 prédios rendem zero.
    const fonte = ler(CARD);
    expect(fonte).toContain("d.totalConhecido === null");
    expect(fonte).toContain("Total indisponível");
  });
});

// ─── 6. O formulário de edição diz o que é cada campo ────────────────────────

describe("🔴 o formulário identifica os campos fora da caixa", () => {
  const fonte = ler(TABELA);

  it("cada campo tem etiqueta própria, não um placeholder por rótulo", () => {
    // Um placeholder desaparece à primeira tecla. A seguir ficavam seis caixas
    // brancas iguais — «Moçambique 27», «Rua de Moçambique n.27», «2ª feira»,
    // «Equipa 13», «Geral 1x semana» — e nenhuma a dizer o que era.
    for (const etiqueta of ["Nome do prédio", "Morada", "Avença mensal", "Dia da semana", "Equipa", "Notas"]) {
      expect(fonte, `${etiqueta} sem etiqueta`).toContain(`etiqueta="${etiqueta}"`);
    }
    // A etiqueta vive num `<label>`, e não num texto solto ao lado.
    expect(fonte).toMatch(/<label className="block">/);
  });

  it("🔴 o rótulo da avença não desaparece ao escrever o valor", () => {
    // Era o pior caso: o único campo normalmente vazio, logo o único cujo
    // rótulo se via — e sumia no instante em que se começava a escrever.
    const campo = fonte.slice(fonte.indexOf('etiqueta="Avença mensal"'));
    expect(campo.slice(0, campo.indexOf("</Campo>"))).toMatch(/placeholder="0,00"/);
    expect(fonte).not.toMatch(/placeholder="Avença mensal/);
  });

  it("o campo da avença mostra o € e diz que vazio não é zero", () => {
    expect(fonte).toContain("Vazio não é zero");
    const campo = fonte.slice(fonte.indexOf('etiqueta="Avença mensal"'));
    expect(campo.slice(0, campo.indexOf("</Campo>"))).toContain("€");
  });

  it("🔴 o dia desativado explica-se em vez de ficar só cinzento", () => {
    // Um campo desativado sem explicação lê-se como avaria.
    expect(fonte).toMatch(/Para mudar de dia, arraste o cartão/);
  });

  it("a edição diz qual prédio está aberto", () => {
    // Com a lista logo por baixo e 146 linhas quase iguais, «Editar prédio»
    // sozinho não chega.
    expect(fonte).toMatch(/editingId && form\.name\.trim\(\)/);
  });

  it("🔴 reaberto pelo link, o foco vai para a avença", () => {
    // É o campo que se vem cá preencher. Vindo do Financeiro, o nome já está
    // certo — pôr o cursor lá obrigava a um clique extra por cada prédio.
    const campo = fonte.slice(fonte.indexOf('etiqueta="Avença mensal"'));
    expect(campo.slice(0, campo.indexOf("</Campo>"))).toContain("autoFocus={!!editingId}");
    expect(fonte).toContain("autoFocus={!editingId}");
  });

  it("dá para fechar e gravar sem ir buscar o rato", () => {
    expect(fonte).toMatch(/e\.key === "Escape"/);
    expect(fonte).toMatch(/e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)/);
    expect(fonte).toContain("Esc para fechar · Ctrl+Enter para guardar");
  });

  it("o erro é anunciado, não só pintado de vermelho", () => {
    expect(fonte).toMatch(/role="alert"/);
  });
});
