// ============================================================================
// Scanner de credenciais versionadas
// ============================================================================
// Origem: incidente de 2026-08-06. `scripts/reset-password.mjs` continha, num
// repositório PÚBLICO e desde 2026-06-03, uma chave `sb_secret_` de service
// role (ignora RLS, acesso total ao projeto), a URL do projeto real, um id de
// utilizador real, uma senha em texto simples, e a chamada
// `auth.admin.updateUserById` que a aplicava.
//
// A regra mais importante aqui, e a que mais fácil seria falhar: **o scanner
// nunca pode imprimir o valor que encontrou**. Um detetor que ecoa o segredo
// para o log do CI passa a ser ele próprio uma fuga — e os logs do CI de um
// repositório público são públicos.
//
// As fixtures deste ficheiro são construídas por concatenação, para que nem
// o próprio teste contenha uma credencial com formato completo em texto.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { analisarConteudo } from "../../scripts/scan-secrets.mjs";

const ROOT = path.join(__dirname, "..", "..");

/** Construída em partes de propósito — ver cabeçalho. */
const CHAVE_SINTETICA = "sb_secret_" + "A".repeat(24);
const TOKEN_SINTETICO = "sbp_" + "b".repeat(40);

describe("deteção — o que tem de ser apanhado", () => {
  it("apanha uma chave secreta do Supabase", () => {
    const achados = analisarConteudo(
      "scripts/qualquer.mjs",
      `const k = "${CHAVE_SINTETICA}";`,
    );

    expect(achados).toHaveLength(1);
    expect(achados[0].tipo).toBe("chave-secreta-supabase");
    expect(achados[0].gravidade).toBe("critico");
    expect(achados[0].linha).toBe(1);
  });

  it("apanha um token de acesso pessoal", () => {
    const achados = analisarConteudo(
      "docs/notas.md",
      `login com token ${TOKEN_SINTETICO}`,
    );

    expect(achados.map((a) => a.tipo)).toContain("token-supabase-pessoal");
  });

  it("apanha SUPABASE_SERVICE_ROLE_KEY atribuída a um literal", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      `SUPABASE_SERVICE_ROLE_KEY = "${"z".repeat(30)}"`,
    );

    expect(achados.map((a) => a.tipo)).toContain("atribuicao-service-role");
  });

  it("apanha uma URL de Postgres com credenciais", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      `const url = "postgresql://postgres.abc:P4ssw0rdReal@db.host.com:5432/postgres";`,
    );

    expect(achados.map((a) => a.tipo)).toContain("url-postgres");
  });

  it("apanha uma senha literal num script administrativo", () => {
    const achados = analisarConteudo(
      "scripts/reset-qualquer-coisa.mjs",
      `await admin.updateUserById(id, { password: "Escala9999!" });`,
    );

    expect(achados.map((a) => a.tipo)).toContain("senha-literal");
  });

  it("apanha uma URL de projeto Supabase escrita em código", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      `const supabase = createClient("https://abcdefghijklmnop.supabase.co", k);`,
    );

    expect(achados.map((a) => a.tipo)).toContain("url-supabase-hardcoded");
  });

  it("reporta a linha certa num ficheiro com várias", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      ["// linha 1", "// linha 2", `const k = "${CHAVE_SINTETICA}";`].join("\n"),
    );

    expect(achados[0].linha).toBe(3);
  });
});

