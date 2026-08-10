/**
 * Acesso administrativo à base para scripts — o **único** caminho permitido.
 *
 * Substitui os sete parsers de `.env.local` escritos à mão que a T17-B1
 * encontrou espalhados por `scripts/`. Cada um deles construía um cliente com a
 * chave administrativa a partir do que quer que estivesse no ficheiro, sem
 * dizer para onde apontava e sem nada que travasse uma escrita em produção.
 *
 * A decisão de correr, e em que modo, é tomada pelo módulo puro
 * `admin-script-guard.mjs`. Este ficheiro só faz o I/O e obedece.
 *
 * ---------------------------------------------------------------------------
 * Uso
 * ---------------------------------------------------------------------------
 *
 *   import { openAdminDb } from "./lib/admin-db.mjs";
 *
 *   const db = await openAdminDb({
 *     script: "fix-num-people.mjs",
 *     purpose: "corrigir num_people em serviços e contratos",
 *     writes: true,
 *   });
 *
 *   const { data } = await db.sb.from("services").select("id").eq("company_id", db.companyId);
 *
 *   await db.write("services", (sb) => sb.update({ num_people: 2 }).eq("id", id));
 *
 *   db.summary();
 *
 * Em dry-run (o modo por omissão) `db.write` **não chama a base**: regista a
 * intenção e devolve-a. O script corre do princípio ao fim e mostra o que faria.
 *
 * ---------------------------------------------------------------------------
 * Linha de comandos comum a todos os scripts
 * ---------------------------------------------------------------------------
 *
 *   --project-ref <ref>    OBRIGATÓRIO. Tem de coincidir com o alvo real.
 *   --company-id <uuid>    Obrigatório para escrever.
 *   --apply                Escreve. Sem isto é dry-run.
 *   --i-am-authorized-to-write-to-production
 *                          Só com autorização explícita do proprietário na
 *                          tarefa atual (AGENTS.md, REGRA ZERO).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { parseCommonArgs, resolveAdminScriptGuard, FLAGS } from "./admin-script-guard.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Lê `.env.local` — um único sítio, em vez de sete parsers com regras
 * ligeiramente diferentes.
 *
 * Não usa `dotenv` de propósito: `dotenv` injecta em `process.env`, e um script
 * que leia `process.env.SUPABASE_SERVICE_ROLE_KEY` directamente volta a escapar
 * ao guard. Aqui os valores ficam num objecto local, que só o guard vê.
 */
