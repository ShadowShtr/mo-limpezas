// ============================================================================
// O CRON DIÁRIO — quem recebe, o que recebe, e o que acontece quando falha
// ============================================================================
//
// 🔴 A base falsa é ESTADUAL: o `notifyUser` simulado grava mesmo na tabela de
//    notificações. Sem isso, o ensaio de «correr duas vezes não duplica»
//    passaria por não haver nada gravado entre as duas execuções — provaria o
//    ensaio, não a dedupe.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const HOJE = "2026-09-26";
const EMPRESA_A = "empresa-a";
const EMPRESA_B = "empresa-b";

interface Notificacao {
  company_id: string; user_id: string; type: string;
  title: string; body: string; data: Record<string, unknown> | null;
  created_at: string;
}

let db: Record<string, Record<string, unknown>[]>;
let notificacoes: Notificacao[];
let falharGravacao: (n: Notificacao) => boolean;
let hoje: string;

function tabela(nome: string) {
  const filtros: string[] = [];
  let dados = nome === "notifications"
    ? notificacoes.map((n) => ({ ...n }) as Record<string, unknown>)
    : [...(db[nome] ?? [])];

  const api = {
    select() { return api; },
    eq(c: string, v: unknown) { filtros.push(c); dados = dados.filter((r) => r[c] === v); return api; },
    is(c: string, v: null) { dados = dados.filter((r) => (r[c] ?? null) === v); return api; },
    in(c: string, vs: unknown[]) { dados = dados.filter((r) => vs.includes(r[c])); return api; },
    not(c: string, op: string, v: unknown) {
      if (op === "is" && v === null) dados = dados.filter((r) => (r[c] ?? null) !== null);
      else if (op === "in") {
        const dentro = String(v).replace(/^\(|\)$/g, "").split(",");
        dados = dados.filter((r) => !dentro.includes(String(r[c])));
      }
      return api;
    },
    lte(c: string, v: string) { dados = dados.filter((r) => String(r[c]) <= v); return api; },
    gte(c: string, v: string) { dados = dados.filter((r) => String(r[c]) >= v); return api; },
    lt(c: string, v: string) { dados = dados.filter((r) => String(r[c]) < v); return api; },
    then(resolve: (v: unknown) => unknown) { return resolve({ data: dados, error: null }); },
  };
  return api;
}

const admin = { from: tabela };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/lisbon-time", async (real) => ({
  ...(await real<Record<string, unknown>>()),
  todayInLisbon: () => hoje,
}));
// 🔴 O duplo falso converte `userId` em `user_id`, tal como o `notifyUser`
//    real faz ao montar o INSERT. Guardar a forma camelCase faria a leitura de
//    dedupe — que filtra por `user_id` — nunca encontrar nada, e os ensaios de
//    «não duplica» passariam por um motivo errado.
interface ArgsNotify {
  companyId: string; userId: string; type: string;
  title: string; body: string; data?: Record<string, unknown>; url?: string;
}

vi.mock("@/lib/push-notify", () => ({
  notifyUser: async (_a: unknown, args: ArgsNotify) => {
    const n: Notificacao = {
      company_id: args.companyId,
      user_id: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      data: args.data ?? null,
      created_at: `${hoje}T08:00:00Z`,
    };
    if (falharGravacao(n)) return { stored: false, notified: false };
    notificacoes.push(n);
    return { stored: true, notified: false };
  },
}));

const { GET } = await import("@/app/api/cron/avisos-vencimento/route");

const SEGREDO = "segredo-de-teste";

const pedido = (auth: string | null) =>
  new NextRequest("https://exemplo.pt/api/cron/avisos-vencimento", {
    headers: auth ? { authorization: auth } : undefined,
  });

// `null` significa «sem cabeçalho». Não se usa `undefined`: um parâmetro por
// omissão aceitaria-o como ausência e devolveria o segredo válido — o ensaio
// passaria a testar o caso autorizado sem ninguém dar por isso.
const correr = (auth: string | null = `Bearer ${SEGREDO}`) => GET(pedido(auth));

const perfil = (p: Record<string, unknown> = {}) => ({
  id: "perf-1", company_id: EMPRESA_A, role: "admin", status: "ativo", ...p,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SEGREDO;
  hoje = HOJE;
  notificacoes = [];
  falharGravacao = () => false;
  db = {
    profiles: [perfil()],
    fixed_variable_payments: [{
      id: "pag-1", company_id: EMPRESA_A, description: "Seguro",
      amount: 100, due_date: HOJE, status: "pendente",
    }],
    management_tasks: [],
    crm_leads: [],
    crm_visits: [],
  };
});

describe("autenticação", () => {
  it("sem CRON_SECRET configurado devolve 500", async () => {
    delete process.env.CRON_SECRET;
    expect((await correr()).status).toBe(500);
  });

  it("segredo errado devolve 401", async () => {
    expect((await correr("Bearer outro")).status).toBe(401);
  });

  it("sem cabeçalho devolve 401", async () => {
    expect((await correr(null)).status).toBe(401);
  });

  it("segredo certo executa", async () => {
    const r = await correr();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, today: HOJE });
  });

  it("não autorizado não grava nada", async () => {
    await correr("Bearer errado");
    expect(notificacoes).toHaveLength(0);
  });
});

