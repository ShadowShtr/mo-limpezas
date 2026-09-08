// ============================================================================
// SUPERFÍCIE PÚBLICA — as views e quem as pode ler
// ============================================================================
//
// Este guard existe por causa de um modo de falha concreto, e não por
// princípio geral:
//
//   `CREATE OR REPLACE VIEW` preserva o ACL mas APAGA as `reloptions`.
//
// A 085 ligou `security_invoker = true` em `teams_with_members` e manteve, de
// propósito, o `GRANT SELECT` a `authenticated` — as duas coisas só são
// seguras juntas: o grant é aceitável porque o RLS company-scoped passa a
// filtrar as linhas.
//
// A 087 acrescentou duas colunas à mesma view com `CREATE OR REPLACE VIEW`.
// O grant sobreviveu; o `security_invoker` não. Caiu a metade que tornava o
// grant seguro, ficou a metade permissiva — e nada avisou, porque o SQL da 087
// está correcto naquilo que se propõe fazer.
//
// Nenhum teste de comportamento apanharia isto: a aplicação continua a
// funcionar exactamente na mesma. O que se perdeu foi uma garantia, e uma
// garantia perdida só se vê olhando para ela de propósito.
//
// Ver docs/SEC-POSTDDL-01.md para a caracterização completa.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRACOES = path.join(process.cwd(), "supabase/migrations");

const ficheirosSql = () =>
  fs
    .readdirSync(MIGRACOES)
    .filter((f) => f.endsWith(".sql"))
    .sort();

const ler = (f: string) => fs.readFileSync(path.join(MIGRACOES, f), "utf8");

/**
 * Views de `public` que uma migration alguma vez pôs em `security_invoker`.
 *
 * Uma view que já esteve aqui não pode voltar a ser recriada sem o repor: é
 * exactamente esse o passo que se perde sem dar por ele.
 */
