// ============================================================================
// CRIAR COLABORADOR — o id da pessoa, e os campos que se perdiam
// ============================================================================
//
// Dois defeitos no mesmo `INSERT`, ambos visíveis no ecrã:
//
//   1. **não enviava `id`.** `profiles.id` é PRIMARY KEY e não tem DEFAULT —
//      durante anos veio de `auth.users.id`, porque criar uma pessoa era criar
//      uma conta. Ao separar as duas coisas, ninguém passou a gerar o id, e a
//      base respondia `null value in column "id" of relation "profiles"`.
//
//   2. **deitava fora NIF, IBAN, valor à hora e datas de contrato.** O
//      formulário recolhia-os, o `safeParse` removia-os por não estarem no
//      schema, e o `INSERT` nunca os via. Gravava com sucesso e a pessoa
//      nascia sem nada disso — que é pior do que recusar guardar, porque
//      ninguém vai lá confirmar.
//
// Corre contra PostgreSQL 16 real, sobre a forma do schema de produção — a
// mesma `production-schema-shape.sql` que os ensaios de RLS usam. É essa
// fidelidade que faz o `NOT NULL` do `id` disparar aqui como dispara lá.
// ============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { baselineCompleto } from "./helpers/production-baseline";

const CONTAINER = `create-colab-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";

let pool: pg.Pool;
let port = 0;

const docker = (a: string[]) => spawnSync("docker", a, { encoding: "utf8" });

async function esperarPronto() {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "colab"]).status === 0) {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "colab" });
      try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
      catch { try { await c.end(); } catch { /* nunca abriu */ } }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

beforeAll(async () => {
  // 🔴 A porta é atribuída pelo Docker, não calculada a partir do pid.
  //
  //    `55600 + (pid % 300)` cobre 55600–55899, e o Windows reserva
  //    55787–55986: mais de um terço dos pids escolhia uma porta proibida e o
  //    ensaio falhava com «bind: … proibida pelas permissões de acesso» — um
  //    vermelho que não diz nada sobre o código. É o mesmo padrão que os
  //    ensaios do período financeiro (090+) já usam.
  docker(["rm", "-f", CONTAINER]);
  const r = docker(["run", "-d", "--name", CONTAINER,
    // Autenticacao `trust` num contentor local e descartavel, como nos outros
    // ensaios. Uma credencial literal aqui ficaria versionada, e o scanner de
    // segredos recusa — com razao.
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=colab",
    "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
  if (r.status !== 0) throw new Error(`contentor: ${r.stderr || r.stdout}`);
  const mapeamento = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapeamento.slice(mapeamento.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${mapeamento}`);
  await esperarPronto();

  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "colab", max: 4 });
  await pool.query(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; ${baselineCompleto()}`);

  // 🔴 O baseline é o schema **antes** desta frente — é ele que os ensaios da
  //    migração precisam. Produção já tem o EXPAND aplicado, por isso aplica-se
  //    aqui também: é este o estado em que o `createColaborador` corre.
  await pool.query(fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", "draft",
    "PROVISIONAL_collaborator_identity_expand.sql"), "utf8"));
  await pool.query("INSERT INTO companies(id,name,slug) VALUES($1,'A','a')", [EMPRESA]);
}, 180_000);

afterAll(async () => {
  try { await pool?.end(); } catch { /* já fechada */ }
  docker(["rm", "-f", CONTAINER]);
});

/** O que a action escreve hoje, campo a campo. Sem id, é o defeito. */
function linha(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    company_id: EMPRESA,
    role: "colaborador",
    full_name: "Pessoa de Ensaio",
    email: null, phone: null, nif: null, iban: null,
    hourly_rate: null, contract_start: null, contract_end: null,
    status: "ativo", contracted_hours_month: 168, skills: [] as string[],
    ...over,
  };
}

async function inserir(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const vals = cols.map((_, i) => `$${i + 1}`).join(",");
  return pool.query(
    `INSERT INTO public.profiles(${cols.join(",")}) VALUES(${vals}) RETURNING id::text, auth_user_id::text`,
    Object.values(row),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// A causa, reproduzida
// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 o defeito", () => {
  it("sem `id`, a base recusa — é a mensagem que aparecia no ecrã", async () => {
    const { id: _semId, ...semId } = linha();
    void _semId;
    await expect(inserir(semId)).rejects.toThrow(
      /null value in column "id"[\s\S]*violates not-null constraint/,
    );
  });

  it("e não há DEFAULT que a salve — o id tem mesmo de vir de fora", async () => {
    const { rows } = await pool.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='profiles' AND column_name='id'`,
    );
    expect(rows[0].column_default).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A correcção
// ═══════════════════════════════════════════════════════════════════════════

