// ============================================================================
// AS QUATRO FONTES — o que entra, o que não entra, e porquê
// ============================================================================

import { describe, expect, it, vi } from "vitest";
import { carregarAvisos, AvisosSourceError } from "@/lib/avisos/load-avisos";

const HOJE = "2026-09-26";       // sábado
const AMANHA = "2026-09-27";
const ONTEM = "2026-09-25";
const DEPOIS = "2026-09-28";

type Linhas = Record<string, unknown[]>;
type Falhas = Record<string, string>;

/**
 * Um cliente falso que aplica os MESMOS filtros que o PostgREST aplicaria.
 *
 * 🔴 Não devolve simplesmente o que lhe dão. Se devolvesse, um ensaio que diga
 *    «um pagamento pago não entra» passaria mesmo que a consulta real não
 *    filtrasse por estado nenhum — e o que estaria a ser provado era o próprio
 *    ensaio, não o código.
 *
 *    Regista também cada filtro aplicado, para se poder afirmar que o recorte
 *    acontece na BASE e não em JavaScript.
 */
function fakeAdmin(linhas: Linhas, falhas: Falhas = {}) {
  const consultas: Array<{ tabela: string; filtros: string[] }> = [];

  function query(tabela: string) {
    const filtros: string[] = [];
    let dados = [...(linhas[tabela] ?? [])] as Record<string, unknown>[];
    const reg = { tabela, filtros };
    consultas.push(reg);

    const api = {
      select() { return api; },
      eq(col: string, val: unknown) {
        filtros.push(`eq:${col}`);
        dados = dados.filter((r) => r[col] === val);
        return api;
      },
      is(col: string, val: null) {
        filtros.push(`is:${col}`);
        dados = dados.filter((r) => (r[col] ?? null) === val);
        return api;
      },
      not(col: string, op: string, val: unknown) {
        filtros.push(`not:${col}:${op}`);
        if (op === "is" && val === null) {
          dados = dados.filter((r) => (r[col] ?? null) !== null);
        } else if (op === "in") {
          const dentro = String(val).replace(/^\(|\)$/g, "").split(",");
          dados = dados.filter((r) => !dentro.includes(String(r[col])));
        }
        return api;
      },
      lte(col: string, val: string) {
        filtros.push(`lte:${col}`);
        dados = dados.filter((r) => String(r[col]) <= val);
        return api;
      },
      gte(col: string, val: string) {
        filtros.push(`gte:${col}`);
        dados = dados.filter((r) => String(r[col]) >= val);
        return api;
      },
      lt(col: string, val: string) {
        filtros.push(`lt:${col}`);
        dados = dados.filter((r) => String(r[col]) < val);
        return api;
      },
      then(resolve: (v: unknown) => unknown) {
        if (falhas[tabela]) return resolve({ data: null, error: { message: falhas[tabela] } });
        return resolve({ data: dados, error: null });
      },
    };
    return api;
  }

  return { admin: { from: query } as never, consultas };
}

const EMPRESA = "empresa-a";
const OUTRA = "empresa-b";

const pagamento = (p: Record<string, unknown> = {}) => ({
  id: "pag-1", company_id: EMPRESA, description: "Seguro", amount: 120.5,
  due_date: HOJE, status: "pendente", ...p,
});
const tarefa = (p: Record<string, unknown> = {}) => ({
  id: "tar-1", company_id: EMPRESA, title: "Enviar recibos",
  due_date: HOJE, completed_at: null, ...p,
});
const lead = (p: Record<string, unknown> = {}) => ({
  id: "lead-1", company_id: EMPRESA, name: "Clínica Norte",
  next_action_at: HOJE, next_action_note: "Ligar", stage: "contactado", ...p,
});
// 12h00 de Lisboa no verão = 11h00Z. Fica bem dentro do dia, em qualquer fuso.
const visita = (p: Record<string, unknown> = {}) => ({
  id: "vis-1", company_id: EMPRESA, address: "Rua A, Porto",
  scheduled_start: `${HOJE}T11:00:00Z`, status: "agendada", ...p,
});

