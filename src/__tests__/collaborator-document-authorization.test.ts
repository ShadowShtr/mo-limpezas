// ============================================================================
// DOCUMENTOS DE COLABORADOR — a fronteira de confiança (P0E)
// ============================================================================
//
// O defeito estava na assinatura da função:
//
//     uploadCollaboratorDocument(collaboratorId, companyId, file)
//
// O `companyId` vinha do browser e era usado como dono do registo e como
// prefixo do caminho no armazenamento. A função verificava que havia sessão e
// mais nada — nem papel, nem se aquela pessoa pertencia àquela empresa — e
// escrevia com o cliente administrativo, que ignora RLS.
//
// Somando: qualquer sessão autenticada podia depositar um ficheiro na ficha de
// qualquer pessoa de qualquer empresa, escolhendo o destino no pedido.
//
// Isto é blindagem do sistema legado **antes** de lhe encostarmos recibos de
// vencimento e comprovativos de pagamento. A P6 decidirá como ele convive com
// os anexos da 074; esta ronda só fecha a porta.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — os validadores puros
// ═══════════════════════════════════════════════════════════════════════════

import {
  isStoragePathInCompany,
  buildDocumentStoragePath,
  sanitizeDocumentFileName,
} from "@/lib/collaborator-documents";

describe("caminho de armazenamento", () => {
  it("aceita um caminho da própria empresa", () => {
    expect(isStoragePathInCompany("empresa-1/colab-1/123-f.pdf", "empresa-1")).toBe(true);
  });

  it("recusa outra empresa", () => {
    expect(isStoragePathInCompany("empresa-2/colab-1/123-f.pdf", "empresa-1")).toBe(false);
  });

  it("recusa prefixo parcial — «empresa-1» não é «empresa-12»", () => {
    expect(isStoragePathInCompany("empresa-12/colab/f.pdf", "empresa-1")).toBe(false);
  });

  it("recusa travessia de diretórios", () => {
    expect(isStoragePathInCompany("empresa-1/../empresa-2/f.pdf", "empresa-1")).toBe(false);
  });

  it("recusa vazios", () => {
    expect(isStoragePathInCompany("", "empresa-1")).toBe(false);
    expect(isStoragePathInCompany("empresa-1/f.pdf", "")).toBe(false);
  });

  it("o nome do ficheiro perde as barras, e nunca fica vazio", () => {
    // Os pontos sobrevivem — `..` sozinho não atravessa nada sem uma barra, e
    // extensões precisam deles. O que tem de desaparecer é o separador.
    expect(sanitizeDocumentFileName("../../etc/passwd")).not.toMatch(/\//);
    expect(sanitizeDocumentFileName("a/b/c.pdf")).toBe("a_b_c.pdf");
    expect(sanitizeDocumentFileName("!!!")).toBe("___");
    expect(sanitizeDocumentFileName("")).toBe("documento");
  });

  it("o caminho é construído a partir dos valores dados, não de um caminho recebido", () => {
    const p = buildDocumentStoragePath({
      companyId: "e1", collaboratorId: "c1", fileName: "a b/c.pdf", now: 1000,
    });
    expect(p).toBe("e1/c1/1000-a_b_c.pdf");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — as actions
// ═══════════════════════════════════════════════════════════════════════════

interface OpStorage { op: "upload" | "remove" | "sign"; paths: string[] }
interface OpDb { table: string; op: string; payload: unknown }

const storageOps: OpStorage[] = [];
const dbOps: OpDb[] = [];
const getUser = vi.fn();

type Terminal = "await" | "single" | "maybeSingle";
let respostas: Record<string, { data?: unknown; error?: unknown }> = {};
let storageFalhas: Record<string, unknown> = {};

function resposta(table: string, terminal: Terminal) {
  const chave = `${table}:${terminal}`;
  if (chave in respostas) return respostas[chave];
  if (table in respostas) return respostas[table];
  return { data: null, error: null };
}

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  let op: string | null = null;
  let payload: unknown = null;

  const encadeia = (nome: string) => (...args: unknown[]) => {
    if (["insert", "update", "upsert", "delete"].includes(nome)) {
      op = nome; payload = args[0] ?? null;
    }
    return builder;
  };
  for (const nome of [
    "select", "insert", "update", "upsert", "delete",
    "eq", "in", "gte", "lte", "lt", "gt", "neq", "is", "order", "limit",
  ]) builder[nome] = encadeia(nome);

  const registar = () => { if (op) dbOps.push({ table, op, payload }); };

  builder.single      = async () => { registar(); return resposta(table, "single"); };
  builder.maybeSingle = async () => { registar(); return resposta(table, "maybeSingle"); };
  builder.then = (r: (v: unknown) => unknown) => {
    registar();
    return Promise.resolve(resposta(table, "await")).then(r);
  };
  return builder;
}

const storage = {
  from: () => ({
    upload: async (p: string) => {
      storageOps.push({ op: "upload", paths: [p] });
      return { error: storageFalhas.upload ?? null };
    },
    remove: async (paths: string[]) => {
      storageOps.push({ op: "remove", paths });
      return { error: storageFalhas.remove ?? null };
    },
    createSignedUrl: async (p: string) => {
      storageOps.push({ op: "sign", paths: [p] });
      return { data: { signedUrl: `https://signed/${p}` }, error: null };
    },
    getPublicUrl: (p: string) => ({ data: { publicUrl: `https://x/collaborator-documents/${p}` } }),
  }),
  getBucket: async () => ({ error: null }),
  createBucket: async () => ({ error: null }),
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => makeBuilder(t), storage }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ACTOR = { id: "gestor-1", company_id: "empresa-1", role: "admin" };
const FALHA = { data: null, error: { code: "57014", message: "canceling statement" } };

function ficheiro(): FormData {
  const fd = new FormData();
  fd.set("file", new File(["x"], "recibo.pdf", { type: "application/pdf" }));
  fd.set("category", "recibo_salario");
  return fd;
}

function cenario(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  respostas = {
    "profiles:single":      { data: ACTOR, error: null },
    "profiles:maybeSingle": { data: { id: "colab-1" }, error: null },
    "collaborator_documents:single":      { data: { id: "doc-novo" }, error: null },
    "collaborator_documents:maybeSingle": { data: null, error: null },
    ...over,
  };
  storageFalhas = {};
}

beforeEach(() => {
  storageOps.length = 0;
  dbOps.length = 0;
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: ACTOR.id } } });
  cenario();
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

const upload = async (colabId = "colab-1", fd = ficheiro()) => {
  const { uploadCollaboratorDocument } = await import("@/app/actions/collaborator-documents");
  return uploadCollaboratorDocument(colabId, fd);
};

describe("upload de documento", () => {
  it("1. gestor da mesma empresa consegue carregar", async () => {
    const res = await upload();
    expect(res.ok).toBe(true);
    expect(storageOps.filter((o) => o.op === "upload")).toHaveLength(1);
    const insert = dbOps.find((o) => o.op === "insert");
    expect((insert?.payload as Record<string, string>).company_id).toBe("empresa-1");
  });

  it("2. 🔴 a empresa vem do servidor — não há por onde a enviar", async () => {
    // A prova é a própria assinatura: `companyId` deixou de ser um parâmetro.
    // Um valor em que não se pode acreditar não deve existir na entrada.
    const { uploadCollaboratorDocument } = await import("@/app/actions/collaborator-documents");
    expect(uploadCollaboratorDocument.length).toBe(2);

    const res = await upload();
    expect(res.ok).toBe(true);
    const insert = dbOps.find((o) => o.op === "insert");
    // A empresa gravada é a do ator, resolvida no servidor.
    expect((insert?.payload as Record<string, string>).company_id).toBe(ACTOR.company_id);
  });

  it("3. colaborador de outra empresa → recusa, zero escritas", async () => {
    // O filtro `.eq("company_id", ...)` faz o alvo não resolver.
    cenario({ "profiles:maybeSingle": { data: null, error: null } });
    const res = await upload("colab-de-outra-empresa");

    expect(res.ok).toBe(false);
    expect(storageOps).toHaveLength(0);
    expect(dbOps.filter((o) => o.op === "insert")).toHaveLength(0);
  });

  it("4. colaborador inexistente → mesma recusa, sem revelar a diferença", async () => {
    cenario({ "profiles:maybeSingle": { data: null, error: null } });
    const res = await upload("nao-existe");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/empresa|tenant|outra/i);
  });

  it("a consulta do alvo falha → recusa fechada, sem escrever", async () => {
    cenario({ "profiles:maybeSingle": FALHA });
    const res = await upload();
    expect(res.ok).toBe(false);
    expect(storageOps).toHaveLength(0);
  });

  it("5. 🔴 categoria inválida → zero escritas no armazenamento", async () => {
    const fd = ficheiro();
    fd.set("category", "categoria_inventada");
    const res = await upload("colab-1", fd);

    expect(res.ok).toBe(false);
    // A validação acontece ANTES do upload: um ficheiro recusado não chega a
    // existir no bucket.
    expect(storageOps).toHaveLength(0);
    expect(dbOps.filter((o) => o.op === "insert")).toHaveLength(0);
  });

  it("6. papel sem permissão → zero escritas", async () => {
    cenario({ "profiles:single": { data: { ...ACTOR, role: "colaborador" }, error: null } });
    const res = await upload();
    expect(res.ok).toBe(false);
    expect(storageOps).toHaveLength(0);
  });

  it("sem sessão → zero escritas", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await upload();
    expect(res.ok).toBe(false);
    expect(storageOps).toHaveLength(0);
  });

  it("7. 🔴 falha a registar → o ficheiro acabado de enviar é removido", async () => {
    cenario({ "collaborator_documents:single": {
      data: null, error: { code: "23503", message: "fk violation" },
    } });
    const res = await upload();

    expect(res.ok).toBe(false);
    const enviado = storageOps.find((o) => o.op === "upload")!.paths[0];
    const removido = storageOps.find((o) => o.op === "remove");
    expect(removido).toBeDefined();
    // Exatamente o objeto deste pedido — nunca um prefixo, nunca uma pasta.
    expect(removido!.paths).toEqual([enviado]);
  });

  it("8. falha a enviar → nenhuma linha na base", async () => {
    storageFalhas.upload = { message: "storage down" };
    const res = await upload();
    expect(res.ok).toBe(false);
    expect(dbOps.filter((o) => o.op === "insert")).toHaveLength(0);
  });

  it("o caminho é derivado no servidor e fica dentro da empresa", async () => {
    await upload();
    const enviado = storageOps.find((o) => o.op === "upload")!.paths[0];
    expect(enviado.startsWith("empresa-1/colab-1/")).toBe(true);
  });

  it("15. a categoria de recibo continua a funcionar e nasce visível", async () => {
    const res = await upload();
    expect(res.ok).toBe(true);
    const insert = dbOps.find((o) => o.op === "insert")!.payload as Record<string, unknown>;
    expect(insert.category).toBe("recibo_salario");
    expect(insert.visible_to_collaborator).toBe(true);
  });

  it("mensagens de falha técnica não expõem o Postgres nem o storage", async () => {
    cenario({ "collaborator_documents:single": {
      data: null, error: { code: "42P01", message: 'relation "collaborator_documents" does not exist' },
    } });
    const res = await upload();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/relation|42P01|collaborator_documents/);
  });
});

