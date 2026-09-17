// ============================================================================
// Inventário automático das referências a `profiles` — gerador
// ============================================================================
//
// 🔴 Porque é que isto é um gerador e não uma lista escrita à mão.
//
//    O fluxo antigo de remoção de um colaborador anulava NOVE colunas. O
//    catálogo tem quarenta e seis. A lista tinha sido escrita à mão uma vez e
//    nunca mais foi lida contra a base: cada migration que acrescentou uma
//    referência a `profiles` — a conciliação bancária, os períodos
//    financeiros, as tarefas de gestão, o funil de leads — alargou o buraco
//    sem que nada ficasse vermelho.
//
//    Uma lista que só um humano atualiza é uma lista que envelhece em
//    silêncio. Esta é lida do `pg_constraint` de um palco com a forma real do
//    schema de produção, e `collaborator-lifecycle-postgres.test.ts` volta a
//    lê-la a cada corrida: se o catálogo e o ficheiro divergirem, o ensaio
//    fica vermelho antes de alguém dar pela diferença.
//
// Correr com:  npx tsx scripts/generate-profile-fk-inventory.ts
//
// Não fala com o Supabase, não lê `.env`, não escreve em base nenhuma a não
// ser num contentor descartável que ele próprio cria e destrói.
// ============================================================================

import { writeFileSync } from "node:fs";
import pg from "pg";

import { startPostgresContainer } from "../src/__tests__/helpers/pg-container";
import { montarPalcoCrm } from "../src/__tests__/helpers/crm-pg-harness";

const DESTINO = "src/domain/collaborators/profile-fk-inventory.ts";

/**
 * A pergunta ao catálogo: que colunas apontam para `public.profiles(id)`.
 *
 * `conkey`/`confkey` são percorridos em paralelo porque as referências do
 * funil de leads são COMPOSTAS — `(owner_id, company_id)` contra
 * `(id, company_id)`. O que interessa é a coluna filha emparelhada com o `id`
 * do perfil; a outra é a barreira de empresa, e anulá-la seria um erro.
 */
const PERGUNTA = `
  SELECT
    con.conname                                        AS restricao,
    src.relname                                        AS tabela,
    (SELECT a.attname
       FROM unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord)
       JOIN unnest(con.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = f.attnum
       JOIN pg_attribute a  ON a.attrelid  = con.conrelid  AND a.attnum  = k.attnum
      WHERE pa.attname = 'id')                         AS coluna,
    CASE con.confdeltype
      WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'  WHEN 'd' THEN 'SET DEFAULT'
    END                                                AS on_delete,
    cardinality(con.conkey) > 1                        AS composta
  FROM pg_constraint con
  JOIN pg_class     src    ON src.oid    = con.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_class     tgt    ON tgt.oid    = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
  WHERE con.contype = 'f'
    AND tgt_ns.nspname = 'public' AND tgt.relname = 'profiles'
    AND src_ns.nspname = 'public'
  ORDER BY src.relname, con.conname;
`;

export interface LinhaCatalogo {
  restricao: string;
  tabela: string;
  coluna: string;
  on_delete: string;
  composta: boolean;
}

/** Lê o catálogo de um palco já montado. Partilhado com o ensaio-guarda. */
export async function lerInventarioDoCatalogo(
  db: pg.Client | pg.Pool,
): Promise<LinhaCatalogo[]> {
  const { rows } = await db.query(PERGUNTA);
  return rows as LinhaCatalogo[];
}

/**
 * A que parte do negócio pertence cada tabela.
 *
 * Serve a interface: quando a remoção é recusada, quem está a ler tem de
 * perceber PORQUÊ em linguagem de quem usa o sistema — «tem folha de
 * pagamento», não «tem linhas em payroll_records».
 */
