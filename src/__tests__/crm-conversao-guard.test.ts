// ============================================================================
// A conversão — invariantes estruturais
// ============================================================================
//
// Análise determinística do código, sem base de dados e sem rede. Não provam
// que a action funciona — provam que não perdeu as propriedades que a tornam
// segura, e que ninguém as remove sem que apareça no diff.
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ler = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ACTION = "src/app/actions/crm-conversao.ts";
const CODIGO_ACTION = ler(ACTION);

function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CODIGO = semComentarios(CODIGO_ACTION);

/** As cinco tabelas que a conversão toca — e que só a RPC pode tocar. */
const TABELAS_DA_CONVERSAO = [
  "crm_leads", "crm_quotes", "clients", "locations", "crm_lead_interactions",
];

describe("o ficheiro de action", () => {
  it("começa com \"use server\" e só exporta funções", () => {
    // Um `"use server"` que exporte um objeto compila e rebenta em runtime —
    // aconteceu a 2026-06-08 e bloqueou as notificações do calendário.
    expect(CODIGO_ACTION.trimStart().startsWith('"use server"')).toBe(true);
    const objetos = [...CODIGO.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)].map((m) => m[1]);
    expect(objetos).toEqual([]);
  });

  it("exporta convertAcceptedQuote", () => {
    expect(CODIGO).toContain("export async function convertAcceptedQuote");
  });
});

describe("🔴 entrada pública — só o quoteId", () => {
  it("a assinatura não aceita empresa, lead nem actor", () => {
    // O admin client faz bypass de RLS: uma empresa vinda do browser seria a
    // porta para converter leads de outra empresa.
    const assinatura = CODIGO.slice(
      CODIGO.indexOf("export async function convertAcceptedQuote"),
    ).split("{")[0];
    expect(assinatura).toContain("quoteId: string");
    expect(assinatura).not.toMatch(/company/i);
    expect(assinatura).not.toMatch(/leadId/i);
    expect(assinatura).not.toMatch(/actor/i);
  });

  it("a empresa e o actor vêm da sessão", () => {
    expect(CODIGO).toContain("p_company_id: profile.company_id");
    expect(CODIGO).toContain("p_actor: profile.id");
    expect(CODIGO).toContain('roles: ["admin", "gestor"]');
  });

  it("valida o UUID antes de qualquer query", () => {
    const corpo = CODIGO.slice(CODIGO.indexOf("export async function convertAcceptedQuote"));
    const validacao = corpo.indexOf("z.uuid()");
    const guard = corpo.indexOf("requireProfile");
    const query = corpo.indexOf(".from(");
    expect(validacao).toBeGreaterThan(-1);
    expect(validacao).toBeLessThan(guard);
    expect(validacao).toBeLessThan(query);
  });
});