describe("destinatários", () => {
  it("admin activo recebe", async () => {
    await correr();
    expect(notificacoes.map((n) => n.user_id)).toEqual(["perf-1"]);
  });

  it("gestor activo recebe", async () => {
    db.profiles = [perfil({ id: "gest-1", role: "gestor" })];
    await correr();
    expect(notificacoes.map((n) => n.user_id)).toEqual(["gest-1"]);
  });

  it("colaboradora NÃO recebe", async () => {
    db.profiles = [perfil({ id: "col-1", role: "colaborador" })];
    await correr();
    expect(notificacoes).toHaveLength(0);
  });

  for (const status of ["inativo", "suspenso", "pendente", null]) {
    it(`estado "${status}" não recebe`, async () => {
      db.profiles = [perfil({ status })];
      await correr();
      expect(notificacoes).toHaveLength(0);
    });
  }

  it("o user_id é o profiles.id, não um auth_user_id", async () => {
    db.profiles = [perfil({ id: "perf-1", auth_user_id: "auth-diferente" })];
    await correr();
    expect(notificacoes[0].user_id).toBe("perf-1");
  });
});

describe("empresas isoladas", () => {
  it("cada gestora só recebe os prazos da sua empresa", async () => {
    db.profiles = [
      perfil({ id: "a-1", company_id: EMPRESA_A }),
      perfil({ id: "b-1", company_id: EMPRESA_B, role: "gestor" }),
    ];
    db.fixed_variable_payments = [
      { id: "pag-a", company_id: EMPRESA_A, description: "Seguro A", amount: 10, due_date: HOJE, status: "pendente" },
      { id: "pag-b", company_id: EMPRESA_B, description: "Seguro B", amount: 20, due_date: HOJE, status: "pendente" },
    ];
    await correr();

    const deA = notificacoes.filter((n) => n.user_id === "a-1");
    const deB = notificacoes.filter((n) => n.user_id === "b-1");
    expect(deA.map((n) => n.title)).toEqual(["Seguro A"]);
    expect(deB.map((n) => n.title)).toEqual(["Seguro B"]);
    expect(deA.every((n) => n.company_id === EMPRESA_A)).toBe(true);
  });

  it("duas gestoras da mesma empresa recebem ambas", async () => {
    db.profiles = [perfil({ id: "a-1" }), perfil({ id: "a-2", role: "gestor" })];
    await correr();
    expect(notificacoes.map((n) => n.user_id).sort()).toEqual(["a-1", "a-2"]);
  });
});

describe("os quatro tipos", () => {
  beforeEach(() => {
    db.management_tasks = [{
      id: "tar-1", company_id: EMPRESA_A, title: "Recibos",
      due_date: HOJE, completed_at: null,
    }];
    db.crm_leads = [{
      id: "lead-1", company_id: EMPRESA_A, name: "Clínica",
      next_action_at: HOJE, next_action_note: "Ligar", stage: "novo",
    }];
    db.crm_visits = [{
      id: "vis-1", company_id: EMPRESA_A, address: "Rua A",
      scheduled_start: `${HOJE}T11:00:00Z`, status: "agendada",
    }];
  });

  it("cada fonte gera o seu tipo", async () => {
    await correr();
    expect(notificacoes.map((n) => n.type).sort()).toEqual([
      "deadline_lead", "deadline_payment", "deadline_task", "deadline_visit",
    ]);
  });

  it("o tipo não muda com a urgência", async () => {
    db.fixed_variable_payments = [
      { id: "p-atrasado", company_id: EMPRESA_A, description: "Velho", amount: 1, due_date: "2026-09-01", status: "pendente" },
      { id: "p-hoje", company_id: EMPRESA_A, description: "Hoje", amount: 1, due_date: HOJE, status: "pendente" },
    ];
    db.management_tasks = []; db.crm_leads = []; db.crm_visits = [];
    await correr();
    expect(new Set(notificacoes.map((n) => n.type))).toEqual(new Set(["deadline_payment"]));
    expect(notificacoes.map((n) => n.data?.urgencia).sort()).toEqual(["atrasado", "hoje"]);
  });

  it("o corpo diz a urgência e a data, e o url leva à superfície", async () => {
    db.management_tasks = []; db.crm_leads = []; db.crm_visits = [];
    await correr();
    expect(notificacoes[0].body).toContain("Hoje");
    expect(notificacoes[0].body).toContain("26/09/2026");
    expect(notificacoes[0].data).toMatchObject({ source: "pagamento", item_id: "pag-1" });
  });

  // 🔴 O JSON é lido pelo cliente. Não leva valores, contactos nem notas.
  it("o data só transporta metadados de navegação e dedupe", async () => {
    db.management_tasks = []; db.crm_leads = []; db.crm_visits = [];
    await correr();
    expect(Object.keys(notificacoes[0].data ?? {}).sort())
      .toEqual(["date", "dedupe_key", "item_id", "source", "urgencia"]);
  });
});

