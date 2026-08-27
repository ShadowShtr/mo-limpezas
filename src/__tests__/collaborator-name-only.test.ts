/**
 * PHASE D — criar uma pessoa só com o nome. COL01 a COL08.
 *
 * O que estes testes protegem não é a validação: é a recusa em inventar dados.
 *
 * O código anterior fabricava um email quando não havia um —
 * `nome.1724713200000@demo.escala.pt` — porque o GoTrue exige um endereço para
 * criar a conta, e criava sempre conta. Esse endereço ficava guardado como se
 * fosse o email da pessoa, indistinguível de um verdadeiro para quem o lesse a
 * seguir.
 *
 * Um campo por preencher é `NULL`. Nunca zero, nunca `"N/A"`, nunca um
 * endereço gerado.
 */
import { describe, expect, it } from "vitest";
import { prepararCriacao, criacaoEscreveNoAuth } from "@/domain/collaborators/create-input";

const ok = (r: ReturnType<typeof prepararCriacao>) => {
  if (!r.ok) throw new Error(`esperava sucesso, veio: ${r.error}`);
  return r.row;
};

describe("COL01–COL08 — só o nome é obrigatório", () => {
  it("COL01. o nome sozinho chega", () => {
    const row = ok(prepararCriacao({ full_name: "Maria Silva" }));
    expect(row.full_name).toBe("Maria Silva");
    expect(row.role).toBe("colaborador");
    expect(row.status).toBe("ativo");
  });

  it("COL02. sem NIF fica NULL — não zero, não vazio, não inventado", () => {
    expect(ok(prepararCriacao({ full_name: "Maria" })).nif).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", nif: "" })).nif).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", nif: "   " })).nif).toBeNull();
  });

  it("COL03. sem IBAN fica NULL", () => {
    expect(ok(prepararCriacao({ full_name: "Maria" })).iban).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", iban: "  " })).iban).toBeNull();
  });

  it("COL04. 🔴 sem email fica NULL — nenhum endereço é fabricado", () => {
    const row = ok(prepararCriacao({ full_name: "Maria Silva" }));
    expect(row.email).toBeNull();
    // A forma que o código antigo gerava não pode reaparecer por caminho nenhum.
    expect(JSON.stringify(row)).not.toMatch(/@demo\.escala\.pt|@example|@placeholder|noreply@/i);
    expect(JSON.stringify(row)).not.toMatch(/\d{10,}/); // sem Date.now() lá dentro
  });

  it("COL05. sem telefone fica NULL", () => {
    expect(ok(prepararCriacao({ full_name: "Maria" })).phone).toBeNull();
  });

  it("COL06. sem datas fica NULL — e uma data inválida também", () => {
    const vazio = ok(prepararCriacao({ full_name: "Maria" }));
    expect(vazio.contract_start).toBeNull();
    expect(vazio.contract_end).toBeNull();
    // `"2026-13-45"` não é uma data: é ausência de data, não um valor a guardar.
    expect(ok(prepararCriacao({ full_name: "Maria", contract_start: "2026-13-45" }))
      .contract_start).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", contract_start: "72026-01-01" }))
      .contract_start).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", contract_start: "2026-03-15" }))
      .contract_start).toBe("2026-03-15");
  });

  it("COL07. duas pessoas com o mesmo nome são duas pessoas", () => {
    const a = ok(prepararCriacao({ full_name: "Maria Silva" }));
    const b = ok(prepararCriacao({ full_name: "Maria Silva" }));
    // Nada nesta camada as distingue nem as recusa: quem distingue é o id, que
    // a base gera. O nome não é identidade.
    expect(a).toEqual(b);
  });

  it("COL08. 🔴 company_id não é aceite — vem da sessão", () => {
    const row = ok(prepararCriacao({
      full_name: "Maria",
      // Um cliente malicioso a tentar criar noutra empresa.
      company_id: "22222222-2222-4222-8222-222222222222",
    } as Parameters<typeof prepararCriacao>[0]));
    expect(row).not.toHaveProperty("company_id");
    expect(JSON.stringify(row)).not.toContain("22222222");
  });
});

describe("PHASE D — criar pessoa não cria conta de acesso", () => {
  it("🔴 COLLABORATOR_CREATE_AUTH_WRITE = 0", () => {
    expect(criacaoEscreveNoAuth()).toBe(false);
  });

  it("a action de criar não chama a API de administração do Auth", async () => {
    const fs = await import("node:fs");
    const fonte = fs.readFileSync("src/app/actions/colaboradores.ts", "utf8");
    const criar = fonte.slice(
      fonte.indexOf("export async function createColaborador"),
      fonte.indexOf("export async function updateColaborador"));
    // Só o código conta — as linhas de comentário explicam o que deixou de se
    // fazer, e mencioná-lo não é fazê-lo.
    const codigo = criar.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(codigo).not.toContain("auth.admin.createUser");
    expect(codigo).not.toContain("demo.escala.pt");
    expect(codigo).not.toContain("Date.now()");
  });
});

describe("valores por preencher nunca viram valores reais", () => {
  it("🔴 valor à hora ausente é NULL, e zero é zero", () => {
    // «Ainda não sabemos quanto ganha» e «ganha zero» são coisas diferentes.
    // Confundi-las faz a folha calcular zero em vez de recusar calcular.
    expect(ok(prepararCriacao({ full_name: "Maria" })).hourly_rate).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", hourly_rate: "" })).hourly_rate).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", hourly_rate: 0 })).hourly_rate).toBe(0);
    expect(ok(prepararCriacao({ full_name: "Maria", hourly_rate: 9.5 })).hourly_rate).toBe(9.5);
  });

  it("horas contratadas ausentes ficam NULL", () => {
    expect(ok(prepararCriacao({ full_name: "Maria" })).contracted_hours_month).toBeNull();
    expect(ok(prepararCriacao({ full_name: "Maria", contracted_hours_month: 168 }))
      .contracted_hours_month).toBe(168);
  });

  it("o nome é aparado, não decorado", () => {
    expect(ok(prepararCriacao({ full_name: "  Maria Silva  " })).full_name).toBe("Maria Silva");
  });
});

describe("o que continua a ser recusado", () => {
  it.each([
    ["sem nome", {}, /nome é obrigatório/i],
    ["nome vazio", { full_name: "   " }, /nome é obrigatório/i],
    ["nome de uma letra", { full_name: "M" }, /2 caracteres/i],
    ["email mal escrito", { full_name: "Maria", email: "maria@" }, /email inválido/i],
    ["função inventada", { full_name: "Maria", role: "patrao" }, /função inválida/i],
    ["estado inventado", { full_name: "Maria", status: "meio-ativo" }, /estado inválido/i],
    ["horas impossíveis", { full_name: "Maria", contracted_hours_month: 900 }, /horas contratadas/i],
    ["valor à hora negativo", { full_name: "Maria", hourly_rate: -5 }, /negativo/i],
  ])("%s", (_label, input, padrao) => {
    const r = prepararCriacao(input as Parameters<typeof prepararCriacao>[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(padrao);
  });

  it("um email escrito é guardado; um email por escrever não é inventado", () => {
    expect(ok(prepararCriacao({ full_name: "Maria", email: "maria@exemplo.pt" })).email)
      .toBe("maria@exemplo.pt");
    expect(ok(prepararCriacao({ full_name: "Maria", email: "  " })).email).toBeNull();
  });
});