const carregar = (linhas: Linhas, falhas: Falhas = {}) =>
  carregarAvisos(fakeAdmin(linhas, falhas).admin, EMPRESA, HOJE);

describe("PAGAMENTOS", () => {
  it("pendente atrasado entra", async () => {
    const r = await carregar({ fixed_variable_payments: [pagamento({ due_date: ONTEM })] });
    expect(r.map((i) => i.urgencia)).toEqual(["atrasado"]);
  });

  it("hoje entra", async () => {
    const r = await carregar({ fixed_variable_payments: [pagamento({ due_date: HOJE })] });
    expect(r.map((i) => i.urgencia)).toEqual(["hoje"]);
  });

  it("amanhã entra", async () => {
    const r = await carregar({ fixed_variable_payments: [pagamento({ due_date: AMANHA })] });
    expect(r.map((i) => i.urgencia)).toEqual(["amanha"]);
  });

  it("depois de amanhã não entra", async () => {
    const r = await carregar({ fixed_variable_payments: [pagamento({ due_date: DEPOIS })] });
    expect(r).toEqual([]);
  });

  it("pago não entra, por mais atrasado que esteja", async () => {
    const r = await carregar({
      fixed_variable_payments: [pagamento({ status: "pago", due_date: ONTEM })],
    });
    expect(r).toEqual([]);
  });

  it("sem vencimento não entra: não há data de onde nascer o aviso", async () => {
    const r = await carregar({ fixed_variable_payments: [pagamento({ due_date: null })] });
    expect(r).toEqual([]);
  });

  it("o aviso nasce do vencimento e aponta para Pagamentos", async () => {
    const [i] = await carregar({ fixed_variable_payments: [pagamento()] });
    expect(i).toMatchObject({
      source: "pagamento",
      date: HOJE,
      title: "Seguro",
      href: "/dashboard/financeiro/pagamentos",
    });
    expect(i.detail).toContain("120,50");
  });
});

describe("TAREFAS", () => {
  it("por concluir com prazo atrasado entra", async () => {
    const r = await carregar({ management_tasks: [tarefa({ due_date: ONTEM })] });
    expect(r.map((i) => i.urgencia)).toEqual(["atrasado"]);
  });

  it("concluída não entra", async () => {
    const r = await carregar({
      management_tasks: [tarefa({ completed_at: "2026-09-20T10:00:00Z", due_date: ONTEM })],
    });
    expect(r).toEqual([]);
  });

  // 🔴 O ensaio que protege as colunas personalizadas do quadro. Uma tarefa
  //    numa coluna que ninguém previu continua por concluir, e tem de avisar.
  it("não depende do nome da coluna Kanban", async () => {
    const inventadas = ["Em revisão", "Bloqueado", "A aguardar cliente", "qualquer-coisa"];
    for (const status of inventadas) {
      const r = await carregar({ management_tasks: [tarefa({ status, due_date: HOJE })] });
      expect(r, `a coluna "${status}" deixou de avisar`).toHaveLength(1);
    }
  });

  it("o filtro usado é completed_at, não status", async () => {
    const { admin, consultas } = fakeAdmin({ management_tasks: [tarefa()] });
    await carregarAvisos(admin, EMPRESA, HOJE);
    const q = consultas.find((c) => c.tabela === "management_tasks");
    expect(q?.filtros).toContain("is:completed_at");
    expect(q?.filtros.some((f) => f.includes("status"))).toBe(false);
  });

  it("aponta para Tarefas", async () => {
    const [i] = await carregar({ management_tasks: [tarefa()] });
    expect(i).toMatchObject({ source: "tarefa", title: "Enviar recibos", href: "/dashboard/tarefas" });
  });
});

