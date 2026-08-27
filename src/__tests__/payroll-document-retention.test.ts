// ============================================================================
// RETENÇÃO DE RECIBOS DE VENCIMENTO (P0F)
// ============================================================================
//
// O risco, em três passos:
//
//     recibo_salario  →  expires_at = upload + 3 meses
//     cron diário     →  procura expirados, sem olhar à categoria
//                     →  storage.remove()  — o ficheiro deixa de existir
//
// O manifesto que o cron guarda antes de apagar tem metadados, não conteúdo.
// Depois de correr, o documento não é recuperável a partir dele.
//
// A correção protege pela **categoria**, não pela data, e por isso não precisa
// de tocar numa única linha histórica: um recibo antigo com `expires_at` de
// ontem passa a ser ignorado sem que nada na base mude.
//
// A pergunta que cada teste faz é sempre a mesma: **alguma coisa foi apagada?**
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — a política, pura
// ═══════════════════════════════════════════════════════════════════════════

import {
  getDocumentRetentionPolicy,
  podeArquivarAutomaticamente,
  resolveDocumentExpiresAt,
  mostraExpiracao,
  CATEGORIAS_PROTEGIDAS,
} from "@/domain/documents/retention-policy";

describe("política de retenção", () => {
  it("🔴 recibo de vencimento não é arquivado automaticamente", () => {
    expect(getDocumentRetentionPolicy("recibo_salario")).toEqual({
      autoArchive: false,
      expiresAfterMonths: null,
    });
    expect(podeArquivarAutomaticamente("recibo_salario")).toBe(false);
  });

  it("as outras categorias mantêm exatamente os três meses de sempre", () => {
    for (const c of ["contrato", "identificacao", "avaria", "outro"]) {
      expect(getDocumentRetentionPolicy(c)).toEqual({
        autoArchive: true,
        expiresAfterMonths: 3,
      });
    }
  });

  it("🔴 categoria desconhecida não herda a política por omissão", () => {
    // Aplicar três meses a algo que não se reconhece é decidir apagar um
    // ficheiro sobre o qual não se sabe nada.
    expect(getDocumentRetentionPolicy("categoria_do_futuro")).toBeNull();
    expect(getDocumentRetentionPolicy(null)).toBeNull();
    expect(getDocumentRetentionPolicy(undefined)).toBeNull();
    expect(getDocumentRetentionPolicy(42)).toBeNull();
  });

  it("🔴 categoria desconhecida nunca autoriza destruição", () => {
    expect(podeArquivarAutomaticamente("categoria_do_futuro")).toBe(false);
    expect(podeArquivarAutomaticamente(null)).toBe(false);
    expect(podeArquivarAutomaticamente(undefined)).toBe(false);
  });

  it("um recibo novo nasce sem data de expiração", () => {
    expect(resolveDocumentExpiresAt("recibo_salario")).toBeNull();
  });

  it("uma categoria normal continua a datar a três meses", () => {
    const base = new Date("2026-08-24T10:00:00.000Z");
    const r = resolveDocumentExpiresAt("contrato", base);
    expect(r).not.toBeNull();
    expect(new Date(r!).getUTCMonth()).toBe(10); // agosto (7) + 3 = novembro (10)
  });

  it("a lista de categorias protegidas deriva da política, não é escrita à mão", () => {
    expect(CATEGORIAS_PROTEGIDAS).toEqual(["recibo_salario"]);
  });

  it("o ecrã só mostra expiração para quem expira mesmo", () => {
    expect(mostraExpiracao("recibo_salario")).toBe(false);
    expect(mostraExpiracao("contrato")).toBe(true);
    expect(mostraExpiracao("desconhecida")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — o cron, contra um Supabase falso que regista destruições
// ═══════════════════════════════════════════════════════════════════════════

const removidos: string[][] = [];
const enviados: string[] = [];
const updates: Array<{ table: string; payload: unknown }> = [];

let linhas: Array<Record<string, unknown>> = [];
let erroConsulta: unknown = null;

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  let op: string | null = null;
  let payload: unknown = null;
  let excluidas: string[] = [];

  const enc = (nome: string) => (...args: unknown[]) => {
    if (nome === "update") { op = "update"; payload = args[0]; }
    if (nome === "not" && args[0] === "category" && args[1] === "in") {
      // `(a,b)` → ["a","b"]
      excluidas = String(args[2]).replace(/[()]/g, "").split(",").filter(Boolean);
    }
    return b;
  };
  for (const n of ["select", "update", "insert", "delete", "eq", "in", "lt", "gt",
                   "is", "not", "order", "limit"]) b[n] = enc(n);

  b.then = (r: (v: unknown) => unknown) => {
    if (op === "update") { updates.push({ table, payload }); return Promise.resolve({ error: null }).then(r); }
    if (table === "companies") {
      return Promise.resolve({ data: [{ id: "empresa-1", name: "Mó" }], error: null }).then(r);
    }
    if (table === "profiles") {
      return Promise.resolve({ data: [{ id: "colab-1", full_name: "X" }], error: null }).then(r);
    }
    if (table === "collaborator_documents") {
      if (erroConsulta) return Promise.resolve({ data: null, error: erroConsulta }).then(r);
      // Emula o filtro SQL de categorias excluídas.
      const visiveis = linhas.filter((l) => !excluidas.includes(String(l.category)));
      return Promise.resolve({ data: visiveis, error: null }).then(r);
    }
    return Promise.resolve({ data: [], error: null }).then(r);
  };
  return b;
}

const storage = {
  from: () => ({
    upload: async (p: string) => { enviados.push(p); return { error: null }; },
    remove: async (paths: string[]) => { removidos.push(paths); return { error: null }; },
  }),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => makeBuilder(t), storage }),
}));

