#!/usr/bin/env node
// ============================================================================
// GUARD — alteração visível exige uma release note NOVA
// ============================================================================
// Compara o diff real do PR contra a base. A versão anterior deste guard
// verificava apenas que a pasta existia e tinha pelo menos uma nota — o que
// significa que alterar quarenta ficheiros de UI sem escrever nada passava,
// porque a nota antiga continuava lá. Era verde por não verificar nada.
//
// Regras:
//
//   · mexer em `src/app/**` ou `src/components/**` exige um ficheiro NOVO em
//     `src/release-notes/`;
//   · modificar ou apagar uma nota existente é sempre erro — publicada, é
//     imutável: a `key` liga ao registo de leitura de cada perfil;
//   · uma nota que deixou de ser verdade **retira-se**, não se apaga: um
//     ficheiro novo em `src/release-note-withdrawals/` com a sua `key`. A
//     retirada é igualmente imutável, e **não** conta como nota nova — se o
//     comportamento mudou, quem usa o sistema tem direito a saber o que é
//     verdade agora, e uma retirada não diz nada a ninguém;
//   · `docs/**`, `reports/**` e `src/__tests__/**` não contam como visíveis.
//
// Não existe variável de ambiente que desligue isto. Um escape genérico
// transformaria o guard em decoração à primeira vez que alguém tivesse pressa.
//
// Uso:
//   node scripts/check-release-note.mjs                 (base = origin/master)
//   node scripts/check-release-note.mjs <base> <head>
// ============================================================================

import { execFileSync } from "node:child_process";

const RELEASE_DIR = "src/release-notes/";
const INDEX = "src/release-notes/index.ts";
const WITHDRAWAL_DIR = "src/release-note-withdrawals/";
const WITHDRAWAL_INDEX = "src/release-note-withdrawals/index.ts";

/** Superfícies cuja alteração se vê no ecrã. */
const AREAS_VISIVEIS = ["src/app/", "src/components/"];

/** Sem superfície de utilizador — alterar isto não muda nada no ecrã. */
const EXCLUIDAS = ["src/__tests__/", "docs/", "reports/"];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function classificar(ficheiros) {
  const visiveis = [];
  const notasNovas = [];
  const notasAlteradas = [];
  const retiradasAlteradas = [];

  for (const { status, path } of ficheiros) {
    if (path.startsWith(RELEASE_DIR)) {
      // `index.ts` só agrega — mexer nele não é escrever uma nota.
      if (path === INDEX) continue;
      if (status === "A") notasNovas.push(path);
      else notasAlteradas.push(`${status} ${path}`);
      continue;
    }

    if (path.startsWith(WITHDRAWAL_DIR)) {
      // 🔴 Uma retirada nova é permitida e **não** entra em `notasNovas`:
      //    retirar um aviso não é anunciar nada. Depois de criada é tão
      //    imutável quanto a nota que retira.
      if (path === WITHDRAWAL_INDEX) continue;
      if (status !== "A") retiradasAlteradas.push(`${status} ${path}`);
      continue;
    }

    if (EXCLUIDAS.some((e) => path.startsWith(e))) continue;
    if (AREAS_VISIVEIS.some((a) => path.startsWith(a))) visiveis.push(`${status} ${path}`);
  }

  const problemas = [];

  if (retiradasAlteradas.length > 0) {
    problemas.push(
      "Uma retirada é imutável como a nota que retira — desfazê-la faz o aviso " +
        "reaparecer a quem já não devia recebê-lo, e apagá-la perde o registo de " +
        "que a nota deixou de ser verdade:\n  " +
        retiradasAlteradas.join("\n  "),
    );
  }

  if (notasAlteradas.length > 0) {
    problemas.push(
      "Uma release note publicada é imutável — a sua `key` liga ao registo de " +
        "leitura de cada perfil. Mudá-la faz o aviso reaparecer a quem já o viu:\n  " +
        notasAlteradas.join("\n  "),
    );
  }

  if (visiveis.length > 0 && notasNovas.length === 0) {
    problemas.push(
      `${visiveis.length} ficheiro(s) visíveis alterados sem nenhuma release note nova.\n  ` +
        visiveis.slice(0, 12).join("\n  ") +
        (visiveis.length > 12 ? `\n  … e mais ${visiveis.length - 12}` : "") +
        `\n\nAcrescenta um ficheiro em ${RELEASE_DIR} a dizer o que mudou, em ` +
        "linguagem de quem usa o sistema.",
    );
  }

  return { visiveis, notasNovas, notasAlteradas, retiradasAlteradas, problemas };
}

export function lerDiff(base, head) {
  const saida = git(["diff", "--name-status", `${base}...${head}`]);
  if (!saida) return [];
  return saida.split("\n").map((linha) => {
    const [status, ...resto] = linha.split("\t");
    return { status: status[0], path: resto[resto.length - 1] };
  });
}

function main() {
  const base = process.argv[2] ?? process.env.BASE_SHA ?? "origin/master";
  const head = process.argv[3] ?? "HEAD";

  let ficheiros;
  try {
    ficheiros = lerDiff(base, head);
  } catch (e) {
    // 🔴 Não conseguir comparar é falha, nunca passe silencioso. Um guard que
    //    devolve verde quando não sabe é pior do que não existir.
    console.error(`❌ Não foi possível comparar ${base}...${head}: ${e.message}`);
    console.error("   O CI precisa de `fetch-depth: 0` para ter a base disponível.");
    process.exit(1);
  }

  const { visiveis, notasNovas, problemas } = classificar(ficheiros);

  if (problemas.length > 0) {
    console.error("❌ USER_VISIBLE_CHANGE_WITHOUT_RELEASE_NOTE\n");
    for (const p of problemas) console.error(`   ${p}\n`);
    process.exit(1);
  }

  if (visiveis.length === 0) {
    console.log("✔ Sem alterações visíveis para o utilizador — release note não é exigida.");
  } else {
    console.log(`✔ ${visiveis.length} ficheiro(s) visíveis, com ${notasNovas.length} release note(s) nova(s):`);
    for (const n of notasNovas) console.log(`   ${n}`);
  }
}

// Só corre como CLI; os testes importam `classificar` e `lerDiff`.
if (process.argv[1] && process.argv[1].endsWith("check-release-note.mjs")) main();
