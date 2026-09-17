// ============================================================================
// Ciclo de vida de um colaborador — provas contra PostgreSQL real
// ============================================================================
//
// 🔴 O defeito, e porque é que só um Postgres a sério o mostra.
//
//    `deleteColaborador` anulava a autoria em nove colunas e depois chamava
//    `deleteUser`. O catálogo tem quarenta e seis colunas a apontar para
//    `profiles`. As trinta e sete restantes bloqueavam o DELETE — DEPOIS das
//    nove já terem sido anuladas.
//
//    Uma prova em memória não consegue mostrar isto, porque o que faz o DELETE
//    falhar é a integridade referencial real. Sem FKs a sério, a sequência
//    antiga «passa» e a suite fica verde sobre um defeito que apaga histórico
//    em produção. É por isso que estes ensaios montam o schema com a forma
//    REAL da base e medem o que lá acontece.
//
// O ensaio decisivo é o `ANTES vs DEPOIS`: corre a sequência antiga contra o
// schema real, mostra que ela deixa o perfil vivo com autorias já perdidas, e
// mostra que o caminho novo não escreve absolutamente nada.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  INVENTARIO_FK_PERFIS,
  avaliarRemocao,
  resumirPorArea,
} from "@/domain/collaborators/lifecycle";
import type { SondagemRelacao } from "@/domain/collaborators/lifecycle-types";

import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import {
  ACTOR,
  ACTOR_OUTRA,
  CLIENTE_A,
  EMPRESA,
  LOCAL_A,
  OUTRA,
  montarPalcoCrm,
  novaLead,
} from "./helpers/crm-pg-harness";

const CONTAINER = `colablifecycle-${process.pid}`;
const LENTO = { timeout: 120_000 };

/** A pessoa que sai. Criada de novo a cada ensaio. */
const SAI = "5a1da001-0001-4001-8001-000000000001";
/** Uma segunda pessoa, para provar que a sondagem não confunde perfis. */
const FICA = "5a1da002-0002-4002-8002-000000000002";

let container: PostgresContainer;
let pool: pg.Pool;

/**
 * A mesma pergunta que o gerador faz ao catálogo.
 *
 * Repetida aqui, e NÃO importada do gerador: se os dois lessem a mesma
 * constante, um erro na pergunta passaria despercebido por concordarem um com
 * o outro. O que se compara é o catálogo contra o ficheiro entregue.
 */
const CATALOGO = `
  SELECT
    con.conname AS restricao,
    src.relname AS tabela,
    (SELECT a.attname
       FROM unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord)
       JOIN unnest(con.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
       JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = f.attnum
       JOIN pg_attribute a  ON a.attrelid  = con.conrelid  AND a.attnum  = k.attnum
      WHERE pa.attname = 'id') AS coluna,
    CASE con.confdeltype
      WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'  WHEN 'd' THEN 'SET DEFAULT'
    END AS on_delete,
    cardinality(con.conkey) > 1 AS composta
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

const assinatura = (r: {
  tabela: string; coluna: string; restricao: string; onDelete: string; composta: boolean;
}) => `${r.tabela}.${r.coluna} [${r.restricao}] ${r.onDelete}${r.composta ? " composta" : ""}`;

async function lerCatalogo(db: pg.Pool | pg.Client): Promise<string[]> {
  const { rows } = await db.query(CATALOGO);
  return (rows as { restricao: string; tabela: string; coluna: string; on_delete: string; composta: boolean }[])
    .map((r) => assinatura({ ...r, onDelete: r.on_delete }))
    .sort();
}

/**
 * Sonda as quarenta e seis referências contra SQL, como a action faz por HTTP.
 *
 * Devolve exactamente a mesma forma que `sondarRelacoesDoPerfil`, para que o
 * módulo de decisão sob ensaio seja o mesmo que corre em produção. O que muda
 * é só o transporte.
 */
async function sondar(db: pg.Pool | pg.Client, perfil: string): Promise<SondagemRelacao[]> {
  const saida: SondagemRelacao[] = [];
  for (const ref of INVENTARIO_FK_PERFIS) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM public.${ref.tabela} WHERE ${ref.coluna} = $1`,
      [perfil],
    );
    saida.push({ ref, estado: "lida", contagem: rows[0].n as number });
  }
  return saida;
}

