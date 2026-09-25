/**
 * 106-B — o runtime e a base dizem a MESMA coisa sobre o estado.
 *
 * 🔴 O que estes ensaios existem para impedir.
 *
 *    A migration 106 fez `profiles.status` participar na autorização ao nível
 *    da base: `get_my_profile_id()` só resolve com `status = 'ativo'`. Isso
 *    fecha as 69 políticas de RLS — e **não fecha nada** do que passa pelo
 *    cliente `service_role`, que tem `BYPASSRLS`.
 *
 *    Três caminhos do runtime resolvem identidade com esse cliente:
 *    `requireProfile`, `getCurrentProfile` e o layout do dashboard. Antes da
 *    106-B, nenhum olhava para o estado. Uma pessoa suspensa com o token ainda
 *    válido executava todas as server actions do produto.
 *
 *    Daí o ensaio K, que é o que interessa: sessão antiga de quem não está
 *    activo NÃO pode ganhar autorização por um caminho que salta a RLS.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { startPostgresContainer, type PostgresContainer }
  from "./helpers/pg-container";
import { baselineCompleto } from "./helpers/production-baseline";
import {
  ESTADOS_COLABORADOR, ESTADO_AUTORIZADO, estadoAutoriza,
  isEstadoColaborador, ROTULO_ESTADO,
} from "@/domain/collaborators/status";

const LENTO = { timeout: 120_000 };

let container: PostgresContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await startPostgresContainer({
    name: `colab-106b-${process.pid}`, database: "colab106b", memory: "512m" });
  pool = new pg.Pool(container.connection);
  await pool.query(baselineCompleto());
  // O CHECK que o dump por introspecção não traz, e que produção tem.
  await pool.query(`
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_status_check
      CHECK (status = ANY (ARRAY['ativo'::text, 'inativo'::text, 'suspenso'::text]));
  `);
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  container?.stop();
});

describe("106-B — uma regra de estado", () => {
  it("🔴 E. a lista do runtime é a lista que a base aceita", LENTO, async () => {
    // 🔴 A prova NÃO é comparar com uma lista escrita neste ficheiro — isso
    //    seria uma terceira cópia. Lê-se o CHECK do catálogo e extraem-se os
    //    literais.
    const { rows } = await pool.query(`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname = 'profiles'
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%status%'`);

    expect(rows).toHaveLength(1);
    const naBase = [...String(rows[0].def).matchAll(/'([a-z_]+)'::text/g)]
      .map((m) => m[1]).sort();

    expect(naBase).toEqual([...ESTADOS_COLABORADOR].sort());

    // E o que a base recusa continua a ser recusado: o estado que o runtime
    // aceitava antes desta unidade.
    expect(naBase).not.toContain("arquivado");
  });

  it("🔴 D. um estado fora do contrato é recusado PELA BASE", LENTO, async () => {
    await pool.query("DELETE FROM public.profiles");
    await pool.query(
      "INSERT INTO public.companies (id,name,slug) VALUES ($1,'A','a') ON CONFLICT DO NOTHING",
      ["11111111-1111-1111-1111-111111111111"]);

    // 🔴 `profiles.id` tem FK para `auth.users`. Sem estas linhas, o INSERT
    //    abaixo rebentava com `profiles_id_fkey` — e a assercao de recusa
    //    passaria pela razao ERRADA, dando verde a um ensaio que nunca chegou
    //    a tocar no CHECK. E por isso que a expressao a seguir so aceita o
    //    nome da constraint de estado.
    const ids: string[] = [];
    for (let i = 0; i <= ESTADOS_COLABORADOR.length; i++) {
      const { rows } = await pool.query(
        "INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id");
      ids.push(rows[0].id);
    }

    // 🔴 `arquivado` era o valor que o `z.enum` do runtime deixava passar.
    //    Aqui prova-se que a base sempre o recusou — ou seja, que a validação
    //    antiga produzia um erro cru do Postgres no ecrã de quem preenchia.
    await expect(pool.query(
      `INSERT INTO public.profiles (id, company_id, full_name, role, status)
       VALUES ($2, $1, 'X', 'colaborador', 'arquivado')`,
      ["11111111-1111-1111-1111-111111111111", ids[0]],
    )).rejects.toThrow(/profiles_status_check/);

    // E os três reais entram.
    for (const [i, e] of ESTADOS_COLABORADOR.entries()) {
      await pool.query(
        `INSERT INTO public.profiles (id, company_id, full_name, role, status)
         VALUES ($3, $1, 'X', 'colaborador', $2)`,
        ["11111111-1111-1111-1111-111111111111", e, ids[i + 1]]);
    }
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.profiles");
    expect(rows[0].n).toBe(ESTADOS_COLABORADOR.length);
  });

  it("🔴 A/B/C. só 'ativo' autoriza, e o desconhecido nunca autoriza", () => {
    expect(estadoAutoriza(ESTADO_AUTORIZADO)).toBe(true);
    expect(estadoAutoriza("inativo")).toBe(false);
    expect(estadoAutoriza("suspenso")).toBe(false);

    // 🔴 FAIL CLOSED. Um estado que este código ainda não conhece não pode
    //    autorizar: é precisamente o caso em que menos se sabe.
    for (const v of [null, undefined, "", "arquivado", "ATIVO", " ativo", 1, {}]) {
      expect(estadoAutoriza(v)).toBe(false);
    }
  });

  it("🔴 todo o estado real tem rótulo, e nada mais tem", () => {
    // Sem isto, acrescentar um estado à lista e esquecer o rótulo só se
    // descobria com um `undefined` no ecrã.
    expect(Object.keys(ROTULO_ESTADO).sort()).toEqual([...ESTADOS_COLABORADOR].sort());
    for (const e of ESTADOS_COLABORADOR) expect(ROTULO_ESTADO[e]).toBeTruthy();
    expect(isEstadoColaborador("arquivado")).toBe(false);
  });
});