export function loadEnvFile(ficheiro = ".env.local") {
  const caminho = path.join(RAIZ, ficheiro);
  if (!fs.existsSync(caminho)) return {};

  const env = {};
  for (const linha of fs.readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const texto = linha.trim();
    if (!texto || texto.startsWith("#")) continue;
    const m = texto.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return env;
}

function abortar(script, mensagem) {
  console.error(`\n🔴 ${script} — RECUSADO\n`);
  console.error(`   ${String(mensagem).split("\n").join("\n   ")}\n`);
  process.exit(1);
}

/**
 * Abre o acesso administrativo, ou desiste.
 *
 * Nunca devolve um cliente sem antes ter impresso contra que projecto se vai
 * trabalhar e em que modo. O ecrã é parte da guarda: o objectivo é que seja
 * impossível correr um destes scripts e ficar sem saber onde se mexeu.
 */
export async function openAdminDb({
  script,
  purpose,
  writes = false,
  requiresCompanyId = true,
  argv = process.argv.slice(2),
}) {
  const env = loadEnvFile();
  const args = parseCommonArgs(argv);

  const veredito = resolveAdminScriptGuard({
    script,
    writes,
    requiresCompanyId,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    productionRef: env.MO_PRODUCTION_PROJECT_REF ?? process.env.MO_PRODUCTION_PROJECT_REF,
    args,
  });

  if (!veredito.ok) abortar(script, veredito.error);

  // O projecto-alvo é impresso SEMPRE, antes de qualquer trabalho. Nunca a
  // chave, nunca a URL completa — o ref chega para identificar, e não é segredo.
  const modo = veredito.mode === "apply" ? "APLICAR (escreve na base)" : "DRY-RUN (nada é escrito)";
  console.error("");
  console.error("┌─────────────────────────────────────────────────────────────");
  console.error(`│ ${script}`);
  if (purpose) console.error(`│ ${purpose}`);
  console.error("├─────────────────────────────────────────────────────────────");
  console.error(`│ Projeto alvo : ${veredito.targetRef}${veredito.targetIsProduction ? "   ⚠️  PRODUÇÃO" : ""}`);
  console.error(`│ Empresa      : ${veredito.companyId ?? "— (script global)"}`);
  console.error(`│ Modo         : ${modo}`);
  console.error("└─────────────────────────────────────────────────────────────");
  for (const aviso of veredito.warnings) console.error(`  ⚠️  ${aviso}`);
  if (veredito.mode === "dry-run" && writes) {
    console.error(`  ℹ️  Para escrever mesmo: ${FLAGS.apply}`);
  }
  console.error("");

  const sb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const apply = veredito.mode === "apply";
  const planeado = [];
  let escritas = 0;
  let falhas = 0;

  const restBase = `${(env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "")}/rest/v1`;
  const chave = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const restHeaders = {
    apikey: chave,
    Authorization: `Bearer ${chave}`,
    "Content-Type": "application/json",
  };

  return {
    sb,
    apply,
    dryRun: !apply,
    companyId: veredito.companyId,
    targetRef: veredito.targetRef,
    args,
    rest: args.rest,

    /**
     * Executa uma escrita — ou, em dry-run, apenas a regista.
     *
     * `construir` recebe o builder já apontado à tabela, para o script não ter
     * de repetir `db.sb.from(...)` e para haver um sítio único onde a escrita
     * passa. O erro **nunca** é ignorado: foi o padrão que a T17-B1 contou 268
     * vezes no código da aplicação, e não se repete aqui.
     */
    async write(tabela, construir, descricao) {
      const rotulo = descricao ?? tabela;
      if (!apply) {
        planeado.push(rotulo);
        console.error(`  [dry-run] escreveria: ${rotulo}`);
        return { ok: true, dryRun: true, data: null };
      }
      const { data, error } = await construir(sb.from(tabela));
      if (error) {
        falhas += 1;
        console.error(`  ❌ ${rotulo}: ${error.message}`);
        return { ok: false, error, data: null };
      }
      escritas += 1;
      return { ok: true, dryRun: false, data };
    },

    /**
     * Leitura pela API REST, para scripts que falam HTTP em vez do SDK.
     *
     * Existe porque `import-predios.mjs` — o script que a T17-B1 apanhou
     * classificado como só-leitura quando na verdade escrevia — chega à base
     * por HTTP. Sem um caminho REST no helper, ficaria de fora da guarda, que
     * é exactamente como o problema começou.
     */
    async restRead(caminho) {
      const res = await fetch(`${restBase}/${caminho}`, { headers: restHeaders });
      if (!res.ok) {
        throw new Error(`GET ${caminho.split("?")[0]} → HTTP ${res.status}`);
      }
      return res.json();
    },

    /** Escrita pela API REST. Respeita o dry-run, como `write`. */
    async restWrite(caminho, init, descricao) {
      const rotulo = descricao ?? `${init?.method ?? "POST"} ${caminho.split("?")[0]}`;
      if (!apply) {
        planeado.push(rotulo);
        console.error(`  [dry-run] escreveria: ${rotulo}`);
        return { ok: true, dryRun: true, data: null };
      }
      const res = await fetch(`${restBase}/${caminho}`, {
        ...init,
        method: init?.method ?? "POST",
        headers: { ...restHeaders, ...(init?.headers ?? {}) },
      });
      if (!res.ok) {
        falhas += 1;
        const corpo = await res.text().catch(() => "");
        console.error(`  ❌ ${rotulo}: HTTP ${res.status} ${corpo.slice(0, 200)}`);
        return { ok: false, error: new Error(`HTTP ${res.status}`), data: null };
      }
      escritas += 1;
      const texto = await res.text();
      return { ok: true, dryRun: false, data: texto ? JSON.parse(texto) : null };
    },

    /** Fecho legível. Em dry-run diz exactamente o que teria acontecido. */
    summary() {
      console.error("");
      if (!apply) {
        console.error(`  DRY-RUN concluído — ${planeado.length} escrita(s) planeada(s), nenhuma executada.`);
        console.error(`  Confirma os números e volta a correr com ${FLAGS.apply}.`);
      } else {
        console.error(`  ✅ ${escritas} escrita(s) em "${veredito.targetRef}"${falhas ? `, ${falhas} falha(s)` : ""}.`);
      }
      console.error("");
      return { escritas, falhas, planeadas: planeado.length };
    },
  };
}