describe("apagar documento", () => {
  const apagar = async () => {
    const { deleteCollaboratorDocument } = await import("@/app/actions/collaborator-documents");
    return deleteCollaboratorDocument("doc-1", "colab-1");
  };

  it("14. apaga um documento — e só um objeto", async () => {
    cenario({ "collaborator_documents:maybeSingle": {
      data: { file_url: "https://x/collaborator-documents/empresa-1/colab-1/1-f.pdf" }, error: null,
    } });
    const res = await apagar();

    expect(res.ok).toBe(true);
    const remove = storageOps.find((o) => o.op === "remove");
    expect(remove!.paths).toEqual(["empresa-1/colab-1/1-f.pdf"]);
    expect(dbOps.filter((o) => o.op === "delete")).toHaveLength(1);
  });

  it("10. documento de outra empresa não resolve → recusa", async () => {
    cenario({ "collaborator_documents:maybeSingle": { data: null, error: null } });
    const res = await apagar();
    expect(res.ok).toBe(false);
    expect(storageOps).toHaveLength(0);
    expect(dbOps.filter((o) => o.op === "delete")).toHaveLength(0);
  });

  it("13. 🔴 falha a apagar do armazenamento → a referência fica", async () => {
    // Das duas inconsistências possíveis, escolhe-se a visível. Ficheiro sem
    // registo é invisível e permanente; registo sem ficheiro é recuperável.
    cenario({ "collaborator_documents:maybeSingle": {
      data: { file_url: "https://x/collaborator-documents/empresa-1/colab-1/1-f.pdf" }, error: null,
    } });
    storageFalhas.remove = { message: "storage down" };

    const res = await apagar();

    expect(res.ok).toBe(false);
    expect(dbOps.filter((o) => o.op === "delete")).toHaveLength(0);
  });

  it("uma consulta falhada não é um documento inexistente", async () => {
    cenario({ "collaborator_documents:maybeSingle": FALHA });
    const res = await apagar();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/não encontrado/i);
    expect(dbOps.filter((o) => o.op === "delete")).toHaveLength(0);
  });

  it("um registo com caminho fora da empresa não faz apagar nada", async () => {
    cenario({ "collaborator_documents:maybeSingle": {
      data: { file_url: "https://x/collaborator-documents/empresa-2/colab-9/1-f.pdf" }, error: null,
    } });
    const res = await apagar();
    expect(res.ok).toBe(false);
    expect(storageOps.filter((o) => o.op === "remove")).toHaveLength(0);
  });
});

