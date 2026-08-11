// ============================================================================
// Pagamentos — ler não escreve
// ============================================================================
//
// A 2026-08-03T11:56:02 nasceram 15 pagamentos fixos de Agosto/2026 no mesmo
// segundo, todos com `source_id`. Ninguém carregou em nada: alguém abriu a
// página. `getPayments` chamava `ensureMonth`, que clonava os fixos do mês
// anterior mais recente.
//
// Duas consequências, ambas reais:
//
//  1. **Os variáveis pareceram desaparecer.** Nunca são clonados — por desenho.
//     Entre 03/08 e 07/08 Agosto tinha 15 fixos e zero variáveis. Nada foi
//     apagado; o mês foi *inventado* incompleto.
//
//  2. **Quatro datas foram perdidas.** `shiftDate` guarda o dia e força o mês
//     de destino. Quatro pagamentos **trimestrais** — 03/08, 03/11, 03/02 e
//     03/05 — foram gravados todos como 03/08. O modelo não tem periodicidade,
//     por isso a função assumiu mensal. É perda de informação, não um problema
//     de apresentação.
//
// Estes testes existem para que ler volte a escrever só por cima de um diff que
// alguém tenha de defender. Ver
// `docs/incidents/2026-08-11-pagamentos-materializacao-implicita.md`.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  stripComments,
  countDirectDbMutations,
  functionBody,
  writeActionsUsedBy,
  collectServerRenderGraph,
  createWriteCapabilityResolver,
} from "@/lib/finance-write-surface";

const ROOT = process.cwd();
const ler = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lerOuNull = (rel: string): string | null => {
  try { return ler(rel); } catch { return null; }
};

const PAYMENTS = "src/app/actions/payments.ts";
const QUARENTENA = "src/lib/payments-month-materialization.ts";
const BANNER = "src/app/(dashboard)/dashboard/_components/payments-reminder-banner.tsx";
const PAGINA = "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx";
const resolvedor = createWriteCapabilityResolver(lerOuNull);

const CLIENTE = "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx";

/** O corpo de uma função exportada, já sem comentários. */
function corpoDe(src: string, nome: string): string {
  const code = stripComments(src);
  const m = new RegExp(`export\\s+async\\s+function\\s+${nome}\\b`).exec(code);
  expect(m, `${nome} tem de existir — senão este teste passa por vacuidade`).not.toBeNull();
  const corpo = functionBody(code, m!.index);
  expect(corpo.length, `o corpo de ${nome} não foi extraído`).toBeGreaterThan(50);
  return corpo;
}

// ─── 1. As duas leituras deixaram de materializar ────────────────────────────

describe("Pagamentos — as leituras não materializam o mês", () => {
  it("1. getPayments não escreve, nem directamente nem por delegação", () => {
    const corpo = corpoDe(ler(PAYMENTS), "getPayments");
    expect(countDirectDbMutations(corpo)).toBe(0);
    expect(corpo, "abrir a página não pode gerar o mês").not.toMatch(/ensureMonth/);
  });

  it("2. getPaymentsReminder não escreve — é o caminho do Dashboard", () => {
    // Este era o mais largo dos dois: bastava entrar na aplicação.
    const corpo = corpoDe(ler(PAYMENTS), "getPaymentsReminder");
    expect(countDirectDbMutations(corpo)).toBe(0);
    expect(corpo, "um lembrete não pode criar aquilo que lembra").not.toMatch(/ensureMonth/);
  });

  it("3. nenhuma função de leitura de payments.ts é reconhecida como escrita", () => {
    const escritoras = resolvedor.exportsThatWrite(PAYMENTS);
    for (const leitura of ["getPayments", "getPaymentsReminder", "getSignedPaymentAttachmentUrl"]) {
      expect(escritoras, `${leitura} tem nome de leitura e tem de o ser`).not.toContain(leitura);
    }
  });

  it("4. shiftDate saiu de payments.ts — a lógica que perdia datas não fica ao alcance", () => {
    expect(stripComments(ler(PAYMENTS))).not.toMatch(/function\s+shiftDate/);
  });
});

// ─── 2. As escritas explícitas continuam a existir ───────────────────────────

describe("Pagamentos — o que o utilizador pede continua a funcionar", () => {
  it("5. as actions de escrita explícita não foram enfraquecidas", () => {
    // Se a contenção tivesse partido alguma destas, teríamos trocado um bug
    // por outro pior: uma página que já não grava nada.
    const escritoras = resolvedor.exportsThatWrite(PAYMENTS);
    for (const a of [
      "createPayment", "updatePayment", "deletePayment", "setPaymentStatus",
      "uploadPaymentAttachment", "deletePaymentAttachment",
    ]) {
      expect(escritoras, `${a} tem de continuar a escrever`).toContain(a);
    }
  });

  it("6. não foi acrescentado nenhum botão de gerar mês", () => {
    // A tentação óbvia era substituir o auto-write por um botão. Não se gera um
    // mês enquanto o modelo não souber distinguir mensal de trimestral — o
    // botão produziria as mesmas datas erradas, só que com uma vítima
    // consentida.
    const cliente = stripComments(ler(CLIENTE));
    expect(cliente).not.toMatch(/Gerar\s+m[êe]s|generateMonth|ensureMonth|materializ/i);
  });
});

// ─── 3. A quarentena está mesmo fora de alcance ──────────────────────────────