function viewsComInvokerLigado(): Map<string, string> {
  const ligadas = new Map<string, string>();
  for (const f of ficheirosSql()) {
    if (f.startsWith("rollback/")) continue;
    const sql = ler(f);
    for (const m of sql.matchAll(
      /ALTER\s+VIEW\s+(?:public\.)?(\w+)\s+SET\s*\(\s*security_invoker\s*=\s*true/gi,
    )) {
      ligadas.set(m[1], f);
    }
    for (const m of sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?(\w+)[\s\S]{0,200}?WITH\s*\(\s*security_invoker\s*=\s*true/gi,
    )) {
      ligadas.set(m[1], f);
    }
  }
  return ligadas;
}

/** Views recriadas por `CREATE OR REPLACE VIEW`, e em que migration. */
function viewsRecriadas(): Array<{ view: string; ficheiro: string }> {
  const out: Array<{ view: string; ficheiro: string }> = [];
  for (const f of ficheirosSql()) {
    const sql = ler(f);
    for (const m of sql.matchAll(/CREATE\s+OR\s+REPLACE\s+VIEW\s+(?:public\.)?(\w+)/gi)) {
      out.push({ view: m[1], ficheiro: f });
    }
  }
  return out;
}

/**
 * O que está por reparar, com a razão escrita.
 *
 * Isto NÃO é uma lista de coisas toleradas. Enquanto tiver linhas, existe uma
 * view em produção a correr como dona quando não devia — e o relatório
 * SEC-POSTDDL-01 diz que existe, em vez de a esconder.
 */
const REGRESSOES_CONHECIDAS: Array<{
  view: string;
  ligadaEm: string;
  perdidaEm: string;
  razao: string;
}> = [
  {
    view: "teams_with_members",
    ligadaEm: "085_public_db_surface_closure.sql",
    perdidaEm: "087_equipas_r4.sql",
    razao:
      "A 087 acrescentou `revision` e `membership_snapshot` com CREATE OR REPLACE " +
      "VIEW, o que apagou as reloptions. A correção precisa de duas metades — " +
      "GRANT EXECUTE de permanent_membership_snapshot a authenticated, e só " +
      "depois o security_invoker — e tem de ser provada com SET ROLE contra " +
      "PostgreSQL real antes de qualquer aplicação. Ver docs/SEC-POSTDDL-01.md.",
  },
];

describe("superfície pública — views", () => {
  it("uma view que já teve security_invoker não é recriada sem o repor", () => {
    const ligadas = viewsComInvokerLigado();
    const conhecidas = new Set(REGRESSOES_CONHECIDAS.map((r) => r.view));
    const perdidas: string[] = [];

    for (const { view, ficheiro } of viewsRecriadas()) {
      const origem = ligadas.get(view);
      if (!origem) continue;
      // Recriada depois de ter sido ligada, no mesmo ficheiro ou num posterior?
      if (ficheiro < origem) continue;

      const sql = ler(ficheiro);
      const repoe = new RegExp(
        `(ALTER\\s+VIEW\\s+(?:public\\.)?${view}\\s+SET\\s*\\(\\s*security_invoker|` +
          `VIEW\\s+(?:public\\.)?${view}[\\s\\S]{0,400}?WITH\\s*\\(\\s*security_invoker)`,
        "i",
      );
      if (!repoe.test(sql) && !conhecidas.has(view)) {
        perdidas.push(`${ficheiro} recria ${view} (ligado em ${origem}) sem repor security_invoker`);
      }
    }

    expect(
      perdidas,
      "CREATE OR REPLACE VIEW apaga as reloptions: a view volta a correr como " +
        "dona e o RLS deixa de se aplicar, sem que nada na aplicação mude",
    ).toEqual([]);
  });

  it("cada regressão conhecida ainda corresponde ao que está nas migrations", () => {
    for (const r of REGRESSOES_CONHECIDAS) {
      // A migration que originalmente ligou o invoker continua a existir.
      expect(
        /ALTER\s+VIEW\s+(?:public\.)?teams_with_members\s+SET\s*\(\s*security_invoker/i.test(
          ler(r.ligadaEm),
        ),
        `${r.view}: ${r.ligadaEm} já não liga o security_invoker`,
      ).toBe(true);

      // E a que o desfez continua a recriá-la.
      expect(
        viewsRecriadas().some((v) => v.view === r.view && v.ficheiro === r.perdidaEm),
        `${r.view}: ${r.perdidaEm} já não a recria`,
      ).toBe(true);

      // 🔴 O sinal de que a regressão foi CORRIGIDA: uma migration posterior à
      //    que a desfez volta a ligar o invoker. Quando isso acontecer, esta
      //    entrada tem de sair da lista — e é este teste que o obriga, em vez
      //    de a deixar a dar ar de dívida ainda aberta.
      const reparada = ficheirosSql().filter(
        (f) =>
          f > r.perdidaEm &&
          new RegExp(
            `ALTER\\s+VIEW\\s+(?:public\\.)?${r.view}\\s+SET\\s*\\(\\s*security_invoker\\s*=\\s*true`,
            "i",
          ).test(ler(f)),
      );

      expect(
        reparada,
        `${r.view}: ${reparada.join(", ")} volta a ligar o security_invoker — ` +
          "a regressão foi corrigida e esta entrada deve sair de REGRESSOES_CONHECIDAS",
      ).toEqual([]);

      expect(r.razao.length, `${r.view} sem razão escrita`).toBeGreaterThan(80);
    }
  });

  it("a correção da teams_with_members leva as duas metades, não só o invoker", () => {
    // Ligar o security_invoker sozinho parte a página de contratos: a view
    // chama permanent_membership_snapshot, e authenticated não tem EXECUTE.
    // Se alguém escrever a migration de correção, ela tem de trazer o grant.
    const correcoes = ficheirosSql().filter((f) => {
      const sql = ler(f);
      return /ALTER\s+VIEW\s+(?:public\.)?teams_with_members\s+SET\s*\(\s*security_invoker\s*=\s*true/i.test(
        sql,
      );
    });

    // A 085 é a original e vive antes da 087 lhe acrescentar a função. Só
    // migrations POSTERIORES à 087 precisam de trazer o grant junto.
    const posteriores = correcoes.filter((f) => f > "087_equipas_r4.sql");

    for (const f of posteriores) {
      const sql = ler(f);
      expect(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(?:public\.)?permanent_membership_snapshot/i.test(sql),
        `${f} liga o security_invoker sem conceder EXECUTE de ` +
          "permanent_membership_snapshot a authenticated — a página de contratos " +
          "passa a apanhar permission denied",
      ).toBe(true);
    }
  });
});