describe("link temporário", () => {
  const assinar = async (url: string) => {
    const { getSignedDocumentUrl } = await import("@/app/actions/collaborator-documents");
    return getSignedDocumentUrl(url);
  };

  const URL_OK = "https://x/collaborator-documents/empresa-1/colab-1/1-f.pdf";

  it("11+12. 🔴 um caminho arbitrário não se assina — resolve-se pela base", async () => {
    // Não existe documento com este URL: não há nada para assinar, por muito
    // bem formado que o caminho esteja.
    cenario({ "collaborator_documents:maybeSingle": { data: null, error: null } });
    const res = await assinar("https://x/collaborator-documents/empresa-1/colab-1/inventado.pdf");

    expect(res.ok).toBe(false);
    expect(storageOps.filter((o) => o.op === "sign")).toHaveLength(0);
  });

  it("um documento registado é assinado", async () => {
    cenario({ "collaborator_documents:maybeSingle": {
      data: { file_url: URL_OK, collaborator_id: "colab-1", visible_to_collaborator: true },
      error: null,
    } });
    const res = await assinar(URL_OK);
    expect(res.ok).toBe(true);
    expect(storageOps.filter((o) => o.op === "sign")).toHaveLength(1);
  });

  it("11. documento de outra empresa não resolve → recusa", async () => {
    cenario({ "collaborator_documents:maybeSingle": { data: null, error: null } });
    const res = await assinar("https://x/collaborator-documents/empresa-2/colab-9/1-f.pdf");
    expect(res.ok).toBe(false);
  });

  it("consulta falhada → recusa fechada, sem assinar", async () => {
    cenario({ "collaborator_documents:maybeSingle": FALHA });
    const res = await assinar(URL_OK);
    expect(res.ok).toBe(false);
    expect(storageOps.filter((o) => o.op === "sign")).toHaveLength(0);
  });

  it("um registo cujo caminho saia da empresa não se assina", async () => {
    cenario({ "collaborator_documents:maybeSingle": {
      data: {
        file_url: "https://x/collaborator-documents/empresa-2/colab-9/1-f.pdf",
        collaborator_id: "colab-1", visible_to_collaborator: true,
      },
      error: null,
    } });
    const res = await assinar("https://x/collaborator-documents/empresa-2/colab-9/1-f.pdf");
    expect(res.ok).toBe(false);
    expect(storageOps.filter((o) => o.op === "sign")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — guardas permanentes, e a prova de que disparam
// ═══════════════════════════════════════════════════════════════════════════

const SRC = ler("src/app/actions/collaborator-documents.ts");
const LIMPO = semComentarios(SRC);

/** A. companyId do cliente nunca chega a uma escrita. */
function empresaVindaDoCliente(src: string): string[] {
  const falhas: string[] = [];
  if (/uploadCollaboratorDocument\s*\(\s*[\s\S]{0,120}?companyId\s*:\s*string/.test(src)) {
    falhas.push("uploadCollaboratorDocument volta a aceitar companyId");
  }
  return falhas;
}

/** C. a categoria é validada em execução, não afirmada ao compilador. */
function categoriaSemParser(src: string): string[] {
  const falhas: string[] = [];
  if (/category\s+as\s+DocumentCategory/.test(src)) falhas.push("category as DocumentCategory");
  if (!src.includes("parseDocumentCategory")) falhas.push("sem parseDocumentCategory");
  return falhas;
}

/** D. uma falha a registar compensa o ficheiro acabado de enviar. */
function uploadSemCompensacao(src: string): string[] {
  const i = src.indexOf("export async function uploadCollaboratorDocument");
  const j = src.indexOf("export async function deleteCollaboratorDocument", i + 1);
  const fn = i < 0 ? "" : src.slice(i, j < 0 ? undefined : j);
  return /dbError[\s\S]{0,400}?storage[\s\S]{0,120}?remove\s*\(\s*\[\s*path\s*\]/.test(fn)
    ? [] : ["upload sem compensação do ficheiro"];
}

describe("guardas permanentes dos documentos", () => {
  it("CLIENT_COMPANY_ID_TRUSTED = 0", () => {
    expect(empresaVindaDoCliente(LIMPO)).toEqual([]);
  });

  it("CATEGORY_RUNTIME_VALIDATED = YES", () => {
    expect(categoriaSemParser(LIMPO)).toEqual([]);
  });

  it("UPLOAD_DB_FAILURE_COMPENSATED = YES", () => {
    expect(uploadSemCompensacao(LIMPO)).toEqual([]);
  });

  it("SIGNED_URL_PATH_SERVER_RESOLVED = YES", () => {
    const i = LIMPO.indexOf("export async function getSignedDocumentUrl");
    const fn = LIMPO.slice(i, LIMPO.indexOf("export async function getMyDocuments", i + 1));
    // O caminho assinado sai do registo, não da string recebida.
    expect(fn).toMatch(/doc\.file_url/);
    expect(fn).toMatch(/createSignedUrl/);
  });

  it("o upload passa pelo guard central com papéis", () => {
    const i = LIMPO.indexOf("export async function uploadCollaboratorDocument");
    const fn = LIMPO.slice(i, LIMPO.indexOf("export async function deleteCollaboratorDocument", i + 1));
    expect(fn).toMatch(/requireProfile\(\s*\{\s*roles:/);
  });

  it("nenhuma remoção de armazenamento usa um prefixo em vez de um caminho", () => {
    // `remove([...])` sempre com caminhos concretos; nunca `list` + apagar pasta.
    expect(LIMPO).not.toMatch(/\.remove\(\s*\[\s*`?\$\{companyId\}\/`?\s*\]/);
  });
});

describe("as guardas acusam código estragado (mutation proof)", () => {
  it("A. voltar a aceitar companyId do cliente dispara", () => {
    const mutado = "export async function uploadCollaboratorDocument(collaboratorId: string, companyId: string, file: FormData) {}";
    expect(empresaVindaDoCliente(mutado).length).toBeGreaterThan(0);
  });

  it("C. voltar a `category as DocumentCategory` dispara", () => {
    const mutado = "const c = category as DocumentCategory;";
    expect(categoriaSemParser(mutado)).toContain("category as DocumentCategory");
  });

  it("C2. tirar o parser dispara", () => {
    expect(categoriaSemParser("const c = category;")).toContain("sem parseDocumentCategory");
  });

  it("D. falha a registar sem limpar o ficheiro dispara", () => {
    const mutado = `
export async function uploadCollaboratorDocument() {
  if (dbError) return { ok: false, error: dbError.message };
}
export async function deleteCollaboratorDocument() {}
`;
    expect(uploadSemCompensacao(mutado)).toContain("upload sem compensação do ficheiro");
  });

  it("as guardas não se deixam enganar pelos comentários que as explicam", () => {
    // O módulo puro cita `category as DocumentCategory` no comentário que
    // explica o que saiu — é lá que o parser vive, porque um ficheiro
    // "use server" não pode exportar constantes nem funções síncronas.
    // Se a guarda medisse comentários, estaria vermelha.
    const lib = ler("src/lib/collaborator-documents.ts");
    expect(lib).toMatch(/category as DocumentCategory/);
    expect(categoriaSemParser(semComentarios(lib))).toEqual([]);
    expect(categoriaSemParser(LIMPO)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — RETENÇÃO: o risco descoberto aqui, corrigido na P0F
// ═══════════════════════════════════════════════════════════════════════════
//
// Estes testes nasceram na P0E a **fixar o comportamento defeituoso**, para que
// não mudasse por acidente e para que o diff mostrasse exatamente o quê quando
// mudasse de propósito. É agora que isso acontece: a P0F muda-o de propósito, e
// este bloco é o diff prometido.
//
//     antes                                    depois
//     ─────────────────────────────────────    ────────────────────────────────
//     RETENTION_MONTHS = 3, para tudo          política por categoria
//     recibo_salario → expires_at = +3 meses   recibo_salario → expires_at NULL
//     cron apaga por data, sem ver categoria   cron consulta a política
//
// A regra em si é testada em `payroll-document-retention.test.ts`. O que fica
// aqui é o par mínimo que prova a transição no ponto de escrita.

describe("retenção — depois da P0F", () => {
  it("a retenção deixou de ser uma constante global deste módulo", () => {
    // `RETENTION_MONTHS = 3` aplicava-se a todas as categorias. A regra mudou
    // de sítio: vive em `src/domain/documents/retention-policy.ts`.
    expect(LIMPO).not.toMatch(/RETENTION_MONTHS\s*=\s*\d/);
    expect(LIMPO).toMatch(/resolveDocumentExpiresAt/);
  });

  it("🔴 um recibo de vencimento nasce SEM data de expiração", async () => {
    const res = await upload();
    expect(res.ok).toBe(true);

    const insert = dbOps.find((o) => o.op === "insert")!.payload as Record<string, unknown>;
    expect(insert.category).toBe("recibo_salario");
    expect(insert.expires_at).toBeNull();
  });

  it("o cron passou a filtrar por categoria, não só por data", () => {
    const cron = semComentarios(ler("src/app/api/cron/archive-documents/route.ts"));
    expect(cron).toMatch(/lt\(\s*["\']expires_at["\']/);
    expect(cron).toMatch(/\.not\(\s*["\']category["\']/);
    expect(cron).toMatch(/podeArquivarAutomaticamente/);
  });
});
