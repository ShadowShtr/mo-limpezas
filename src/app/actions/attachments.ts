"use server";

// ============================================================================
// ANEXOS MÚLTIPLOS — actions partilhadas pelos três fluxos
// ============================================================================
// Pagamentos, Tarefas e Faltas passam por aqui. Um caminho só, para não
// voltarmos a ter três implementações de anexos que divergem com o tempo.
//
// 🔴 REGRAS QUE ESTE FICHEIRO EXISTE PARA GARANTIR
//
// 1. **Adicionar nunca remove.** `addAttachment` não apaga nada que já lá
//    esteja — nem ficheiro de storage, nem coluna legada. O único `remove()`
//    de storage neste caminho é a compensação do ficheiro que ACABOU de ser
//    enviado quando o INSERT falha. Ver a nota no fim de `addAttachment`.
//    (Antes desta ronda, `uploadPaymentAttachment` apagava o anexo anterior
//    do bucket antes de gravar o novo — sem recuperação possível.)
//
// 2. **A identidade de autorização é o trio.** Nunca se lê nem se remove um
//    anexo só por `attachment.id`: revalida-se sempre
//    `company_id` + `parent_type` + `parent_id` contra o registo pai real e
//    contra o utilizador autenticado. Um id válido com o parent errado é
//    negado.
//
// 3. **Idempotência por `client_event_id`.** Duplo-clique, retry de rede ou
//    re-render não podem criar dois anexos. O índice único da 074 transforma
//    a segunda tentativa em conflito, e aqui devolve-se o anexo existente em
//    vez de um erro.
//
// Ver docs/ATTACHMENTS-MULTIPLE.md e supabase/migrations/074_attachments.sql.
// ============================================================================

import { isNoRowsError, logQueryFailure, queryFailure } from "@/lib/query-error";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth-guard";
import {
  type AttachmentParentType,
  type AttachmentView,
  PARENT_BUCKET,
  PARENT_TABLE,
  buildAttachmentPath,
  combineAttachments,
  isAttachmentParentType,
  isAttachmentPathInCompany,
  isLegacyAttachmentId,
  resolveAttachmentStoragePath,
  validateAttachmentFile,
} from "@/lib/attachments";

type Guard = Awaited<ReturnType<typeof requireProfile>>;
type Admin = Extract<Guard, { ok: true }>["admin"];

/** As colunas legadas de cada fluxo — lidas, nunca escritas por `addAttachment`. */
const LEGACY_COLUMNS: Record<
  AttachmentParentType,
  { url: string; name: string | null; size: string | null; mime: string | null }
> = {
  fixed_variable_payment: {
    url: "attachment_url",
    name: "attachment_name",
    size: "attachment_size",
    mime: "attachment_mime",
  },
  management_task: { url: "attachment_url", name: "attachment_name", size: null, mime: null },
  absence: { url: "document_url", name: null, size: null, mime: null },
};

function revalidateFor(parentType: AttachmentParentType) {
  switch (parentType) {
    case "fixed_variable_payment":
      revalidatePath("/dashboard/financeiro/pagamentos");
      revalidatePath("/dashboard/financeiro");
      break;
    case "management_task":
      revalidatePath("/dashboard/tarefas");
      break;
    case "absence":
      revalidatePath("/dashboard/colaboradores");
      break;
  }
  revalidatePath("/dashboard");
}

/**
 * 🔴 O coração da autorização.
 *
 * Confirma que o registo pai existe E pertence à empresa do utilizador
 * autenticado. Devolve as colunas legadas de anexo já lidas, para o read model
 * não precisar de uma segunda ida à base.
 *
 * Nunca aceita `parentType` sem o validar: a string vem do cliente.
 */
async function loadParent(
  admin: Admin,
  companyId: string,
  parentType: string,
  parentId: string,
): Promise<
  | { ok: true; parentType: AttachmentParentType; legacy: { url: string | null; name: string | null; size: number | null; mime: string | null } }
  | { ok: false; error: string }
