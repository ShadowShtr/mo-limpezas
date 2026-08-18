// ============================================================================
// ANEXOS MÚLTIPLOS — helpers puros e read model
// ============================================================================
// Cobre a parte de `src/lib/attachments.ts` que decide o que a UI vê e o que o
// servidor aceita: combinação legado + novos, identidade sintética do legado,
// validação de tipo/tamanho/limite, e as barreiras de tenant nos caminhos de
// storage.
//
// A migration está validada à parte, contra Postgres real (PGlite): unicidade
// de `storage_path`, idempotência por `client_event_id` no escopo da empresa,
// CHECK de `parent_type`, RLS e rollback. Ver
// docs/ATTACHMENTS-MULTIPLE.md.
//
// Origem: até 2026-08-18 anexar um segundo ficheiro num pagamento apagava o
// primeiro do storage. Os testes de regressão explícita estão no fim.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_ATTACHMENT_MIME,
  MAX_ATTACHMENTS_PER_PARENT,
  MAX_ATTACHMENT_BYTES,
  PARENT_BUCKET,
  PARENT_TABLE,
  PARENT_TYPES,
  buildAttachmentPath,
  combineAttachments,
  isAllowedAttachmentMime,
  isAttachmentParentType,
  isAttachmentPathInCompany,
  isLegacyAttachmentId,
  legacyAttachmentId,
  sanitizeAttachmentFileName,
  validateAttachmentFile,
} from "../lib/attachments";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const OUTRA_COMPANY = "22222222-2222-2222-2222-222222222222";
const PARENT = "33333333-3333-3333-3333-333333333333";

function row(over: Partial<Parameters<typeof combineAttachments>[0]["rows"][number]> = {}) {
  return {
    id: over.id ?? "row-1",
    original_name: over.original_name ?? "novo.pdf",
    mime_type: over.mime_type ?? "application/pdf",
    size_bytes: over.size_bytes ?? 2048,
    created_at: over.created_at ?? "2026-08-18T10:00:00Z",
    storage_bucket: over.storage_bucket ?? "payment-attachments",
    storage_path: over.storage_path ?? `${COMPANY}/${PARENT}/1-novo.pdf`,
  };
}

const LEGACY = { url: "https://x/storage/v1/payment-attachments/c/p/antigo.pdf", name: "antigo.pdf", size: 1024, mime: "application/pdf" };

describe("parent_type — contrato servidor↔tabela", () => {
  it("aceita apenas os três tipos convertidos", () => {
    expect(PARENT_TYPES).toEqual(["fixed_variable_payment", "management_task", "absence"]);
    for (const t of PARENT_TYPES) expect(isAttachmentParentType(t)).toBe(true);
  });

  // Teste adicional: manipular parent_type no request → DENY.
  it("🔴 rejeita parent_type arbitrário vindo do cliente", () => {
    for (const mau of ["profiles", "companies", "invoices", "", "fixed_variable_payments", null, 7, {}]) {
      expect(isAttachmentParentType(mau)).toBe(false);
    }
  });

  it("cada tipo tem tabela e bucket", () => {
    for (const t of PARENT_TYPES) {
      expect(PARENT_TABLE[t]).toBeTruthy();
      expect(PARENT_BUCKET[t]).toBeTruthy();
    }
  });

  it("pagamentos e tarefas reutilizam os buckets legados", () => {
    // Os ficheiros antigos vivem lá; separá-los dos novos não traria nada.
    expect(PARENT_BUCKET.fixed_variable_payment).toBe("payment-attachments");
    expect(PARENT_BUCKET.management_task).toBe("task-attachments");
  });
});

