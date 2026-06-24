// Carimba a versão da cache do service worker em cada build de deploy.
// Só corre em ambiente de build remoto (Vercel/CI) — localmente o sw.js mantém
// "mo-limpezas-dev" para não sujar a working tree.
//
// Cada deploy fica com um valor ÚNICO (timestamp), o que:
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
const version = `${Date.now().toString(36)}${sha ? "-" + sha : ""}`;

const src = readFileSync(swPath, "utf8");
const next = src.replace(/const CACHE = "mo-limpezas-[^"]*";/, `const CACHE = "mo-limpezas-${version}";`);

if (next === src) {
  console.warn("[stamp-sw] não encontrei a linha do CACHE — sw.js inalterado.");
} else {
  writeFileSync(swPath, next);
  console.log(`[stamp-sw] cache carimbada: mo-limpezas-${version}`);
}
