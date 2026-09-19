// ============================================================================
// CRM — as invariantes estruturais das actions e da navegação
// ============================================================================
//
// Análise determinística do código, sem base de dados e sem rede. Estes testes
// não provam que uma action funciona — provam que não perdeu as propriedades
// que a tornam segura, e que ninguém as remove sem que apareça no diff.
//
// Cada bloco existe por causa de um defeito que este repositório já teve.
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { activeCrmView, CRM_VIEWS } from "@/components/crm/crm-nav";

const ROOT = process.cwd();
const ler = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ACTIONS = "src/app/actions/crm-leads.ts";
const CODIGO_ACTIONS = ler(ACTIONS);

/** Tira comentários, para medir o código e não a documentação. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CODIGO = semComentarios(CODIGO_ACTIONS);

/** As funções exportadas do ficheiro de actions. */
function exportacoes(src: string): string[] {
  return [...semComentarios(src).matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
}

/**
 * O corpo de uma função exportada, até à declaração de topo seguinte.
 *
 * 🔴 O limite tem de incluir as declarações **não** exportadas. A primeira
 *    versão parava só em `\nexport `, e por isso colava os helpers internos do
 *    fim do ficheiro ao corpo da última action — que passava a parecer que
 *    inseria linhas que nunca insere.
 */
function corpoDe(nome: string): string {
  const src = CODIGO;
  const inicio = src.indexOf(`export async function ${nome}`);
  if (inicio === -1) throw new Error(`função ${nome} não encontrada`);
  const resto = src.slice(inicio + 1);
  const fim = resto.search(/\n(export |async function |function |type |const |interface )/);
  return fim === -1 ? resto : resto.slice(0, fim);
}

const ESCRITAS = ["createLead", "updateLead", "moveLeadStage", "reorderLeads", "addLeadInteraction", "archiveLead"];
const LEITURAS = ["getLeads", "getLead"];

describe("CRM — o ficheiro de actions só exporta funções", () => {
  it("🔴 nenhuma exportação de objeto num ficheiro \"use server\"", () => {
    // Um `"use server"` que exporte um objeto compila e rebenta em runtime.
    // Aconteceu a 2026-06-08 com CANCEL_TYPE_LABELS e bloqueou todas as
    // notificações do calendário. As constantes do CRM vivem em src/lib/crm/.
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

describe("CRM — autenticação e empresa", () => {
  it("🔴 toda a action passa pelo guard central", () => {
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      expect(corpoDe(fn), `${fn} não chama requireProfile`).toContain("requireProfile");
    }
  });

  it("🔴 nenhuma escrita aceita o papel de colaboradora", () => {
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      expect(
        corpoDe(fn),
        `${fn} devia exigir admin/gestor`,
      ).toContain('roles: ["admin", "gestor"]');
    }
  });

  it("🔴 nenhuma action exportada aceita a empresa como argumento", () => {
    // O admin client faz bypass de RLS: um `companyId` vindo do cliente seria
    // a porta para ler e escrever noutra empresa. Mede-se a assinatura das
    // funções exportadas — um helper interno pode receber a empresa que a
    // própria action já resolveu a partir da sessão, e isso é seguro.
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      const assinatura = corpoDe(fn).split("{")[0];
      expect(assinatura, `${fn} recebe a empresa de fora`).not.toMatch(/company/i);
    }
    expect(CODIGO).toContain("profile.company_id");
  });

  it("🔴 nenhuma query lê ou altera o CRM sem filtrar a empresa", () => {
    // Uma query ao admin client sem este filtro alcança todas as empresas.
    // Um `insert` é a excepção legítima: não filtra, carimba — e o carimbo
    // vem da sessão, o que o teste seguinte verifica.
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      const corpo = corpoDe(fn);
      if (!corpo.includes('.from("crm_')) continue;
      const soInsere = /\.from\("crm_\w+"\)\s*\.insert\(/.test(corpo)
        && !/\.(select|update|delete)\(/.test(corpo.split(".insert(")[0].split('.from("crm_')[1] ?? "");
      if (soInsere && !corpo.includes(".update(") && !corpo.includes(".maybeSingle()")) continue;
      expect(corpo, `${fn} consulta o CRM sem filtrar a empresa`).toContain(
        'eq("company_id", profile.company_id)',
      );
    }
  });

  it("🔴 toda a inserção carimba a empresa da sessão", () => {
    // O que o filtro faz na leitura, o carimbo faz na escrita: sem ele, a
    // linha nasceria sem dono ou com o dono errado.
    for (const fn of ESCRITAS) {
      const corpo = corpoDe(fn);
      if (!corpo.includes(".insert(")) continue;
      expect(corpo, `${fn} insere sem carimbar a empresa`).toContain(
        "company_id: profile.company_id",
      );
    }
  });
});

describe("CRM — o formato do resultado", () => {
  it("todas as actions declaram ActionResult", () => {
    for (const fn of [...ESCRITAS, ...LEITURAS]) {
      expect(corpoDe(fn), `${fn} não devolve ActionResult`).toContain("ActionResult<");
    }
  });

  it("🔴 o erro cru do Supabase nunca chega ao ecrã", () => {
    // `error.message` do Supabase expõe nomes de tabelas e restrições a quem
    // não tem nada com isso, e não ajuda o utilizador. O detalhe vai para o
    // log, por `internalFailure`.
    expect(CODIGO).not.toMatch(/error:\s*error\.message/);
    expect(CODIGO).not.toMatch(/actionFailure\([^)]*error\.message/);
    expect(CODIGO).toContain("internalFailure(");
  });

  it("a entrada é validada antes de tocar na base", () => {
    for (const fn of ESCRITAS) {
      if (fn === "archiveLead") continue; // só recebe um id, validado pela query
      expect(corpoDe(fn), `${fn} não valida a entrada`).toMatch(/safeParse|validationFailure/);
    }
  });
});

describe("CRM — a fronteira com a operação e com o dinheiro", () => {
  it("🔴 o CRM não escreve em serviços, contratos, faturas nem caixa", () => {
    // Esta é a fronteira que mantém o módulo fora do orçamento de escrita
    // financeira, e que impede uma lead de criar trabalho a fingir. A 086 já
    // rejeitou por escrito a ideia de representar dinheiro com um `services`
    // fictício; vale aqui sem alteração.
    for (const tabela of ["services", "contracts", "invoices", "cash_flow_entries", "invoice_items"]) {
      expect(CODIGO, `o CRM não pode escrever em ${tabela}`).not.toContain(`.from("${tabela}")`);
    }
  });

  it("só toca nas suas tabelas e lê `profiles` para os nomes", () => {
    const tabelas = [...new Set([...CODIGO.matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1]))].sort();
    expect(tabelas).toEqual(["crm_lead_interactions", "crm_leads", "profiles"]);
  });
});

describe("CRM — a revalidação passa pelo helper central", () => {
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

  it("nenhuma leitura escreve nem revalida", () => {
    // Uma leitura que revalida a meio de um render é o que rebentou a Folha de
    // Pagamento em 2026-07-06.
    for (const fn of LEITURAS) {
      const corpo = corpoDe(fn);
      expect(corpo, `${fn} é leitura e revalida`).not.toContain("invalidateBusinessState");
      expect(corpo, `${fn} é leitura e insere`).not.toMatch(/\.insert\(|\.upsert\(/);
      expect(corpo, `${fn} é leitura e actualiza`).not.toMatch(/\.update\(|\.delete\(/);
    }
  });
});

describe("CRM — as queries são explícitas", () => {
  it("🔴 nunca select(\"*\")", () => {
    // Uma coluna nova passaria a viajar para o cliente sem ninguém decidir que
    // devia.
    expect(CODIGO).not.toContain('select("*")');
  });
});

describe("CRM — as constantes vivem fora das actions", () => {
  const ficheirosLib = readdirSync(join(ROOT, "src/lib/crm"));

  it("há um módulo de constantes, e não tem \"use server\"", () => {
    expect(ficheirosLib.length).toBeGreaterThan(0);
    for (const f of ficheirosLib) {
      const src = ler(`src/lib/crm/${f}`);
      expect(src, `src/lib/crm/${f} não pode ser um ficheiro de server actions`)
        .not.toMatch(/^\s*"use server"/);
    }
  });
});

describe("CRM — a navegação do módulo", () => {
  it("cada vista tem rota, etiqueta e ícone", () => {
    for (const v of CRM_VIEWS) {
      expect(v.href.startsWith("/dashboard/crm")).toBe(true);
      expect(v.label).toBeTruthy();
      expect(v.icon).toBeTruthy();
    }
  });

  it("a vista activa é a correspondência mais longa", () => {
    // Com rotas aninhadas, `/dashboard/crm` casaria com tudo o que vem abaixo
    // e duas abas ficariam acesas ao mesmo tempo.
    expect(activeCrmView("/dashboard/crm")).toBe("/dashboard/crm");
    expect(activeCrmView("/dashboard/crm/abc-123")).toBe("/dashboard/crm");
    expect(activeCrmView("/dashboard/clientes")).toBeNull();
  });

  it("a barra lateral ganha um item só, e é o do módulo", () => {
    const sidebar = ler("src/components/layout/sidebar.tsx");
    const entradas = [...sidebar.matchAll(/href:\s*"(\/dashboard\/crm[^"]*)"/g)].map((m) => m[1]);
    expect(entradas).toEqual(["/dashboard/crm"]);
  });

  // 🔴 O defeito que este bloco trava.
  //
  //    Na branch ampla, esta navegação nascia com três entradas — Pipeline,
  //    Visitas e Orçamentos — porque lá as quatro migrations existiam. Trazida
  //    para aqui tal e qual, dava duas abas a apontar para ecrãs cujas tabelas
  //    (`crm_visits`, `crm_quotes`) NÃO existem em produção: um clique, e a
  //    página rebenta na primeira consulta.
  //
  //    A regra não é «só uma vista». É: uma vista só entra quando a rota dela
  //    existe no repositório. Assim, quando a 102 trouxer a página de Visitas,
  //    a entrada pode entrar na mesma PR — e nunca antes dela.
  it("🔴 nenhuma vista aponta para uma rota que não existe", () => {
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
});

describe("CRM — a interface nunca escreve directamente na base", () => {
  const UI = "src/app/(dashboard)/dashboard/crm";

  function ficheirosUi(dir = UI, acc: string[] = []): string[] {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) ficheirosUi(rel, acc);
      else if (/\.tsx?$/.test(e.name)) acc.push(rel);
    }
    return acc;
  }

  it("🔴 nenhum componente do CRM faz mutação na base", () => {
    // O RLS só dá SELECT a `authenticated`: uma escrita pelo browser falharia
    // em silêncio. Foi assim que os membros das equipas não gravavam, em 2026-06-08.
    for (const f of ficheirosUi()) {
      const src = semComentarios(ler(f));
      expect(src, `${f} escreve na base`).not.toMatch(/\.from\(["'][^"']+["']\)\s*\.\s*(insert|update|upsert|delete)/);
      expect(src, `${f} usa o cliente de browser do Supabase`).not.toContain("createBrowserClient");
    }
  });

  it("todo o resultado de action é tratado", () => {
    // ~10 chamadas espalhadas ignoravam o resultado da action e mostravam
    // sucesso falso (auditoria de 2026-07-04).
    for (const f of ficheirosUi()) {
      const src = semComentarios(ler(f));
      const chamadas = [...src.matchAll(/await (createLead|updateLead|moveLeadStage|archiveLead|addLeadInteraction|reorderLeads)\(/g)];
      if (chamadas.length === 0) continue;
      expect(src, `${f} chama actions sem verificar res.ok`).toContain("res.ok");
    }
  });
});