describe("Pagamentos — a materialização está em quarentena, não em uso", () => {
  it("7. o módulo em quarentena não é importado por ninguém", () => {
    // Preservar a lógica só é seguro enquanto for provadamente inalcançável.
    const alvo = "payments-month-materialization";
    const infractores: string[] = [];

    const varrer = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) varrer(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && rel !== QUARENTENA) {
          const code = stripComments(ler(rel));
          if (new RegExp(`from\\s*["'][^"']*${alvo}["']`).test(code)) infractores.push(rel);
        }
      }
    };
    varrer("src");

    // Este próprio ficheiro refere o nome numa string, não num import — é
    // exactamente a armadilha "mencionar ≠ usar" que o projecto já apanhou
    // várias vezes. Por isso a procura é por `from "…"`, não pelo nome solto.
    expect(infractores, "importar a quarentena é reabrir o incidente").toEqual([]);
  });

  it("🔴 7b. mover a escrita para outro módulo não a esconde da guarda", () => {
    // Foi um teste de mutação que encontrou este buraco: reintroduzi o defeito
    // por trás de um import e **três guardas passaram na mesma**. O detector
    // anterior só seguia delegação dentro do próprio ficheiro, por isso um
    // `insert` a um import de distância era invisível.
    //
    // Reconhecer só o caminho conhecido dá um "seguro" falso — e um falso
    // seguro é pior do que guarda nenhuma, porque dispensa quem lê de olhar.
    const fake: Record<string, string> = {
      "src/app/actions/p.ts": `
        import { ensureMonth } from "@/lib/m";
        export async function getCoisas() { await ensureMonth(); return read(); }
        export async function soLe() { return read(); }
      `,
      "src/lib/m.ts": `export async function ensureMonth() { await admin.from("t").insert(rows); }`,
    };
    const r = createWriteCapabilityResolver((rel) => fake[rel] ?? null);
    expect(r.exportsThatWrite("src/app/actions/p.ts")).toEqual(["getCoisas"]);
  });

  it("7c. um import de tipo não conta, e um ciclo não pendura", () => {
    const fake: Record<string, string> = {
      "src/a.ts": `import type { X } from "@/b";\nimport { vai } from "@/b";\nexport async function f(): Promise<X> { return vai(); }`,
      "src/b.ts": `import { f } from "@/a";\nexport async function vai() { return f(); }`,
    };
    const r = createWriteCapabilityResolver((rel) => fake[rel] ?? null);
    expect(() => r.exportsThatWrite("src/a.ts")).not.toThrow();
    expect(r.exportsThatWrite("src/a.ts")).toEqual([]);
  });

  it("8. o módulo em quarentena não é um endpoint invocável", () => {
    // Um export de um ficheiro `"use server"` torna-se uma server action que o
    // browser pode chamar por RPC. Manter `ensureMonth` exportada em
    // `payments.ts` teria sido pior do que deixá-la lá dentro chamada.
    expect(ler(QUARENTENA)).not.toMatch(/^\s*["']use server["']/m);
    expect(countDirectDbMutations(ler(QUARENTENA)), "a lógica está preservada, não amputada")
      .toBeGreaterThan(0);
  });
});

// ─── 4. Os grafos de render ──────────────────────────────────────────────────

describe("Pagamentos — renderizar não escreve", () => {
  const WRITE_ACTIONS = resolvedor.exportsThatWrite(PAYMENTS);

  it("9. o grafo de render do Dashboard não chama nenhuma escrita de pagamentos", () => {
    const grafo = collectServerRenderGraph(
      ["src/app/(dashboard)/dashboard/page.tsx"],
      lerOuNull,
    );
    expect(grafo, "o banner tem de estar no grafo, senão isto não prova nada")
      .toContain(BANNER);

    const infractores: string[] = [];
    for (const f of grafo) {
      for (const a of writeActionsUsedBy(lerOuNull(f) ?? "", WRITE_ACTIONS)) {
        infractores.push(`${f} → ${a}`);
      }
    }
    expect(infractores, "entrar na aplicação não pode criar pagamentos").toEqual([]);
  });

  it("10. o grafo de render de Pagamentos não chama nenhuma escrita", () => {
    const grafo = collectServerRenderGraph([PAGINA], lerOuNull);
    expect(grafo).toContain(PAGINA);

    const infractores: string[] = [];
    for (const f of grafo) {
      for (const a of writeActionsUsedBy(lerOuNull(f) ?? "", WRITE_ACTIONS)) {
        infractores.push(`${f} → ${a}`);
      }
      expect(countDirectDbMutations(lerOuNull(f) ?? ""), `${f} faz mutação directa`).toBe(0);
    }
    expect(infractores, "abrir Pagamentos — em qualquer mês — não pode escrever").toEqual([]);
  });
});

// ─── 5. Um mês vazio diz a verdade ───────────────────────────────────────────

describe("Pagamentos — um mês vazio não é um mês a zero", () => {
  it("11. o estado vazio dos variáveis é explícito", () => {
    expect(ler(CLIENTE)).toContain("Ainda não existem pagamentos variáveis neste mês.");
  });

  it("12. o estado vazio dos fixos é explícito, e não promete repetição automática", () => {
    const src = ler(CLIENTE);
    expect(src).toContain("Ainda não existem pagamentos fixos neste mês.");
    expect(src, "já não se repetem sozinhos — dizer o contrário é mentir ao utilizador")
      .not.toMatch(/repetem\s+todos\s+os\s+meses\s+automaticamente/i);
  });

  it("🔴 13. um mês sem linhas mostra-se como não preparado, não como 0,00 €", () => {
    // Ausência de dados não é ausência de despesa. Um KPI a zero num mês nunca
    // lançado diz ao dono que não tem nada a pagar — que é falso, e é a leitura
    // mais cara possível.
    const src = stripComments(ler(CLIENTE));
    expect(src).toMatch(/Mês ainda não preparado/);
    expect(
      src,
      "os KPIs têm de estar condicionados a existirem linhas",
    ).toMatch(/data\.fixos\.length\s*>\s*0\s*\|\|\s*data\.variaveis\.length\s*>\s*0/);
  });
});
