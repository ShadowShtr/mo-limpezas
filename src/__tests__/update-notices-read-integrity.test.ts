// ============================================================================
// AVISOS — integridade do «marcar como lido» e da contagem de destinatários
// ============================================================================
// Duas classes de defeito que a revisão apanhou antes de a 076 ir a produção:
//
//   1. `markNoticeAsRead` aceitava qualquer string. Marcar como lida uma
//      release ainda fora do lote fazia-a desaparecer sem nunca ter sido
//      mostrada — o utilizador nunca sabia o que tinha mudado.
//
//   2. A publicação escrevia primeiro e contava depois, devolvendo
//      `recipients = -1` com `ok: true` se a contagem falhasse. Publicar sem
//      saber para quem, e apresentar isso como sucesso.
//
// Os cenários de base (contra Postgres real) estão em `tmp/validate-076.mjs`.
// Aqui prova-se o contrato do runtime por inspecção do código — a alternativa
// seria montar todo o cliente Supabase em memória, e o que interessa é que as
// barreiras existem e estão na ordem certa.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();
const ACTION = fs.readFileSync(path.join(RAIZ, "src/app/actions/update-notices.ts"), "utf8");
const MIGRATION = fs.readFileSync(
  path.join(RAIZ, "supabase/migrations/076_update_notices.sql"), "utf8",
);

