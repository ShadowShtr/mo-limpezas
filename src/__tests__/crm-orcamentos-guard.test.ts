// ============================================================================
// Orçamentos — as invariantes estruturais das actions, da UI e do PDF
// ============================================================================
//
// Análise determinística do código, sem base de dados e sem rede. Não provam
// que uma action funciona — provam que não perdeu as propriedades que a tornam
// segura, e que ninguém as remove sem que apareça no diff.
//
// Cada bloco corresponde a uma exigência escrita do escopo 103-B1, ou a um
// defeito que este repositório já teve.
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { activeCrmView, CRM_VIEWS } from "@/components/crm/crm-nav";

const ROOT = process.cwd();
const ler = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ACTIONS = "src/app/actions/crm-orcamentos.ts";
const UI = "src/app/(dashboard)/dashboard/crm/orcamentos";
const PDF = `${UI}/_components/quote-pdf.ts`;

const CODIGO_ACTIONS = ler(ACTIONS);

/** Tira comentários, para medir o código e não a documentação. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CODIGO = semComentarios(CODIGO_ACTIONS);

function exportacoes(src: string): string[] {
  return [...semComentarios(src).matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
}

/**
 * O corpo de uma função exportada, até à declaração de topo seguinte.
 *
 * O limite inclui as declarações não exportadas — senão os helpers internos do
 * fim do ficheiro colavam-se ao corpo da última action, que passaria a parecer
 * que insere linhas que nunca insere.
 */
function corpoDe(nome: string): string {
  // 🔴 O parêntesis faz parte da busca. Sem ele, `getQuote` casa primeiro com
  //    `getQuotes` (que aparece antes no ficheiro) e o ensaio passa a medir a
  //    função errada — um verde que não prova nada sobre a função pedida.
  const inicio = CODIGO.indexOf(`export async function ${nome}(`);
  if (inicio === -1) throw new Error(`função ${nome} não encontrada`);
  const resto = CODIGO.slice(inicio + 1);
  const fim = resto.search(/\n(export |async function |function |type |const |interface )/);
  return fim === -1 ? resto : resto.slice(0, fim);
}

function ficheirosUi(dir = UI, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) ficheirosUi(rel, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

const ESCRITAS = ["createQuote", "reviseQuote", "setQuoteStatus"];
const LEITURAS = ["getQuotes", "getQuote"];

/** As três RPC da 103, e as únicas por onde a escrita pode passar. */
const RPCS = {
  createQuote: "create_crm_quote_with_items",
  reviseQuote: "revise_crm_quote",
  setQuoteStatus: "set_crm_quote_status",
} as const;

describe("o ficheiro de actions só exporta funções", () => {
  it("🔴 nenhuma exportação de objeto num ficheiro \"use server\"", () => {
    // Um `"use server"` que exporte um objeto compila e rebenta em runtime.
    // Aconteceu a 2026-06-08 e bloqueou todas as notificações do calendário.
    const objetos = [...CODIGO.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)].map((m) => m[1]);
    expect(objetos, `exportações que não são função: ${objetos.join(", ")}`).toEqual([]);
  });

  it("começa com \"use server\"", () => {
    expect(CODIGO_ACTIONS.trimStart().startsWith('"use server"')).toBe(true);
  });

  it("exporta as funções que a interface usa", () => {
    const nomes = exportacoes(CODIGO_ACTIONS);
    for (const esperada of [...ESCRITAS, ...LEITURAS]) {
      expect(nomes, `${esperada} devia ser exportada`).toContain(esperada);
    }
  });
});

