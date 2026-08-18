// ============================================================================
// PAGAMENTOS — o erro da action tem de chegar ao ecrã
// ============================================================================
// Origem (2026-08-18, relato de utilizador em produção): «marco o pagamento
// como pago e não atualiza».
//
// A causa não era a base nem a RPC. `setPaymentStatus` é fail-closed e devolve
// `{ ok: false, error }` em todos os caminhos — sem permissão, período
// financeiro fechado, erro da 073. O handler do cliente fazia:
//
//     await setPaymentStatus(...);   // resultado descartado
//     reload();
//
// O `reload()` relia o estado real, que não tinha mudado, e a linha voltava a
// aparecer exactamente como estava. Sem mensagem. Para quem clicava, a
// operação parecia não ter efeito nenhum — quando na verdade tinha sido
// recusada, com um motivo que ninguém via.
//
// O caso mais provável em uso real é o mês fechado: a guarda de período
// recusa, a action traduz o erro, e o erro morria no cliente.
//
// Estes testes são estáticos (leitura do ficheiro) porque o handler vive num
// Client Component com `startTransition` — montá-lo exigiria um ambiente de
// React que o projecto não usa nos testes. O que se fixa aqui é a propriedade
// que regrediu: nenhuma chamada a uma action de mutação pode ter o resultado
// descartado.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CLIENT = path.join(
  process.cwd(),
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx",
);
const SRC = fs.readFileSync(CLIENT, "utf8");

/** As actions de mutação de pagamentos — todas devolvem `{ ok, error? }`. */
const MUTATIONS = ["setPaymentStatus", "deletePayment", "createPayment", "updatePayment"];

describe("🔴 payments-client — nenhum resultado de mutação é descartado", () => {
  for (const fn of MUTATIONS) {
    it(`${fn} tem o resultado atribuído, não descartado`, () => {
      // `await fn(` no início de uma instrução — sem `const x =` antes — é
      // exactamente a forma que engolia o erro. Comentários não contam: o
      // próprio handler documenta o padrão antigo para explicar a correcção.
      const linhas = SRC.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes(`await ${fn}(`))
        .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));

      expect(linhas.length, `nenhuma chamada a ${fn} encontrada`).toBeGreaterThan(0);
      for (const linha of linhas) {
        const atribui = /(const|let|var)\s+\w+\s*=|=\s*(await\s+)?\w+\s*\(|\?\s*await|:\s*await/.test(linha);
        expect(atribui, `resultado descartado em: ${linha}`).toBe(true);
      }
    });
  }

  it("toggleStatus verifica res.ok antes de recarregar", () => {
    const i = SRC.indexOf("function toggleStatus");
    expect(i).toBeGreaterThan(-1);
    const corpo = SRC.slice(i, i + 700);

    expect(corpo).toContain("const res = await setPaymentStatus");
    expect(corpo).toContain("if (!res.ok)");
    // O erro tem de ir para o estado que a página renderiza.
    expect(corpo).toContain("setError(");
    // E não pode recarregar como se nada fosse quando a action recusa.
    const posIf = corpo.indexOf("if (!res.ok)");
    const posReturn = corpo.indexOf("return;", posIf);
    const posReload = corpo.indexOf("reload()", posIf);
    expect(posReturn).toBeGreaterThan(-1);
    expect(posReturn).toBeLessThan(posReload);
  });

  it("handleDelete verifica res.ok antes de recarregar", () => {
    const i = SRC.indexOf("function handleDelete");
    expect(i).toBeGreaterThan(-1);
    const corpo = SRC.slice(i, i + 700);

    expect(corpo).toContain("const res = await deletePayment");
    expect(corpo).toContain("if (!res.ok)");
    expect(corpo).toContain("setError(");
  });

  it("a página tem onde mostrar o erro", () => {
    // Sem isto, `setError` seria só um estado que ninguém vê.
    expect(SRC).toContain("const [error, setError] = useState");
    expect(SRC).toMatch(/\{error && \(/);
  });
});

describe("setPaymentStatus — a action continua fail-closed", () => {
  const ACTION = fs.readFileSync(path.join(process.cwd(), "src/app/actions/payments.ts"), "utf8");

  function corpoDe(nome: string): string {
    const i = ACTION.indexOf(`export async function ${nome}`);
    if (i < 0) return "";
    const resto = ACTION.slice(i + 10);
    const fim = resto.indexOf("\nexport async function ");
    return fim < 0 ? resto : resto.slice(0, fim);
  }

  const corpo = corpoDe("setPaymentStatus");

  it("recusa sem permissão", () => {
    expect(corpo).toContain("requireProfile");
    expect(corpo).toMatch(/if \(!guard\.ok\) return \{ ok: false/);
  });

  it("recusa em período financeiro fechado", () => {
    expect(corpo).toContain("assertFinancialPeriodOpen");
    expect(corpo).toMatch(/if \(!p\.ok\) return \{ ok: false/);
  });

  it("propaga o erro da RPC canónica em vez de o engolir", () => {
    expect(corpo).toContain("marcarPagamentoPago");
    expect(corpo).toContain("desmarcarPagamentoPago");
    expect(corpo).toMatch(/if \(!r\.ok\) return \{ ok: false/);
  });

  it("🔴 nunca devolve ok depois de um erro registado só em consola", () => {
    // O anti-padrão: `if (error) console.error(...)` e `return { ok: true }`.
    expect(corpo).not.toMatch(/console\.(error|warn)[\s\S]{0,120}return \{ ok: true \}/);
  });

  it("invalida as superfícies financeiras depois de escrever", () => {
    // Sem isto, a base mudava e as outras vistas ficavam com dados velhos.
    expect(corpo).toContain("revalidateCaixa()");
  });
});

// ── Separação entre anexo e efeito económico ────────────────────────────────
//
// Um anexo é metadata. Adicionar ou remover um não pode mexer no estado
// económico do pagamento, e marcar como pago não pode mexer nos anexos.

describe("🔴 anexos e estado de pagamento são independentes", () => {
  const ATTACH = fs.readFileSync(path.join(process.cwd(), "src/app/actions/attachments.ts"), "utf8");
  const ACTION = fs.readFileSync(path.join(process.cwd(), "src/app/actions/payments.ts"), "utf8");

  it("as actions de anexo não tocam no estado do pagamento", () => {
    for (const proibido of ["status", "paid_at", "payment_date", "cash_flow_entries", "mark_payment_paid"]) {
      expect(ATTACH.includes(`"${proibido}"`), `attachments.ts menciona ${proibido}`).toBe(false);
    }
  });

  it("as actions de anexo não escrevem em fluxo de caixa", () => {
    expect(ATTACH).not.toContain("cash_flow");
    expect(ATTACH).not.toContain("marcarPagamentoPago");
  });

  it("setPaymentStatus não altera colunas de anexo", () => {
    const corpo = ACTION.slice(ACTION.indexOf("export async function setPaymentStatus"));
    const ate = corpo.slice(0, corpo.indexOf("\nexport async function ", 10));
    expect(ate).not.toContain("attachment_url");
    expect(ate).not.toContain("attachment_name");
  });
});
