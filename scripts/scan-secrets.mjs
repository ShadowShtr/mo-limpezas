#!/usr/bin/env node
/**
 * Procura credenciais em ficheiros versionados.
 *
 * Origem: incidente de 2026-08-06. `scripts/reset-password.mjs` continha, num
 * repositório PÚBLICO e desde 2026-06-03, uma chave `sb_secret_` de service
 * role (ignora RLS, acesso total ao projeto), a URL do projeto real, um id de
 * utilizador real, uma senha em texto simples, e uma chamada a
 * `auth.admin.updateUserById` que a aplicava.
 *
 * ---------------------------------------------------------------------------
 * Regras deste scanner
 * ---------------------------------------------------------------------------
 * 1. **Nunca imprime o valor encontrado.** Reporta ficheiro, linha e tipo de
 *    risco, e mais nada. Um scanner que ecoa o segredo para o log do CI
 *    transforma-se ele próprio numa fuga — e os registos do CI de um
 *    repositório público também são públicos.
 *
 * 2. Só olha para o que está versionado (`git ls-files`). O que o git ignora
 *    não é repositório.
 *
 * 3. **Analisa todos os ficheiros de texto, sem filtrar por extensão.** Um
 *    segredo num `.txt`, `.toml`, `.ini`, `Dockerfile` ou ficheiro sem
 *    extensão conta tanto como num `.ts`. Binários são detetados por bytes
 *    nulos, não por nome.
 *
 * 4. **A verificação de marcador aplica-se só ao VALOR capturado**, nunca à
 *    linha. A primeira versão ignorava a linha inteira se ela contivesse
 *    "example", "placeholder", "xxxx" ou "..." em qualquer sítio — o que
 *    deixava passar uma chave real acompanhada de um comentário inocente:
 *
 *        const k = "sb_secret_<credencial-real>"; // placeholder, trocar depois
 *
 *    Essa linha continha "placeholder", e a chave real escapava. Agora só o
 *    valor entre aspas é avaliado, e "xxxx" no meio de material real não
 *    perdoa nada: um valor só é marcador se for marcador POR INTEIRO.
 *
 * 5. Falha fechado: qualquer achado devolve código de saída 1.
 *
 * Uso:
 *   npm run secrets:scan
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/**
 * Ficheiros onde um tipo específico é legítimo, com o motivo exigido.
 *
 * Nunca `"*"`: um perdão genérico esconderia uma credencial nova num ficheiro
 * que só devia estar isento de um tipo. Cada entrada nomeia exatamente os
 * tipos que aceita.
 */
const ALLOWLIST = [
  {
    ficheiro: "src/__tests__/migration-runner-guards.test.ts",
    tipos: ["url-supabase-hardcoded"],
    motivo:
      "Testa a extração de project ref a partir de URLs — tem de conter URLs " +
      "com forma real. Os refs são sintéticos, verificado em scan-secrets.test.ts.",
  },
];

/**
 * Um VALOR é marcador quando é marcador por inteiro. Nunca por conter um
 * pedaço que pareça um.
 */
const VALOR_SINTETICO = [
  /^x+$/i, // xxxxxxxx
  /^<[^>]*>$/, // <ref-descartavel>, <password>
  /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, // ${SUPABASE_KEY}
  /^\$[A-Za-z_][A-Za-z0-9_]*$/, // $SUPABASE_KEY
  /^\.{3,}$/, // ...
  /^(seu|teu|your|my)[-_]?(valor|value|key|chave|password|senha|token)$/i,
  /^(placeholder|example|exemplo|changeme|dummy|fake|ficticio|sintetico|test|teste|todo|tbd)$/i,
  /^(password|passwd|senha|segredo|secret|pass)$/i,
  /^[-_]+$/,
];

function ehValorSintetico(valor) {
  if (!valor) return true;
  const limpo = valor.trim();
  if (limpo.length === 0) return true;
  return VALOR_SINTETICO.some((padrao) => padrao.test(limpo));
}

/**
 * Cada regra captura o VALOR no grupo 1. É esse valor — e só esse — que passa
 * pela verificação de marcador.
 */