describe("o scanner nunca expõe o valor encontrado", () => {
  it("nenhum campo do achado contém a credencial", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      `const k = "${CHAVE_SINTETICA}";`,
    );

    const serializado = JSON.stringify(achados);

    expect(serializado).not.toContain(CHAVE_SINTETICA);
    // Nem sequer um pedaço reconhecível.
    expect(serializado).not.toContain("A".repeat(12));

    // O achado tem de ser útil na mesma: onde está e o que é.
    expect(achados[0]).toMatchObject({
      ficheiro: "scripts/x.mjs",
      linha: 1,
      tipo: "chave-secreta-supabase",
    });
  });

  it("o próprio scanner não imprime a linha lida", () => {
    const fonte = fs
      .readFileSync(path.join(ROOT, "scripts/scan-secrets.mjs"), "utf8")
      .replace(/\r\n/g, "\n");

    // A saída é construída só com metadados. Se alguém acrescentar a linha ou
    // o valor ao console, este teste falha.
    const saidas = fonte.match(/console\.(log|error)\([^;]*/g) ?? [];

    for (const saida of saidas) {
      expect(saida, `saída suspeita: ${saida}`).not.toMatch(
        /\blinha\.|\bvalor\b|match\[|\.match\(/,
      );
    }
  });
});

describe("permitido — o que não pode dar falso positivo", () => {
  it("variáveis de ambiente são a forma correta e não são sinalizadas", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      [
        "const supabase = createClient(",
        "  process.env.NEXT_PUBLIC_SUPABASE_URL,",
        "  process.env.SUPABASE_SERVICE_ROLE_KEY,",
        ");",
        "const PASSWORD = process.env.SEED_PASSWORD;",
      ].join("\n"),
    );

    expect(achados).toEqual([]);
  });

  it("marcadores de documentação não são credenciais", () => {
    const achados = analisarConteudo(
      "docs/x.md",
      [
        "SUPABASE_DB_URL=postgresql://postgres.<ref-descartavel>:<password>@host:5432/postgres",
        'password: "<YOUR_PASSWORD>"',
        "chave: sb_secret_xxxxxxxxxxxxxxxxxxxx",
      ].join("\n"),
    );

    expect(achados).toEqual([]);
  });

  it("um project ref sintético num teste é permitido", () => {
    const fixture = fs
      .readFileSync(
        path.join(ROOT, "src/__tests__/migration-runner-guards.test.ts"),
        "utf8",
      )
      .replace(/\r\n/g, "\n");

    const achados = analisarConteudo(
      "src/__tests__/migration-runner-guards.test.ts",
      fixture,
    );

    expect(achados).toEqual([]);
  });
});

describe("estado do repositório depois do incidente", () => {
  it("scripts/reset-password.mjs não existe", () => {
    expect(fs.existsSync(path.join(ROOT, "scripts/reset-password.mjs"))).toBe(
      false,
    );
  });

  it("nenhum script administrativo aponta para um projeto por omissão", () => {
    const dir = path.join(ROOT, "scripts");

    const infratores = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".mjs"))
      .filter((n) => {
        const conteudo = fs.readFileSync(path.join(dir, n), "utf8");
        return /["'`]https:\/\/[a-z0-9]{12,}\.supabase\.co/.test(conteudo);
      });

    expect(infratores).toEqual([]);
  });

  it("nenhuma senha literal nos scripts que criam contas", () => {
    for (const rel of [
      "scripts/create-admins.mjs",
      "scripts/create-colaborador.mjs",
    ]) {
      const conteudo = fs.readFileSync(path.join(ROOT, rel), "utf8");

      expect(conteudo, rel).toMatch(/process\.env\.SEED_PASSWORD/);
      expect(analisarConteudo(rel, conteudo), rel).toEqual([]);
    }
  });

  it("o scanner está ligado ao CI, antes dos testes", () => {
    const workflow = fs
      .readFileSync(path.join(ROOT, ".github/workflows/quality.yml"), "utf8")
      .replace(/\r\n/g, "\n");

    expect(workflow).toContain("npm run secrets:scan");

    const posScan = workflow.indexOf("npm run secrets:scan");
    const posTest = workflow.indexOf("npm test");

    expect(posScan).toBeGreaterThan(-1);
    expect(posTest).toBeGreaterThan(posScan);
  });

  it("existe o script npm", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );

    expect(pkg.scripts["secrets:scan"]).toContain("scan-secrets.mjs");
  });
});
