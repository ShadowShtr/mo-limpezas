/**
 * Rasto de pagamentos — allowlist de VALORES e supressão no sink.
 *
 * Duas coisas que o master ainda não garantia.
 *
 * 1. **O `code` era filtrado por forma, não por valor.** A regra era
 *    `/^[A-Za-z0-9_.:-]{1,48}$/`: qualquer coisa que *parecesse* um código
 *    entrava nos logs inteira. `IBAN123456789` parece um código. Um nome de
 *    cliente sem espaços parece um código. Um token parece um código.
 *
 * 2. **O `paymentId` do AUTH_GUARD era o que o caller enviou.** Nessa etapa
 *    `requireProfile` ainda não passou: não há sessão, não há empresa, e o id
 *    é entrada não autenticada. Um UUID forjado passa por `idSeguro()` sem
 *    ficar mais seguro — a forma nunca disse nada sobre a origem.
 *
 * A garantia de (2) vive no **sink**, não em cada caller. Uma regra que
 * depende de quem chama se lembrar dela é uma regra que já falhou uma vez.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODIGOS_CONHECIDOS,
  tracePaymentStatus,
  type PaymentStatusStage,
} from "@/lib/observability/payment-status-trace";

const ROOT = process.cwd();
const ler = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const FONTE_SINK = ler("src", "lib", "observability", "payment-status-trace.ts");

/**
 * O sink sem comentários.
 *
 * 🔴 A guarda tem de medir o CÓDIGO, e o comentário que explica a regra antiga
 *    faz parte da correcção — apagar a explicação para o teste ficar verde
 *    ensinaria a nao documentar. Uma varredura que confunde as duas coisas dá
 *    vermelho a quem documenta e verde a quem reintroduz a regra sem uma
 *    palavra.
 */
const SINK_SEM_COMENTARIOS = FONTE_SINK
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

/** Captura o que foi para a consola, sem o deixar sujar a saída dos testes. */
function capturar() {
  const linhas: string[] = [];
  const guardar = (v: unknown) => linhas.push(String(v));
  const spies = [
    vi.spyOn(console, "log").mockImplementation(guardar),
    vi.spyOn(console, "warn").mockImplementation(guardar),
    vi.spyOn(console, "error").mockImplementation(guardar),
  ];
  return { linhas, restaurar: () => spies.forEach((s) => s.mockRestore()) };
}

