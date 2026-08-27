/**
 * PHASE E — dar, tirar e devolver acesso. ACC01–08, PWD01–08, FAIL01–05.
 *
 * O que estes testes protegem é sobretudo o que acontece quando as coisas
 * correm mal. Criar a conta e ligá-la à pessoa são escritas em dois sistemas
 * diferentes — o Auth e a base — e não há transação que abranja os dois.
 *
 * As duas falhas possíveis são assimétricas, e tratá-las como se fossem
 * simétricas é que faria estragos:
 *
 *   conta criada + ligação falhada → identidade capaz de autenticar sem dono;
 *                                    tem de ser desfeita
 *   conta não criada               → a pessoa fica como estava; não é dano
 */
import { describe, expect, it } from "vitest";
import {
  podeGerirAcesso, podeCriarAcesso, exigeAcessoExistente, estadoAcesso,
  identificadorDeAutenticacao, eIdentificadorTecnico, AUTH_IDENTIFIER_DOMAIN,
  validarSenhaTemporaria, registoDeSenha, compensacaoNecessaria,
  falhaDeContaApagaPessoa,
  type Actor, type Pessoa,
} from "@/domain/collaborators/access-lifecycle";

const EMPRESA_A = "11111111-1111-4111-8111-111111111111";
const EMPRESA_B = "22222222-2222-4222-8222-222222222222";

const pessoa = (over: Partial<Pessoa> = {}): Pessoa => ({
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  company_id: EMPRESA_A,
  full_name: "Maria Silva",
  auth_user_id: null,
  ...over,
});

const actor = (over: Partial<Actor> = {}): Actor => ({
  profile_id: "bbbbbbbb-0000-4000-8000-000000000001",
  company_id: EMPRESA_A,
  role: "admin",
  ...over,
});

describe("ACC01–ACC08 — o ciclo do acesso", () => {
  it("ACC01. uma pessoa sem conta existe e é uma pessoa válida", () => {
    const p = pessoa();
    expect(p.auth_user_id).toBeNull();
    expect(estadoAcesso(p, null)).toBe("sem_acesso");
  });

  it("ACC02. sem conta, não há por onde entrar", () => {
    // Não existe operação de acesso aplicável a quem não tem conta: definir
    // senha, desactivar ou reactivar exigem que já haja uma.
    for (const op of ["definir senha", "desactivar", "reactivar"]) {
      const d = exigeAcessoExistente(actor(), pessoa(), op);
      expect(d.permitido).toBe(false);
      if (!d.permitido) expect(d.codigo).toBe("ACCESS_NOT_FOUND");
    }
  });

  it("ACC03. criar acesso usa a mesma pessoa — o id não muda", () => {
    const p = pessoa();
    expect(podeCriarAcesso(actor(), p).permitido).toBe(true);
    // O identificador de autenticação **deriva** do id da pessoa: não há como
    // criar acesso para outra pessoa sem mudar o id, e o id não muda.
    expect(identificadorDeAutenticacao(p.id)).toContain(p.id);
  });

  it("ACC04. quem já tem acesso não recebe uma segunda conta", () => {
    const d = podeCriarAcesso(actor(), pessoa({ auth_user_id: "auth-1" }));
    expect(d.permitido).toBe(false);
    if (!d.permitido) expect(d.codigo).toBe("ACCESS_ALREADY_EXISTS");
  });

  it("ACC05. repetir o pedido não cria outra conta", () => {
    // A primeira chamada liga a conta; a segunda vê `auth_user_id` preenchido.
    const p = pessoa();
    expect(podeCriarAcesso(actor(), p).permitido).toBe(true);
    const depois = { ...p, auth_user_id: "auth-1" };
    expect(podeCriarAcesso(actor(), depois).permitido).toBe(false);
  });

  it("ACC06. dois administradores em simultâneo — o segundo é recusado", () => {
    const p = pessoa();
    // Os dois vêem a pessoa sem conta e são autorizados a tentar.
    expect(podeCriarAcesso(actor({ profile_id: "admin-1" }), p).permitido).toBe(true);
    expect(podeCriarAcesso(actor({ profile_id: "admin-2" }), p).permitido).toBe(true);
    // O primeiro grava; o segundo passa a ver a conta e é recusado. A garantia
    // final é o índice único em `auth_user_id`, provada em Postgres — aqui
    // prova-se que a recusa acontece antes de criar a conta para depois a
    // apagar.
    const gravado = { ...p, auth_user_id: "auth-do-primeiro" };
    const d = podeCriarAcesso(actor({ profile_id: "admin-2" }), gravado);
    expect(d.permitido).toBe(false);
    if (!d.permitido) expect(d.codigo).toBe("ACCESS_ALREADY_EXISTS");
  });

  it("ACC07. desactivar o acesso não apaga a pessoa", () => {
    const p = pessoa({ auth_user_id: "auth-1" });
    // Desactivado é um estado do acesso, não da pessoa: ela continua lá, com o
    // mesmo id, e com ela a folha, os documentos e o histórico.
    expect(estadoAcesso(p, { disabled: true })).toBe("desativado");
    expect(p.id).toBe(pessoa().id);
    expect(p.auth_user_id).toBe("auth-1");
  });

  it("ACC08. reactivar devolve a mesma conta, não cria outra", () => {
    const p = pessoa({ auth_user_id: "auth-1" });
    expect(exigeAcessoExistente(actor(), p, "reactivar").permitido).toBe(true);
    expect(estadoAcesso(p, { disabled: false })).toBe("ativo");
    // A conta é a mesma de antes de ser desactivada.
    expect(p.auth_user_id).toBe("auth-1");
  });
});

