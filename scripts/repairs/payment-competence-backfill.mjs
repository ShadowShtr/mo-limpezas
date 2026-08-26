#!/usr/bin/env node
// ============================================================================
// CLI da reparação de competência dos pagamentos
// ============================================================================
//
// Por omissão faz DRY-RUN. Escrever exige quatro flags em conjunto:
//
//   node scripts/repairs/payment-competence-backfill.mjs \
//     --apply --manifest <ficheiro> --manifest-sha <sha256> \
//     --confirm-production <project-ref>
//
// Gerar um manifesto novo (só leitura):
//
//   node scripts/repairs/payment-competence-backfill.mjs --snapshot <ficheiro>
//
// ---------------------------------------------------------------------------
// Segredos
// ---------------------------------------------------------------------------
//
// 🔴 Este ficheiro nunca imprime a connection string, nem parte dela, nem o
//    conteúdo do `.env.local`. Numa ronda anterior um diagnóstico assumiu que
//    todas as linhas do `.env.local` eram `CHAVE=valor`, imprimiu uma linha
//    inteira que não era, e expôs uma password. O parser abaixo ignora por
//    construção qualquer linha sem `=`, e toda a mensagem de erro passa por
//    `sanitizar()` antes de chegar ao ecrã.
// ============================================================================