describe("isolamento de tenant no caminho de storage", () => {
  it("aceita caminho da própria empresa", () => {
    expect(isAttachmentPathInCompany(`${COMPANY}/${PARENT}/1-f.pdf`, COMPANY)).toBe(true);
  });

  // Teste 11/12: tenant A não lê nem remove de B.
  it("🔴 recusa caminho de outra empresa", () => {
    expect(isAttachmentPathInCompany(`${OUTRA_COMPANY}/${PARENT}/1-f.pdf`, COMPANY)).toBe(false);
  });

  it("🔴 recusa travessia de directórios", () => {
    expect(isAttachmentPathInCompany(`${COMPANY}/../${OUTRA_COMPANY}/f.pdf`, COMPANY)).toBe(false);
    expect(isAttachmentPathInCompany("../etc/passwd", COMPANY)).toBe(false);
  });

  it("recusa entradas vazias", () => {
    expect(isAttachmentPathInCompany("", COMPANY)).toBe(false);
    expect(isAttachmentPathInCompany(`${COMPANY}/f.pdf`, "")).toBe(false);
  });

  it("o caminho gerado fica sempre dentro da empresa", () => {
    const p = buildAttachmentPath({ companyId: COMPANY, parentId: PARENT, fileName: "a b/c.pdf", now: 1 });
    expect(isAttachmentPathInCompany(p, COMPANY)).toBe(true);
    expect(isAttachmentPathInCompany(p, OUTRA_COMPANY)).toBe(false);
  });

  it("sanitiza nomes perigosos", () => {
    // O que torna o nome seguro é não sobrar separador de caminho: sem `/`,
    // os pontos que restam são apenas parte do nome do ficheiro.
    const limpo = sanitizeAttachmentFileName("../../etc/passwd");
    expect(limpo).not.toContain("/");
    expect(limpo).not.toContain("\\");
    expect(sanitizeAttachmentFileName("")).toBe("anexo");
  });

  it("🔴 um nome com ../ não escapa da pasta da empresa", () => {
    // A prova que interessa é sobre o caminho final, não sobre o nome isolado.
    const p = buildAttachmentPath({ companyId: COMPANY, parentId: PARENT, fileName: "../../etc/passwd", now: 1 });
    expect(p.startsWith(`${COMPANY}/${PARENT}/`)).toBe(true);
    expect(isAttachmentPathInCompany(p, COMPANY)).toBe(true);
    expect(isAttachmentPathInCompany(p, OUTRA_COMPANY)).toBe(false);
  });

  // Achado desta ronda: o sanitize trocava `/` por `_` mas mantinha os pontos,
  // e o caminho resultante continha `..`. O upload passava, mas o guard
  // recusava-o depois — o anexo ficava impossível de abrir ou de remover.
  it("🔴 nome com pontos seguidos continua utilizável depois de gravado", () => {
    for (const nome of ["../../etc/passwd", "relatório..final.pdf", "a...b.pdf", "..", "..."]) {
      const p = buildAttachmentPath({ companyId: COMPANY, parentId: PARENT, fileName: nome, now: 1 });
      expect(p).not.toContain("..");
      // Sem isto, abrir e remover ficariam ambos bloqueados para sempre.
      expect(isAttachmentPathInCompany(p, COMPANY)).toBe(true);
    }
  });
});