describe("🔴 a proveniência é source_lead_id, nunca lead_id", () => {
  it("lê `source_lead_id` e passa-o como p_lead_id", () => {
    expect(CODIGO).toContain('select("source_lead_id")');
    expect(CODIGO).toContain("p_lead_id: quote.source_lead_id");
  });

  it("🔴 `lead_id` não é usado como proveniência", () => {
    // Depois da conversão `lead_id` fica a NULL; só a proveniência sobrevive,
    // e é ela que faz a repetição encontrar a mesma lead.
    expect(CODIGO).not.toMatch(/(^|[^_])\blead_id\b/m);
  });

  it("o SELECT é mínimo — não traz estado para revalidar", () => {
    // Trazer `status`/`superseded_by_id` seria começar a duplicar as regras
    // da RPC, e uma leitura sem lock nem sequer é verdade na escrita.
    const selects = [...CODIGO.matchAll(/\.select\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(selects).toEqual(["source_lead_id"]);
  });
});

describe("🔴 escrita SÓ pela RPC", () => {
  it("zero writes directos nas cinco tabelas da conversão", () => {
    for (const t of TABELAS_DA_CONVERSAO) {
      const escritas = [...CODIGO.matchAll(
        new RegExp(`\\.from\\("${t}"\\)\\s*\\.\\s*(insert|update|upsert|delete)`, "g"),
      )];
      expect(escritas.length, `${t} escrita directamente`).toBe(0);
    }
  });

  it("nenhum insert/update/upsert/delete em lado nenhum", () => {
    expect(CODIGO).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(CODIGO).not.toMatch(/\.from\([^)]*\)\s*\.\s*update\(/);
  });

  it("🔴 exactamente um caminho de RPC, e é o da 104", () => {
    const chamadas = [...CODIGO.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]);
    expect(chamadas).toEqual(["convert_crm_lead_atomic"]);
  });

  it("não cria contrato, serviço nem nada financeiro", () => {
    for (const t of ["contracts", "services", "invoices", "invoice_items", "cash_flow_entries"]) {
      expect(CODIGO, `toca em ${t}`).not.toContain(`"${t}"`);
    }
  });
});

describe("🔴 a auditoria distingue conversão de repetição", () => {
  it("só grava quando alreadyConverted é falso", () => {
    expect(CODIGO).toContain("if (!alreadyConverted)");
    const posGuarda = CODIGO.indexOf("if (!alreadyConverted)");
    const posAudit = CODIGO.indexOf("auditLog(", posGuarda);
    expect(posAudit).toBeGreaterThan(posGuarda);
  });

  it("a invalidação acontece em qualquer sucesso", () => {
    // Fora do `if (!alreadyConverted)`: quem repetiu pode ter uma lista
    // desactualizada noutro separador.
    expect(CODIGO).toContain("invalidateBusinessState(");
    expect(CODIGO).toContain('domains: ["leads", "clients", "locations"]');
    expect(CODIGO).toContain("clientId,");
  });

  it("nenhum revalidatePath à mão", () => {
    expect(CODIGO).not.toContain("revalidatePath(");
  });
});

describe("o erro cru nunca chega ao ecrã", () => {
  it("usa internalFailure e não expõe error.message", () => {
    expect(CODIGO).toContain("internalFailure(");
    expect(CODIGO).not.toMatch(/actionFailure\([^)]*error\.message/);
    expect(CODIGO).not.toMatch(/message:\s*error\.message/);
  });

  it("todas as sentinelas da 104 têm tradução", () => {
    const sql = ler("supabase/migrations/104_crm_conversao_lead.sql");
    // 🔴 `[A-Z0-9_]+`, com dígitos: sem eles o regex pára em `CRM_CONV_`
    //    (o caractere seguinte é `1`) e passa a exigir a tradução de um
    //    prefixo que não é sentinela nenhuma.
    //
    //    As `CRM_CONV_104_*` são erros de APLICAÇÃO da migration — precondições,
    //    proveniência, pós-estado. Nunca chegam a uma chamada da RPC em
    //    runtime, por isso não têm tradução de utilizador.
    const sentinelas = [...new Set(
      [...sql.matchAll(/RAISE EXCEPTION\s+'([A-Z0-9_]+)/g)].map((m) => m[1]),
    )].filter((s) => !s.startsWith("CRM_CONV_104_"));

    expect(sentinelas.length).toBeGreaterThan(5);

    // 🔴 `CONVERSION_QUOTE_REQUIRED` fica DE FORA da tabela de tradução, e é
    //    deliberado. A RPC levanta-a com `p_quote_id` NULL, e esta action só
    //    a chama com um UUID já validado — numa chamada válida é impossível.
    //    Se aparecer, é defeito nosso, não do utilizador: traduzi-la para
    //    «faltou indicar o orçamento» seria culpá-lo por um erro que não
    //    cometeu e não sabe corrigir. Cai no genérico, e há um ensaio em
    //    `crm-conversao-actions.test.ts` que o prova pelo comportamento.
    const SEM_TRADUCAO_DE_PROPOSITO = ["CONVERSION_QUOTE_REQUIRED"];

    for (const s of sentinelas) {
      if (SEM_TRADUCAO_DE_PROPOSITO.includes(s)) {
        expect(CODIGO, `${s} devia cair no genérico`).not.toContain(s);
        continue;
      }
      expect(CODIGO, `${s} sem tradução`).toContain(s);
    }
  });
});

describe("🔴 esta unidade não traz schema", () => {
  it("🔴 a action não usa nenhuma RPC criada depois da 104", () => {
    // 🔴 Este ensaio já mediu outra coisa: exigia que NÃO existisse nenhum
    //    ficheiro de migration numerado acima de 104. Era verdade enquanto a
    //    104 era a última, e deixou de o ser quando a 105 chegou — a cadeia
    //    cresce, e um guard que proíbe o futuro não é um guard, é um travão.
    //
    //    O que esta unidade promete, e continua a ter de provar, é mais
    //    estreito e mais útil: `crm-conversao.ts` não pode passar a depender de
    //    um objecto criado por uma migration POSTERIOR à 104. Se isso
    //    acontecesse, o runtime desta unidade deixaria de funcionar em
    //    qualquer base onde só a 104 esteja aplicada — que é exactamente o
    //    estado que a produção pode ter entre dois applies.
    //
    // 🔴 Só as numeradas com TRÊS dígitos. As datadas legadas (`20260608_*`)
    //    começam por oito dígitos e `slice(0, 3)` daria 202.
    const posteriores = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((m) => /^\d{3}[a-z]?_.*\.sql$/.test(m))
      .filter((m) => Number(m.slice(0, 3)) > 104);

    const funcoesNovas = new Set<string>();
    for (const ficheiro of posteriores) {
      const sql = ler(`supabase/migrations/${ficheiro}`);
      for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)/g)) {
        funcoesNovas.add(m[1]);
      }
    }

    for (const f of funcoesNovas) {
      expect(CODIGO, `a action usa ${f}, criada depois da 104`).not.toContain(f);
    }
  });

  it("a 104 no repositório é a que está aplicada", () => {
    // O rollback fixa o checksum da 104; se o SQL mudar sem o rollback mudar,
    // há um ensaio próprio que fica vermelho. Aqui basta garantir que ninguém
    // acrescentou migrations a esta unidade.
    expect(ler("supabase/migrations/104_crm_conversao_lead.sql")).toContain(
      "convert_crm_lead_atomic",
    );
  });
});

