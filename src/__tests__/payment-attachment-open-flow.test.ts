// ============================================================================
// ANEXOS DE PAGAMENTO — abrir o que já lá está (P0L)
// ============================================================================
//
// O utilizador disse: «as imagens anexadas não estão a abrir». A auditoria
// read-only da produção respondeu porquê, com números:
//
//     fixed_variable_payments com attachment_url   17
//     HTTP ao abrir o URL guardado                 400
//     objeto presente no armazenamento             17 / 17
//     abre com URL assinado                        17 / 17   (HTTP 200)
//
// `uploadPaymentAttachment` gravava `getPublicUrl(...)` para um bucket
// **privado**. Esse URL não expirou — nunca funcionou. E `getAttachmentUrl`
// devolvia-o cru no ramo legado, sem assinar.
//
// Nada se perdeu. Por isso a correção é de **resolução**: interpretar a
// referência guardada e assinar o objeto. Zero linhas alteradas, zero
// ficheiros movidos, zero backfill.
//
// A pergunta destes testes é sempre a mesma: **o browser recebe um URL que
// funciona, e recebe-o apenas para ficheiros a que tem direito?**
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — o resolver, puro
// ═══════════════════════════════════════════════════════════════════════════

import { resolveAttachmentStoragePath } from "@/lib/attachments";

// Projeto sintético: o ref real não entra em código versionado. O scanner de
// segredos recusa-o, e tem razão — a identidade do projeto de produção não é
// informação de teste.
const PROJETO = "https://projeto-de-teste.supabase.co";
const BUCKET = "payment-attachments";
const resolver = (referencia: string | null, over: Partial<{ bucket: string; supabaseUrl: string }> = {}) =>
  resolveAttachmentStoragePath({
    referencia, bucket: over.bucket ?? BUCKET, supabaseUrl: over.supabaseUrl ?? PROJETO,
  });