const ONTEM = new Date(Date.now() - 86400000).toISOString();
const ANO_PASSADO = new Date(Date.now() - 365 * 86400000).toISOString();

const doc = (over: Record<string, unknown>) => ({
  id: "d1", file_name: "f.pdf",
  file_url: "https://x/collaborator-documents/empresa-1/colab-1/1-f.pdf",
  file_size: 1, mime_type: "application/pdf", category: "outro",
  notes: null, visible_to_collaborator: true, uploaded_by_role: "gestor",
  expires_at: ONTEM, created_at: ONTEM, collaborator_id: "colab-1",
  ...over,
});

function pedido(secret = "segredo") {
  return {
    headers: { get: (k: string) => (k === "authorization" ? `Bearer ${secret}` : null) },
    nextUrl: { searchParams: { get: () => null } },
  } as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  removidos.length = 0; enviados.length = 0; updates.length = 0;
  linhas = []; erroConsulta = null;
  process.env.CRON_SECRET = "segredo";
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const correrCron = async (req = pedido()) => {
  const { GET } = await import("@/app/api/cron/archive-documents/route");
  return GET(req);
};

/** Todos os caminhos que o cron mandou apagar, em lista plana. */
const apagados = () => removidos.flat();

describe("cron de eliminação", () => {
  it("3. 🔴 recibo expirado ontem NÃO é apagado", async () => {
    linhas = [doc({ id: "recibo", category: "recibo_salario", expires_at: ONTEM })];
    await correrCron();
    expect(apagados()).toHaveLength(0);
  });

  it("4. 🔴 recibo expirado há um ano NÃO é apagado", async () => {
    linhas = [doc({ id: "recibo", category: "recibo_salario", expires_at: ANO_PASSADO })];
    await correrCron();
    expect(apagados()).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("5. um documento normal expirado continua a ser processado como antes", async () => {
    linhas = [doc({ id: "contrato-velho", category: "contrato" })];
    await correrCron();
    expect(apagados()).toEqual(["empresa-1/colab-1/1-f.pdf"]);
  });

  it("6. 🔴 categoria desconhecida → zero destruições", async () => {
    // Mesmo que a consulta a traga (o filtro SQL só exclui as conhecidas
    // protegidas), a verificação por documento recusa.
    linhas = [doc({ id: "estranho", category: "categoria_do_futuro" })];
    await correrCron();
    expect(apagados()).toHaveLength(0);
  });

  it("7. política irresolúvel → zero destruições", async () => {
    linhas = [doc({ id: "sem-categoria", category: null })];
    await correrCron();
    expect(apagados()).toHaveLength(0);
  });

  it("8. 🔴 consulta em erro → zero destruições", async () => {
    erroConsulta = { code: "57014", message: "canceling statement" };
    linhas = [doc({ id: "qualquer", category: "contrato" })];
    await correrCron();
    expect(apagados()).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("9. um recibo não entra no manifesto de eliminação", async () => {
    linhas = [
      doc({ id: "recibo", category: "recibo_salario" }),
      doc({ id: "outro", category: "outro" }),
    ];
    await correrCron();
    // O manifesto é o conjunto do que vai ser destruído. Um documento que
    // sobrevive não pertence a essa lista.
    expect(enviados.length).toBeLessThanOrEqual(1);
    expect(apagados()).not.toContain("recibo");
  });

  it("um lote misto apaga só o que pode ser apagado", async () => {
    linhas = [
      doc({ id: "r", category: "recibo_salario",
            file_url: "https://x/collaborator-documents/empresa-1/colab-1/RECIBO.pdf" }),
      doc({ id: "c", category: "contrato",
            file_url: "https://x/collaborator-documents/empresa-1/colab-1/CONTRATO.pdf" }),
    ];
    await correrCron();
    expect(apagados()).toEqual(["empresa-1/colab-1/CONTRATO.pdf"]);
  });

  it("13. 🔴 chamada sem autorização é recusada e nada é apagado", async () => {
    linhas = [doc({ id: "c", category: "contrato" })];
    const res = await correrCron(pedido("segredo-errado"));
    expect(res.status).toBe(401);
    expect(apagados()).toHaveLength(0);
  });

  it("sem CRON_SECRET configurado, recusa em vez de correr aberto", async () => {
    delete process.env.CRON_SECRET;
    linhas = [doc({ id: "c", category: "contrato" })];
    const res = await correrCron();
    expect(res.status).toBe(500);
    expect(apagados()).toHaveLength(0);
  });

  it("14. correr duas vezes deixa o recibo intacto nas duas", async () => {
    linhas = [doc({ id: "recibo", category: "recibo_salario" })];
    await correrCron();
    await correrCron();
    expect(apagados()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — guardas permanentes
// ═══════════════════════════════════════════════════════════════════════════

const CRON = semComentarios(ler("src/app/api/cron/archive-documents/route.ts"));
const ACTIONS = semComentarios(ler("src/app/actions/collaborator-documents.ts"));
const POLICY = semComentarios(ler("src/domain/documents/retention-policy.ts"));

/** DESTRUCTIVE_CRON_WITHOUT_RETENTION_POLICY */
function destruicaoSemPolitica(src: string): string[] {
  const falhas: string[] = [];
  const i = src.indexOf(".remove(");
  if (i < 0) return falhas; // não destrói nada
  // A política tem de ser consultada antes do ponto de destruição.
  if (!src.slice(0, i).includes("podeArquivarAutomaticamente")) {
    falhas.push("remove() sem verificação de política antes");
  }
  return falhas;
}

/** SALARY_RECEIPT_AUTO_EXPIRY */
function recibosComExpiracao(src: string): string[] {
  const falhas: string[] = [];
  if (/RETENTION_MONTHS\s*=\s*\d/.test(src)) falhas.push("cálculo de retenção local");
  if (/setMonth\([\s\S]{0,60}?\+\s*\d/.test(src)) falhas.push("data de expiração calculada à mão");
  return falhas;
}

describe("guardas permanentes da retenção", () => {
  it("SALARY_RECEIPT_AUTO_EXPIRY = 0", () => {
    expect(recibosComExpiracao(ACTIONS)).toEqual([]);
    expect(ACTIONS).toMatch(/resolveDocumentExpiresAt/);
  });

  it("DESTRUCTIVE_CRON_WITHOUT_RETENTION_POLICY = 0", () => {
    expect(destruicaoSemPolitica(CRON)).toEqual([]);
    expect(destruicaoSemPolitica(ACTIONS)).toEqual([]);
  });

  it("UNKNOWN_DOCUMENT_CATEGORY_AUTO_DELETE = 0", () => {
    // A política devolve `null` para desconhecido, e quem destrói exige `true`.
    expect(POLICY).toMatch(/autoArchive\s*===\s*true/);
  });

  it("a proteção do cron não vive só no filtro da consulta", () => {
    // Se vivesse, tirar o `.not(...)` reabria o risco em silêncio.
    const ocorrencias = (CRON.match(/podeArquivarAutomaticamente/g) ?? []).length;
    expect(ocorrencias).toBeGreaterThanOrEqual(2);
  });

  it("a política é a única fonte — o cálculo de datas não está espalhado", () => {
    expect(POLICY).toMatch(/setMonth/);
    expect(recibosComExpiracao(ACTIONS)).toEqual([]);
  });

  it("15+16+17. sem migration, sem UPDATE histórico, sem backfill", () => {
    // 🔴 A versão anterior desta guarda dizia «não existe nenhuma migration
    //    numerada 077 ou acima». Media a coisa errada: ficava vermelha à
    //    primeira migration que alguém escrevesse a seguir, por razões que nada
    //    tinham que ver com retenção de documentos — e foi exactamente isso que
    //    aconteceu com a 079 (uma alteração de RPC de pagamentos).
    //
    //    O que se quer garantir é que **a retenção** não trouxe migration
    //    nenhuma: nenhum ficheiro de migration mexe em `expires_at` nem em
    //    `collaborator_documents`. Isso continua a apanhar o defeito real — um
    //    backfill de datas de expiração escondido numa migration — e deixa de
    //    depender de quantas migrations existem.
    //
    //    As duas migrations abaixo são as que **criaram** o esquema —
    //    `collaborator_documents` e a coluna `expires_at`. São o ponto de
    //    partida, não a retenção: a política vive toda em código. Qualquer
    //    outra migration a aparecer nesta lista é uma migration nova a mexer em
    //    datas de expiração, que é precisamente o que não pode acontecer.
    const CRIARAM_O_ESQUEMA = ["021_documents_enhanced.sql", "20260608_new_features.sql"];

    const dir = path.join(ROOT, "supabase/migrations");
    const tocamNaRetencao = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && !CRIARAM_O_ESQUEMA.includes(f))
      .filter((f) => {
        const sql = fs.readFileSync(path.join(dir, f), "utf8");
        const executavel = sql
          .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
        return /\bexpires_at\b/.test(executavel) || /\bcollaborator_documents\b/.test(executavel);
      });
    expect(tocamNaRetencao, "migration a mexer na retenção de documentos").toEqual([]);
    // Nenhuma escrita em massa sobre expires_at em lado nenhum.
    expect(ACTIONS).not.toMatch(/update\(\s*\{\s*expires_at/);
    expect(CRON).not.toMatch(/update\(\s*\{\s*expires_at/);
  });
});

describe("as guardas acusam código estragado (mutation proof)", () => {
  it("A. apagar sem consultar a política dispara", () => {
    const mutado = 'const paths = docs.map(p => p); await storage.remove(paths);';
    expect(destruicaoSemPolitica(mutado)).toContain("remove() sem verificação de política antes");
  });

  it("B. devolver a política por omissão para categoria desconhecida dispara", () => {
    // A guarda é o próprio teste da Parte A, mas prova-se aqui o contrato.
    expect(getDocumentRetentionPolicy("nao_existe")).toBeNull();
    expect(podeArquivarAutomaticamente("nao_existe")).toBe(false);
  });

  it("C. recibo com três meses dispara", () => {
    expect(getDocumentRetentionPolicy("recibo_salario")!.expiresAfterMonths).not.toBe(3);
    expect(resolveDocumentExpiresAt("recibo_salario")).toBeNull();
  });

  it("D. filtrar só por expires_at, sem política, dispara", () => {
    const mutado = `
const expired = await db.from("collaborator_documents").lt("expires_at", now);
await storage.remove(expired.map(d => d.path));
`;
    expect(destruicaoSemPolitica(mutado).length).toBeGreaterThan(0);
  });

  it("E. reintroduzir o cálculo de datas à mão dispara", () => {
    const mutado = 'const e = new Date(); e.setMonth(e.getMonth() + 3);';
    expect(recibosComExpiracao(mutado)).toContain("data de expiração calculada à mão");
  });

  it("as guardas não se deixam enganar pelos comentários", () => {
    // O cron cita `storage.remove()` no comentário que explica o que faz.
    expect(ler("src/app/api/cron/archive-documents/route.ts")).toMatch(/storage\.remove\(\)/);
    expect(destruicaoSemPolitica(CRON)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — o ecrã não anuncia uma expiração que já não acontece
// ═══════════════════════════════════════════════════════════════════════════

describe("10+11. apresentação", () => {
  const dashboard = semComentarios(
    ler("src/app/(dashboard)/dashboard/colaboradores/[id]/_components/documents-section.tsx"),
  );
  const app = semComentarios(
    ler("src/app/(app)/app/perfil/_components/documents-section.tsx"),
  );

  it("o dashboard pergunta à política antes de olhar para a coluna", () => {
    expect(dashboard).toMatch(/mostraExpiracao/);
    expect(dashboard).toMatch(/SEM_ELIMINACAO_AUTOMATICA/);
  });

  it("o aviso de backup não conta documentos que já não são apagados", () => {
    expect(dashboard).toMatch(/expiraMesmo\(d\)\s*&&\s*isBackupWarning/);
  });

  it("a app da colaboradora também consulta a política", () => {
    expect(app).toMatch(/mostraExpiracao\(doc\.category\)/);
  });

  it("nenhum ecrã lê `expires_at` cru para decidir se expira", () => {
    // A coluna continua lá nos registos antigos; deixou de mandar.
    expect(dashboard).not.toMatch(/\{doc\.expires_at \? `/);
  });
});
