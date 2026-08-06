// ============================================================================
// Scanner de credenciais versionadas
// ============================================================================
// Origem: incidente de 2026-08-06. `scripts/reset-password.mjs` continha, num
// repositório PÚBLICO e desde 2026-06-03, uma chave `sb_secret_` de service
// role, a URL do projeto real, um id de utilizador real, uma senha em texto
// simples, e a chamada `auth.admin.updateUserById` que a aplicava.
//
// A primeira versão do scanner tinha um bypass grave: depois de encontrar um
// padrão, ignorava a LINHA INTEIRA se ela contivesse um marcador como
// "example", "placeholder", "xxxx" ou "...". Uma credencial real acompanhada
// de um comentário inocente escapava:
//
//     const k = "sb_secret_<real>"; // placeholder, trocar depois
//
// A correção avalia apenas o VALOR capturado. É isso que a maior parte destes
// testes prova — cada um deles falharia contra a versão antiga.
//
// Nenhuma credencial com formato completo aparece literalmente neste ficheiro:
// as fixtures são construídas por concatenação, para o próprio teste não ser
// uma fuga nem disparar o scanner.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  analisarConteudo,
  analisarFicheiro,
  ehBinario,
} from "../../scripts/scan-secrets.mjs";

const ROOT = path.join(__dirname, "..", "..");

// Construídas em partes — ver cabeçalho.
const CHAVE = "sb_secret_" + "K7pQ2mN4vR8xT1wY6zA3bC5d";
const CHAVE_COM_XXXX = "sb_secret_" + "K7pQxxxxN4vR8xT1wY6zA3bC";
const TOKEN = "sbp_" + "9f3a1c7e5b2d8046af91c3e57b0d2946af81c3e5";
const PG = "postgre" + "sql://postgres.abcdefghijkl:" + "R3alP4ss!x" + "@db.h.com:5432/postgres";
const SENHA_LINHA = "pass" + "word: " + '"' + "Escala2026!" + '"';

describe("bypass por marcador na linha — o defeito corrigido", () => {
  it("credencial real + comentário 'placeholder' → DETETADA", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      `const k = "${CHAVE}"; // placeholder, trocar depois`,
    );

    expect(achados.map((a) => a.tipo)).toContain("chave-secreta-supabase");
  });

  it("credencial real contendo 'xxxx' no meio → DETETADA", () => {
    // O valor tem xxxx lá dentro, mas não é xxxx por inteiro.
    const achados = analisarConteudo(
      "scripts/x.mjs",
      `const k = "${CHAVE_COM_XXXX}";`,
    );

    expect(achados.map((a) => a.tipo)).toContain("chave-secreta-supabase");
  });

  it("senha real + comentário 'example' → DETETADA", () => {
    const achados = analisarConteudo(
      "scripts/admin.mjs",
      `${SENHA_LINHA} // example only`,
    );

    expect(achados.map((a) => a.tipo)).toContain("senha-literal");
  });

  it("credencial real na mesma linha de '<ref>' → DETETADA", () => {
    const achados = analisarConteudo(
      "docs/x.md",
      `Para o projeto <ref-descartavel>, usar a chave ${CHAVE}`,
    );

    expect(achados.map((a) => a.tipo)).toContain("chave-secreta-supabase");
  });

  it("credencial real acompanhada de '...' → DETETADA", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      `const k = "${CHAVE}"; // ver ... documentação`,
    );

    expect(achados).toHaveLength(1);
  });

  it("token real com 'dummy' no comentário → DETETADO", () => {
    const achados = analisarConteudo("docs/x.md", `token ${TOKEN} (dummy?)`);

    expect(achados.map((a) => a.tipo)).toContain("token-supabase-pessoal");
  });

  it("URL de Postgres com senha real + 'example' na linha → DETETADA", () => {
    const achados = analisarConteudo(
      "docs/exemplo.md",
      `# example de ligação\nSUPABASE_DB_URL=${PG}`,
    );

    expect(achados.map((a) => a.tipo)).toContain("url-postgres");
    expect(achados[0].linha).toBe(2);
  });
});