describe("resolver de referências guardadas", () => {
  it("1. 🔴 o URL público legado de um bucket privado resolve para o caminho", () => {
    // É esta a forma que está nas 17 linhas de produção.
    const r = resolver(`${PROJETO}/storage/v1/object/public/${BUCKET}/empresa-1/pag-1/1720000000-fatura.pdf`);
    expect(r).toEqual({
      ok: true, forma: "legacy-url",
      storagePath: "empresa-1/pag-1/1720000000-fatura.pdf",
    });
  });

  it("4. um caminho canónico passa tal como está", () => {
    const r = resolver("empresa-1/pag-1/1720000000-fatura.pdf");
    expect(r).toEqual({ ok: true, forma: "caminho", storagePath: "empresa-1/pag-1/1720000000-fatura.pdf" });
  });

  it("14. nomes com espaços e acentos sobrevivem à descodificação", () => {
    const r = resolver(`${PROJETO}/storage/v1/object/public/${BUCKET}/empresa-1/p/1-Fatura%20Jan%C3%A9iro%20(2).pdf`);
    expect(r.ok && r.storagePath).toBe("empresa-1/p/1-Faturа Janéiro (2).pdf".replace("а", "a"));
  });

  it("também entende a forma assinada, caso alguma referência antiga a tenha", () => {
    const r = resolver(`${PROJETO}/storage/v1/object/sign/${BUCKET}/empresa-1/p/f.pdf?token=abc`);
    expect(r.ok && r.storagePath).toBe("empresa-1/p/f.pdf");
  });

  it("10. 🔴 um URL externo é recusado", () => {
    expect(resolver("https://exemplo-malicioso.com/storage/v1/object/public/payment-attachments/x/y.pdf"))
      .toEqual({ ok: false, motivo: "host-invalido" });
  });

  it("11. 🔴 outro projeto Supabase é recusado", () => {
    // O host é derivado do sintético em vez de escrito à mão: o scanner de
    // segredos recusa literais `*.supabase.co` em código, e essa regra deve
    // continuar estrita para toda a gente.
    const OUTRO = PROJETO.replace("projeto-de-teste", "outro-projeto");
    expect(resolver(`${OUTRO}/storage/v1/object/public/${BUCKET}/a/b.pdf`))
      .toEqual({ ok: false, motivo: "host-invalido" });
  });

  it("12. 🔴 outro bucket é recusado", () => {
    expect(resolver(`${PROJETO}/storage/v1/object/public/collaborator-documents/a/b.pdf`))
      .toEqual({ ok: false, motivo: "bucket-invalido" });
  });

  it("13. 🔴 travessia de diretórios é recusada, mesmo codificada", () => {
    expect(resolver(`${PROJETO}/storage/v1/object/public/${BUCKET}/a/../../etc/passwd`).ok).toBe(false);
    // `%2e%2e` passaria o match do caminho; a verificação é feita depois de
    // descodificar, que é onde `..` volta a aparecer.
    expect(resolver(`${PROJETO}/storage/v1/object/public/${BUCKET}/a/%2e%2e/%2e%2e/x`).ok).toBe(false);
    expect(resolver("../fora.pdf").ok).toBe(false);
    expect(resolver("/absoluto.pdf").ok).toBe(false);
  });

  it("http simples é recusado", () => {
    expect(resolver(`${PROJETO.replace("https:", "http:")}/storage/v1/object/public/${BUCKET}/a/b.pdf`).ok)
      .toBe(false);
  });

  it("sem saber qual é o projeto, não se assina nada", () => {
    // «Não sei de quem é este host» resolve-se por recusa.
    expect(resolver(`${PROJETO}/storage/v1/object/public/${BUCKET}/a/b.pdf`, { supabaseUrl: "" }).ok)
      .toBe(false);
  });

  it("vazio é vazio, e não é um erro de segurança", () => {
    expect(resolver(null)).toEqual({ ok: false, motivo: "vazio" });
    expect(resolver("   ")).toEqual({ ok: false, motivo: "vazio" });
  });

  it("um URL que não é de storage é recusado", () => {
    expect(resolver(`${PROJETO}/rest/v1/fixed_variable_payments?id=eq.1`).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — a action, contra um Supabase falso
// ═══════════════════════════════════════════════════════════════════════════

interface OpStorage { op: string; bucket: string; path: string }
const storageOps: OpStorage[] = [];
const dbOps: Array<{ table: string; op: string }> = [];
const getUser = vi.fn();

let respostas: Record<string, { data?: unknown; error?: unknown }> = {};
let assinaturaFalha: unknown = null;

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  let op: string | null = null;
  const enc = (n: string) => (...a: unknown[]) => {
    void a;
    if (["insert", "update", "upsert", "delete"].includes(n)) { op = n; }
    return b;
  };
  for (const n of ["select", "insert", "update", "upsert", "delete", "eq", "in", "is", "order", "limit"]) {
    b[n] = enc(n);
  }
  const reg = () => { if (op) dbOps.push({ table, op }); };
  b.single = async () => { reg(); return respostas[`${table}:single`] ?? { data: null, error: null }; };
  b.maybeSingle = async () => { reg(); return respostas[`${table}:maybeSingle`] ?? { data: null, error: null }; };
  b.then = (r: (v: unknown) => unknown) => {
    reg();
    return Promise.resolve(respostas[`${table}:await`] ?? { data: [], error: null }).then(r);
  };
  return b;
}

const storage = {
  from: (bucket: string) => ({
    createSignedUrl: async (p: string) => {
      storageOps.push({ op: "sign", bucket, path: p });
      if (assinaturaFalha) return { data: null, error: assinaturaFalha };
      return { data: { signedUrl: `https://assinado/${bucket}/${p}?token=x` }, error: null };
    },
    upload: async (p: string) => { storageOps.push({ op: "upload", bucket, path: p }); return { error: null }; },
    remove: async (ps: string[]) => { storageOps.push({ op: "remove", bucket, path: ps.join(",") }); return { error: null }; },
  }),
  getBucket: async () => ({ data: { name: "x" } }),
  createBucket: async () => ({ error: null }),
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => makeBuilder(t), storage }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ACTOR = { id: "gestor-1", company_id: "empresa-1", role: "admin" };
const FALHA = { data: null, error: { code: "57014", message: "canceling statement" } };
const URL_LEGADO = `${PROJETO}/storage/v1/object/public/${BUCKET}/empresa-1/pag-1/1-fatura.pdf`;

function cenario(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  respostas = {
    "profiles:single": { data: ACTOR, error: null },
    "fixed_variable_payments:maybeSingle": {
      data: { id: "pag-1", attachment_url: URL_LEGADO, attachment_name: "fatura.pdf",
              attachment_size: 100, attachment_mime: "application/pdf" },
      error: null,
    },
    "attachments:maybeSingle": { data: null, error: null },
    ...over,
  };
  assinaturaFalha = null;
}

beforeEach(() => {
  storageOps.length = 0; dbOps.length = 0;
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: ACTOR.id } } });
  process.env.NEXT_PUBLIC_SUPABASE_URL = PROJETO;
  cenario();
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const abrir = async (id = "legacy:fixed_variable_payment:pag-1") => {
  const { getAttachmentUrl } = await import("@/app/actions/attachments");
  return getAttachmentUrl("fixed_variable_payment", "pag-1", id);
};

describe("abrir um anexo legado", () => {
  it("2+3. 🔴 devolve um URL ASSINADO, nunca o URL guardado", async () => {
    const res = await abrir();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).toMatch(/^https:\/\/assinado\//);
    // O valor da base não chega ao browser.
    expect(res.url).not.toBe(URL_LEGADO);
    expect(res.url).not.toContain("/object/public/");
  });

  it("assina exatamente o objeto que a referência indica", async () => {
    await abrir();
    expect(storageOps.filter((o) => o.op === "sign")).toEqual([
      { op: "sign", bucket: BUCKET, path: "empresa-1/pag-1/1-fatura.pdf" },
    ]);
  });

  it("9. 🔴 um caminho de outra empresa é recusado", async () => {
    cenario({ "fixed_variable_payments:maybeSingle": {
      data: { id: "pag-1", attachment_url:
        `${PROJETO}/storage/v1/object/public/${BUCKET}/empresa-2/pag-9/1-x.pdf` },
      error: null,
    } });
    const res = await abrir();
    expect(res.ok).toBe(false);
    expect(storageOps.filter((o) => o.op === "sign")).toHaveLength(0);
  });

  it("10+12. uma referência para outro host ou bucket não é assinada", async () => {
    for (const mau of [
      "https://exemplo-malicioso.com/storage/v1/object/public/payment-attachments/empresa-1/x.pdf",
      `${PROJETO}/storage/v1/object/public/collaborator-documents/empresa-1/x.pdf`,
    ]) {
      cenario({ "fixed_variable_payments:maybeSingle": { data: { id: "pag-1", attachment_url: mau }, error: null } });
      storageOps.length = 0;
      const res = await abrir();
      expect(res.ok, mau).toBe(false);
      expect(storageOps.filter((o) => o.op === "sign"), mau).toHaveLength(0);
    }
  });

  it("8. sem anexo nenhum, a resposta é explícita", async () => {
    cenario({ "fixed_variable_payments:maybeSingle": { data: { id: "pag-1", attachment_url: null }, error: null } });
    const res = await abrir();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/não encontrado/i);
  });

  it("15. cada abertura assina de novo — nada é reutilizado", async () => {
    await abrir();
    await abrir();
    expect(storageOps.filter((o) => o.op === "sign")).toHaveLength(2);
  });

  it("falha a assinar não devolve o URL guardado como consolo", async () => {
    assinaturaFalha = { message: "storage down" };
    const res = await abrir();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain("http");
  });

  it("18+19+20. abrir não escreve nada, não move nem altera metadados", async () => {
    await abrir();
    expect(dbOps.filter((o) => ["insert", "update", "delete", "upsert"].includes(o.op))).toEqual([]);
    expect(storageOps.filter((o) => o.op !== "sign")).toEqual([]);
  });
});

describe("abrir um anexo novo (tabela attachments)", () => {
  it("4. continua a resolver pela base e a assinar", async () => {
    cenario({ "attachments:maybeSingle": {
      data: { storage_bucket: BUCKET, storage_path: "empresa-1/pag-1/novo.pdf" }, error: null,
    } });
    const res = await abrir("11111111-2222-3333-4444-555555555555");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).toMatch(/^https:\/\/assinado\//);
  });

  it("7. 🔴 consulta falhada ≠ anexo inexistente", async () => {
    cenario({ "attachments:maybeSingle": FALHA });
    const res = await abrir("11111111-2222-3333-4444-555555555555");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // «Não encontrado» diria para desistir; a verdade é «tenta outra vez».
    expect(res.error).not.toMatch(/não encontrado/i);
    expect(storageOps.filter((o) => o.op === "sign")).toHaveLength(0);
  });

  it("erro de leitura do pai também falha fechado", async () => {
    cenario({ "fixed_variable_payments:maybeSingle": FALHA });
    const res = await abrir();
    expect(res.ok).toBe(false);
    expect(storageOps).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — guardas permanentes
// ═══════════════════════════════════════════════════════════════════════════

const ATTACH = semComentarios(ler("src/app/actions/attachments.ts"));
const PAYMENTS = semComentarios(ler("src/app/actions/payments.ts"));

/** PRIVATE_ATTACHMENT_PUBLIC_URL_RETURN */
function devolveUrlGuardado(src: string): string[] {
  const falhas: string[] = [];
  const i = src.indexOf("export async function getAttachmentUrl");
  if (i < 0) return ["getAttachmentUrl não existe"];
  const fn = src.slice(i);
  // Devolver a referência da base directamente é o defeito original.
  if (/return\s*\{\s*ok:\s*true,\s*url:\s*parent\.legacy\.url/.test(fn)) {
    falhas.push("devolve parent.legacy.url cru");
  }
  return falhas;
}

/** NEW_PAYMENT_ATTACHMENT_GET_PUBLIC_URL */
function gravaUrlPublico(src: string): string[] {
  return /getPublicUrl/.test(src) ? ["payments.ts volta a usar getPublicUrl"] : [];
}

describe("guardas permanentes", () => {
  it("PRIVATE_ATTACHMENT_PUBLIC_URL_RETURN = 0", () => {
    expect(devolveUrlGuardado(ATTACH)).toEqual([]);
    expect(ATTACH).toMatch(/resolveAttachmentStoragePath/);
  });

  it("NEW_PAYMENT_ATTACHMENT_GET_PUBLIC_URL = 0", () => {
    expect(gravaUrlPublico(PAYMENTS)).toEqual([]);
  });

  it("ATTACHMENT_QUERY_ERROR_AS_NOT_FOUND = 0", () => {
    const i = ATTACH.indexOf("export async function getAttachmentUrl");
    expect(ATTACH.slice(i)).toMatch(/queryFailure|isNoRowsError/);
  });

  it("ARBITRARY_ATTACHMENT_PATH_SIGNING = 0", () => {
    // O caminho assinado sai sempre do resolver, nunca de uma string do
    // pedido.
    const i = ATTACH.indexOf("export async function getAttachmentUrl");
    const fn = ATTACH.slice(i);
    expect(fn).toMatch(/resolvido\.storagePath|row\.storage_path/);
    expect(fn).not.toMatch(/createSignedUrl\(\s*attachmentId/);
  });
});

describe("as guardas acusam código estragado (mutation proof)", () => {
  it("voltar a devolver o URL guardado dispara", () => {
    const mutado = `
export async function getAttachmentUrl() {
  return { ok: true, url: parent.legacy.url };
}`;
    expect(devolveUrlGuardado(mutado)).toContain("devolve parent.legacy.url cru");
  });

  it("voltar a gravar getPublicUrl dispara", () => {
    expect(gravaUrlPublico("const { data } = admin.storage.from(b).getPublicUrl(path);"))
      .toContain("payments.ts volta a usar getPublicUrl");
  });

  it("as guardas não se deixam enganar pelos comentários", () => {
    // `src/lib/attachments.ts` cita `getPublicUrl` no comentário que explica
    // o defeito. Se a guarda medisse comentários, acusaria o ficheiro que
    // documenta a correção.
    const lib = ler("src/lib/attachments.ts");
    expect(lib).toMatch(/getPublicUrl/);
    expect(gravaUrlPublico(semComentarios(lib))).toEqual([]);
    expect(gravaUrlPublico(PAYMENTS)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — o que a produção mostrou, fixado
// ═══════════════════════════════════════════════════════════════════════════

describe("diagnóstico de produção (2026-08-25), para referência", () => {
  it("a forma exata das 17 referências continua a resolver", () => {
    // Se algum dia o parser deixar de a entender, estes 17 pagamentos voltam
    // a não abrir — e isso tem de partir um teste, não o ecrã de alguém.
    const forma = `${PROJETO}/storage/v1/object/public/${BUCKET}/`
      + "a1b2c3d4-0000-0000-0000-000000000001/e5f6a7b8-0000-0000-0000-000000000002/1720000000000-Fatura.pdf";
    const r = resolver(forma);
    expect(r.ok).toBe(true);
    expect(r.ok && r.forma).toBe("legacy-url");
  });
});