describe("validação de ficheiro", () => {
  const bom = { size: 1024, mime: "application/pdf", existingCount: 0 };

  it("aceita um PDF normal", () => {
    expect(validateAttachmentFile(bom).ok).toBe(true);
  });

  it("recusa ficheiro vazio", () => {
    const r = validateAttachmentFile({ ...bom, size: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EMPTY");
  });

  it("recusa acima do limite de tamanho", () => {
    const r = validateAttachmentFile({ ...bom, size: MAX_ATTACHMENT_BYTES + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOO_LARGE");
  });

  it("🔴 recusa MIME fora da lista", () => {
    for (const mau of ["application/x-msdownload", "text/html", "application/octet-stream", null, ""]) {
      const r = validateAttachmentFile({ ...bom, mime: mau });
      expect(r.ok).toBe(false);
    }
  });

  it("aceita os tipos da lista", () => {
    for (const m of ALLOWED_ATTACHMENT_MIME) {
      expect(isAllowedAttachmentMime(m)).toBe(true);
    }
    expect(isAllowedAttachmentMime("APPLICATION/PDF")).toBe(true);
  });

  it("recusa acima do limite de quantidade", () => {
    const r = validateAttachmentFile({ ...bom, existingCount: MAX_ATTACHMENTS_PER_PARENT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOO_MANY");
  });

  it("o limite conta só anexos novos — o legado não gasta quota", () => {
    expect(validateAttachmentFile({ ...bom, existingCount: MAX_ATTACHMENTS_PER_PARENT - 1 }).ok).toBe(true);
  });
});

describe("read model — legado + novos numa lista só", () => {
  // Teste 1/8: o anexo legado continua visível.
  it("pagamento só com legado mostra 1 anexo", () => {
    const list = combineAttachments({ parentType: "fixed_variable_payment", parentId: PARENT, legacy: LEGACY, rows: [] });
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("legacy");
    expect(list[0].name).toBe("antigo.pdf");
    expect(list[0].legacyUrl).toBe(LEGACY.url);
  });

  // Teste adicional: legacy + 2 novos = exactamente 3.
  it("🔴 legado + 2 novos = exactamente 3 (sem duplicar o legado)", () => {
    const list = combineAttachments({
      parentType: "fixed_variable_payment",
      parentId: PARENT,
      legacy: LEGACY,
      rows: [row({ id: "a", original_name: "n1.pdf" }), row({ id: "b", original_name: "n2.pdf", storage_path: `${COMPANY}/${PARENT}/2-n2.pdf` })],
    });
    expect(list).toHaveLength(3);
    expect(list.filter((a) => a.source === "legacy")).toHaveLength(1);
    expect(list.filter((a) => a.source === "attachments")).toHaveLength(2);
  });

  it("o legado vem primeiro, os novos por ordem de criação", () => {
    const list = combineAttachments({
      parentType: "fixed_variable_payment",
      parentId: PARENT,
      legacy: LEGACY,
      rows: [row({ id: "a", original_name: "n1.pdf" }), row({ id: "b", original_name: "n2.pdf", storage_path: `${COMPANY}/${PARENT}/2.pdf` })],
    });
    expect(list.map((a) => a.name)).toEqual(["antigo.pdf", "n1.pdf", "n2.pdf"]);
  });

  it("sem legado mostra só os novos", () => {
    const list = combineAttachments({ parentType: "management_task", parentId: PARENT, legacy: null, rows: [row()] });
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("attachments");
  });

  it("sem nada devolve lista vazia", () => {
    expect(combineAttachments({ parentType: "absence", parentId: PARENT, legacy: null, rows: [] })).toEqual([]);
  });

  it("legado com url nula não conta como anexo", () => {
    const list = combineAttachments({
      parentType: "absence",
      parentId: PARENT,
      legacy: { url: null, name: null },
      rows: [row()],
    });
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("attachments");
  });

  it("size_bytes chega do driver como string e é normalizado", () => {
    // bigint no Postgres → string no cliente.
    const list = combineAttachments({
      parentType: "fixed_variable_payment",
      parentId: PARENT,
      legacy: null,
      rows: [row({ size_bytes: "4096" as unknown as number })],
    });
    expect(list[0].sizeBytes).toBe(4096);
    expect(typeof list[0].sizeBytes).toBe("number");
  });

  it("faltas usam document_url como legado", () => {
    const list = combineAttachments({
      parentType: "absence",
      parentId: PARENT,
      legacy: { url: "https://x/absence-documents/c/p/baixa.pdf", name: null },
      rows: [],
    });
    expect(list).toHaveLength(1);
    // A coluna legada de faltas não guarda nome — cai no rótulo genérico.
    expect(list[0].name).toBe("anexo");
  });
});

describe("identidade do anexo legado", () => {
  it("é determinística — a mesma entre renders", () => {
    const a = legacyAttachmentId("fixed_variable_payment", PARENT);
    const b = legacyAttachmentId("fixed_variable_payment", PARENT);
    expect(a).toBe(b);
  });

  it("distingue legado de linha de attachments", () => {
    expect(isLegacyAttachmentId(legacyAttachmentId("absence", PARENT))).toBe(true);
    expect(isLegacyAttachmentId("row-1")).toBe(false);
    expect(isLegacyAttachmentId("33333333-3333-3333-3333-333333333333")).toBe(false);
  });

  // Teste 5/6: remover o novo não altera o legado, e vice-versa.
  it("🔴 remover um novo deixa o legado na lista", () => {
    const antes = combineAttachments({
      parentType: "fixed_variable_payment",
      parentId: PARENT,
      legacy: LEGACY,
      rows: [row({ id: "a" }), row({ id: "b", storage_path: `${COMPANY}/${PARENT}/2.pdf` })],
    });
    // O que a UI faz depois de removeAttachment("b") devolver ok.
    const depois = antes.filter((x) => x.id !== "b");
    expect(depois).toHaveLength(2);
    expect(depois.some((x) => x.source === "legacy")).toBe(true);
    expect(depois.some((x) => x.id === "a")).toBe(true);
  });

  it("🔴 remover o legado deixa os novos na lista", () => {
    const legacyId = legacyAttachmentId("fixed_variable_payment", PARENT);
    const antes = combineAttachments({
      parentType: "fixed_variable_payment",
      parentId: PARENT,
      legacy: LEGACY,
      rows: [row({ id: "a" }), row({ id: "b", storage_path: `${COMPANY}/${PARENT}/2.pdf` })],
    });
    const depois = antes.filter((x) => x.id !== legacyId);
    expect(depois).toHaveLength(2);
    expect(depois.every((x) => x.source === "attachments")).toBe(true);
  });
});

// ── Regressão explícita ─────────────────────────────────────────────────────
//
// O gate que impede o regresso do comportamento destrutivo. Se alguém voltar a
// pôr um `remove()` no caminho de adicionar, isto falha.

describe("🔴 regressão — adicionar nunca remove", () => {
  const ACTION = fs.readFileSync(path.join(process.cwd(), "src/app/actions/attachments.ts"), "utf8");
  const PAYMENTS = fs.readFileSync(path.join(process.cwd(), "src/app/actions/payments.ts"), "utf8");

  function corpoDe(src: string, nome: string): string {
    const i = src.indexOf(`export async function ${nome}`);
    if (i < 0) return "";
    const resto = src.slice(i + 10);
    const fim = resto.indexOf("\nexport async function ");
    return fim < 0 ? resto : resto.slice(0, fim);
  }

  it("uploadPaymentAttachment já não apaga o ficheiro anterior", () => {
    const corpo = corpoDe(PAYMENTS, "uploadPaymentAttachment");
    expect(corpo).not.toContain(".remove([oldPath])");
    expect(corpo).not.toContain("Substitui um anexo anterior");
  });

  it("addAttachment só remove o ficheiro que acabou de enviar", () => {
    const corpo = corpoDe(ACTION, "addAttachment");
    const removes = corpo.match(/\.remove\(\[[^\]]*\]\)/g) ?? [];
    // Exactamente um: a compensação do upload que falhou no INSERT.
    expect(removes).toHaveLength(1);
    expect(removes[0]).toContain("path");
    expect(removes[0]).not.toContain("old");
  });

  it("removeAttachment filtra pelo trio company + parent_type + parent_id", () => {
    const corpo = corpoDe(ACTION, "removeAttachment");
    expect(corpo).toContain('.eq("company_id"');
    expect(corpo).toContain('.eq("parent_type"');
    expect(corpo).toContain('.eq("parent_id"');
  });

  it("🔴 nenhum DELETE em massa por parent_id", () => {
    // `DELETE ... WHERE parent_id = X` sem id é o erro que apagaria tudo.
    const deletes = ACTION.match(/\.delete\(\)[\s\S]{0,400}?;/g) ?? [];
    for (const d of deletes) {
      expect(d).toContain('.eq("id"');
    }
  });

  it("getAttachmentUrl valida o caminho contra a empresa", () => {
    const corpo = corpoDe(ACTION, "getAttachmentUrl");
    expect(corpo).toContain("isAttachmentPathInCompany");
  });

  it("a migration 074 não altera as colunas legadas", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/074_attachments.sql"), "utf8");
    expect(sql).not.toMatch(/ALTER TABLE\s+(public\.)?fixed_variable_payments/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+(public\.)?management_tasks/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+(public\.)?absences/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    // E não copia o legado para a tabela nova — isso duplicaria na UI.
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(public\.)?attachments/i);
  });

  it("a migration 074 não tem policy de UPDATE", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/074_attachments.sql"), "utf8");
    expect(sql).toMatch(/FOR SELECT/);
    expect(sql).toMatch(/FOR INSERT/);
    expect(sql).toMatch(/FOR DELETE/);
    expect(sql).not.toMatch(/FOR UPDATE/);
  });
});