describe("🔴 escrita SÓ por RPC — zero escritas directas nas tabelas", () => {
  it("nenhum insert/update/upsert/delete em crm_quotes nem crm_quote_items", () => {
    // O número é escolhido sob `pg_advisory_xact_lock`, e o cabeçalho e as
    // linhas nascem na mesma transação. Uma escrita directa perde as duas
    // garantias: números duplicados e documentos sem linhas.
    for (const tabela of ["crm_quotes", "crm_quote_items"]) {
      const escritas = [
        ...CODIGO.matchAll(
          new RegExp(`\\.from\\("${tabela}"\\)\\s*\\.\\s*(insert|update|upsert|delete)`, "g"),
        ),
      ];
      expect(escritas.length, `${tabela} escrita directamente ${escritas.length}×`).toBe(0);
    }
  });

  it("cada escrita chama a sua RPC, pelo nome exacto", () => {
    for (const [fn, rpc] of Object.entries(RPCS)) {
      expect(corpoDe(fn), `${fn} não chama ${rpc}`).toContain(`.rpc("${rpc}"`);
    }
  });

  it("🔴 nenhuma escrita chama uma RPC que não seja uma das três da 103", () => {
    const chamadas = [...CODIGO.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]);
    expect([...new Set(chamadas)].sort()).toEqual([...Object.values(RPCS)].sort());
  });

  it("as leituras não escrevem nem revalidam", () => {
    // Uma leitura que revalida a meio de um render é o que rebentou a Folha de
    // Pagamento a 2026-07-06.
    for (const fn of LEITURAS) {
      const corpo = corpoDe(fn);
      expect(corpo, `${fn} é leitura e revalida`).not.toContain("invalidateBusinessState");
      expect(corpo, `${fn} é leitura e chama RPC`).not.toContain(".rpc(");
      expect(corpo, `${fn} é leitura e insere`).not.toMatch(/\.insert\(|\.upsert\(/);
      expect(corpo, `${fn} é leitura e actualiza`).not.toMatch(/\.update\(|\.delete\(/);
    }
  });
});

describe("autenticação, papel e empresa", () => {
  it("🔴 toda a action passa pelo guard central com admin/gestor", () => {
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      expect(corpoDe(fn), `${fn} não chama requireProfile`).toContain("requireProfile");
      expect(corpoDe(fn), `${fn} devia exigir admin/gestor`).toContain('roles: ["admin", "gestor"]');
    }
  });

  it("🔴 nenhuma action exportada aceita a empresa como argumento", () => {
    // O admin client faz bypass de RLS: um `companyId` vindo do cliente seria
    // a porta para ler e escrever noutra empresa.
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      const assinatura = corpoDe(fn).split("{")[0];
      expect(assinatura, `${fn} recebe a empresa de fora`).not.toMatch(/company/i);
    }
    expect(CODIGO).toContain("profile.company_id");
  });

  it("🔴 a empresa das RPC vem SEMPRE da sessão", () => {
    // `p_company_id` é o que isola o inquilino dentro da RPC. Um valor vindo
    // do cliente atravessava-o.
    const passagens = [...CODIGO.matchAll(/p_company_id:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(passagens.length).toBe(ESCRITAS.length);
    for (const v of passagens) expect(v).toBe("profile.company_id");
  });

  it("🔴 nenhuma leitura consulta as tabelas sem filtrar a empresa", () => {
    for (const fn of LEITURAS) {
      expect(corpoDe(fn), `${fn} consulta sem filtrar a empresa`).toContain(
        'eq("company_id", profile.company_id)',
      );
    }
  });

  it("só toca nas suas tabelas, nas do funil e nas definições", () => {
    const tabelas = [...new Set([...CODIGO.matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1]))].sort();
    expect(tabelas).toEqual([
      "clients",
      "company_settings",
      "crm_lead_interactions",
      "crm_leads",
      "crm_quote_items",
      "crm_quotes",
    ]);
  });
});

describe("a fronteira com a operação e com o dinheiro", () => {
  it("🔴 orçamentar não escreve em serviços, contratos, faturas nem caixa", () => {
    // Um orçamento NÃO é documento fiscal: não entra em `invoices`, não gera
    // movimento de caixa e não participa no protocolo de período financeiro.
    for (const tabela of [
      "services",
      "contracts",
      "invoices",
      "invoice_items",
      "cash_flow_entries",
      "locations",
      "financial_periods",
    ]) {
      expect(CODIGO, `o CRM não pode tocar em ${tabela}`).not.toContain(`.from("${tabela}")`);
    }
  });

  it("nenhuma action chama revalidatePath à mão", () => {
    // Chamar `revalidatePath` directamente é como se esquece uma rota — foi a
    // causa 9 da auditoria de reversões.
    expect(CODIGO).not.toContain("revalidatePath(");
    expect(CODIGO).toContain("invalidateBusinessState(");
  });

  it("toda a escrita revalida", () => {
    for (const fn of ESCRITAS) {
      expect(corpoDe(fn), `${fn} escreve e não revalida`).toContain("invalidateBusinessState");
    }
  });
});

describe("o formato do resultado", () => {
  it("todas as actions declaram ActionResult", () => {
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      expect(corpoDe(fn), `${fn} não devolve ActionResult`).toContain("ActionResult<");
    }
  });

  it("🔴 o erro cru do Supabase nunca chega ao ecrã", () => {
    // `error.message` expõe nomes de tabelas e restrições a quem não tem nada
    // com isso, e não ajuda o utilizador. O detalhe vai para o log.
    expect(CODIGO).not.toMatch(/error:\s*error\.message/);
    expect(CODIGO).not.toMatch(/actionFailure\([^)]*error\.message/);
    expect(CODIGO).toContain("internalFailure(");
  });

  it("a entrada é validada antes de tocar na base", () => {
    for (const fn of ESCRITAS) {
      expect(corpoDe(fn), `${fn} não valida a entrada`).toMatch(/safeParse|validationFailure/);
    }
  });

  it("🔴 cada sentinela da 103 tem tradução", () => {
    // Uma sentinela sem tradução cai no erro genérico, e o utilizador não
    // percebe o que aconteceu a um documento que estava a tentar mudar.
    const sql = ler("supabase/migrations/103_crm_orcamentos.sql");
    const sentinelas = [
      ...new Set([...sql.matchAll(/RAISE EXCEPTION '(QUOTE_[A-Z_]+)/g)].map((m) => m[1])),
    ];
    expect(sentinelas.length).toBeGreaterThan(5);
    for (const s of sentinelas) {
      expect(CODIGO, `${s} sem tradução nas actions`).toContain(s);
    }
  });

  it("nunca select(\"*\")", () => {
    expect(CODIGO).not.toContain('select("*")');
  });
});

describe("🔴 a lista operacional só traz revisões vivas", () => {
  it("getQuotes filtra superseded_by_id IS NULL POR OMISSÃO", () => {
    // Sem isto, uma cadeia revista aparece duas vezes: com R0 «enviado» e R1
    // «rascunho» (a viva), o filtro «Enviado» contava a R0 — um orçamento que
    // já não está em vigor, a inflar as propostas por responder.
    expect(corpoDe("getQuotes")).toContain('is("superseded_by_id", null)');
  });

  it("🔴 só um `true` explícito desliga o filtro", () => {
    // `!opts?.incluirSubstituidas` daria o mesmo resultado hoje, mas qualquer
    // valor estranho — uma string vazia, um `0` — cairia do lado errado. O
    // default tem de ser o lado seguro.
    expect(corpoDe("getQuotes")).toContain("opts?.incluirSubstituidas !== true");
  });

  it("a página da lista usa o default — não pede histórico", () => {
    const pagina = semComentarios(ler(`${UI}/page.tsx`));
    expect(pagina).toContain("getQuotes()");
    expect(pagina).not.toContain("incluirSubstituidas");
  });

  it("🔴 o filtro é do servidor, não uma escolha do componente", () => {
    // Uma lista que recebe demais e esconde no cliente continua a trazer
    // demais para o browser, e a contar mal em qualquer sítio onde alguém use
    // o comprimento do array.
    const lista = semComentarios(ler(`${UI}/_components/quotes-client.tsx`));
    expect(lista).not.toContain("superseded_by_id");
  });

  it("getQuote(id) continua a abrir qualquer versão, viva ou histórica", () => {
    // A leitura de UM orçamento é por id e não filtra: quem tem o link de uma
    // versão substituída tem de a poder ver. É uma decisão de LISTAGEM, não de
    // retenção — nada se apaga.
    expect(corpoDe("getQuote")).not.toContain("superseded_by_id");
  });

  it("o detalhe continua a avisar quando a versão está substituída", () => {
    const detalhe = semComentarios(ler(`${UI}/_components/quote-detail-sheet.tsx`));
    expect(detalhe).toContain("superseded_by_id");
  });
});

describe("🔴 proveniência — source_lead_id, e não lead_id", () => {
  it("a RPC de criação é quem grava a proveniência", () => {
    const sql = ler("supabase/migrations/103_crm_orcamentos.sql");
    // A 103 passa `p_lead_id` como `source_lead_id` no INSERT.
    expect(sql).toContain("source_lead_id");
    expect(sql).toContain("QUOTE_SOURCE_LEAD_IMMUTABLE");
  });

  it("a leitura por lead filtra pela PROVENIÊNCIA", () => {
    // Depois da conversão (104) `lead_id` fica a NULL. Um filtro por ele
    // deixaria de encontrar o orçamento que fechou o negócio.
    expect(corpoDe("getQuotes")).toContain('eq("source_lead_id", opts.leadId)');
    expect(corpoDe("getQuotes")).not.toContain('eq("lead_id", opts.leadId)');
  });

  it("a linha da lista liga à ficha pela proveniência", () => {
    const lista = semComentarios(ler(`${UI}/_components/quotes-client.tsx`));
    expect(lista).toContain("q.source_lead_id");
  });

  it("source_lead_id viaja na leitura", () => {
    expect(CODIGO).toContain("source_lead_id");
  });
});

describe("🔴 o domínio decimal é fechado no SERVIDOR", () => {
  it("quantidade, preço e desconto passam pelo limite", () => {
    // Uma Server Action é um endpoint: o `<input>` não é um gate. Quem lhe
    // chamar directamente com casas a mais tem de ser recusado antes da RPC.
    expect(CODIGO).toContain("hasMaxDecimalPlaces");
    expect(CODIGO).toContain("itemAceite");
    for (const campo of ["quantity: itemAceite", "unitPrice: itemAceite"]) {
      expect(CODIGO, `${campo} sem limite decimal`).toContain(campo);
    }
    // 🔴 O desconto tem escala PRÓPRIA — `descontoAceite`, 2 casas, porque
    //    `discount_pct` é numeric(5,2). O bloco «o desconto tem escala
    //    própria» mais abaixo é que o verifica; aqui basta que nenhum dos dois
    //    tenha ficado sem validação nenhuma.
    const descontos = [...CODIGO.matchAll(/discountPct:\s*\w+\(/g)];
    expect(descontos.length, "os dois discountPct têm de ser validados").toBe(2);
  });

  it("🔴 nenhum campo numérico do orçamento escapa ao limite", () => {
    // Se alguém acrescentar um `z.number()` solto nestes schemas, aparece aqui.
    const numerosSoltos = [...CODIGO.matchAll(/(quantity|unitPrice|discountPct):\s*z\.number\(/g)];
    expect(numerosSoltos.map((m) => m[1]), "campo sem limite de escala").toEqual([]);
  });

  it("🔴 o limite das linhas é o da COLUNA (2), não o da aritmética (6)", () => {
    // `quantity` e `unit_price` são numeric(10,2). Com seis casas o documento
    // deixava de fechar consigo próprio: 0,335 persiste 0,34 e a linha vale
    // 1,01, quando 3 × 0,34 dá 1,02.
    const lib = ler("src/lib/crm/quotes.ts");
    expect(lib).toContain("QUOTE_ITEM_MAX_DECIMAL_PLACES = 2");
    expect(CODIGO).toContain("QUOTE_ITEM_MAX_DECIMAL_PLACES");
  });

  it("🔴 `hasMaxDecimalPlaces` não tem limite por omissão", () => {
    // O default de 6 foi como as linhas ficaram a aceitar seis casas: quem
    // escreveu `hasMaxDecimalPlaces(v)` julgou estar a validar o domínio.
    const lib = semComentarios(ler("src/lib/crm/quotes.ts"));
    expect(lib).toContain("hasMaxDecimalPlaces(value: number, max: number)");
    expect(lib).not.toMatch(/hasMaxDecimalPlaces\(value: number, max = /);
  });

  it("🔴 rejeita, não arredonda — nenhum arredondamento silencioso na entrada", () => {
    // NO_DATA_LOSS: quem escreve 0,335 não escreveu 0,34. O valor vai para a
    // RPC como foi escrito, ou não vai de todo.
    const criacao = corpoDe("createQuote");
    const revisao = corpoDe("reviseQuote");
    for (const [nome, corpo] of [["createQuote", criacao], ["reviseQuote", revisao]] as const) {
      expect(corpo, `${nome} arredonda a entrada`).not.toMatch(/toFixed\(|Math\.round\(/);
    }
    // As linhas viajam tal como vieram.
    expect(criacao).toContain("unit_price: i.unitPrice");
    expect(criacao).toContain("quantity: i.quantity");
  });

  it("a UI espelha a regra, mas não é ela o gate", () => {
    const formulario = semComentarios(ler(`${UI}/_components/quote-sheet.tsx`));
    expect(formulario).toContain("hasMaxDecimalPlaces");
    expect(formulario).toContain("QUOTE_ITEM_MAX_DECIMAL_PLACES");
    expect(formulario).toContain("foraDeDominio");
    // E não mostra um total que a base não vai confirmar. `invalido` junta as
    // três recusas do servidor: casas a mais nas linhas, casas a mais no
    // desconto, e montante que não cabe em numeric(10,2).
    expect(formulario).toContain("invalido ?");
  });
});

describe("🔴 o desconto tem escala própria (numeric(5,2))", () => {
  it("os dois discountPct usam o limite do desconto, não o das linhas", () => {
    // `decimalAceite` traz 6 casas por omissão — é o domínio das LINHAS. O
    // desconto é `numeric(5,2)` e a RPC calcula com o valor bruto antes de a
    // coluna arredondar: seis casas fariam o documento dizer 3,14 % e os
    // totais valerem 3,141592 %.
    const descontos = [...CODIGO.matchAll(/discountPct:\s*(\w+)\(/g)].map((m) => m[1]);
    expect(descontos).toEqual(["descontoAceite", "descontoAceite"]);
    expect(CODIGO).toContain("QUOTE_DISCOUNT_MAX_DECIMAL_PLACES");
  });

  it("o limite é 2, e a constante existe", () => {
    const lib = ler("src/lib/crm/quotes.ts");
    expect(lib).toContain("QUOTE_DISCOUNT_MAX_DECIMAL_PLACES = 2");
  });

  it("a UI espelha a escala do desconto", () => {
    const formulario = semComentarios(ler(`${UI}/_components/quote-sheet.tsx`));
    expect(formulario).toContain("descontoForaDeDominio");
    expect(formulario).toContain("QUOTE_DISCOUNT_MAX_DECIMAL_PLACES");
  });
});

describe("🔴 os totais têm de caber em numeric(10,2)", () => {
  it("existe a constante do máximo que a coluna guarda", () => {
    const lib = ler("src/lib/crm/quotes.ts");
    expect(lib).toContain("QUOTE_MAX_STORED_AMOUNT = 99_999_999.99");
    expect(lib).toContain("export function excedeMontanteMaximo");
  });

  it("🔴 criação e revisão verificam ANTES de chamar a RPC", () => {
    // O domínio de cada campo isolado não chega: 100 000 × 1 000 000 são ambos
    // aceites e dão 1e11. Sem isto, o Postgres respondia `numeric field
    // overflow` depois de a transação começar.
    for (const fn of ["createQuote", "reviseQuote"]) {
      const corpo = corpoDe(fn);
      const guarda = corpo.indexOf("excedeMontanteMaximo");
      const rpc = corpo.indexOf(".rpc(");
      expect(guarda, `${fn} não verifica o montante`).toBeGreaterThan(-1);
      expect(rpc, `${fn} não chama RPC`).toBeGreaterThan(-1);
      expect(guarda, `${fn}: verificação depois da RPC`).toBeLessThan(rpc);
    }
  });

  it("🔴 a verificação usa a taxa de IVA lida do servidor", () => {
    // Pode ser o IVA a estourar um subtotal que cabia: 99 000 000 cabe,
    // 121 770 000 não. Por isso a conta vem DEPOIS de ler as definições.
    for (const fn of ["createQuote", "reviseQuote"]) {
      const corpo = corpoDe(fn);
      const settings = corpo.indexOf("company_settings");
      const guarda = corpo.indexOf("excedeMontanteMaximo");
      expect(guarda, `${fn}: verifica antes de saber a taxa`).toBeGreaterThan(settings);
      expect(corpo).toContain("vatRate: settings.vat_rate");
    }
  });

  it("a UI espelha o limite e desativa o submit", () => {
    const formulario = semComentarios(ler(`${UI}/_components/quote-sheet.tsx`));
    expect(formulario).toContain("excedeMontanteMaximo");
    expect(formulario).toContain("const invalido =");
    expect(formulario).toContain("disabled={pending || invalido");
  });
});

describe("🔴 a timeline da lead segue a PROVENIÊNCIA", () => {
  it("existe um helper que lê a lead da própria linha", () => {
    expect(CODIGO).toContain("registarEventoDoOrcamentoNaLead");
    expect(CODIGO).toContain('select("source_lead_id, quote_number")');
  });

  it("🔴 revisão e mudança de estado registam na ficha da lead", () => {
    // `audit_logs` não substitui `crm_lead_interactions`: a ficha lê a segunda.
    for (const fn of ["reviseQuote", "setQuoteStatus"]) {
      expect(corpoDe(fn), `${fn} não escreve na timeline`)
        .toContain("registarEventoDoOrcamentoNaLead");
    }
  });

  it("🔴 nunca por lead_id — é `source_lead_id` ou nada", () => {
    // `lead_id` é o destinatário ACTUAL e a conversão (104) põe-no a NULL.
    // Uma timeline construída a partir dele deixava de registar eventos
    // exactamente nos orçamentos que fecharam negócio.
    const helper = CODIGO.slice(CODIGO.indexOf("async function registarEventoDoOrcamentoNaLead"));
    const corpo = helper.slice(0, helper.indexOf("async function registarNaLead"));
    expect(corpo).toContain("source_lead_id");
    expect(corpo).not.toMatch(/(^|[^_])lead_id\s*[,)]/m);
  });

  it("🔴 best-effort: nunca desfaz a operação principal", () => {
    const helper = CODIGO.slice(CODIGO.indexOf("async function registarEventoDoOrcamentoNaLead"));
    const corpo = helper.slice(0, helper.indexOf("async function registarNaLead"));
    expect(corpo).toContain("try {");
    expect(corpo).toContain("catch");
    // Não devolve nada que o chamador possa transformar em falha.
    expect(corpo).toContain("Promise<void>");
  });

  it("a timeline só é escrita DEPOIS de a RPC ter corrido bem", () => {
    for (const fn of ["reviseQuote", "setQuoteStatus"]) {
      const corpo = corpoDe(fn);
      const erro = corpo.indexOf("if (error) return erroDaRpc");
      const timeline = corpo.indexOf("registarEventoDoOrcamentoNaLead");
      expect(erro, `${fn}: sem tratamento de erro da RPC`).toBeGreaterThan(-1);
      expect(timeline, `${fn}: timeline antes de saber se a RPC correu`).toBeGreaterThan(erro);
    }
  });
});

describe("🔴 fora de escopo em 103-B1: email e conversão", () => {
  const ficheiros = [ACTIONS, ...ficheirosUi(), "src/lib/crm/quotes.ts"];

  it("zero referências a email, Resend, outbox ou templates", () => {
    // O envio é a 103-B2, com o seu retry, dedup e prova de entrega. Uma
    // chamada best-effort aqui faria o aviso contar como feito — e um efeito
    // externo que às vezes acontece é pior do que nenhum.
    for (const f of ficheiros) {
      const src = semComentarios(ler(f));
      for (const proibido of [
        "resend",
        "Resend",
        "sendQuoteByEmail",
        "sendEmail",
        "outbox",
        "email-templates",
      ]) {
        expect(src, `${f} refere ${proibido}`).not.toContain(proibido);
      }
    }
  });

  // 🔴 Este ensaio mudou de alvo com a 104-B, e a mudança é deliberada.
  //
  //    Enquanto a conversão não existia, o travão era «nenhum ficheiro de
  //    orçamentos refere a conversão» — servia para impedir que a 104
  //    entrasse por arrasto numa PR que não era dela. A 104-A foi aplicada em
  //    produção e a 104-B entrou pela sua própria porta, com o detalhe do
  //    orçamento aceite como ponto de entrada aprovado.
  //
  //    A fronteira que continua a interessar é outra, e é permanente: a
  //    ACTION de orçamentos não converte ninguém. `crm-orcamentos.ts` trata
  //    do documento; quem cria clientes é `crm-conversao.ts`, pela RPC. E
  //    nenhum dos dois toca em `converted_contract_id`/`converted_service_id`
  //    — esses são da conversão de contrato, que não existe.
  it("🔴 a action de orçamentos não converte, e ninguém finge contrato", () => {
    expect(semComentarios(CODIGO_ACTIONS), "crm-orcamentos.ts refere a conversão")
      .not.toContain("crm-conversao");

    for (const f of ficheiros) {
      const src = semComentarios(ler(f));
      for (const proibido of [
        "converterLeadEmCliente",
        "convertLeadToClient",
        "converted_contract_id",
        "converted_service_id",
      ]) {
        expect(src, `${f} refere ${proibido}`).not.toContain(proibido);
      }
    }
  });

  it("a conversão entra SÓ pelo detalhe do orçamento", () => {
    // O ponto de entrada aprovado é um: o detalhe do orçamento aceite. Se
    // aparecer noutro ficheiro de orçamentos, foi por arrasto.
    const comConversao = ficheirosUi()
      .filter((f) => semComentarios(ler(f)).includes("crm-conversao"));
    expect(comConversao).toEqual([`${UI}/_components/quote-detail-sheet.tsx`]);
  });

  // 🔴 Este ensaio mudou de alvo quando a 104-A chegou, e a mudança é
  //    deliberada.
  //
  //    Enquanto o 103-B1 estava aberto, o travão era «nenhuma migration 104
  //    nesta PR» — a fronteira a proteger era a da UNIDADE DE TRABALHO. Essa
  //    PR fechou e a 104 entrou pela sua própria porta, com a sua autorização.
  //
  //    A fronteira que continua a interessar é outra, e é permanente: o
  //    runtime de orçamentos não chama a conversão. Um orçamento não converte
  //    ninguém — quem converte é a 104-B, a partir da ficha da lead. Manter a
  //    asserção antiga seria manter um teste que já não diz nada sobre o
  //    código que está a proteger.
  it("🔴 o runtime de orçamentos não chama a RPC de conversão", () => {
    for (const f of [ACTIONS, ...ficheirosUi()]) {
      const src = semComentarios(ler(f));
      expect(src, `${f} chama a conversão`).not.toContain("convert_crm_lead_atomic");
    }
  });
});

describe("🔴 o PDF é local e não leva notas internas", () => {
  const CODIGO_PDF = semComentarios(ler(PDF));

  it("internal_notes não aparece no ficheiro do PDF", () => {
    // São notas de trabalho — margem, dúvidas sobre o pagamento. Um PDF com
    // elas entregue a um cliente não se desfaz.
    expect(CODIGO_PDF).not.toContain("internal_notes");
    expect(CODIGO_PDF).not.toContain("internalNotes");
  });

  it("descarrega localmente — sem upload, sem bucket, sem fetch", () => {
    expect(CODIGO_PDF).toContain("doc.save(");
    for (const proibido of ["storage", "createSignedUrl", "upload(", "fetch("]) {
      expect(CODIGO_PDF, `o PDF faz ${proibido}`).not.toContain(proibido);
    }
  });

  it("🔴 usa os valores PERSISTIDOS, e não recalcula nada", () => {
    // Um recálculo no cliente pode divergir do gravado, e então o papel que
    // vai para o cliente diz um total que o sistema não confirma.
    expect(CODIGO_PDF).toContain("quote.total");
    expect(CODIGO_PDF).toContain("quote.vat_amount");
    expect(CODIGO_PDF).toContain("i.line_total");
    expect(CODIGO_PDF).not.toContain("totaisDoOrcamento");
    // Nenhuma multiplicação de quantidade por preço a fingir de total.
    expect(CODIGO_PDF).not.toMatch(/quantity\s*\*\s*/);
  });

  it("jspdf entra por import dinâmico", () => {
    expect(CODIGO_PDF).toContain('await import("jspdf")');
    expect(CODIGO_PDF).toContain('await import("jspdf-autotable")');
  });
});

describe("a interface nunca escreve directamente na base", () => {
  it("🔴 nenhum componente faz mutação nem usa o cliente de browser", () => {
    // O RLS só dá SELECT a `authenticated`: uma escrita pelo browser falharia
    // em silêncio. Foi assim que os membros das equipas não gravavam.
    for (const f of ficheirosUi()) {
      const src = semComentarios(ler(f));
      expect(src, `${f} escreve na base`).not.toMatch(
        /\.from\(["'][^"']+["']\)\s*\.\s*(insert|update|upsert|delete)/,
      );
      expect(src, `${f} usa o cliente de browser do Supabase`).not.toContain("createBrowserClient");
    }
  });

  it("todo o resultado de action é tratado", () => {
    // ~10 chamadas espalhadas ignoravam o resultado e mostravam sucesso falso
    // (auditoria de 2026-07-04).
    for (const f of ficheirosUi()) {
      const src = semComentarios(ler(f));
      const chamadas = [...src.matchAll(/await (createQuote|reviseQuote|setQuoteStatus|getQuote)\(/g)];
      if (chamadas.length === 0) continue;
      expect(src, `${f} chama actions sem verificar res.ok`).toMatch(/res\.ok/);
    }
  });
});

describe("o fluxo que a direcção exige ver", () => {
  const detalhe = semComentarios(ler(`${UI}/_components/quote-detail-sheet.tsx`));
  const formulario = semComentarios(ler(`${UI}/_components/quote-sheet.tsx`));

  it("🔴 rascunho → enviado é MANUAL e está disponível na UI", () => {
    // Sem isto, um orçamento entregue por PDF ficava eternamente «rascunho».
    expect(detalhe).toContain("setQuoteStatus");
    expect(detalhe).toContain("allowedQuoteTransitions");
    expect(detalhe).toContain("Marcar como enviado");
  });

  it("🔴 a revisão passa por revise_crm_quote, e não por texto a dizer que passa", () => {
    expect(formulario).toContain("reviseQuote");
    expect(detalhe).toContain("onRevise");
    expect(detalhe).toContain("canReviseQuote");
  });

  it("🔴 a UI não tenta editar um rascunho in-place", () => {
    // `revise_crm_quote` recusa um rascunho (`QUOTE_DRAFT_EDIT_IN_PLACE`) e
    // não existe RPC atómica para o corrigir. Um UPDATE + DELETE + INSERT em
    // chamadas separadas deixaria o rascunho sem linhas nenhumas se falhasse a
    // meio. Até haver essa RPC, corrige-se anulando e fazendo outro.
    expect(CODIGO_ACTIONS).toContain("DRAFT_EDIT_REQUIRES_ATOMIC_RPC");
    for (const f of ficheirosUi()) {
      const src = semComentarios(ler(f));
      expect(src, `${f} tem uma action de edição de rascunho`).not.toMatch(/updateQuote|editQuote/);
    }
    expect(exportacoes(CODIGO_ACTIONS)).not.toContain("updateQuote");
  });

  it("o formulário não oferece campos que a RPC de revisão ignora", () => {
    // `revise_crm_quote` herda destinatário, tipo, condições e notas internas
    // da versão anterior. Um campo editável cujo conteúdo é descartado em
    // silêncio é pior do que a ausência do campo.
    expect(formulario).toContain("eRevisao");
    expect(formulario).toContain("{!eRevisao && (");
  });
});

describe("a navegação do módulo", () => {
  it("🔴 o CRM tem três vistas, e Orçamentos é uma delas", () => {
    expect(CRM_VIEWS.map((v) => v.href)).toEqual([
      "/dashboard/crm",
      "/dashboard/crm/visitas",
      "/dashboard/crm/orcamentos",
    ]);
  });

  it("cada vista tem rota, etiqueta e ícone", () => {
    for (const v of CRM_VIEWS) {
      expect(v.href.startsWith("/dashboard/crm")).toBe(true);
      expect(v.label).toBeTruthy();
      expect(v.icon).toBeTruthy();
    }
  });

  it("🔴 nenhuma vista aponta para uma rota que não existe", () => {
    // Uma entrada para um ecrã cuja tabela não existe leva a uma página que
    // rebenta na primeira consulta.
    for (const { href, label } of CRM_VIEWS) {
      const rota = href.replace(/^\/dashboard/, "src/app/(dashboard)/dashboard");
      let existe = true;
      try {
        ler(`${rota}/page.tsx`);
      } catch {
        existe = false;
      }
      expect(existe, `«${label}» aponta para ${href}, que não tem page.tsx`).toBe(true);
    }
  });

  it("🔴 a ficha de uma lead acende Pipeline, não Orçamentos", () => {
    // Correspondência mais longa primeiro. Com o prefixo simples,
    // `/dashboard/crm/<uuid>` acenderia duas abas ao mesmo tempo.
    expect(activeCrmView("/dashboard/crm")).toBe("/dashboard/crm");
    expect(activeCrmView("/dashboard/crm/abc-123")).toBe("/dashboard/crm");
    expect(activeCrmView("/dashboard/crm/orcamentos")).toBe("/dashboard/crm/orcamentos");
    expect(activeCrmView("/dashboard/crm/visitas")).toBe("/dashboard/crm/visitas");
    expect(activeCrmView("/dashboard/clientes")).toBeNull();
  });

  it("a barra lateral continua com um item só para o módulo", () => {
    const sidebar = ler("src/components/layout/sidebar.tsx");
    const entradas = [...sidebar.matchAll(/href:\s*"(\/dashboard\/crm[^"]*)"/g)].map((m) => m[1]);
    expect(entradas).toEqual(["/dashboard/crm"]);
  });
});

describe("as constantes vivem fora das actions", () => {
  it("nenhum ficheiro de src/lib/crm é um ficheiro de server actions", () => {
    for (const f of readdirSync(join(ROOT, "src/lib/crm"))) {
      const src = ler(`src/lib/crm/${f}`);
      expect(src, `src/lib/crm/${f} não pode ter "use server"`).not.toMatch(/^\s*"use server"/);
    }
  });
});