describe("dedupe", () => {
  it("correr duas vezes no mesmo dia não cria duplicados", async () => {
    await correr();
    const depoisDaPrimeira = notificacoes.length;
    expect(depoisDaPrimeira).toBe(1);

    const r = await correr();
    expect(notificacoes).toHaveLength(depoisDaPrimeira);
    expect(await r.json()).toMatchObject({ ok: true, enviados: 0, saltados: 1 });
  });

  it("três execuções seguidas continuam a dar uma notificação", async () => {
    await correr(); await correr(); await correr();
    expect(notificacoes).toHaveLength(1);
  });

  // 🔴 O caso que obriga a chave a levar o dia da execução, e não a data do
  //    item: a conta de ontem continua por pagar e tem de voltar a avisar.
  it("no dia seguinte volta a avisar o mesmo item", async () => {
    await correr();
    expect(notificacoes).toHaveLength(1);

    hoje = "2026-09-27";
    await correr();
    expect(notificacoes).toHaveLength(2);
    expect(notificacoes.map((n) => n.data?.dedupe_key)).toEqual([
      "2026-09-26:pagamento:pag-1",
      "2026-09-27:pagamento:pag-1",
    ]);
  });

  it("a dedupe é por pessoa: a segunda gestora recebe o seu", async () => {
    await correr();
    db.profiles = [perfil({ id: "perf-1" }), perfil({ id: "perf-2", role: "gestor" })];
    await correr();
    expect(notificacoes.map((n) => n.user_id).sort()).toEqual(["perf-1", "perf-2"]);
  });
});

describe("falhas de gravação", () => {
  it("stored=false faz o cron terminar com erro", async () => {
    falharGravacao = () => true;
    const r = await correr();
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ ok: false, enviados: 0, falhados: 1 });
  });

  // 🔴 Uma falha no meio não pode abortar a rota: sem isto, o primeiro item
  //    problemático deixava toda a gente sem aviso nesse dia.
  it("os itens antes e depois de uma falha ficam persistidos", async () => {
    db.fixed_variable_payments = [
      { id: "p-1", company_id: EMPRESA_A, description: "Primeiro", amount: 1, due_date: HOJE, status: "pendente" },
      { id: "p-2", company_id: EMPRESA_A, description: "Problema", amount: 1, due_date: HOJE, status: "pendente" },
      { id: "p-3", company_id: EMPRESA_A, description: "Terceiro", amount: 1, due_date: HOJE, status: "pendente" },
    ];
    falharGravacao = (n) => n.title === "Problema";

    const r = await correr();
    expect(r.status).toBe(500);
    expect(notificacoes.map((n) => n.title).sort()).toEqual(["Primeiro", "Terceiro"]);
    expect(await r.json()).toMatchObject({ enviados: 2, falhados: 1 });
  });

  it("uma retry recupera o que falhou e não duplica o que passou", async () => {
    db.fixed_variable_payments = [
      { id: "p-1", company_id: EMPRESA_A, description: "Primeiro", amount: 1, due_date: HOJE, status: "pendente" },
      { id: "p-2", company_id: EMPRESA_A, description: "Problema", amount: 1, due_date: HOJE, status: "pendente" },
    ];
    falharGravacao = (n) => n.title === "Problema";
    await correr();
    expect(notificacoes).toHaveLength(1);

    falharGravacao = () => false;
    const r = await correr();
    expect(r.status).toBe(200);
    expect(notificacoes.map((n) => n.title).sort()).toEqual(["Primeiro", "Problema"]);
    expect(await r.json()).toMatchObject({ enviados: 1, saltados: 1, falhados: 0 });
  });

  it("uma empresa que falha não cala as outras", async () => {
    db.profiles = [
      perfil({ id: "a-1", company_id: EMPRESA_A }),
      perfil({ id: "b-1", company_id: EMPRESA_B }),
    ];
    db.fixed_variable_payments = [
      { id: "pag-a", company_id: EMPRESA_A, description: "Problema", amount: 1, due_date: HOJE, status: "pendente" },
      { id: "pag-b", company_id: EMPRESA_B, description: "Seguro B", amount: 1, due_date: HOJE, status: "pendente" },
    ];
    falharGravacao = (n) => n.title === "Problema";

    const r = await correr();
    expect(r.status).toBe(500);
    expect(notificacoes.map((n) => n.user_id)).toEqual(["b-1"]);
  });
});

describe("sem nada a avisar", () => {
  it("não grava e responde ok", async () => {
    db.fixed_variable_payments = [];
    const r = await correr();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, enviados: 0 });
    expect(notificacoes).toHaveLength(0);
  });

  it("sem destinatários activos não corre consulta de avisos nenhuma", async () => {
    db.profiles = [perfil({ status: "inativo" })];
    const r = await correr();
    expect(await r.json()).toMatchObject({ ok: true, empresas: 0, enviados: 0 });
  });
});