> {
  if (!isAttachmentParentType(parentType)) {
    return { ok: false, error: "Tipo de registo inválido." };
  }
  if (!parentId) return { ok: false, error: "Registo não indicado." };

  const cols = LEGACY_COLUMNS[parentType];
  const select = ["id", cols.url, cols.name, cols.size, cols.mime].filter(Boolean).join(", ");

  const { data, error } = await admin
    .from(PARENT_TABLE[parentType])
    .select(select)
    .eq("id", parentId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  // Não distingue "não existe" de "é de outra empresa" — não se confirma a
  // existência de registos alheios a quem não lhes deve aceder.
  if (!data) return { ok: false, error: "Registo não encontrado." };

  // O `select` é montado por `parent_type`, logo o tipo estático não o segue.
  const row = data as unknown as Record<string, unknown>;
  return {
    ok: true,
    parentType,
    legacy: {
      url: (row[cols.url] as string | null) ?? null,
      name: cols.name ? ((row[cols.name] as string | null) ?? null) : null,
      size: cols.size ? ((row[cols.size] as number | null) ?? null) : null,
      mime: cols.mime ? ((row[cols.mime] as string | null) ?? null) : null,
    },
  };
}

/** Lista de anexos de um registo: legado + novos, numa lista só. */
export async function listAttachments(
  parentType: string,
  parentId: string,
): Promise<{ ok: true; attachments: AttachmentView[] } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const parent = await loadParent(admin, profile.company_id, parentType, parentId);
  if (!parent.ok) return { ok: false, error: parent.error };

  const { data: rows, error } = await admin
    .from("attachments")
    .select("id, original_name, mime_type, size_bytes, created_at, storage_bucket, storage_path")
    .eq("company_id", profile.company_id)
    .eq("parent_type", parent.parentType)
    .eq("parent_id", parentId)
    .order("created_at", { ascending: true });

  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    attachments: combineAttachments({
      parentType: parent.parentType,
      parentId,
      legacy: parent.legacy,
      rows: rows ?? [],
    }),
  };
}

/**
 * Acrescenta UM anexo. Chamar N vezes para N ficheiros — cada um falha ou
 * passa por si, e um erro no terceiro não desfaz os dois primeiros.
 *
 * `clientEventId` deve ser estável por ficheiro escolhido (não por tentativa):
 * é o que torna o retry seguro.
 */
export async function addAttachment(
  parentType: string,
  parentId: string,
  formData: FormData,
): Promise<{ ok: true; attachment: AttachmentView; deduped?: boolean } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const parent = await loadParent(admin, profile.company_id, parentType, parentId);
  if (!parent.ok) return { ok: false, error: parent.error };

  const file = formData.get("file") as File | null;
  if (!file) return { ok: false, error: "Ficheiro em falta." };
  const clientEventId = (formData.get("clientEventId") as string | null) || null;

  // Retry/duplo-clique: se este evento já produziu um anexo, devolve-se esse.
  if (clientEventId) {
    const { data: existing } = await admin
      .from("attachments")
      .select("id, original_name, mime_type, size_bytes, created_at, storage_bucket, storage_path")
      .eq("company_id", profile.company_id)
      .eq("client_event_id", clientEventId)
      .maybeSingle();
    if (existing) {
      const [view] = combineAttachments({
        parentType: parent.parentType,
        parentId,
        legacy: null,
        rows: [existing],
      });
      return { ok: true, attachment: view, deduped: true };
    }
  }

  const { count } = await admin
    .from("attachments")
    .select("id", { count: "exact", head: true })
    .eq("company_id", profile.company_id)
    .eq("parent_type", parent.parentType)
    .eq("parent_id", parentId);

  const validation = validateAttachmentFile({
    size: file.size,
    mime: file.type,
    existingCount: count ?? 0,
  });
  if (!validation.ok) return { ok: false, error: validation.error };

  const bucket = PARENT_BUCKET[parent.parentType];
  await ensureBucket(admin, bucket);

  const path = buildAttachmentPath({
    companyId: profile.company_id,
    parentId,
    fileName: file.name,
  });

  const { error: uploadError } = await admin.storage
    .from(bucket)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  const { data: inserted, error: dbError } = await admin
    .from("attachments")
    .insert({
      company_id: profile.company_id,
      parent_type: parent.parentType,
      parent_id: parentId,
      storage_bucket: bucket,
      storage_path: path,
      original_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      client_event_id: clientEventId,
      created_by: profile.id,
    })
    .select("id, original_name, mime_type, size_bytes, created_at, storage_bucket, storage_path")
    .single();

  if (dbError || !inserted) {
    // 🔴 Compensação: o storage aceitou o ficheiro mas a base recusou a
    //    referência. Remove-se o ficheiro QUE ACABOU DE SER ENVIADO — nunca
    //    nenhum outro — para não deixar um objecto órfão no bucket.
    await admin.storage.from(bucket).remove([path]).catch(() => {});
    return { ok: false, error: dbError?.message ?? "Não foi possível registar o anexo." };
  }

  revalidateFor(parent.parentType);

  const [view] = combineAttachments({
    parentType: parent.parentType,
    parentId,
    legacy: null,
    rows: [inserted],
  });
  return { ok: true, attachment: view };
}