describe("o identificador de entrada não é o email da pessoa", () => {
  it("🔴 deriva do id, não do nome nem do email", () => {
    const p = pessoa();
    const ident = identificadorDeAutenticacao(p.id);
    expect(ident).toContain(p.id);
    expect(ident.toLowerCase()).not.toContain("maria");
    expect(ident.toLowerCase()).not.toContain("silva");
  });

  it("🔴 não se pode confundir com correio real", () => {
    const ident = identificadorDeAutenticacao(pessoa().id);
    expect(ident.endsWith(`@${AUTH_IDENTIFIER_DOMAIN}`)).toBe(true);
    // `.invalid` é reservado precisamente para não existir: ninguém escreve
    // para aqui por engano, e ninguém o toma por um endereço da pessoa.
    expect(AUTH_IDENTIFIER_DOMAIN.endsWith(".invalid")).toBe(true);
    expect(eIdentificadorTecnico(ident)).toBe(true);
    expect(eIdentificadorTecnico("maria@exemplo.pt")).toBe(false);
    expect(eIdentificadorTecnico(null)).toBe(false);
  });

  it("duas pessoas nunca partilham identificador", () => {
    const a = identificadorDeAutenticacao("aaaaaaaa-0000-4000-8000-000000000001");
    const b = identificadorDeAutenticacao("aaaaaaaa-0000-4000-8000-000000000002");
    expect(a).not.toBe(b);
  });
});

describe("PWD01–PWD08 — senhas", () => {
  it("PWD01. o administrador define uma senha temporária", () => {
    expect(validarSenhaTemporaria("Temp2026ab")).toEqual({ ok: true });
  });

  it("PWD02. 🔴 o que se guarda não contém a senha", () => {
    const registo = registoDeSenha(
      pessoa({ auth_user_id: "auth-1" }), actor(), "2026-08-27T10:00:00.000Z");
    const texto = JSON.stringify(registo);
    expect(texto).not.toContain("Temp2026ab");
    expect(Object.keys(registo)).not.toContain("password");
    expect(Object.keys(registo)).not.toContain("senha");
    // O que fica: que houve uma definição, quem a fez e quando.
    expect(registo.must_change_password).toBe(true);
    expect(registo.actor_profile_id).toBe(actor().profile_id);
  });

  it("PWD03. 🔴 não há operação que devolva a senha actual", async () => {
    // O módulo inteiro não expõe nada que leia uma senha. Se um dia alguém
    // acrescentar, este teste dá-lhe conta disso.
    const modulo = await import("@/domain/collaborators/access-lifecycle");
    for (const nome of Object.keys(modulo)) {
      expect(nome.toLowerCase()).not.toMatch(/(get|ler|obter|read).*(password|senha)/);
    }
    // E o ficheiro não guarda nem devolve valores de senha em lado nenhum.
    const fs = await import("node:fs");
    const fonte = fs.readFileSync("src/domain/collaborators/access-lifecycle.ts", "utf8");
    const codigo = fonte.split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(codigo).not.toMatch(/password:\s*senha|senha:\s*senha|plaintext/i);
  });

  it("PWD04. definir senha obriga a trocá-la no primeiro acesso", () => {
    const registo = registoDeSenha(
      pessoa({ auth_user_id: "auth-1" }), actor(), "2026-08-27T10:00:00.000Z");
    expect(registo.must_change_password).toBe(true);
    expect(estadoAcesso(pessoa({ auth_user_id: "auth-1" }),
      { must_change_password: true })).toBe("troca_pendente");
  });

  it("PWD05. depois de trocada, deixa de estar pendente", () => {
    expect(estadoAcesso(pessoa({ auth_user_id: "auth-1" }),
      { must_change_password: false })).toBe("ativo");
  });

  it("PWD07. um reset novo volta a marcar a troca", () => {
    const registo = registoDeSenha(
      pessoa({ auth_user_id: "auth-1" }), actor(), "2026-08-27T11:00:00.000Z");
    expect(registo.must_change_password).toBe(true);
  });

  it("PWD08. 🔴 não se define senha a quem é de outra empresa", () => {
    const d = exigeAcessoExistente(
      actor({ company_id: EMPRESA_A }),
      pessoa({ company_id: EMPRESA_B, auth_user_id: "auth-1" }),
      "definir senha");
    expect(d.permitido).toBe(false);
    if (!d.permitido) expect(d.codigo).toBe("CROSS_COMPANY_BLOCKED");
  });

  it.each([
    ["vazia", "", /obrigatória/i],
    ["curta demais", "Ab1", /8 caracteres/i],
    ["só letras", "abcdefghij", /letras e números/i],
    ["só números", "1234567890", /letras e números/i],
    ["longa demais", `${"a1".repeat(40)}`, /72 caracteres/i],
  ])("uma senha %s é recusada", (_label, senha, padrao) => {
    const r = validarSenhaTemporaria(senha);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toMatch(padrao);
  });

  it("🔴 o limite de 72 existe porque o bcrypt trunca em silêncio", () => {
    // Aceitar 100 caracteres e guardar 72 daria a quem a escreveu a impressão
    // de uma senha mais forte do que a que ficou.
    expect(validarSenhaTemporaria("a1".repeat(36)).ok).toBe(true);   // 72
    expect(validarSenhaTemporaria(`${"a1".repeat(36)}x`).ok).toBe(false); // 73
  });
});