const REGRAS = [
  {
    tipo: "chave-secreta-supabase",
    gravidade: "critico",
    descricao: "Chave secreta do Supabase (sb_secret_) — ignora RLS",
    padrao: /sb_secret_([A-Za-z0-9_-]{8,})/g,
  },
  {
    tipo: "token-supabase-pessoal",
    gravidade: "critico",
    descricao: "Token de acesso pessoal do Supabase (sbp_) — Management API",
    padrao: /\bsbp_([A-Za-z0-9]{20,})/g,
  },
  {
    tipo: "jwt-literal",
    gravidade: "critico",
    descricao: "JWT literal (pode ser service_role)",
    padrao: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  },
  {
    tipo: "atribuicao-service-role",
    gravidade: "critico",
    descricao: "SUPABASE_SERVICE_ROLE_KEY atribuída a um literal",
    // Mínimo de 8 e sem `{`, `#` ou `,`: senão apanha `KEY: {` de um objeto de
    // configuração e `KEY=   # comentário` de um ficheiro de exemplo, que não
    // são valores nenhuns.
    padrao:
      /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*(?:["'`]([^"'`\r\n]{8,})["'`]|([^\s"'`\r\n#{},]{8,}))/g,
  },
  {
    tipo: "url-postgres",
    gravidade: "critico",
    descricao: "URL de ligação Postgres com credenciais",
    // Captura a senha, que é a parte sensível.
    padrao: /postgresql:\/\/[^\s"'`:@]+:([^\s"'`@]+)@/g,
  },
  {
    tipo: "senha-literal",
    gravidade: "critico",
    descricao: "Senha em texto simples",
    padrao: /\bpass(?:word|wd)?\s*[:=]\s*["'`]([^"'`\r\n]{3,})["'`]/gi,
  },
  {
    tipo: "url-supabase-hardcoded",
    gravidade: "alto",
    descricao: "URL de projeto Supabase escrita em código",
    padrao: /["'`]https:\/\/([a-z0-9]{12,})\.supabase\.co/g,
    apenasEm: /\.(mjs|cjs|js|jsx|ts|tsx)$/,
  },
];

/** Um ref de projeto sintético é reconhecível pelo próprio valor. */
const REF_SINTETICO = /ficti|sintetic|dummy|fake|example|exemplo|placeholder|teste/i;

function permitido(rel, tipo) {
  return ALLOWLIST.some(
    (entrada) => entrada.ficheiro === rel && entrada.tipos.includes(tipo),
  );
}

/**
 * Binário por conteúdo, não por extensão: um byte nulo nos primeiros 8 KB é o
 * sinal usado pelo próprio git.
 */
export function ehBinario(buffer) {
  const limite = Math.min(buffer.length, 8192);
  for (let i = 0; i < limite; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function analisarConteudo(rel, conteudo) {
  const achados = [];
  const linhas = conteudo.split(/\r?\n/);

  for (const regra of REGRAS) {
    if (regra.apenasEm && !regra.apenasEm.test(rel)) continue;
    if (permitido(rel, regra.tipo)) continue;

    linhas.forEach((linha, indice) => {
      // `g` é partilhado entre chamadas — reiniciar antes de cada linha.
      regra.padrao.lastIndex = 0;

      let match;
      while ((match = regra.padrao.exec(linha)) !== null) {
        // Só o valor capturado é avaliado. A linha à volta é irrelevante.
        const valor = match[1] ?? match[2] ?? "";

        if (ehValorSintetico(valor)) continue;

        if (
          regra.tipo === "url-supabase-hardcoded" &&
          REF_SINTETICO.test(valor)
        ) {
          continue;
        }

        achados.push({
          ficheiro: rel,
          linha: indice + 1,
          tipo: regra.tipo,
          gravidade: regra.gravidade,
          descricao: regra.descricao,
        });

        // Um achado por linha e por tipo chega para agir.
        break;
      }
    });
  }

  return achados;
}

/** Devolve `[]` para binários, sem os ler como texto. */
export function analisarFicheiro(rel, buffer) {
  if (ehBinario(buffer)) return [];
  return analisarConteudo(rel, buffer.toString("utf8"));
}

function ficheirosVersionados() {
  const saida = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return saida
    .split("\0")
    .filter(Boolean)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
}

function main() {
  const ficheiros = ficheirosVersionados();
  const achados = [];
  let binarios = 0;

  for (const rel of ficheiros) {
    const buffer = fs.readFileSync(path.join(ROOT, rel));

    if (ehBinario(buffer)) {
      binarios += 1;
      continue;
    }

    achados.push(...analisarConteudo(rel, buffer.toString("utf8")));
  }

  console.log(
    `Analisados ${ficheiros.length - binarios} ficheiros de texto versionados ` +
      `(${binarios} binários ignorados).`,
  );

  if (achados.length === 0) {
    console.log("✔ Nenhuma credencial encontrada.");
    return;
  }

  console.error(`\n❌ ${achados.length} achado(s):\n`);

  for (const a of achados) {
    // NUNCA o valor. Só onde está e o que é.
    console.error(`  [${a.gravidade}] ${a.ficheiro}:${a.linha} — ${a.descricao}`);
  }

  console.error(
    "\nUma credencial versionada tem de ser ROTACIONADA, não apenas apagada:\n" +
      "apagar o ficheiro não desativa a chave que já foi publicada.\n" +
      "Ver docs/PRODUCTION-RUNBOOK.md, secção 10.",
  );

  process.exitCode = 1;
}

// Só corre quando é invocado como programa, para os testes poderem importar as
// funções sem disparar a análise da árvore toda.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("scan-secrets.mjs")) {
  main();
}