/** Sem comentários: as notas citam os padrões antigos para os explicar. */
function semComentarios(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

function corpoDe(nome: string): string {
  const i = ACTION.indexOf(`export async function ${nome}`);
  if (i < 0) return "";
  const resto = ACTION.slice(i + 10);
  const fim = resto.indexOf("\nexport async function ");
  return fim < 0 ? resto : resto.slice(0, fim);
}

describe("🔴 NOTICE_KEY_SERVER_VALIDATION", () => {
  const corpo = corpoDe("markNoticeAsRead");

  it("a chave é validada contra o ciclo actual do perfil", () => {
    expect(corpo).toContain("resolverCicloEstrito");
    expect(corpo).toMatch(/ciclo\.some\(\(n\) => n\.key === noticeKey\)/);
  });

  it("recusa uma chave fora do ciclo", () => {
    expect(corpo).toContain("Este aviso não está disponível para este perfil");
  });

  it("🔴 a mensagem de recusa não distingue os motivos", () => {
    // Dizer «esse aviso é de outra empresa» confirmaria a existência de avisos
    // alheios a quem tentasse adivinhar chaves.
    expect(semComentarios(corpo)).not.toMatch(/outra empresa|outro tenant/i);
  });

  it("usa o resolver ESTRITO, não a versão que engole erros", () => {
    // `getPendingNotices` devolve `[]` em erro — usá-lo aqui faria toda a
    // chave ser recusada durante uma falha transitória, ou pior, aceite.
    expect(corpo).not.toContain("getPendingNotices");
    expect(corpo).toContain("resolverCicloEstrito");
  });

  it("um erro ao resolver o ciclo recusa a escrita", () => {
    expect(corpo).toMatch(/catch[\s\S]{0,220}return \{ ok: false/);
  });

  it("READ_IDEMPOTENCY: uma chave já lida passa sem revalidar o ciclo", () => {
    // O segundo clique é o caso normal. A chave sai do ciclo assim que é
    // marcada — exigir que lá continuasse faria o duplo clique falhar.
    const posJaLido = corpo.indexOf("jaLido");
    const posCiclo = corpo.indexOf("resolverCicloEstrito");
    expect(posJaLido).toBeGreaterThan(-1);
    expect(posJaLido).toBeLessThan(posCiclo);
    expect(corpo).toMatch(/if \(jaLido\) return \{ ok: true \}/);
  });

  it("o profile_id sai da sessão, nunca de argumento", () => {
    expect(corpo).toContain("profile_id: profile.id");
    expect(ACTION).not.toMatch(/markNoticeAsRead\([^)]*profileId/);
  });

  it("mantém o upsert idempotente", () => {
    expect(corpo).toContain("ignoreDuplicates: true");
    expect(corpo).toContain('onConflict: "profile_id,notice_key"');
  });
});

describe("🔴 DIRECT_APP_NOTICE_READ_INSERT = DENY", () => {
  it("não há policy de INSERT em app_notice_reads", () => {
    // `WITH CHECK (profile_id = auth.uid())` parecia seguro, mas só validava a
    // coluna do perfil: qualquer sessão podia gravar a sua própria leitura com
    // uma notice_key à escolha, contornando a validação da action.
    expect(MIGRATION).toContain('DROP POLICY IF EXISTS "insert own reads"');
    expect(MIGRATION).not.toMatch(/CREATE POLICY "insert own reads"/);
  });

  it("nenhuma policy de INSERT em app_notice_reads", () => {
    const criacoes = MIGRATION.match(/CREATE POLICY[\s\S]{0,200}?ON public\.app_notice_reads[\s\S]{0,120}?FOR (\w+)/g) ?? [];
    for (const c of criacoes) {
      expect(c, "policy de INSERT recriada").not.toMatch(/FOR INSERT/);
    }
  });

  it("ler as próprias leituras continua permitido", () => {
    expect(MIGRATION).toMatch(/CREATE POLICY "read own reads"[\s\S]{0,160}FOR SELECT/);
  });

  it("app_notices e app_notice_targets continuam fail closed", () => {
    expect(MIGRATION).not.toMatch(/CREATE POLICY[^;]*ON public\.app_notices[\s\S]{0,120}FOR SELECT/);
    expect(MIGRATION).not.toMatch(/CREATE POLICY[^;]*ON public\.app_notice_targets/);
  });
});

describe("🔴 RECIPIENT_COUNT_PREWRITE", () => {
  const corpo = corpoDe("publishNotice");

  it("conta ANTES de qualquer escrita", () => {
    const posContagem = corpo.indexOf("validarEContarDestinatarios");
    const posInsert = corpo.indexOf('.from("app_notices")');
    expect(posContagem).toBeGreaterThan(-1);
    expect(posInsert).toBeGreaterThan(-1);
    // Se a contagem falhar, não nasce nem o rascunho.
    expect(posContagem).toBeLessThan(posInsert);
  });

  it("🔴 RECIPIENTS_NEGATIVE_SENTINEL = 0", () => {
    // «Publicado para -1 perfis» era sucesso com uma propriedade desconhecida.
    expect(semComentarios(corpo)).not.toContain("recipients = -1");
    expect(semComentarios(ACTION)).not.toMatch(/recipients\s*=\s*-1/);
  });

  it("não publica e conta depois", () => {
    expect(corpo).not.toMatch(/contagem pós-publicação/);
  });

  it("o preview e a publicação usam a mesma função", () => {
    // Duas regras separadas divergiriam, e o número mostrado antes de publicar
    // deixaria de corresponder ao que acontece.
    expect(corpoDe("countRecipients")).toContain("validarEContarDestinatarios");
    expect(corpo).toContain("validarEContarDestinatarios");
  });

  it("a função autoritativa lança em vez de devolver zero", () => {
    const i = ACTION.indexOf("async function validarEContarDestinatarios");
    const bloco = ACTION.slice(i, i + 2400);
    expect(bloco).toMatch(/if \(error\) throw error/);
    expect(bloco).not.toMatch(/return \{ count: 0/);
  });
});

describe("🔴 INACTIVE_PROFILE_TARGET = DENY", () => {
  const i = ACTION.indexOf("async function validarEContarDestinatarios");
  const bloco = ACTION.slice(i, i + 2400);

  it("perfis explícitos têm de estar activos", () => {
    // Validar só «o id existe» deixava passar um perfil inactivo: cinco ids
    // seleccionados, três pessoas alcançáveis, e o painel dizia cinco.
    expect(bloco).toMatch(/\.in\("id", profileIds\)[\s\S]{0,80}\.eq\("status", "ativo"\)/);
  });

  it("recusa se algum id não estiver no conjunto activo", () => {
    expect(bloco).toContain("não existe ou não está activo");
  });

  it("a contagem por empresa conta só perfis activos", () => {
    expect(bloco).toMatch(/\.in\("company_id", companyIds\)[\s\S]{0,80}\.eq\("status", "ativo"\)/);
  });

  it("deduplica antes de validar e contar", () => {
    expect(bloco).toContain("new Set(companyIdsIn)");
    expect(bloco).toContain("new Set(profileIdsIn)");
  });
});

describe("publicação continua em duas fases", () => {
  const corpo = corpoDe("publishNotice");

  it("nasce rascunho e só depois é publicado", () => {
    expect(corpo).toContain("published_at: null");
    const posDraft = corpo.indexOf("published_at: null");
    const posPublish = corpo.indexOf("published_at: new Date().toISOString()");
    expect(posPublish).toBeGreaterThan(posDraft);
  });

  it("os alvos entram antes da publicação", () => {
    const posAlvos = corpo.indexOf('.from("app_notice_targets")');
    const posPublish = corpo.indexOf("published_at: new Date().toISOString()");
    expect(posAlvos).toBeGreaterThan(-1);
    expect(posAlvos).toBeLessThan(posPublish);
  });
});