/**
 * Remove UM anexo — o escolhido, e mais nenhum.
 *
 * Aceita tanto o id de uma linha de `attachments` como o id sintético do
 * legado. São caminhos deliberadamente distintos: o legado limpa colunas do
 * registo pai, o novo apaga uma linha. Ver a nota em `AttachmentView.source`.
 */
export async function removeAttachment(
  parentType: string,
  parentId: string,
  attachmentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const parent = await loadParent(admin, profile.company_id, parentType, parentId);
  if (!parent.ok) return { ok: false, error: parent.error };

  if (isLegacyAttachmentId(attachmentId)) {
    return removeLegacyAttachment(admin, profile.company_id, parent.parentType, parentId, parent.legacy.url);
  }

  // 🔴 O trio inteiro no WHERE. Um id válido de outro registo — ou de outra
  //    empresa — não corresponde a nada aqui.
  const { data: row } = await admin
    .from("attachments")
    .select("id, storage_bucket, storage_path")
    .eq("id", attachmentId)
    .eq("company_id", profile.company_id)
    .eq("parent_type", parent.parentType)
    .eq("parent_id", parentId)
    .maybeSingle();

  if (!row) return { ok: false, error: "Anexo não encontrado." };

  if (!isAttachmentPathInCompany(row.storage_path, profile.company_id)) {
    return { ok: false, error: "Caminho de anexo inválido." };
  }

  const { error: storageError } = await admin.storage
    .from(row.storage_bucket)
    .remove([row.storage_path]);
  // Não se apaga a referência se o ficheiro continua lá: ficaria um objecto
  // órfão e a UI diria que o anexo desapareceu.
  if (storageError) return { ok: false, error: storageError.message };

  const { error: dbError } = await admin
    .from("attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("company_id", profile.company_id)
    .eq("parent_type", parent.parentType)
    .eq("parent_id", parentId);
  if (dbError) return { ok: false, error: dbError.message };

  revalidateFor(parent.parentType);
  return { ok: true };
}

/**
 * Remoção do anexo legado: limpa as colunas do registo pai e apaga o ficheiro
 * correspondente. **Não toca em nenhuma linha de `attachments`.**
 */
async function removeLegacyAttachment(
  admin: Admin,
  companyId: string,
  parentType: AttachmentParentType,
  parentId: string,
  legacyUrl: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!legacyUrl) return { ok: false, error: "Anexo não encontrado." };

  const bucket = PARENT_BUCKET[parentType];
  const bucketPrefix = `/${bucket}/`;
  const oldPath = legacyUrl.includes(bucketPrefix)
    ? decodeURIComponent(legacyUrl.split(bucketPrefix)[1])
    : null;

  if (oldPath && isAttachmentPathInCompany(oldPath, companyId)) {
    const { error } = await admin.storage.from(bucket).remove([oldPath]);
    if (error) return { ok: false, error: error.message };
  }

  const cols = LEGACY_COLUMNS[parentType];
  const patch: Record<string, null> = { [cols.url]: null };
  if (cols.name) patch[cols.name] = null;
  if (cols.size) patch[cols.size] = null;
  if (cols.mime) patch[cols.mime] = null;

  const { error: dbError } = await admin
    .from(PARENT_TABLE[parentType])
    // As colunas limpas dependem de `parent_type` (ver LEGACY_COLUMNS), por
    // isso o patch é montado em runtime e o tipo estático não o acompanha.
    .update(patch as never)
    .eq("id", parentId)
    .eq("company_id", companyId);
  if (dbError) return { ok: false, error: dbError.message };

  revalidateFor(parentType);
  return { ok: true };
}