/** Semeia as duas pessoas do ensaio, ambas sem qualquer relação. */
async function semearPessoas(db: pg.Pool | pg.Client): Promise<void> {
  await db.query("INSERT INTO auth.users (id, email) VALUES ($1,'sai@teste.pt'), ($2,'fica@teste.pt')", [SAI, FICA]);
  await db.query(
    `INSERT INTO public.profiles (id, company_id, full_name, role, status)
     VALUES ($1,$2,'Quem Sai','colaborador','ativo'), ($3,$4,'Quem Fica','colaborador','ativo')`,
    [SAI, EMPRESA, FICA, EMPRESA],
  );
}

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "colaboradores",
    memory: "512m",
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => { /* já fechado */ });
  container?.stop();
});

beforeEach(async () => {
  await montarPalcoCrm(pool);
  await semearPessoas(pool);
});

// ---------------------------------------------------------------------------
describe("inventário de FKs para profiles", () => {
  it("o ficheiro entregue descreve o catálogo, referência a referência", LENTO, async () => {
    const doCatalogo = await lerCatalogo(pool);
    const doFicheiro = INVENTARIO_FK_PERFIS.map(assinatura).sort();

    // Igualdade, não inclusão. Uma referência a mais no ficheiro seria uma
    // sondagem a uma coluna que não existe — o guard falharia sempre e a
    // eliminação ficaria impossível sem ninguém perceber porquê.
    expect(doFicheiro).toEqual(doCatalogo);
  });

  it("cobre as quarenta e seis, e não as nove que o fluxo antigo conhecia", LENTO, async () => {
    const doCatalogo = await lerCatalogo(pool);
    expect(doCatalogo.length).toBe(46);

    // As nove do fluxo antigo, tal como lá estavam escritas.
    const antigas = [
      "services.created_by", "services.cancelled_by", "contracts.created_by",
      "absences.created_by", "absences.approved_by", "absences.replaced_by",
      "vacation_requests.reviewed_by", "invoices.created_by", "payroll_records.approved_by",
    ];
    const todas = INVENTARIO_FK_PERFIS.map((r) => `${r.tabela}.${r.coluna}`);
    for (const a of antigas) expect(todas).toContain(a);
    expect(todas.filter((t) => !antigas.includes(t)).length).toBe(37);
  });

  it("uma FK nova e desconhecida deixa o guard vermelho", LENTO, async () => {
    // O cenário que este ficheiro inteiro existe para apanhar: alguém
    // acrescenta uma tabela que aponta para `profiles` e esquece-se do
    // inventário. Sem esta prova, o guard continuaria a dar verde a apagar um
    // perfil que já é responsável por alguma coisa nessa tabela nova.
    await pool.query(`
      CREATE TABLE public.tabela_futura (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        aprovado_por uuid REFERENCES public.profiles(id)
      );
    `);

    const doCatalogo = await lerCatalogo(pool);
    const doFicheiro = INVENTARIO_FK_PERFIS.map(assinatura).sort();

    expect(doCatalogo).toContain("tabela_futura.aprovado_por [tabela_futura_aprovado_por_fkey] NO ACTION");
    expect(doFicheiro).not.toEqual(doCatalogo);
  });
});