describe("🔴 a UI espera a conversão de verdade", () => {
  const DETALHE = "src/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-detail-sheet.tsx";
  const UI = semComentarios(ler(DETALHE));

  it("a conversão NÃO usa startTransition", () => {
    // `ConfirmDialog` faz `await onConfirm()`. `startTransition` devolve
    // `void`: o await resolveria de imediato e o diálogo fecharia antes de a
    // conversão terminar, dando a impressão de que já estava feita.
    const corpo = UI.slice(UI.indexOf("async function converter"));
    const fim = corpo.indexOf("\n  }");
    expect(corpo.slice(0, fim)).not.toContain("startTransition");
  });

  it("usa estado próprio e uma função async real", () => {
    expect(UI).toContain("const [converting, setConverting] = useState(false)");
    expect(UI).toContain("async function converter()");
    expect(UI).toContain("onConfirm={converter}");
  });

  it("🔴 `busy` cobre os caminhos de fecho do painel", () => {
    expect(UI).toContain("const busy = pending || converting");
    expect(UI).toContain('e.key === "Escape" && !busy');
    expect(UI).toContain("e.currentTarget && !busy");
    expect(UI).toContain('disabled={busy} aria-label="Fechar"');
  });

  it("os dois estados de conversão são mutuamente exclusivos", () => {
    expect(UI).toContain("canConvertQuote(q)");
    expect(UI).toContain("isConvertedLeadQuote(q)");
  });

  it("navega para o cliente, e não abre contrato", () => {
    expect(UI).toContain("/dashboard/clientes/");
    expect(UI).not.toContain("contratos/novo");
    expect(UI).not.toContain("ContratoSheet");
  });

  it("🔴 a copy diz de onde vem a morada do local — e sob que condição", () => {
    // A RPC usa a morada da VISITA só quando essa morada está preenchida; uma
    // visita sem morada cai na morada da LEAD, tal como a ausência de visita.
    //
    // 🔴 Não basta a copy mencionar «visita» e «lead»: a versão anterior dizia
    //    «a morada da visita, quando existe», que se lê como «quando existe
    //    visita» — e prometia a morada da lead só na falta de visita. Uma
    //    visita sem morada desmentia o ecrã. Estas asserções prendem a
    //    condição, não o vocabulário.
    const desc = UI.slice(UI.indexOf("description="), UI.indexOf("confirmLabel="));
    expect(desc).toMatch(/morada da visita[^.]*estiver preenchida/);
    expect(desc).toMatch(/caso contrário[^.]*morada da lead/);
    expect(desc).not.toMatch(/um cliente e um local com os dados da lead/);
    // A formulação ambígua não pode voltar.
    expect(desc).not.toMatch(/quando existe/);
    expect(desc).not.toMatch(/se não houver visita/);
  });

  it("🔴 a copy não promete contrato nem serviços", () => {
    const desc = UI.slice(UI.indexOf("description="), UI.indexOf("confirmLabel="));
    expect(desc).toContain("Não cria contrato");
    expect(desc).toContain("ganha");
  });

  it("a release note descreve a mesma regra da morada, com a mesma condição", () => {
    // 🔴 O texto vive em literais concatenados: reconstituí-lo antes de medir,
    //    senão uma quebra de linha no meio da frase escondia a regra e o
    //    ensaio ficava verde por acidente de formatação.
    const fonte = ler("src/release-notes/2026-09-23-crm-conversao-cliente.ts");
    const nota = fonte.replace(/"\s*\+\s*"/g, "");

    expect(nota).toMatch(/morada da visita[^.]*estiver preenchida/);
    expect(nota).toMatch(/caso contrário[^.]*morada da lead/);
    expect(nota).not.toMatch(/o local com os dados da lead/);
    expect(nota).not.toMatch(/se não houver visita/);

    // Sem jargão interno: quem lê a nota não sabe o que é uma RPC.
    for (const proibido of ["RPC", "migration", "Postgres", "constraint", "convert_crm_lead_atomic"]) {
      expect(nota, `a nota menciona ${proibido}`).not.toContain(proibido);
    }
  });

  it("o ConfirmDialog global não foi alterado", () => {
    const dialog = ler("src/components/ui/confirm-dialog.tsx");
    expect(dialog).toContain("interface ConfirmDialogProps");
    expect(dialog).toContain("await onConfirm()");
  });
});