describe("criar com o id gerado no servidor", () => {
  it("HOT01. só o nome — cria, e sem conta de acesso", async () => {
    const { rows } = await inserir(linha({ full_name: "Só Nome" }));
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].auth_user_id).toBeNull();
  });

  it("HOT02. 🔴 a pessoa existe sem que exista conta nenhuma no Auth", async () => {
    // É este o ponto do EXPAND: identidade própria, conta opcional e posterior.
    const { rows } = await inserir(linha({ full_name: "Sem Conta" }));
    const { rows: contas } = await pool.query(
      "SELECT count(*)::int n FROM auth.users WHERE id = $1", [rows[0].id],
    );
    expect(contas[0].n).toBe(0);
  });

  it("HOT03. os campos opcionais são gravados, não descartados", async () => {
    const r = await inserir(linha({
      full_name: "Com Dados",
      nif: "123456789", iban: "PT50000000000000000000000",
      hourly_rate: 9.5, contract_start: "2026-08-01", contract_end: "2026-12-31",
      email: "a@b.pt", phone: "912345678",
    }));
    const { rows } = await pool.query(
      `SELECT nif, iban, hourly_rate::text, contract_start::text, contract_end::text, email, phone
         FROM public.profiles WHERE id = $1`, [r.rows[0].id],
    );
    expect(rows[0]).toEqual({
      nif: "123456789", iban: "PT50000000000000000000000",
      hourly_rate: "9.50", contract_start: "2026-08-01", contract_end: "2026-12-31",
      email: "a@b.pt", phone: "912345678",
    });
  });

  it("HOT04. 🔴 vazio fica NULL, nunca string vazia nem valor inventado", async () => {
    const r = await inserir(linha({ full_name: "Tudo Vazio" }));
    const { rows } = await pool.query(
      `SELECT nif, iban, hourly_rate, contract_start, contract_end, email, phone
         FROM public.profiles WHERE id = $1`, [r.rows[0].id],
    );
    for (const [campo, valor] of Object.entries(rows[0])) {
      expect(valor, campo).toBeNull();
    }
  });

  it("HOT05. dois com o mesmo nome convivem, com ids diferentes", async () => {
    const a = await inserir(linha({ full_name: "Maria Silva" }));
    const b = await inserir(linha({ full_name: "Maria Silva" }));
    expect(a.rows[0].id).not.toBe(b.rows[0].id);
  });

  it("HOT06. apagar a conta de acesso não apaga a pessoa", async () => {
    // O cascade antigo levava à frente a folha, os documentos e as equipas.
    const conta = randomUUID();
    await pool.query("INSERT INTO auth.users(id,email) VALUES($1,'x@y')", [conta]);
    const r = await inserir(linha({ full_name: "Com Acesso", auth_user_id: conta }));

    await pool.query("DELETE FROM auth.users WHERE id = $1", [conta]);

    const { rows } = await pool.query(
      "SELECT full_name, auth_user_id FROM public.profiles WHERE id = $1", [r.rows[0].id],
    );
    expect(rows[0].full_name).toBe("Com Acesso");
    expect(rows[0].auth_user_id).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardas permanentes sobre a action
// ═══════════════════════════════════════════════════════════════════════════

describe("a action não pode voltar atrás", () => {
  const src = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.readFileSync("src/app/actions/colaboradores.ts", "utf8").replace(/\r\n/g, "\n");
  };

  it("🔴 o INSERT envia um id gerado no servidor", () => {
    expect(src()).toMatch(/id: randomUUID\(\)/);
    expect(src()).toMatch(/import \{ randomUUID \} from "node:crypto"/);
  });

  it("🔴 criar uma pessoa não cria conta no Auth", () => {
    // 🔴 O recorte tem de parar na `export` seguinte. Procurar `\n}\n` levava a
    //    fatia até muito depois do fim da função, e apanhava o
    //    `auth.admin.updateUserById` de `definirSenhaTemporaria` — uma função
    //    diferente, que **deve mesmo** mexer no Auth. O teste ficava vermelho a
    //    apontar para código correcto.
    //
    // 🔴 E tem de olhar só para o **código**. O corpo tem um comentário que
    //    explica o que a versão antiga fazia — «chamava `auth.admin.createUser`»
    //    — e uma procura por texto encontra sempre a documentação do problema.
    //    É a armadilha «mencionar ≠ usar», que já apanhou testes deste projecto.
    const s = src();
    const i = s.indexOf("export async function createColaborador");
    const seguinte = s.indexOf("\nexport ", i + 1);
    const corpo = s.slice(i, seguinte === -1 ? undefined : seguinte)
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

    expect(corpo).not.toMatch(/auth\.admin\.(createUser|inviteUser)/);
  });

  it("os cinco campos opcionais chegam ao INSERT", () => {
    const s = src();
    const ins = s.slice(s.indexOf(".insert({"), s.indexOf("});", s.indexOf(".insert({")));
    for (const campo of ["nif", "iban", "hourly_rate", "contract_start", "contract_end"]) {
      expect(ins, campo).toMatch(new RegExp(`\\b${campo}:`));
    }
  });

  it("e estão declarados no schema — senão o safeParse deita-os fora", () => {
    const s = src();
    const schema = s.slice(s.indexOf("const colaboradorSchema"), s.indexOf("});", s.indexOf("const colaboradorSchema")));
    for (const campo of ["nif", "iban", "hourly_rate", "contract_start", "contract_end"]) {
      expect(schema, campo).toMatch(new RegExp(`\\b${campo}:`));
    }
  });

  it("os tipos locais conhecem as colunas que a base tem", () => {
    // Foi o `Insert` desactualizado que fez o typecheck recusar `nif` com
    // «Type 'string | null' is not assignable to type 'never'».
    const t = fs.readFileSync(path.join(process.cwd(), "src", "types", "database.ts"), "utf8");
    const i = t.indexOf("profiles: {");
    const insert = t.slice(i, i + 3000).split("\n").find((l) => l.includes("Insert:"))!;
    for (const campo of ["nif", "iban", "hourly_rate", "contract_start", "contract_end"]) {
      expect(insert, campo).toContain(campo);
    }
  });
});