describe("marcador puro — o que continua permitido", () => {
  it("valor inteiramente formado por x", () => {
    expect(
      analisarConteudo("docs/x.md", `chave: sb_secret_${"x".repeat(20)}`),
    ).toEqual([]);
  });

  it("marcador em ângulos", () => {
    expect(
      analisarConteudo(
        "docs/x.md",
        "SUPABASE_DB_URL=postgre" +
          "sql://postgres.<ref>:<password>@host:5432/postgres",
      ),
    ).toEqual([]);
  });

  it("variável de ambiente por interpolação", () => {
    expect(
      analisarConteudo("scripts/x.sh", 'SUPABASE_SERVICE_ROLE_KEY="${SUPA_KEY}"'),
    ).toEqual([]);
  });

  it("leitura correta a partir do ambiente", () => {
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

  it("declaração vazia num ficheiro de exemplo", () => {
    expect(
      analisarConteudo(
        ".env.example",
        "SUPABASE_SERVICE_ROLE_KEY=       # apenas server-side",
      ),
    ).toEqual([]);
  });

  it("chave de objeto de configuração não é um valor", () => {
    expect(
      analisarConteudo(
        "scripts/check-env.ts",
        "  SUPABASE_SERVICE_ROLE_KEY: {\n    desc: 'Service role key',\n  },",
      ),
    ).toEqual([]);
  });
});

describe("cobertura de ficheiros — sem filtrar por extensão", () => {
  it("segredo num .txt → DETETADO", () => {
    const achados = analisarFicheiro("notas.txt", Buffer.from(`chave ${CHAVE}`));

    expect(achados.map((a) => a.tipo)).toContain("chave-secreta-supabase");
  });

  it("segredo num ficheiro sem extensão → DETETADO", () => {
    const achados = analisarFicheiro("Dockerfile", Buffer.from(`ENV K=${CHAVE}`));

    expect(achados.map((a) => a.tipo)).toContain("chave-secreta-supabase");
  });

  it("segredo num .toml, .ini e .csv → DETETADO", () => {
    for (const nome of ["config.toml", "app.ini", "dados.csv"]) {
      const achados = analisarFicheiro(nome, Buffer.from(`k=${CHAVE}`));

      expect(achados.length, nome).toBeGreaterThan(0);
    }
  });

  it("ficheiro binário → IGNORADO", () => {
    // Um byte nulo é o sinal, tal como no git — não a extensão.
    const binario = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
      Buffer.from(CHAVE),
    ]);

    expect(ehBinario(binario)).toBe(true);
    expect(analisarFicheiro("imagem.png", binario)).toEqual([]);
  });

  it("texto sem bytes nulos não é confundido com binário", () => {
    expect(ehBinario(Buffer.from("texto normal com acentuação ção"))).toBe(false);
  });
});

describe("o scanner nunca expõe o valor encontrado", () => {
  it("nenhum campo do achado contém a credencial", () => {
    const achados = analisarConteudo("scripts/x.mjs", `const k = "${CHAVE}";`);
    const serializado = JSON.stringify(achados);

    expect(serializado).not.toContain(CHAVE);
    expect(serializado).not.toContain("K7pQ2mN4");

    expect(achados[0]).toMatchObject({
      ficheiro: "scripts/x.mjs",
      linha: 1,
      tipo: "chave-secreta-supabase",
      gravidade: "critico",
    });
  });

  it("o próprio scanner não imprime a linha nem o valor", () => {
    const fonte = fs
      .readFileSync(path.join(ROOT, "scripts/scan-secrets.mjs"), "utf8")
      .replace(/\r\n/g, "\n");

    const saidas = fonte.match(/console\.(log|error)\([^;]*/g) ?? [];

    for (const saida of saidas) {
      expect(saida, `saída suspeita: ${saida}`).not.toMatch(
        /\blinha\.|\bvalor\b|match\[|\.match\(/,
      );
    }
  });

  it("reporta a linha certa num ficheiro com várias", () => {
    const achados = analisarConteudo(
      "scripts/x.mjs",
      ["// um", "// dois", `const k = "${CHAVE}";`].join("\n"),
    );

    expect(achados[0].linha).toBe(3);
  });
});

describe("allowlist — sem perdões genéricos", () => {
  it("nenhuma entrada usa o tipo curinga", () => {
    const fonte = fs
      .readFileSync(path.join(ROOT, "scripts/scan-secrets.mjs"), "utf8")
      .replace(/\r\n/g, "\n");

    const bloco = fonte.slice(
      fonte.indexOf("const ALLOWLIST"),
      fonte.indexOf("const VALOR_SINTETICO"),
    );

    expect(bloco).not.toMatch(/tipos:\s*\[\s*["']\*["']/);
    // Cada entrada tem de justificar-se.
    const entradas = bloco.match(/ficheiro:/g) ?? [];
    const motivos = bloco.match(/motivo:/g) ?? [];
    expect(motivos.length).toBe(entradas.length);
  });

  it("o próprio scanner não precisa de estar na allowlist", () => {
    const fonte = fs.readFileSync(
      path.join(ROOT, "scripts/scan-secrets.mjs"),
      "utf8",
    );

    // Se os padrões estivessem escritos de forma a apanhar-se a si próprios,
    // a saída seria a de um perdão implícito. Não é: não encontra nada.
    expect(analisarConteudo("scripts/scan-secrets.mjs", fonte)).toEqual([]);
  });

  it("este ficheiro de teste também passa limpo", () => {
    const fonte = fs.readFileSync(
      path.join(ROOT, "src/__tests__/scan-secrets.test.ts"),
      "utf8",
    );

    expect(analisarConteudo("src/__tests__/scan-secrets.test.ts", fonte)).toEqual(
      [],
    );
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