const AREAS: Record<string, string> = {
  absences: "faltas",
  vacation_requests: "ferias",
  timesheets: "ponto",
  daily_clocks: "ponto",
  payroll_records: "payroll",
  team_members: "equipas",
  teams: "equipas",
  services: "servicos",
  service_reinforcements: "servicos",
  service_photos: "servicos",
  service_price_audit: "servicos",
  contracts: "contratos",
  invoices: "financeiro",
  cash_flow_entries: "financeiro",
  fixed_variable_payments: "financeiro",
  financial_periods: "financeiro",
  bank_reconciliation_matches: "conciliacao",
  bank_statement_imports: "conciliacao",
  collaborator_documents: "documentos",
  attachments: "documentos",
  management_tasks: "tarefas",
  building_cards: "tarefas",
  notifications: "notificacoes",
  push_subscriptions: "notificacoes",
  client_notifications: "notificacoes",
  app_notices: "notificacoes",
  app_notice_reads: "notificacoes",
  app_notice_targets: "notificacoes",
  audit_logs: "auditoria",
  crm_leads: "crm",
  crm_lead_interactions: "crm",
  platform_admins: "plataforma",
  collaborator_ride_assignments: "transporte",
  vehicle_allocations: "transporte",
};

const CABECALHO = [
  "// ============================================================================",
  "// GERADO — não editar à mão",
  "// ============================================================================",
  "//",
  "// Produzido por `scripts/generate-profile-fk-inventory.ts` a partir do",
  "// `pg_constraint` de um palco com a forma real do schema de produção.",
  "//",
  "// 🔴 Este ficheiro é a lista COMPLETA de sítios onde um perfil pode ser",
  "//    responsável por alguma coisa. O guard de remoção percorre-o inteiro: uma",
  "//    entrada em falta não é uma imprecisão de documentação, é um perfil",
  "//    apagado com histórico atrás.",
  "//",
  "//    `src/__tests__/collaborator-lifecycle-postgres.test.ts` volta a ler o",
  "//    catálogo e compara-o com isto. Uma FK nova para `profiles` que não passe",
  "//    por aqui deixa esse ensaio vermelho — de propósito.",
  "//",
  "// Para regenerar:  npx tsx scripts/generate-profile-fk-inventory.ts",
  "// ============================================================================",
  "",
  'import type { ReferenciaPerfil } from "./lifecycle-types";',
  "",
  "export const INVENTARIO_FK_PERFIS: readonly ReferenciaPerfil[] = [",
].join("\n");

function serializar(linhas: LinhaCatalogo[]): string {
  const corpo = linhas
    .map((l) => {
      const area = AREAS[l.tabela] ?? "outros";
      // `CASCADE` desaparece com o perfil; tudo o resto BLOQUEIA o DELETE e é,
      // por isso, prova de que existe histórico com autoria por trás.
      return (
        `  { tabela: ${JSON.stringify(l.tabela)}, coluna: ${JSON.stringify(l.coluna)}, ` +
        `restricao: ${JSON.stringify(l.restricao)}, onDelete: ${JSON.stringify(l.on_delete)}, ` +
        `composta: ${l.composta}, area: ${JSON.stringify(area)} },`
      );
    })
    .join("\n");
  return `${CABECALHO}\n${corpo}\n] as const;\n`;
}

async function main(): Promise<void> {
  const contentor = await startPostgresContainer({
    name: `mo-fk-inventory-${process.pid}`,
    database: "inventario",
  });
  const db = new pg.Client({ ...contentor.connection });
  try {
    await db.connect();
    await montarPalcoCrm(db);
    const linhas = await lerInventarioDoCatalogo(db);
    const semColuna = linhas.filter((l) => !l.coluna);
    if (semColuna.length > 0) {
      // Uma FK para `profiles` que não emparelhe nenhuma coluna com `id` é uma
      // forma que este gerador não sabe ler. Escrever um inventário incompleto
      // seria pior do que não escrever nenhum.
      throw new Error(
        `FKs para profiles sem coluna emparelhada com id: ${semColuna
          .map((l) => l.restricao)
          .join(", ")}`,
      );
    }
    writeFileSync(DESTINO, serializar(linhas), "utf8");
    console.log(`${DESTINO}: ${linhas.length} referências a public.profiles.`);
  } finally {
    await db.end().catch(() => {
      /* já fechado */
    });
    contentor.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