describe("LEADS", () => {
  it("próxima acção atrasada, hoje e amanhã entram", async () => {
    for (const [data, esperado] of [[ONTEM, "atrasado"], [HOJE, "hoje"], [AMANHA, "amanha"]] as const) {
      const r = await carregar({ crm_leads: [lead({ next_action_at: data })] });
      expect(r.map((i) => i.urgencia)).toEqual([esperado]);
    }
  });

  it("ganho não entra", async () => {
    const r = await carregar({ crm_leads: [lead({ stage: "ganho", next_action_at: ONTEM })] });
    expect(r).toEqual([]);
  });

  it("perdido não entra", async () => {
    const r = await carregar({ crm_leads: [lead({ stage: "perdido", next_action_at: ONTEM })] });
    expect(r).toEqual([]);
  });

  it("depois de amanhã não entra", async () => {
    const r = await carregar({ crm_leads: [lead({ next_action_at: DEPOIS })] });
    expect(r).toEqual([]);
  });

  it("sem próxima acção marcada não entra", async () => {
    const r = await carregar({ crm_leads: [lead({ next_action_at: null })] });
    expect(r).toEqual([]);
  });

  it("aponta para a lead concreta e usa a nota como detalhe", async () => {
    const [i] = await carregar({ crm_leads: [lead()] });
    expect(i).toMatchObject({ source: "lead", href: "/dashboard/crm/lead-1", detail: "Ligar" });
  });

  it("sem nota, o detalhe tem um texto próprio em vez de ficar vazio", async () => {
    const [i] = await carregar({ crm_leads: [lead({ next_action_note: null })] });
    expect(i.detail).toBe("Próxima acção comercial");
  });
});

describe("VISITAS — o fuso é aqui que importa", () => {
  it("agendada para hoje entra", async () => {
    const r = await carregar({ crm_visits: [visita()] });
    expect(r.map((i) => i.urgencia)).toEqual(["hoje"]);
  });

  it("agendada para amanhã entra", async () => {
    const r = await carregar({ crm_visits: [visita({ scheduled_start: `${AMANHA}T11:00:00Z` })] });
    expect(r.map((i) => i.urgencia)).toEqual(["amanha"]);
  });

  it("depois de amanhã não entra", async () => {
    const r = await carregar({ crm_visits: [visita({ scheduled_start: `${DEPOIS}T11:00:00Z` })] });
    expect(r).toEqual([]);
  });

  it("realizada, cancelada e não compareceu não entram", async () => {
    for (const status of ["realizada", "cancelada", "nao_compareceu"]) {
      const r = await carregar({ crm_visits: [visita({ status })] });
      expect(r, `status "${status}" não devia avisar`).toEqual([]);
    }
  });

  // 🔴 A borda que o atalho `slice(0, 10)` erra.
  //
  //    Uma visita às 00h30 de dia 27 em Lisboa (verão, UTC+1) é
  //    `2026-09-26T23:30:00Z`. Ler os dez primeiros caracteres diria «dia 26» —
  //    o aviso de amanhã apareceria como sendo de hoje.
  it("00h30 de amanhã em Lisboa não é lida como hoje", async () => {
    const r = await carregar({ crm_visits: [visita({ scheduled_start: "2026-09-26T23:30:00Z" })] });
    expect(r).toHaveLength(1);
    expect(r[0].date).toBe(AMANHA);
    expect(r[0].urgencia).toBe("amanha");
  });

  // 🔴 A borda simétrica: 23h30 de hoje em Lisboa é 22h30Z do mesmo dia — essa
  //    o atalho acertaria. O ensaio existe para fixar os dois lados.
  it("23h30 de hoje em Lisboa continua a ser hoje", async () => {
    const r = await carregar({ crm_visits: [visita({ scheduled_start: "2026-09-26T22:30:00Z" })] });
    expect(r[0].date).toBe(HOJE);
  });

  // 🔴 Decisão desta versão, não esquecimento: visitas passadas ainda
  //    `agendada` não viram «atrasado». Ver a nota no loader.
  it("uma visita antiga ainda agendada NÃO é trazida como atrasada", async () => {
    const r = await carregar({ crm_visits: [visita({ scheduled_start: `${ONTEM}T11:00:00Z` })] });
    expect(r).toEqual([]);
  });

  it("sem morada, mostra um título próprio", async () => {
    const [i] = await carregar({ crm_visits: [visita({ address: null })] });
    expect(i).toMatchObject({ title: "Visita comercial", href: "/dashboard/crm/visitas" });
  });
});