/** URL assinada de leitura, válida por 5 minutos — o mesmo que os fluxos já faziam. */
export async function getAttachmentUrl(
  parentType: string,
  parentId: string,
  attachmentId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const parent = await loadParent(admin, profile.company_id, parentType, parentId);
  if (!parent.ok) return { ok: false, error: parent.error };

  // ── Anexo legado ──────────────────────────────────────────────────────────
  //
  // 🔴 Aqui devolvia-se `parent.legacy.url` cru, e era esse o defeito.
  //
  //    `uploadPaymentAttachment` gravava `getPublicUrl(...)` de um bucket
  //    **privado**. Esse URL não expira — nunca funcionou. Dezassete
  //    pagamentos ficaram com uma referência que devolve HTTP 400, enquanto
  //    os ficheiros estavam intactos no armazenamento (17/17 abrem quando
  //    assinados). Nada se perdeu: só a referência apontava para uma porta
  //    que não existe.
  //
  //    A referência guardada passa a ser interpretada, nunca reenviada.
  if (isLegacyAttachmentId(attachmentId)) {
    const bucket = PARENT_BUCKET[parent.parentType];
    const resolvido = resolveAttachmentStoragePath({
      referencia: parent.legacy.url,
      bucket,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    });

    if (!resolvido.ok) {
      if (resolvido.motivo === "vazio") return { ok: false, error: "Anexo não encontrado." };
      // Um valor que aponta para outro host, outro bucket ou fora do caminho
      // permitido não se assina — assinar às cegas transformaria um valor
      // errado na base num acesso concedido.
      logQueryFailure("getAttachmentUrl:referencia-legada", { code: resolvido.motivo });
      return { ok: false, error: "Anexo inválido." };
    }

    if (!isAttachmentPathInCompany(resolvido.storagePath, profile.company_id)) {
      return { ok: false, error: "Sem permissão para aceder a este ficheiro." };
    }

    const { data: assinado, error: erroLegado } = await admin.storage
      .from(bucket)
      .createSignedUrl(resolvido.storagePath, 300);

    if (erroLegado || !assinado) {
      logQueryFailure("getAttachmentUrl:assinar-legado", erroLegado);
      return { ok: false, error: "Não foi possível abrir o anexo." };
    }
    return { ok: true, url: assinado.signedUrl };
  }

  const { data: row, error: erroLinha } = await admin
    .from("attachments")
    .select("storage_bucket, storage_path")
    .eq("id", attachmentId)
    .eq("company_id", profile.company_id)
    .eq("parent_type", parent.parentType)
    .eq("parent_id", parentId)
    .maybeSingle();

  // Uma consulta falhada não é um anexo inexistente: a primeira pede para
  // tentar outra vez, a segunda diz que não vale a pena.
  if (erroLinha && !isNoRowsError(erroLinha)) {
    return queryFailure("getAttachmentUrl:attachment", erroLinha);
  }
  if (!row) return { ok: false, error: "Anexo não encontrado." };
  if (!isAttachmentPathInCompany(row.storage_path, profile.company_id)) {
    return { ok: false, error: "Caminho de anexo inválido." };
  }

  const { data, error } = await admin.storage
    .from(row.storage_bucket)
    .createSignedUrl(row.storage_path, 300);
  if (error || !data) {
    logQueryFailure("getAttachmentUrl:assinar", error);
    return { ok: false, error: "Não foi possível abrir o anexo." };
  }

  return { ok: true, url: data.signedUrl };
}

/** Cria o bucket privado no primeiro upload — mesmo padrão dos fluxos actuais. */
async function ensureBucket(admin: Admin, bucket: string) {
  const { data } = await admin.storage.getBucket(bucket);
  if (data) return;
  await admin.storage.createBucket(bucket, { public: false });
}
