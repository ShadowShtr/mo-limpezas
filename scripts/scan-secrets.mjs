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
 *    transforma-se ele próprio numa fuga.
 * 2. Só olha para o que está versionado (`git ls-files`). O que o git ignora
 *    não é repositório — `.env.local` e afins ficam de fora por definição.
 * 3. Falha fechado: qualquer achado devolve código de saída 1.
 * 4. Fixtures sintéticas são permitidas quando declaradas — ver ALLOWLIST.
 *
 * Uso:
 *   npm run secrets:scan
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Extensões que vale a pena analisar. */
const EXTENSOES = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".sql",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".ps1",
  ".env",
  ".example",
]);

/**
 * Ficheiros onde um padrão é legítimo, com o motivo exigido.
 *
 * Não é uma lista de perdão genérico: cada entrada nomeia o tipo de risco que
 * se aceita naquele ficheiro, e mais nenhum.
 */
const ALLOWLIST = [
  {
    ficheiro: "scripts/scan-secrets.mjs",
    tipos: ["*"],
    motivo: "É o próprio detetor — contém os padrões que procura.",
  },
  {
    ficheiro: "src/__tests__/scan-secrets.test.ts",
    tipos: ["*"],
    motivo: "Testes do detetor, com fixtures sintéticas construídas no teste.",
  },
  {
    ficheiro: ".env.example",
    tipos: ["url-postgres", "atribuicao-service-role"],
    motivo: "Modelo de configuração, com marcadores e não valores.",
  },
  {
    ficheiro: "docs/PRODUCTION-RUNBOOK.md",
    tipos: ["url-postgres"],
    motivo: "Procedimento com marcadores <ref-...>, sem credenciais.",
  },
  {
    ficheiro: "docs/PLANO-MESTRE.md",
    tipos: ["url-postgres"],
    motivo: "Documento de planeamento, sem credenciais.",
  },
  {
    ficheiro: "src/__tests__/migration-runner-guards.test.ts",
    tipos: ["url-postgres", "url-supabase-hardcoded"],
    motivo:
      "Testa a extração de project ref a partir de URLs — tem de conter URLs. " +
      "Os refs e senhas são sintéticos, verificado em scan-secrets.test.ts.",
  },
  {
    ficheiro: "src/__tests__/audit.test.ts",
    tipos: ["senha-literal"],
    motivo:
      "Fixture do sanitizador de auditoria: prova que um campo `password` é " +
      "removido dos logs. O valor é a palavra 'segredo'.",
  },
];

/**
 * Um valor é considerado marcador (e não credencial) quando é claramente um
 * espaço reservado. Evita falsos positivos em documentação e exemplos.
 */
// `x{4,}` sem fronteira de palavra de propósito: um marcador escrito como
// `sb_secret_xxxxxxxx` não tem fronteira antes dos `x` (o `_` é caráter de
// palavra). Uma chave real com quatro `x` seguidos é possível mas improvável,
// e o custo do falso negativo é menor que o de o CI ficar vermelho por
// documentação — que levaria alguém a desligar o scanner.
const MARCADORES =
  /(<[^>]+>|\$\{[^}]+\}|x{4,}|\bYOUR_|\bSEU_|\bTEU_|\bexample\b|\bplaceholder\b|\bfake\b|ficti|sintetic|\bdummy\b|\bchangeme\b|\bREPLACE\b|\.\.\.)/i;

const REGRAS = [
  {
    tipo: "chave-secreta-supabase",
    gravidade: "critico",
    descricao: "Chave secreta do Supabase (sb_secret_) — ignora RLS",
    // Só conta se vier seguida de material que pareça mesmo uma chave.
    padrao: /sb_secret_[A-Za-z0-9_-]{8,}/,
  },
  {
    tipo: "token-supabase-pessoal",
    gravidade: "critico",
    descricao: "Token de acesso pessoal do Supabase (sbp_)",
    padrao: /\bsbp_[a-f0-9]{20,}/,
  },
  {
    tipo: "jwt-literal",
    gravidade: "critico",
    descricao: "JWT literal (pode ser service_role)",
    padrao: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    tipo: "atribuicao-service-role",
    gravidade: "critico",
    descricao: "SUPABASE_SERVICE_ROLE_KEY atribuída a um literal",
    padrao: /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/,
  },
  {
    tipo: "url-postgres",
    gravidade: "critico",
    descricao: "URL de ligação Postgres com credenciais",
    padrao: /postgresql:\/\/[^\s"'`:]+:[^\s"'`@]+@/,
  },
  {
    tipo: "senha-literal",
    gravidade: "critico",
    descricao: "Senha em texto simples",
    padrao: /\bpassword\s*[:=]\s*["'`][^"'`\s]{4,}["'`]/i,
  },
  {
    tipo: "url-supabase-hardcoded",
    gravidade: "alto",
    descricao: "URL de projeto Supabase escrita em código",
    padrao: /["'`]https:\/\/[a-z0-9]{12,}\.supabase\.co/,
    // Documentação pode citar o formato; o risco é em código executável.
    apenasEm: /\.(mjs|cjs|js|jsx|ts|tsx)$/,
  },
];

function ficheirosVersionados() {
  const saida = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return saida
    .split("\0")
    .filter(Boolean)
    .filter((rel) => {
      const ext = path.extname(rel).toLowerCase();
      return EXTENSOES.has(ext) || path.basename(rel).startsWith(".env");
    })
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
}

function permitido(rel, tipo) {
  return ALLOWLIST.some(
    (entrada) =>
      entrada.ficheiro === rel &&
      (entrada.tipos.includes("*") || entrada.tipos.includes(tipo)),
  );
}

export function analisarConteudo(rel, conteudo) {
  const achados = [];
  const linhas = conteudo.split(/\r?\n/);

  for (const regra of REGRAS) {
    if (regra.apenasEm && !regra.apenasEm.test(rel)) continue;
    if (permitido(rel, regra.tipo)) continue;

    linhas.forEach((linha, indice) => {
      if (!regra.padrao.test(linha)) return;
      // Um marcador não é uma credencial.
      if (MARCADORES.test(linha)) return;

      achados.push({
        ficheiro: rel,
        linha: indice + 1,
        tipo: regra.tipo,
        gravidade: regra.gravidade,
        descricao: regra.descricao,
      });
    });
  }

  return achados;
}

function main() {
  const ficheiros = ficheirosVersionados();
  const achados = [];

  for (const rel of ficheiros) {
    const conteudo = fs.readFileSync(path.join(ROOT, rel), "utf8");
    achados.push(...analisarConteudo(rel, conteudo));
  }

  console.log(`Analisados ${ficheiros.length} ficheiros versionados.`);

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
      "Ver docs/PRODUCTION-RUNBOOK.md.",
  );

  process.exitCode = 1;
}

// Só corre quando é invocado como programa, para os testes poderem importar
// `analisarConteudo` sem disparar a análise da árvore toda.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("scan-secrets.mjs")) {
  main();
}