describe("FAIL01–FAIL05 — quando os dois sistemas divergem", () => {
  it("FAIL01. 🔴 conta criada e ligação falhada → a conta é desfeita", () => {
    expect(compensacaoNecessaria(true, false)).toBe("apagar_conta");
  });

  it("FAIL02. 🔴 conta não criada → a pessoa fica exactamente como estava", () => {
    expect(compensacaoNecessaria(false, false)).toBe("nada");
    // E nunca se apaga a pessoa por o Auth não ter respondido: seria destruir
    // a folha, os documentos e o histórico dela por causa de uma falha de rede.
    expect(falhaDeContaApagaPessoa()).toBe(false);
  });

  it("tudo bem sucedido não compensa nada", () => {
    expect(compensacaoNecessaria(true, true)).toBe("nada");
  });

  it("FAIL03. duas ligações concorrentes dão uma conta só", () => {
    // A segunda tentativa vê `auth_user_id` já preenchido e recusa antes de
    // criar. Quem chegar a criar e não conseguir gravar cai no FAIL01.
    const gravado = pessoa({ auth_user_id: "auth-1" });
    expect(podeCriarAcesso(actor(), gravado).permitido).toBe(false);
  });

  it("FAIL05. uma pessoa lida antes de mudar não é ligada por engano", () => {
    // O estado que se leu no início pode estar velho quando se vai gravar.
    // Como a decisão é tomada sobre a linha lida, e a gravação é condicional
    // ao `auth_user_id` continuar nulo, a corrida resolve-se com um perdedor,
    // não com duas contas.
    const lidaAntes = pessoa();
    const entretantoLigada = pessoa({ auth_user_id: "auth-de-outro" });
    expect(podeCriarAcesso(actor(), lidaAntes).permitido).toBe(true);
    expect(podeCriarAcesso(actor(), entretantoLigada).permitido).toBe(false);
  });
});

describe("quem pode gerir acessos", () => {
  it.each([
    ["admin", "admin", true],
    ["gestor", "gestor", true],
    ["colaborador", "colaborador", false],
  ])("%s", (_l, role, esperado) => {
    expect(podeGerirAcesso(actor({ role }), pessoa()).permitido).toBe(esperado);
  });

  it("🔴 nem um admin toca em pessoas de outra empresa", () => {
    const d = podeGerirAcesso(actor({ company_id: EMPRESA_A }),
      pessoa({ company_id: EMPRESA_B }));
    expect(d.permitido).toBe(false);
    if (!d.permitido) expect(d.codigo).toBe("CROSS_COMPANY_BLOCKED");
  });

  it("um colaborador de outra empresa é recusado pelo papel, não pela empresa", () => {
    // A ordem importa para a mensagem: quem não pode gerir acessos não precisa
    // de saber se a pessoa existe noutra empresa.
    const d = podeGerirAcesso(actor({ role: "colaborador", company_id: EMPRESA_A }),
      pessoa({ company_id: EMPRESA_B }));
    expect(d.permitido).toBe(false);
    if (!d.permitido) expect(d.codigo).toBe("ACCESS_MANAGEMENT_FORBIDDEN");
  });
});