// ---------------------------------------------------------------------------
describe("elegibilidade para eliminação física", () => {
  it("um perfil sem nada atrás é elegível", LENTO, async () => {
    const veredicto = avaliarRemocao(await sondar(pool, SAI));
    expect(veredicto.codigo).toBe("SEM_HISTORICO");
    expect(veredicto.elegivel).toBe(true);
    expect(veredicto.totalRegistos).toBe(0);
  });

  it("e o DELETE passa mesmo, sem uma única autoria anulada antes", LENTO, async () => {
    await pool.query("DELETE FROM public.profiles WHERE id = $1", [SAI]);
    const { rows } = await pool.query("SELECT count(*)::int n FROM public.profiles WHERE id=$1", [SAI]);
    expect(rows[0].n).toBe(0);
  });

  /**
   * Cada caso semeia UMA relação e afirma que ela sozinha chega para recusar.
   *
   * Em lista e não em ensaios separados porque a afirmação é a mesma para
   * todas: uma linha em qualquer parte do inventário é histórico, e histórico
   * não se apaga para caber num DELETE. Escrevê-las à mão, uma a uma, só
   * convidaria a que a próxima ficasse de fora.
   */
  const CASOS: { nome: string; area: string; sql: (p: string) => [string, unknown[]] }[] = [
    {
      nome: "histórico financeiro — fluxo de caixa",
      area: "financeiro",
      sql: (p) => [
        `INSERT INTO public.cash_flow_entries (company_id, type, amount, description, date, created_by)
         VALUES ($1,'saida',100,'Compra','2026-09-01',$2)`,
        [EMPRESA, p],
      ],
    },
    {
      nome: "histórico financeiro — pagamentos fixos/variáveis",
      area: "financeiro",
      sql: (p) => [
        `INSERT INTO public.fixed_variable_payments
           (company_id, kind, description, amount, period_year, period_month, created_by)
         VALUES ($1,'fixo','Renda',500,2026,9,$2)`,
        [EMPRESA, p],
      ],
    },
    {
      nome: "períodos financeiros fechados por esta pessoa",
      area: "financeiro",
      sql: (p) => [
        `INSERT INTO public.financial_periods (company_id, year, month, status, closed_by)
         VALUES ($1, 2026, 8, 'closed', $2)`,
        [EMPRESA, p],
      ],
    },
    {
      nome: "conciliação bancária — importação de extrato",
      area: "conciliacao",
      sql: (p) => [
        `INSERT INTO public.bank_statement_imports
           (company_id, file_name, file_type, file_hash, status, uploaded_by)
         VALUES ($1,'extrato.csv','csv','hash-1','completed',$2)`,
        [EMPRESA, p],
      ],
    },
    {
      nome: "tarefas de gestão — atribuídas",
      area: "tarefas",
      sql: (p) => [
        "INSERT INTO public.management_tasks (company_id, title, assigned_to) VALUES ($1,'Rever rotas',$2)",
        [EMPRESA, p],
      ],
    },
    {
      nome: "tarefas de gestão — criadas",
      area: "tarefas",
      sql: (p) => [
        "INSERT INTO public.management_tasks (company_id, title, created_by) VALUES ($1,'Comprar material',$2)",
        [EMPRESA, p],
      ],
    },
    {
      nome: "documentos carregados por esta pessoa",
      area: "documentos",
      sql: (p) => [
        `INSERT INTO public.collaborator_documents (company_id, collaborator_id, category, file_name, file_url, uploaded_by)
         VALUES ($1,$2,'contrato','ct.pdf','https://x/ct.pdf',$3)`,
        [EMPRESA, FICA, p],
      ],
    },
    {
      nome: "CRM — dona de uma lead",
      area: "crm",
      sql: (p) => [
        "UPDATE public.crm_leads SET owner_id = $1 WHERE company_id = $2",
        [p, EMPRESA],
      ],
    },
    {
      nome: "CRM — criou uma lead",
      area: "crm",
      sql: (p) => [
        "UPDATE public.crm_leads SET created_by = $1 WHERE company_id = $2",
        [p, EMPRESA],
      ],
    },
  ];

  for (const caso of CASOS) {
    it(`recusa: ${caso.nome}`, LENTO, async () => {
      if (caso.area === "crm") await novaLead(pool);
      const [sql, args] = caso.sql(SAI);
      await pool.query(sql, args);

      const veredicto = avaliarRemocao(await sondar(pool, SAI));
      expect(veredicto.elegivel).toBe(false);
      expect(veredicto.codigo).toBe("TEM_HISTORICO");
      expect(resumirPorArea(veredicto.relacoes).map((a) => a.area)).toContain(caso.area);

      // E a base concorda: o DELETE que o guard recusou também não passaria.
      await expect(
        pool.query("DELETE FROM public.profiles WHERE id = $1", [SAI]),
      ).rejects.toThrow();
    });
  }

  it("CRM — autor de uma interação", LENTO, async () => {
    const lead = await novaLead(pool);
    await pool.query(
      `INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary, author_id)
       VALUES ($1,$2,'nota','Primeiro contacto',$3)`,
      [EMPRESA, lead, SAI],
    );

    const veredicto = avaliarRemocao(await sondar(pool, SAI));
    expect(veredicto.elegivel).toBe(false);
    expect(resumirPorArea(veredicto.relacoes).map((a) => a.area)).toContain("crm");
  });

  it("serviços e contratos com autoria desta pessoa", LENTO, async () => {
    await pool.query(
      `INSERT INTO public.contracts (company_id, location_id, frequency, starts_on, created_by)
       VALUES ($1,$2,'semanal','2026-01-01',$3)`,
      [EMPRESA, LOCAL_A, SAI],
    );
    const veredicto = avaliarRemocao(await sondar(pool, SAI));
    expect(veredicto.elegivel).toBe(false);
    expect(resumirPorArea(veredicto.relacoes).map((a) => a.area)).toContain("contratos");
  });

  it("uma relação de OUTRA empresa também conta", LENTO, async () => {
    // A sondagem corre sem filtro de empresa, e é de propósito. Uma linha de
    // outra empresa a apontar para este perfil destrói-se na mesma quando ele
    // desaparece, e um guard que filtrasse por empresa daria verde a isso.
    await pool.query(
      "INSERT INTO public.management_tasks (company_id, title, assigned_to) VALUES ($1,'Tarefa alheia',$2)",
      [OUTRA, SAI],
    );
    const veredicto = avaliarRemocao(await sondar(pool, SAI));
    expect(veredicto.elegivel).toBe(false);
    expect(veredicto.relacoes.some((r) => r.tabela === "management_tasks")).toBe(true);
  });

  it("uma relação de outra pessoa não conta para esta", LENTO, async () => {
    await pool.query(
      "INSERT INTO public.management_tasks (company_id, title, assigned_to) VALUES ($1,'Tarefa da outra',$2)",
      [EMPRESA, FICA],
    );
    expect(avaliarRemocao(await sondar(pool, SAI)).elegivel).toBe(true);
    expect(avaliarRemocao(await sondar(pool, FICA)).elegivel).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("fail-closed — não saber nunca autoriza apagar", () => {
  it("uma sondagem falhada recusa, mesmo com tudo o resto a zero", LENTO, async () => {
    const sondagens = await sondar(pool, SAI);
    const comFalha: SondagemRelacao[] = [
      ...sondagens.slice(1),
      { ref: sondagens[0].ref, estado: "falhada", detalhe: "ligação perdida" },
    ];
    const veredicto = avaliarRemocao(comFalha);
    expect(veredicto.elegivel).toBe(false);
    expect(veredicto.codigo).toBe("SONDAGEM_FALHADA");
  });

  it("uma referência por sondar recusa — a ausência não é zero", LENTO, async () => {
    const sondagens = (await sondar(pool, SAI)).slice(1);
    const veredicto = avaliarRemocao(sondagens);
    expect(veredicto.elegivel).toBe(false);
    expect(veredicto.codigo).toBe("SONDAGEM_INCOMPLETA");
  });

  it("uma sondagem repetida não tapa uma referência que ninguém tocou", LENTO, async () => {
    const sondagens = await sondar(pool, SAI);
    const batoteiro = [...sondagens.slice(1), sondagens[1]];
    expect(batoteiro.length).toBe(sondagens.length);
    expect(avaliarRemocao(batoteiro).codigo).toBe("SONDAGEM_INCOMPLETA");
  });
});

// ---------------------------------------------------------------------------
describe("o estado proibido: perfil vivo + histórico meio-apagado", () => {
  /** Semeia autoria nas nove colunas que o fluxo antigo anulava, e numa que não. */
  async function semearAutorias(): Promise<void> {
    await pool.query(
      `INSERT INTO public.contracts (company_id, location_id, frequency, starts_on, created_by)
       VALUES ($1,$2,'semanal','2026-01-01',$3)`,
      [EMPRESA, LOCAL_A, SAI],
    );
    await pool.query(
      `INSERT INTO public.invoices (company_id, client_id, invoice_number, invoice_date, due_date, total, created_by)
       VALUES ($1,$2,'F2026/001','2026-01-05','2026-02-05',123,$3)`,
      [EMPRESA, CLIENTE_A, SAI],
    );
    // Esta é das trinta e sete que o fluxo antigo NÃO conhecia. É ela que faz
    // o DELETE falhar — depois de as outras já terem sido anuladas.
    await pool.query(
      `INSERT INTO public.cash_flow_entries (company_id, type, amount, description, date, created_by)
       VALUES ($1,'saida',100,'Compra','2026-09-01',$2)`,
      [EMPRESA, SAI],
    );
  }

  const autorias = async () => {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM public.contracts          WHERE created_by = $1) AS contratos,
         (SELECT count(*)::int FROM public.invoices           WHERE created_by = $1) AS faturas,
         (SELECT count(*)::int FROM public.cash_flow_entries  WHERE created_by = $1) AS caixa,
         (SELECT count(*)::int FROM public.profiles           WHERE id         = $1) AS perfil`,
      [SAI],
    );
    return rows[0] as { contratos: number; faturas: number; caixa: number; perfil: number };
  };

  it("ANTES: a sequência antiga produz o estado proibido", LENTO, async () => {
    await semearAutorias();

    // A sequência antiga, tal como estava — cada UPDATE confirma-se sozinho,
    // porque a chave administrativa fala por HTTP e não há transação nenhuma
    // a envolvê-los.
    await pool.query("UPDATE public.contracts SET created_by = NULL WHERE created_by = $1", [SAI]);
    await pool.query("UPDATE public.invoices  SET created_by = NULL WHERE created_by = $1", [SAI]);

    // E então o DELETE, que a décima referência recusa.
    await expect(
      pool.query("DELETE FROM public.profiles WHERE id = $1", [SAI]),
    ).rejects.toThrow();

    const depois = await autorias();
    expect(depois.perfil).toBe(1);      // PROFILE_EXISTS = YES
    expect(depois.contratos).toBe(0);   // autoria perdida
    expect(depois.faturas).toBe(0);     // autoria perdida
    expect(depois.caixa).toBe(1);       // a que bloqueou, intacta
    // Exactamente o par que a direcção proíbe.
  });

  it("DEPOIS: o caminho novo recusa sem escrever nada", LENTO, async () => {
    await semearAutorias();
    const antes = await autorias();

    const veredicto = avaliarRemocao(await sondar(pool, SAI));
    expect(veredicto.elegivel).toBe(false);

    // A recusa é a operação inteira. Não houve UPDATE nenhum a preceder o
    // DELETE, porque não há DELETE a preceder.
    expect(await autorias()).toEqual(antes);
    expect(antes.contratos).toBe(1);
    expect(antes.faturas).toBe(1);
    expect(antes.caixa).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("o que `status = 'inativo'` faz, e o que não faz", () => {
  it("desativar preserva TODAS as relações", LENTO, async () => {
    await pool.query(
      `INSERT INTO public.contracts (company_id, location_id, frequency, starts_on, created_by)
       VALUES ($1,$2,'semanal','2026-01-01',$3)`,
      [EMPRESA, LOCAL_A, SAI],
    );
    const antes = avaliarRemocao(await sondar(pool, SAI));

    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [SAI]);

    const depois = avaliarRemocao(await sondar(pool, SAI));
    expect(depois.totalRegistos).toBe(antes.totalRegistos);
    const { rows } = await pool.query("SELECT status FROM public.profiles WHERE id=$1", [SAI]);
    expect(rows[0].status).toBe("inativo");
  });

  it("🔴 o enum da aplicação e o CHECK da base não coincidem", LENTO, async () => {
    // Achado, registado e NÃO corrigido aqui.
    //
    // `colaboradores.ts` declara `z.enum(["ativo","inativo","arquivado"])`; a
    // migration 002 declara `CHECK (status IN ('ativo','inativo','suspenso'))`.
    // «arquivado» passa a validação e é recusado pela base; «suspenso» é
    // aceite pela base e recusado pela validação — e a ficha do colaborador
    // mostra «Suspenso» para tudo o que não seja ativo ou inativo.
    //
    // Fica aqui porque é sobre o ciclo de vida e porque ninguém o tinha
    // escrito. Não se corrige nesta branch: alinhar os dois lados é mexer no
    // schema ou no contrato da action, e a 102 não abre aqui.
    const migracao = readFileSync(join(process.cwd(), "supabase/migrations/002_profiles.sql"), "utf8");
    const check = /CHECK \(status IN \(([^)]*)\)\)/.exec(migracao);
    expect(check, "a migration 002 tem de continuar a declarar o CHECK").not.toBeNull();
    const naBase = (check as RegExpExecArray)[1].split(",").map((v) => v.trim().replace(/'/g, ""));
    expect(naBase).toEqual(["ativo", "inativo", "suspenso"]);

    const action = readFileSync(join(process.cwd(), "src/app/actions/colaboradores.ts"), "utf8");
    expect(action).toContain('z.enum(["ativo", "inativo", "arquivado"])');
    expect(naBase).not.toContain("arquivado");

    // O palco não pode medir isto: o dump da forma de produção extrai tabelas,
    // colunas, PK/FK, RLS e políticas — não restrições CHECK. Afirmar contra
    // ele que a base recusa «arquivado» daria verde onde a base real recusa.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE contype='c' AND conrelid='public.profiles'::regclass`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("🔴 nenhuma política RLS consulta `profiles.status`", LENTO, async () => {
    // A prova mais importante deste bloco, e a que contraria o que os
    // comentários do repositório afirmam («status controla acesso e escala»).
    //
    // Em base, `status` não fecha porta nenhuma: não é lido por política
    // alguma. Quem for marcado como inativo continua a poder ler e escrever
    // tudo o que a sua `role` permite — é por isso que `desativarColaborador`
    // TEM de banir a conta no Auth, e não pode limitar-se a mudar a coluna.
    const { rows } = await pool.query(`
      SELECT count(*)::int AS n
      FROM pg_policies
      WHERE schemaname = 'public'
        AND (COALESCE(qual,'') ILIKE '%status%' OR COALESCE(with_check,'') ILIKE '%status%')
        AND (COALESCE(qual,'') ILIKE '%profiles%' OR COALESCE(with_check,'') ILIKE '%profiles%')
    `);
    expect(rows[0].n).toBe(0);
  });

  it("as escalas e a folha, essas, filtram por 'ativo'", LENTO, async () => {
    // O contrapeso do ensaio anterior: `status` não fecha o acesso, mas é
    // respeitado pelas consultas que montam equipas e folha de pagamento. É
    // essa a parte da desativação que já funciona hoje.
    await pool.query("UPDATE public.profiles SET status='inativo' WHERE id=$1", [SAI]);
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM public.profiles
        WHERE company_id=$1 AND role='colaborador' AND status='ativo'`,
      [EMPRESA],
    );
    expect(rows[0].n).toBe(1); // só FICA
  });
});

// ---------------------------------------------------------------------------
describe("isolamento entre empresas", () => {
  it("a FK composta do CRM recusa uma dona de outra empresa", LENTO, async () => {
    const lead = await novaLead(pool);
    await expect(
      pool.query("UPDATE public.crm_leads SET owner_id=$1 WHERE id=$2", [ACTOR_OUTRA, lead]),
    ).rejects.toThrow();
    await pool.query("UPDATE public.crm_leads SET owner_id=$1 WHERE id=$2", [ACTOR, lead]);
  });
});
