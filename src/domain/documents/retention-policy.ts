// ============================================================================
// RETENÇÃO DE DOCUMENTOS — quem pode ser destruído pelo relógio
// ============================================================================
//
// Regra pura, sem Supabase, sem React. Existe por causa de um risco ativo,
// não de uma dívida arquitetural:
//
//     recibo_salario
//       → expires_at = upload + 3 meses          (todas as categorias)
//       → cron diário procura expirados          (sem olhar à categoria)
//       → storage.remove(paths)                  (o ficheiro deixa de existir)
//
// Um recibo de vencimento carregado hoje perdia o ficheiro daqui a três meses,
// sem ninguém carregar em nada. O manifesto que o cron guarda antes de apagar
// tem **metadados**, não conteúdo: depois de correr, o documento não é
// recuperável a partir dele.
//
// ---------------------------------------------------------------------------
// O que este módulo decide, e o que não decide
// ---------------------------------------------------------------------------
//
// Decide: **o sistema pode apagar isto sozinho?**
//
// Não decide quanto tempo a lei obriga a guardar um recibo de vencimento. Essa
// é uma questão jurídica, e a resposta a dar enquanto ela não estiver escrita
// não é "três meses" — é "não destruir". `autoArchive: false` significa
// exatamente isto e nada mais: **não existe política de destruição automática
// aprovada, logo o sistema não destrói**.
//
// ---------------------------------------------------------------------------
// Porque é que a política tem de ser consultada, e não só a coluna
// ---------------------------------------------------------------------------
//
// Já existem linhas antigas com `category = "recibo_salario"` e um `expires_at`
// no passado. Corrigir isso com um `UPDATE` seria mexer em dados históricos
// para resolver um defeito de código — e um `UPDATE` errado num campo que
// comanda um cron destrutivo é pior do que o defeito.
//
// Por isso a proteção vive na **categoria**, não na data. Uma linha com
// `expires_at` de ontem e categoria protegida é ignorada pelo cron, sem que
// nada na base tenha de mudar. O risco fecha hoje, sem backfill.
// ============================================================================

import {
  DOCUMENT_CATEGORIES,
  parseDocumentCategory,
  type DocumentCategory,
} from "@/lib/collaborator-documents";

export interface DocumentRetentionPolicy {
  /** O sistema pode arquivar/apagar isto sozinho, por idade? */
  autoArchive: boolean;
  /** Meses até expirar. `null` quando não há expiração automática. */
  expiresAfterMonths: number | null;
}

/**
 * A política em vigor antes desta correção, para todas as categorias.
 * Mantém-se **exatamente** para tudo o que não seja recibo de vencimento —
 * esta ronda corrige um risco provado, não redesenha retenção.
 */
const POLITICA_PADRAO: DocumentRetentionPolicy = {
  autoArchive: true,
  expiresAfterMonths: 3,
};

const POLITICA_PROTEGIDA: DocumentRetentionPolicy = {
  autoArchive: false,
  expiresAfterMonths: null,
};

const POLITICAS: Record<DocumentCategory, DocumentRetentionPolicy> = {
  contrato:       POLITICA_PADRAO,
  identificacao:  POLITICA_PADRAO,
  avaria:         POLITICA_PADRAO,
  outro:          POLITICA_PADRAO,
  // 🔴 A única alteração de negócio desta ronda.
  recibo_salario: POLITICA_PROTEGIDA,
};

/**
 * Política de retenção de uma categoria.
 *
 * 🔴 Devolve `null` para uma categoria que não se reconhece — e isso **não** é
 *    o mesmo que devolver a política por omissão. Quem decide destruir tem de
 *    tratar `null` como recusa: aplicar três meses a uma categoria
 *    desconhecida seria decidir apagar um ficheiro sobre o qual não se sabe
 *    nada. Destruir exige certeza; guardar a mais, não.
 */
export function getDocumentRetentionPolicy(
  category: unknown,
): DocumentRetentionPolicy | null {
  const conhecida = parseDocumentCategory(category);
  return conhecida ? POLITICAS[conhecida] : null;
}

/**
 * Pode o cron destruir um documento desta categoria?
 *
 * Falha fechada por construção: categoria desconhecida devolve `false`.
 */
export function podeArquivarAutomaticamente(category: unknown): boolean {
  return getDocumentRetentionPolicy(category)?.autoArchive === true;
}

/**
 * `expires_at` a gravar num documento novo — `null` quando a categoria não
 * expira.
 *
 * Fonte única do cálculo. Antes, o `new Date(); setMonth(+3)` estava repetido
 * em três sítios do módulo de documentos, todos a ignorar a categoria.
 */
export function resolveDocumentExpiresAt(
  category: unknown,
  from: Date = new Date(),
): string | null {
  const politica = getDocumentRetentionPolicy(category);
  // Categoria desconhecida nunca chega aqui em escrita — o upload valida antes.
  // Se chegasse, não datar é a escolha segura: sem data, o cron não a apanha.
  if (!politica?.expiresAfterMonths) return null;

  const expira = new Date(from);
  expira.setMonth(expira.getMonth() + politica.expiresAfterMonths);
  return expira.toISOString();
}

/**
 * As categorias que o cron nunca pode destruir.
 *
 * Serve para restringir a própria consulta — mas é uma otimização, não a
 * proteção. A proteção é a verificação por documento em
 * `podeArquivarAutomaticamente`, feita imediatamente antes de apagar. Se
 * alguém remover este filtro da consulta um dia, o ficheiro continua a
 * sobreviver.
 */
export const CATEGORIAS_PROTEGIDAS: DocumentCategory[] = DOCUMENT_CATEGORIES
  .filter((c) => !POLITICAS[c].autoArchive);

/**
 * Para o ecrã: um documento desta categoria mostra data de expiração?
 *
 * 🔴 Categoria desconhecida devolve `false`, e a primeira versão desta função
 *    devolvia `true` — `politica?.expiresAfterMonths !== null` dá `undefined
 *    !== null`, que é verdadeiro. O optional chaining tinha transformado
 *    "não sei" em "expira", que é o mesmo erro que este módulo existe para
 *    fechar, cometido dentro do próprio módulo.
 */
export function mostraExpiracao(category: unknown): boolean {
  const politica = getDocumentRetentionPolicy(category);
  return politica !== null && politica.expiresAfterMonths !== null;
}

export const SEM_ELIMINACAO_AUTOMATICA = "Sem eliminação automática";
