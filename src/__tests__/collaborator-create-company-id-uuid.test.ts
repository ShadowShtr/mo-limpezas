// ============================================================================
// «company_id inválido.» — criar um colaborador ficou impossível
// ============================================================================
//
// O sintoma, em produção: preencher o formulário, carregar em «Criar
// colaborador», e receber `company_id inválido.` Sempre. Para qualquer pessoa.
//
// A causa não estava em colaboradores. `colaboradorSchema` declarava
//
//     company_id: z.string().uuid("company_id inválido.").optional()
//
// e o servidor **ignorava** o valor — a empresa vem sempre do perfil de quem
// está autenticado. Era peso morto, até deixar de ser: o Zod 4 passou a validar
// UUIDs contra a RFC 9562, que exige um nibble de versão entre 1 e 8. O
// `company_id` desta empresa é `00000000-0000-0000-0000-000000000001`, com
// versão `0`. O Zod 3 aceitava; o Zod 4 recusa.
//
// A falha entrou numa atualização de dependência, longe de qualquer alteração a
// colaboradores, e bloqueou a funcionalidade inteira.
//
// 🔴 A lição não é «relaxar a validação de UUID». É que **validar o que não se
//    usa só pode fazer mal**: não protege nada, e cria uma forma de falhar. A
//    empresa resolve-se no servidor; é lá que tem de ser verificada.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ROOT = process.cwd();
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const ACTION = "src/app/actions/colaboradores.ts";
const SHEET = "src/app/(dashboard)/dashboard/colaboradores/_components/sheet.tsx";

/** O `company_id` real desta empresa. Não é segredo — é um id de tenant. */
const COMPANY_ID_REAL = "00000000-0000-0000-0000-000000000001";

describe("a causa, reproduzida", () => {
  it("🔴 o Zod 4 recusa o company_id real desta empresa", () => {
    // É isto, e só isto, que produzia «company_id inválido.».
    const antigo = z.string().uuid("company_id inválido.");
    const r = antigo.safeParse(COMPANY_ID_REAL);

    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe("company_id inválido.");
  });

  it("e aceita um uuid v4 normal — não é o validador que está partido", () => {
    // A regra do Zod 4 está correcta. O que estava errado era aplicá-la a um
    // campo que ninguém lê.
    expect(z.string().uuid().safeParse("a6ee192c-78c5-42a2-be25-7fea591422df").success).toBe(true);
  });

  it("o nibble de versão do nosso id é 0, e a RFC só admite 1 a 8", () => {
    const versao = COMPANY_ID_REAL.split("-")[2][0];
    expect(versao).toBe("0");
    expect(["1", "2", "3", "4", "5", "6", "7", "8"]).not.toContain(versao);
  });
});

describe("a correcção, e a guarda para não voltar", () => {
  it("🔴 o schema de criação não valida company_id", () => {
    // Se alguém o repuser, este teste fica vermelho antes de chegar a produção.
    const src = ler(ACTION);
    const i = src.indexOf("const colaboradorSchema");
    const bloco = src.slice(i, src.indexOf("});", i));

    expect(bloco).not.toMatch(/company_id/);
  });

  it("🔴 nenhum schema de validação desta action valida company_id", () => {
    // Não basta tirar de um: a mesma armadilha serve para o `update`.
    const semComentarios = ler(ACTION)
      .split("\n").filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("/*")).join("\n");

    expect(semComentarios).not.toMatch(/company_id:\s*z\./);
  });

  it("o cliente deixou de enviar company_id ao criar", () => {
    const src = ler(SHEET);
    expect(src).toMatch(/await createColaborador\(input\)/);
    expect(src).not.toMatch(/createColaborador\(\{\s*\.\.\.input,\s*company_id/);
  });

  it("🔴 a empresa continua a vir do servidor, e o payload continua ignorado", () => {
    // A correcção não pode ter aberto a porta a escolher a empresa pelo browser.
    const src = ler(ACTION);
    expect(src).toMatch(/const companyId = callerProfile\.company_id/);
    expect(src).toMatch(/company_id: companyId/);
  });

  it("só admin e gestor criam, e a verificação vem antes da escrita", () => {
    const src = ler(ACTION);
    const i = src.indexOf("export async function createColaborador");
    const corpo = src.slice(i, src.indexOf("\n}\n", i));

    const guarda = corpo.indexOf('["admin", "gestor"].includes');
    const escrita = corpo.indexOf(".insert(");
    expect(guarda).toBeGreaterThan(-1);
    expect(escrita).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(escrita);
  });
});

describe("o que a correcção não pode ter partido", () => {
  it("só o nome continua obrigatório", () => {
    const src = ler(ACTION);
    const i = src.indexOf("const colaboradorSchema");
    const bloco = src.slice(i, src.indexOf("});", i));

    expect(bloco).toMatch(/full_name: z\.string\(\)\.min\(2/);
    for (const opcional of ["email", "phone", "contracted_hours_month"]) {
      const linha = bloco.split("\n").find((l) => l.trim().startsWith(`${opcional}:`));
      expect(linha, opcional).toMatch(/optional\(\)|nullable\(\)|default\(/);
    }
  });

  it("as validações de uuid que servem para alguma coisa ficam", () => {
    // `service_id` e `user_id` são gerados por `gen_random_uuid()` — são v4 e a
    // validação protege mesmo. Tirá-las por arrasto seria a correcção errada.
    expect(ler("src/app/api/app/timesheet/route.ts")).toMatch(/service_id: z\.string\(\)\.uuid\(/);
    expect(ler("src/app/api/push/send/route.ts")).toMatch(/user_id: z\.string\(\)\.uuid\(/);
  });
});
