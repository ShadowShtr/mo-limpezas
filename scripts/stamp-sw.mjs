// Carimba a versão da cache do service worker em cada build de deploy.
// Só corre em ambiente de build remoto (Vercel/CI) — localmente o sw.js mantém
// "mo-limpezas-dev" para não sujar a working tree.
//
// 2026-08-05 (correção de bug real de produção — aviso de atualização do PWA
// repetia-se sem necessidade): a versão anterior usava `Date.now()`, o que
// dava uma versão NOVA a cada build/redeploy mesmo sem nenhuma alteração de
// código — o browser via isso como "há sempre uma atualização" e mostrava o
// aviso "Atualizar" repetidamente, mesmo entre deploys idênticos. Agora a
// versão é exatamente o SHA do commit (VERCEL_GIT_COMMIT_SHA, os mesmos 7
// caracteres já usados nos logs/PRs desta sessão) — só muda quando entra
// código novo em produção, que é exatamente quando o aviso deve aparecer.
//
// Cada commit novo em produção fica com um valor ÚNICO (o seu SHA), o que:
//   1. purga a cache antiga na ativação do novo service worker;
//   2. faz o browser detetar o sw.js como alterado -> dispara o aviso "Atualizar".

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const onBuildServer = process.env.VERCEL || process.env.CI;
if (!onBuildServer) {
  console.log("[stamp-sw] ambiente local — mantém 'mo-limpezas-dev'.");
  process.exit(0);
}

const swPath = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js");
const sha = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7);

if (!sha) {
  // Nunca cair de volta para Date.now() — isso é exatamente o bug que esta
  // mudança corrige. Sem SHA disponível, o build segue com o CACHE que já
  // estava no ficheiro (não estampa nada de novo) e avisa nos logs.
  console.warn("[stamp-sw] VERCEL_GIT_COMMIT_SHA não definido — sw.js mantido sem novo carimbo.");
  process.exit(0);
}

const version = sha;
const src = readFileSync(swPath, "utf8");
const next = src.replace(/const CACHE = "mo-limpezas-[^"]*";/, `const CACHE = "mo-limpezas-${version}";`);

if (next === src) {
  console.warn("[stamp-sw] não encontrei a linha do CACHE — sw.js inalterado.");
} else {
  writeFileSync(swPath, next);
  console.log(`[stamp-sw] cache carimbada: mo-limpezas-${version}`);
}