import pg from "pg";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs, runBackfill, sanitizar, competenceFromDueDate, UPDATE_FIELD_WHITELIST,
  verificarHashManifesto,
} from "./lib/competence-backfill-core.mjs";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Lê `.env` aceitando apenas `CHAVE=valor`. Linhas soltas são ignoradas. */
function lerEnv(ficheiro) {
  const env = {};
  if (!fs.existsSync(ficheiro)) return env;
  for (const linha of fs.readFileSync(ficheiro, "utf8").split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (!/^[A-Z0-9_]+$/i.test(k)) continue;
    env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const sha256 = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");

/**
 * Identifica o alvo da ligação: produção (Supabase) ou ensaio (descartável).
 *
 * 🔴 As duas formas são deliberadamente distintas e nunca se confundem. Um
 *    host Supabase só pode ser confirmado com o seu project ref; um host que
 *    não seja Supabase só pode ser confirmado com a palavra literal
 *    `ENSAIO-DESCARTAVEL`, e só quando a URL foi passada à mão com
 *    `--database-url`. Não há caminho em que uma escreva com a confirmação da
 *    outra.
 */
function identificarAlvo(url, veioDeFlag) {
  let u;
  try { u = new URL(url); } catch { return { kind: "desconhecido", ref: null }; }

  const supabase = /supabase\.(co|com)$/i.test(u.hostname) || /pooler\.supabase\.com$/i.test(u.hostname);
  if (supabase) {
    if (u.username.includes(".")) return { kind: "producao", ref: u.username.split(".").slice(1).join(".") };
    const m = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(u.hostname);
    return { kind: "producao", ref: m ? m[1] : null };
  }
  // Só é ensaio se alguém escreveu a URL na linha de comando de propósito.
  if (!veioDeFlag) return { kind: "desconhecido", ref: null };
  return { kind: "ensaio", ref: "ENSAIO-DESCARTAVEL" };
}

const log = (m) => console.log(m);
const logErro = (m) => console.error(m);

async function principal() {
  const r = parseArgs(process.argv.slice(2));
  if (!r.ok) { logErro("❌ " + r.error); process.exit(1); }
  const args = r.args;

  const env = { ...lerEnv(path.join(RAIZ, ".env.local")), ...process.env };
  const url = args.databaseUrl || env.SUPABASE_DB_URL || env.DATABASE_URL;
  if (!url) {
    logErro("❌ Falta SUPABASE_DB_URL no .env.local (ligação Postgres direta, não PostgREST).");
    process.exit(1);
  }

  // 🔴 O alvo é identificado ANTES de ligar, e é ele que decide o SSL.
  //
  //    Produção (Supabase) liga sempre com SSL. Um Postgres descartável local
  //    não o suporta — mas só se chega a esse ramo com `--database-url`
  //    escrito à mão e um host que não é Supabase. Não há forma de a ligação
  //    de produção perder o SSL por causa deste ramo.
  const alvo = identificarAlvo(url, Boolean(args.databaseUrl));
  const client = new pg.Client({
    connectionString: url,
    ssl: alvo.kind === "ensaio" ? false : { rejectUnauthorized: false },
    statement_timeout: 60000,
  });
  try {
    await client.connect();
  } catch (err) {
    logErro("❌ Ligação falhou: " + sanitizar(err.message));
    process.exit(1);
  }

  try {
    // ── Modo snapshot: só leitura, produz o manifesto ───────────────────────
    if (args.snapshot) {
      const q = await client.query(
        `SELECT id, company_id, description, due_date::text AS due_date,
                amount::text AS amount, status, paid_at::text AS paid_at,
                period_year, period_month, attachment_url, attachment_name,
                attachment_size, attachment_mime, updated_at::text AS updated_at
         FROM public.fixed_variable_payments ORDER BY id`);

      const caixa = await client.query(
        `SELECT id, reference_id, date, amount FROM public.cash_flow_entries
         WHERE reference_type = 'fixed_variable_payment'`);
      const porPagamento = new Map(caixa.rows.map((x) => [x.reference_id, x]));

      const manifesto = [];
      let semVencimento = 0;
      const ilegiveis = [];
      for (const p of q.rows) {
        // 🔴 "não tem data" e "tem uma data que não consigo ler" são coisas
        //    diferentes. A primeira é normal (IVA, Segurança Social, rendas);
        //    a segunda é corrupção, e passar por cima dela em silêncio era como
        //    o defeito original nascia. Uma aborta o snapshot.
        if (p.due_date === null || p.due_date === undefined) { semVencimento++; continue; }
        const alvo = competenceFromDueDate(p.due_date);
        if (!alvo) { ilegiveis.push(p.id); continue; }
        if (alvo.year === p.period_year && alvo.month === p.period_month) continue;
        manifesto.push({
          payment_id: p.id, company_id: p.company_id, due_date: p.due_date,
          before_period_year: p.period_year, before_period_month: p.period_month,
          after_period_year: alvo.year, after_period_month: alvo.month,
          status: p.status, paid_at: p.paid_at, amount: p.amount, updated_at: p.updated_at,
          attachment: { url: p.attachment_url, name: p.attachment_name, size: p.attachment_size, mime: p.attachment_mime },
          cashflow: porPagamento.get(p.id)
            ? { id: porPagamento.get(p.id).id, date: porPagamento.get(p.id).date, amount: porPagamento.get(p.id).amount }
            : null,
          reason: "DUE_DATE_MONTH_MISMATCH",
        });
      }

      const rollback = manifesto.map((l) => ({
        payment_id: l.payment_id,
        restore_period_year: l.before_period_year,
        restore_period_month: l.before_period_month,
      }));

      if (ilegiveis.length > 0) {
        logErro(`❌ ${ilegiveis.length} pagamento(s) com due_date presente mas ilegível — snapshot abortado.`);
        for (const id of ilegiveis.slice(0, 10)) logErro("   " + id);
        return 1;
      }

      fs.writeFileSync(args.snapshot, JSON.stringify(manifesto, null, 2), "utf8");
      const alvoRollback = args.snapshot.replace(/\.json$/, "") + ".rollback.json";
      fs.writeFileSync(alvoRollback, JSON.stringify(rollback, null, 2), "utf8");

      log("ROWS_SCANNED             = " + q.rows.length);
      log("ROWS_WITHOUT_DUE_DATE    = " + semVencimento);
      log("MANIFEST_ROW_COUNT       = " + manifesto.length);
      log("MANIFEST_SHA256          = " + sha256(manifesto));
      log("ROLLBACK_MANIFEST_SHA256 = " + sha256(rollback));
      log("SNAPSHOT_WRITES          = 0");
      return 0;
    }

    // ── Dry-run / apply exigem manifesto ────────────────────────────────────
    if (!args.manifest) {
      logErro("❌ Falta --manifest. Gera um com --snapshot <ficheiro> primeiro.");
      return 1;
    }
    const manifesto = JSON.parse(fs.readFileSync(args.manifest, "utf8"));

    // 🔴 O hash é um portão, não um rótulo. Um ficheiro com o nome certo e o
    //    conteúdo trocado é exatamente o cenário que isto recusa.
    if (args.manifestSha || args.apply) {
      const h = verificarHashManifesto(manifesto, args.manifestSha, sha256);
      if (!h.ok) {
        logErro("❌ " + h.error);
        if (h.real) { logErro("   esperado: " + args.manifestSha); logErro("   real    : " + h.real); }
        return 1;
      }
      log("MANIFEST_HASH_GUARD = OK");
    }

    log("TARGET_KIND            = " + alvo.kind);
    if (args.apply && alvo.kind === "desconhecido") {
      logErro("❌ TARGET_UNIDENTIFIED — alvo não reconhecido. Para um ensaio, passa --database-url explicitamente.");
      return 1;
    }
    const res = await runBackfill({
      client, manifesto, apply: args.apply,
      projectRefEsperado: alvo.ref, confirmProduction: args.confirmProduction,
      log, logErro,
    });

    log("");
    log("UPDATE_FIELD_WHITELIST = " + UPDATE_FIELD_WHITELIST.join(","));
    log("WRITES                 = " + res.writes);
    return res.exitCode;
  } catch (err) {
    logErro("❌ " + sanitizar(err.message));
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

process.exit(await principal());