/** Emite uma linha e devolve-a já desserializada. */
function linha(input: {
  stage: PaymentStatusStage;
  code?: string | null;
  paymentId?: string | null;
  companyId?: string | null;
}) {
  const { linhas, restaurar } = capturar();
  tracePaymentStatus({
    stage: input.stage,
    correlationId: "cid",
    targetStatus: "pago",
    paymentId: input.paymentId,
    companyId: input.companyId,
    code: input.code,
    ok: false,
  });
  restaurar();
  return JSON.parse(linhas[0]) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

// ═══════════════════════════════════════════════════════════════════════════

describe("MASTER_REGEX_SANITIZER_SUPERSEDED", () => {
  it("🔴 a allowlist de formato desapareceu do módulo", () => {
    // A regra antiga aceitava qualquer coisa com forma de código. Se voltar,
    // isto fica vermelho antes de alguém reparar num log com um IBAN.
    expect(SINK_SEM_COMENTARIOS).not.toContain("[A-Za-z0-9_.:-]{1,48}");
  });

  it("🔴 e o `slice(60)` que a antecedeu também não voltou", () => {
    expect(SINK_SEM_COMENTARIOS).not.toMatch(/slice\(\s*0?\s*,?\s*60\s*\)/);
  });

  it("o conjunto fechado tem os quinze códigos do domínio, sem repetições", () => {
    expect(new Set(CODIGOS_CONHECIDOS).size).toBe(CODIGOS_CONHECIDOS.length);
    expect(CODIGOS_CONHECIDOS.length).toBe(15);
  });
});

describe("CLOSED_CODE_ALLOWLIST — só os códigos reais sobrevivem", () => {
  it.each(CODIGOS_CONHECIDOS.map((c) => [c]))("%s passa tal e qual", (codigo) => {
    expect(linha({ stage: "PAYMENT_STATUS_MARK_RPC", code: codigo }).code).toBe(codigo);
  });

  /**
   * 🔴 Estes são exactamente os exemplos que a regra de forma deixava passar.
   *    Todos têm forma de código. Nenhum é um código deste domínio.
   */
  it.each([
    ["IBAN123456789"],
    ["CustomerName123"],
    ["SecretTokenABC"],
    ["PT50000201231234567890154"],
    // 🔴 Escrito sem o prefixo real de propósito. O `secrets:scan` não sabe
    //    distinguir uma chave de exemplo de uma verdadeira — e é bom que não
    //    saiba. Um teste não pode obrigar a afrouxar essa guarda.
    ["ChaveDeServico_abcdef123456"],
    ["maria.silva"],
    ["351-912-345-678"],
    ["FINANCIAL_PERIOD_CLOSED_EXTRA"],
    ["unauthenticated"],
    ["UNEXPECTED_EXCEPTION "],
  ])("%s vira UNCLASSIFIED_CODE", (intruso) => {
    const l = linha({ stage: "PAYMENT_STATUS_MARK_RPC", code: intruso });
    expect(l.code).toBe("UNCLASSIFIED_CODE");
  });

  it("🔴 o valor original nunca sobrevive em lado nenhum da linha", () => {
    // Não basta o campo `code` estar limpo: o que se exige é que o texto
    // desconhecido não apareça na linha inteira, sob que campo for.
    const segredo = "IBANPT50000201231234567890154";
    const l = linha({ stage: "PAYMENT_STATUS_UNMARK_RPC", code: segredo });
    expect(JSON.stringify(l)).not.toContain(segredo);
    expect(JSON.stringify(l)).not.toContain(segredo.slice(0, 12));
  });

  it("um código ausente continua a ser `null`, e não `UNCLASSIFIED_CODE`", () => {
    // A diferença importa a quem lê o log: «não houve código» e «veio código
    // que não reconheço» são dois factos distintos.
    expect(linha({ stage: "PAYMENT_STATUS_OK", code: null }).code).toBeNull();
    expect(linha({ stage: "PAYMENT_STATUS_OK" }).code).toBeNull();
    expect(linha({ stage: "PAYMENT_STATUS_OK", code: "" }).code).toBeNull();
  });
});

describe("🔴 a allowlist não pode desactualizar-se em silêncio", () => {
  /**
   * Varre as origens reais e exige que cada literal emitido esteja no conjunto.
   *
   * Duas das quatro origens já são cobertas pelo compilador (`AuthGuardCode` e
   * `MotivoFalha` são uniões tipadas, e o sink tem uma guarda de tipo sobre
   * elas). As guardas de período não são: o `code` delas é `string`. É essa a
   * fenda que este teste fecha.
   */
  const ORIGENS = [
    ["src/app/actions/payments.ts", /\bcode:\s*"([^"]+)"/g],
    ["src/lib/finance-period-guard.ts", /\bcode:\s*"([^"]+)"/g],
    ["src/lib/finance-rpc/payment-cashflow.ts", /\bmotivo:\s*"([^"]+)"/g],
    ["src/lib/finance-period-guard.ts", /^export const ERRO_[A-Z_]+ = "([^"]+)"/gm],
    ["src/lib/finance-rpc/payment-cashflow.ts", /^export const ERRO_[A-Z_]+ = "([^"]+)"/gm],
    ["src/lib/auth-guard.ts", /^\s{2}[A-Z_]+:\s*"([^"]+)",$/gm],
  ] as const;

  it("todos os códigos emitidos pelas origens estão no conjunto fechado", () => {
    const encontrados = new Set<string>();
    for (const [ficheiro, padrao] of ORIGENS) {
      const fonte = ler(...ficheiro.split("/"));
      for (const m of fonte.matchAll(padrao)) encontrados.add(m[1]);
    }

    // Se a varredura não encontrasse nada, este teste passaria por vacuidade —
    // que é a forma mais silenciosa de uma guarda morrer.
    expect(encontrados.size).toBeGreaterThanOrEqual(10);

    const fora = [...encontrados].filter(
      (c) => !(CODIGOS_CONHECIDOS as readonly string[]).includes(c),
    );
    expect(
      fora,
      "código emitido que não está em CODIGOS_CONHECIDOS — acrescentar lá, " +
        "ou o log passa a dizer UNCLASSIFIED_CODE sem ninguém perceber porquê",
    ).toEqual([]);
  });

  it("e o conjunto fechado não tem códigos que já ninguém emite", () => {
    // O inverso do teste anterior. Uma lista que só cresce acaba por autorizar
    // valores que deixaram de existir — e a allowlist deixa de descrever o
    // sistema.
    const fontes = [
      "src/app/actions/payments.ts",
      "src/lib/finance-period-guard.ts",
      "src/lib/finance-rpc/payment-cashflow.ts",
      "src/lib/auth-guard.ts",
    ].map((f) => ler(...f.split("/"))).join("\n");

    const orfaos = CODIGOS_CONHECIDOS.filter((c) => !fontes.includes(`"${c}"`));
    expect(orfaos, "código na allowlist que nenhuma origem emite").toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("AUTH_GUARD_PAYMENT_SUPPRESSED_AT_SINK", () => {
  const UUID_FORJADO = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it.each([
    ["um UUID válido mas forjado", UUID_FORJADO],
    ["um UUID inválido", "nao-e-um-uuid"],
    ["texto com PII", "Maria Silva, 912345678, maria@exemplo.pt"],
    ["um id vazio", ""],
    ["um id enorme", "x".repeat(5000)],
  ])("🔴 no AUTH_GUARD, %s não fica registado", (_n, id) => {
    const l = linha({ stage: "PAYMENT_STATUS_AUTH_GUARD", paymentId: id, code: "FORBIDDEN" });
    expect(l.payment).toBeNull();
    // Nem sequer `INVALID_UUID`: a etapa não regista pagamento nenhum, e a
    // ausência é a informação certa. Um marcador diria «veio um id mau»,
    // quando o que se quer dizer é «aqui não se olha para ids».
    expect(l.payment).not.toBe("INVALID_UUID");
    if (id) expect(JSON.stringify(l)).not.toContain(id.slice(0, 12));
  });

  it("UNAUTHENTICATED_INPUT_ID_LOGGED = NO para os três códigos da guarda", () => {
    for (const code of ["UNAUTHENTICATED", "PROFILE_NOT_FOUND", "FORBIDDEN"]) {
      const l = linha({ stage: "PAYMENT_STATUS_AUTH_GUARD", paymentId: UUID_FORJADO, code });
      expect(l.payment, code).toBeNull();
      // O código continua a ser registado: é ele que diz porque falhou, e não
      // identifica ninguém.
      expect(l.code, code).toBe(code);
    }
  });

  it("🔴 e nas outras etapas o pagamento continua a ser registado", () => {
    // A supressão tem de ser cirúrgica. Se apagasse o `payment` em todas as
    // etapas, o rasto deixava de servir para o que foi feito: dizer qual
    // pagamento parou onde.
    const outras: PaymentStatusStage[] = [
      "PAYMENT_STATUS_PERIOD_GUARD",
      "PAYMENT_STATUS_MARK_RPC",
      "PAYMENT_STATUS_UNMARK_GUARD",
      "PAYMENT_STATUS_UNMARK_RPC",
      "PAYMENT_STATUS_OK",
      "PAYMENT_STATUS_UNEXPECTED_EXCEPTION",
    ];
    for (const stage of outras) {
      const l = linha({ stage, paymentId: UUID_FORJADO });
      expect(l.payment, stage).toBe(UUID_FORJADO);
    }
  });

  it("a supressão está no sink, e não numa condição do caller", () => {
    // 🔴 É esta a diferença que a direcção pediu. `payments.ts` continua a
    //    passar `paymentId: id` no AUTH_GUARD — e pode continuar. A garantia
    //    não depende de nenhum caller: está no sítio onde se escreve.
    const action = ler("src", "app", "actions", "payments.ts");
    expect(action).toMatch(/stage: "PAYMENT_STATUS_AUTH_GUARD"[\s\S]{0,200}?paymentId: id/);
    expect(SINK_SEM_COMENTARIOS).toMatch(
      /input\.stage === "PAYMENT_STATUS_AUTH_GUARD"\s*\?\s*null/,
    );
  });

  it("o `company` do AUTH_GUARD também não existe — nem é passado, nem cabe", () => {
    // Nesta etapa a empresa ainda não foi resolvida a partir da sessão. Se
    // aparecesse aqui, só podia ter vindo do cliente.
    expect(linha({ stage: "PAYMENT_STATUS_AUTH_GUARD", companyId: null }).company).toBeNull();
  });
});
