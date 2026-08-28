/**
 * Rasto de `setPaymentStatus` — prova de que cada falha fica distinguível e de
 * que nada sensível entra na linha.
 *
 * O motivo é concreto: a 2026-08-27 uma marcação real não escreveu nada e a
 * base ficou intacta. Correcto — mas indistinguível de uma falha antes da RPC,
 * porque um rollback integral deixa exactamente o mesmo estado. Diagnosticar
 * exigia repetir em produção.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  novoCorrelationId,
  tracePaymentStatus,
  PAYMENT_STATUS_CODES,
  type PaymentStatusStage,
} from "@/lib/observability/payment-status-trace";

const ACTION = fs.readFileSync(
  path.join(process.cwd(), "src", "app", "actions", "payments.ts"),
  "utf8",
);

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

afterEach(() => vi.restoreAllMocks());

describe("rasto — cada etapa é distinguível", () => {
  const ETAPAS: PaymentStatusStage[] = [
    "PAYMENT_STATUS_AUTH_GUARD",
    "PAYMENT_STATUS_PERIOD_GUARD",
    "PAYMENT_STATUS_MARK_RPC",
    "PAYMENT_STATUS_UNMARK_GUARD",
    "PAYMENT_STATUS_UNMARK_RPC",
    "PAYMENT_STATUS_OK",
    "PAYMENT_STATUS_UNEXPECTED_EXCEPTION",
  ];

  it("🔴 as sete etapas produzem `stage` diferente na linha", () => {
    const { linhas, restaurar } = capturar();
    for (const stage of ETAPAS) {
      tracePaymentStatus({
        stage, correlationId: "cid1", targetStatus: "pago",
        paymentId: "p1", code: "X", ok: stage === "PAYMENT_STATUS_OK",
      });
    }
    restaurar();
    const stages = linhas.map((l) => JSON.parse(l).stage);
    expect(stages).toEqual(ETAPAS);
    expect(new Set(stages).size).toBe(ETAPAS.length);
  });

  it("o correlation id junta as etapas do mesmo clique", () => {
    const { linhas, restaurar } = capturar();
    const cid = novoCorrelationId();
    tracePaymentStatus({ stage: "PAYMENT_STATUS_AUTH_GUARD", correlationId: cid, targetStatus: "pago", ok: false });
    tracePaymentStatus({ stage: "PAYMENT_STATUS_MARK_RPC", correlationId: cid, targetStatus: "pago", ok: false });
    restaurar();
    const cids = linhas.map((l) => JSON.parse(l).cid);
    expect(new Set(cids).size).toBe(1);
    expect(cids[0]).toBe(cid);
  });

  it("dois cliques distintos não partilham correlation id", () => {
    expect(novoCorrelationId()).not.toBe(novoCorrelationId());
  });

  it("a severidade acompanha o resultado", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    tracePaymentStatus({ stage: "PAYMENT_STATUS_UNEXPECTED_EXCEPTION", correlationId: "c", targetStatus: "pago", ok: false });
    tracePaymentStatus({ stage: "PAYMENT_STATUS_MARK_RPC", correlationId: "c", targetStatus: "pago", ok: false });
    tracePaymentStatus({ stage: "PAYMENT_STATUS_OK", correlationId: "c", targetStatus: "pago", ok: true });
    expect(err).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("🔴 sanitização — o que nunca pode aparecer", () => {
  it("a linha só tem os campos previstos", () => {
    const { linhas, restaurar } = capturar();
    tracePaymentStatus({
      stage: "PAYMENT_STATUS_MARK_RPC", correlationId: "cid", targetStatus: "pago",
      paymentId: "pay-1", companyId: "comp-1", code: "argumentosInvalidos", ok: false,
    });
    restaurar();
    expect(Object.keys(JSON.parse(linhas[0])).sort())
      .toEqual(["cid", "code", "company", "ok", "payment", "stage", "t", "target", "ts"]);
  });

  it("um `code` da allowlist passa exactamente como é", () => {
    const { linhas, restaurar } = capturar();
    for (const c of PAYMENT_STATUS_CODES) {
      tracePaymentStatus({
        stage: "PAYMENT_STATUS_MARK_RPC", correlationId: "c", targetStatus: "pago", code: c, ok: false,
      });
    }
    restaurar();
    expect(linhas.map((l) => JSON.parse(l).code)).toEqual([...PAYMENT_STATUS_CODES]);
  });

  // ── TESTES ADVERSARIAIS ───────────────────────────────────────────────────
  //
  // 🔴 A versão anterior truncava a 60 caracteres. Truncar limita o TAMANHO da
  //    fuga, não impede a fuga: os primeiros 60 caracteres de uma mensagem do
  //    Postgres chegam para levar um IBAN, uma password ou um cabeçalho. Estes
  //    testes enviam de propósito aquilo que nunca pode sair do outro lado.
  it("🔴 um `code` arbitrário nunca aparece — nem o seu início", () => {
    const hostis = [
      "IBAN PT50 0002 0123 1234 5678 9015 4 — pagamento a fornecedor",
      "password=segredo-do-cliente",
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
      "postgres://user:pw@db.example.com:5432/prod",
      "erro: duplicate key value violates unique constraint (descricao=Renda Julho)",
      "x".repeat(500),
    ];
    for (const hostil of hostis) {
      const { linhas, restaurar } = capturar();
      tracePaymentStatus({
        stage: "PAYMENT_STATUS_MARK_RPC", correlationId: "c", targetStatus: "pago",
        code: hostil, ok: false,
      });
      restaurar();
      const linha = linhas[0];
      expect(JSON.parse(linha).code, hostil).toBe("UNKNOWN_CODE");
      // Nem um pedaço do original: nenhuma palavra de 4+ caracteres sobrevive.
      for (const palavra of hostil.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 4)) {
        expect(linha, `fuga de "${palavra}"`).not.toContain(palavra);
      }
    }
  });

  it("🔴 um `paymentId` hostil não é registado — só UUID entra", () => {
    const hostis = [
      "password=segredo-do-cliente",
      "Bearer eyJhbGciOiJIUzI1NiJ9",
      "PT50 0002 0123 1234 5678 9015 4",
      "'; DROP TABLE fixed_variable_payments; --",
      "22222222-2222-4222-8222", // UUID truncado: continua a não ser UUID
    ];
    for (const hostil of hostis) {
      const { linhas, restaurar } = capturar();
      tracePaymentStatus({
        stage: "PAYMENT_STATUS_MARK_RPC", correlationId: "c", targetStatus: "pago",
        paymentId: hostil, companyId: hostil, ok: false,
      });
      restaurar();
      const l = JSON.parse(linhas[0]);
      expect(l.payment, hostil).toBeNull();
      expect(l.company, hostil).toBeNull();
      for (const palavra of hostil.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 4)) {
        expect(linhas[0], `fuga de "${palavra}"`).not.toContain(palavra);
      }
    }
  });

  it("um UUID legítimo continua a ser registado — o diagnóstico não se perdeu", () => {
    const uuid = "22222222-2222-4222-8222-222222222222";
    const { linhas, restaurar } = capturar();
    tracePaymentStatus({
      stage: "PAYMENT_STATUS_MARK_RPC", correlationId: "c", targetStatus: "pago",
      paymentId: uuid, companyId: uuid, ok: false,
    });
    restaurar();
    const l = JSON.parse(linhas[0]);
    expect(l.payment).toBe(uuid);
    expect(l.company).toBe(uuid);
  });

  it("🔴 um `targetStatus` hostil vira `invalid` — só os dois estados passam", () => {
    const { linhas, restaurar } = capturar();
    for (const alvo of ["pago", "pendente", "Bearer segredo-abc", "cancelado", "", "PAGO"]) {
      tracePaymentStatus({
        stage: "PAYMENT_STATUS_MARK_RPC", correlationId: "c", targetStatus: alvo, ok: false,
      });
    }
    restaurar();
    expect(linhas.map((l) => JSON.parse(l).target))
      .toEqual(["pago", "pendente", "invalid", "invalid", "invalid", "invalid"]);
    for (const l of linhas) {
      expect(l).not.toContain("Bearer");
      expect(l).not.toContain("segredo");
    }
  });

  it("campos ausentes ficam nulos, não indefinidos nem inventados", () => {
    const { linhas, restaurar } = capturar();
    tracePaymentStatus({ stage: "PAYMENT_STATUS_AUTH_GUARD", correlationId: "c", targetStatus: "pago", ok: false });
    restaurar();
    const l = JSON.parse(linhas[0]);
    expect(l.payment).toBeNull();
    expect(l.company).toBeNull();
    expect(l.code).toBeNull();
  });

  it("o módulo não referencia nada sensível", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "observability", "payment-status-trace.ts"),
      "utf8",
    ).replace(/^\s*\/\/.*$/gm, "");
    for (const proibido of [
      "cookie", "Authorization", "SERVICE_ROLE", "SUPABASE_DB_URL", "DATABASE_URL",
      "password", "token", "description", "attachment", "email", "phone", "process.env",
    ]) {
      expect(fonte.toLowerCase(), `menciona ${proibido}`).not.toContain(proibido.toLowerCase());
    }
  });

  it("a action não passa descrição, anexo nem env para o rasto", () => {
    const chamadas = ACTION.match(/tracePaymentStatus\(\{[\s\S]*?\}\)/g) ?? [];
    expect(chamadas.length).toBeGreaterThanOrEqual(6);
    for (const c of chamadas) {
      for (const proibido of ["description", "attachment", "process.env", "notes", "amount"]) {
        expect(c, `chamada com ${proibido}`).not.toContain(proibido);
      }
    }
  });
});

describe("a instrumentação não muda comportamento", () => {
  it("todas as etapas de falha continuam a devolver erro, nenhuma vira sucesso", () => {
    const corpo = ACTION.slice(
      ACTION.indexOf("export async function setPaymentStatus"),
      ACTION.indexOf("export async function deletePayment"),
    );
    // Cada trace de falha é seguido de um `return` de erro — nunca de `ok: true`.
    //
    // 🔴 A captura tem de ser não-gananciosa até ao PRIMEIRO `return`: um
    //    `[\s\S]*?` largo atravessa o bloco seguinte e apanha o `return
    //    { ok: true }` do caminho de sucesso, dando um falso vermelho.
    const falhas = corpo.match(/ok: false,\s*\}\);\s*return [^;]+;/g) ?? [];
    expect(falhas.length).toBeGreaterThanOrEqual(5);
    for (const f of falhas) {
      expect(f, f).not.toMatch(/return\s*\{\s*ok:\s*true/);
    }
  });

  it("não nasceu caminho alternativo de escrita", () => {
    const corpo = ACTION.slice(
      ACTION.indexOf("export async function setPaymentStatus"),
      ACTION.indexOf("export async function deletePayment"),
    );
    // As únicas escritas continuam a ser as RPCs canónicas e o UPDATE dos
    // outros estados (`cancelado`, …), que já existia.
    expect(corpo).toContain("marcarPagamentoPago");
    expect(corpo).toContain("desmarcarPagamentoPago");
    expect((corpo.match(/\.insert\(/g) ?? []).length).toBe(0);
    expect((corpo.match(/\.delete\(/g) ?? []).length).toBe(0);
  });

  it("o guard de papéis continua a ser admin/gestor", () => {
    const corpo = ACTION.slice(ACTION.indexOf("export async function setPaymentStatus"));
    expect(corpo).toMatch(/requireProfile\(\{\s*roles:\s*\["admin",\s*"gestor"\]\s*\}\)/);
  });
});