describe("TENANT — uma empresa nunca vê a outra", () => {
  it("nenhuma das quatro fontes atravessa a fronteira", async () => {
    const r = await carregar({
      fixed_variable_payments: [pagamento({ id: "p-b", company_id: OUTRA })],
      management_tasks: [tarefa({ id: "t-b", company_id: OUTRA })],
      crm_leads: [lead({ id: "l-b", company_id: OUTRA })],
      crm_visits: [visita({ id: "v-b", company_id: OUTRA })],
    });
    expect(r).toEqual([]);
  });

  it("com as duas empresas na tabela, só vem a própria", async () => {
    const r = await carregar({
      fixed_variable_payments: [pagamento({ id: "p-a" }), pagamento({ id: "p-b", company_id: OUTRA })],
    });
    expect(r.map((i) => i.itemId)).toEqual(["p-a"]);
  });

  it("todas as consultas filtram por empresa", async () => {
    const { admin, consultas } = fakeAdmin({});
    await carregarAvisos(admin, EMPRESA, HOJE);
    expect(consultas).toHaveLength(4);
    for (const c of consultas) {
      expect(c.filtros, `${c.tabela} não filtrou por empresa`).toContain("eq:company_id");
    }
  });
});

describe("FALHA — erro de leitura não é ausência de avisos", () => {
  for (const tabela of ["fixed_variable_payments", "management_tasks", "crm_leads", "crm_visits"]) {
    it(`falha em ${tabela} faz o loader lançar, não devolver lista parcial`, async () => {
      await expect(carregar(
        {
          fixed_variable_payments: [pagamento()],
          management_tasks: [tarefa()],
          crm_leads: [lead()],
          crm_visits: [visita()],
        },
        { [tabela]: "sem ligação" },
      )).rejects.toBeInstanceOf(AvisosSourceError);
    });
  }

  it("a action engole a falha e devolve lista vazia", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth-guard", () => ({
      requireProfile: async () => ({
        ok: true, admin: {}, profile: { id: "perfil-1", company_id: EMPRESA },
      }),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => fakeAdmin({}, { crm_visits: "sem ligação" }).admin,
    }));
    const { getAvisosVencimento } = await import("@/app/actions/avisos");
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getAvisosVencimento()).resolves.toEqual([]);
    expect(erro).toHaveBeenCalled();
    erro.mockRestore();
    vi.doUnmock("@/lib/auth-guard");
    vi.doUnmock("@/lib/supabase/admin");
  });
});

describe("as quatro fontes convergem numa lista ordenada", () => {
  it("dinheiro primeiro dentro do mesmo dia, atrasados à frente", async () => {
    const r = await carregar({
      fixed_variable_payments: [pagamento({ id: "p1", due_date: HOJE })],
      management_tasks: [tarefa({ id: "t1", due_date: ONTEM })],
      crm_leads: [lead({ id: "l1", next_action_at: HOJE })],
      crm_visits: [visita({ id: "v1" })],
    });
    expect(r.map((i) => i.key)).toEqual([
      "tarefa:t1",      // atrasado
      "pagamento:p1",   // hoje, dinheiro primeiro
      "visita:v1",      // hoje
      "lead:l1",        // hoje
    ]);
  });
});
