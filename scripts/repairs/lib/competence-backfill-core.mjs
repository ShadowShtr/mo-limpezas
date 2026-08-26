// ============================================================================
// REPARAÇÃO — competência dos pagamentos, alinhada ao vencimento
// ============================================================================
//
// 🔴 Isto escreve em dados financeiros reais. Leia antes de mexer.
//
// O que corrige: 29 pagamentos gravados com `period_year`/`period_month` do mês
// que estava aberto no ecrã, em vez do mês do vencimento. A causa foi corrigida
// no código pela #77; isto é a água que já tinha caído no chão.
//
// ---------------------------------------------------------------------------
// Porque é que é tudo-ou-nada
// ---------------------------------------------------------------------------
//
// Um lote parcial — 28 movidas, 1 saltada — deixaria o Financeiro num estado
// que ninguém pediu e que é pior do que o defeito: metade dos meses corrigidos,
// metade não, e nenhuma forma de saber qual sem reler tudo. Por isso não existe
// "skip e continua". Se uma linha divergir do manifesto, nada é escrito.
//
// ---------------------------------------------------------------------------
// O que pode mudar, e o que não pode
// ---------------------------------------------------------------------------
//
//   pode mudar:  period_year, period_month
//   não pode:    tudo o resto
//
// O `UPDATE` é construído campo a campo, nunca por espalhamento do objeto lido.
// Espalhar seria a forma mais fácil de, um dia, arrastar um `amount` ou um
// `paid_at` sem ninguém reparar.
//
// A caixa é intocável por desenho: este ficheiro nunca escreve em
// `cash_flow_entries`. Competência é o mês a que a obrigação pertence; caixa é
// o dia em que o dinheiro saiu. São coisas diferentes, e uma delas já está
// certa.
// ============================================================================

export const UPDATE_FIELD_WHITELIST = Object.freeze(["period_year", "period_month"]);

/** Campos que têm de estar iguais ao manifesto, antes e depois. */
export const PROTECTED_FIELDS = Object.freeze([
  "company_id", "due_date", "amount", "status", "paid_at", "updated_at",
  "attachment_url", "attachment_name", "attachment_size", "attachment_mime",
]);

/**
 * Mês civil de uma data `YYYY-MM-DD`.
 *
 * 🔴 Nunca `new Date(due_date)`: em Lisboa, no verão, `"2026-08-01"` lido como
 *    instante UTC e convertido para local devolve 31 de julho. Um pagamento
 *    saltaria de mês por causa do fuso horário.
 */
export function competenceFromDueDate(dueDate) {
  if (typeof dueDate !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate.trim());
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return { year, month };
}

const chave = (c) => `${c.year}-${String(c.month).padStart(2, "0")}`;

/** Normaliza para comparação: `null` e `undefined` são a mesma ausência. */
const igual = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
};

/** Remove qualquer connection string de uma mensagem antes de a mostrar. */
export function sanitizar(mensagem) {
  return String(mensagem ?? "").replace(/postgres(ql)?:\/\/\S+/gi, "<URL OMITIDA>");
}

// ─── Argumentos ──────────────────────────────────────────────────────────────

/**
 * 🔴 `--apply` sozinho não chega, de propósito.
 *
 *    Escrever exige as quatro em conjunto: o modo, o manifesto, o hash desse
 *    manifesto e o projeto confirmado à mão. Cada uma sozinha é fácil de
 *    escrever por engano numa linha de comando; as quatro juntas não.
 */
export function parseArgs(argv) {
  const out = { apply: false, manifest: null, manifestSha: null, confirmProduction: null, snapshot: null };
  const conhecidas = new Set(["--apply", "--manifest", "--manifest-sha", "--confirm-production", "--snapshot"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!conhecidas.has(a)) return { ok: false, error: `Flag desconhecida: ${a}` };
    if (a === "--apply") { out.apply = true; continue; }
    const valor = argv[i + 1];
    // Uma flag seguida de outra flag é quase sempre um valor esquecido.
    if (valor === undefined || valor.startsWith("--")) {
      return { ok: false, error: `${a} exige um valor.` };
    }
    if (a === "--manifest") out.manifest = valor;
    if (a === "--manifest-sha") out.manifestSha = valor;
    if (a === "--confirm-production") out.confirmProduction = valor;
    if (a === "--snapshot") out.snapshot = valor;
    i++;
  }

  if (out.apply) {
    const falta = [];
    if (!out.manifest) falta.push("--manifest");
    if (!out.manifestSha) falta.push("--manifest-sha");
    if (!out.confirmProduction) falta.push("--confirm-production");
    if (falta.length) {
      return { ok: false, error: `--apply exige também ${falta.join(", ")}. Sem elas, nada é escrito.` };
    }
  }
  return { ok: true, args: out };
}

/**
 * O manifesto no disco é o que foi autorizado?
 *
 * 🔴 O hash é um portão, não um rótulo. Um ficheiro com o nome certo e o
 *    conteúdo trocado — editado à mão, ou regenerado depois da autorização —
 *    passaria por qualquer verificação que olhasse só para o caminho.
 *
 *    Vive aqui, e não no CLI, para poder ser exercitado por um teste. Enquanto
 *    esteve só no CLI, remover o portão não fazia nenhum teste ficar vermelho.
 */
export function verificarHashManifesto(manifesto, shaEsperado, calcularSha) {
  if (!shaEsperado) return { ok: false, error: "MANIFEST_SHA_REQUIRED — escrever exige --manifest-sha." };
  const real = calcularSha(manifesto);
  if (real !== shaEsperado) {
    return { ok: false, error: "MANIFEST_SHA_MISMATCH — o manifesto no disco não é o que foi autorizado.", real };
  }
  return { ok: true, real };
}

// ─── Validações ──────────────────────────────────────────────────────────────

/** O manifesto descreve mesmo o que diz descrever? */
export function validarManifesto(linhas) {
  if (!Array.isArray(linhas)) return { ok: false, error: "Manifesto tem de ser uma lista." };
  if (linhas.length === 0) return { ok: false, error: "Manifesto vazio — nada a fazer." };

  const vistos = new Set();
  for (const l of linhas) {
    if (!l || typeof l !== "object") return { ok: false, error: "Entrada de manifesto não é um objeto." };
    if (typeof l.payment_id !== "string" || !l.payment_id) return { ok: false, error: "Entrada sem payment_id." };
    if (vistos.has(l.payment_id)) return { ok: false, error: `payment_id repetido no manifesto: ${l.payment_id}` };
    vistos.add(l.payment_id);

    const derivada = competenceFromDueDate(l.due_date);
    if (!derivada) return { ok: false, error: `due_date inválida ou ausente em ${l.payment_id} — nunca candidata.` };

    if (derivada.year !== l.after_period_year || derivada.month !== l.after_period_month) {
      return { ok: false, error: `after_* não corresponde ao vencimento em ${l.payment_id}.` };
    }
    if (derivada.year === l.before_period_year && derivada.month === l.before_period_month) {
      return { ok: false, error: `${l.payment_id} já está no mês certo — não devia estar no manifesto.` };
    }
  }
  return { ok: true };
}

/**
 * Onde vive, no manifesto, o valor esperado para um campo da linha.
 *
 * Os campos de anexo estão aninhados em `attachment`; os restantes são planos.
 * Uma só função para as duas leituras — a comparação de antes e a pós-condição
 * têm de concordar, e enquanto estavam escritas separadamente divergiam.
 */
function valorEsperado(esperado, campo) {
  return campo.startsWith("attachment_")
    ? esperado.attachment?.[campo.replace("attachment_", "")]
    : esperado[campo];
}

/** Uma linha lida da base bate certo com o que o manifesto diz dela? */
export function compararComManifesto(linha, esperado) {
  const difs = [];
  if (Number(linha.period_year) !== Number(esperado.before_period_year)) difs.push("period_year");
  if (Number(linha.period_month) !== Number(esperado.before_period_month)) difs.push("period_month");
  for (const campo of PROTECTED_FIELDS) {
    if (!igual(linha[campo], valorEsperado(esperado, campo))) difs.push(campo);
  }
  return difs;
}

/** Algum dos meses envolvidos está fechado? */
export function periodosFechadosEnvolvidos(manifesto, periodos) {
  if (!Array.isArray(periodos) || periodos.length === 0) return [];
  const fechado = new Set();
  for (const p of periodos) {
    const st = String(p.status ?? "").toLowerCase();
    const trancado = p.closed_at != null || st === "fechado" || st === "closed" || p.is_closed === true;
    if (trancado) fechado.add(`${p.year ?? p.period_year}-${String(p.month ?? p.period_month).padStart(2, "0")}`);
  }
  const colisoes = [];
  for (const l of manifesto) {
    const origem = chave({ year: l.before_period_year, month: l.before_period_month });
    const destino = chave({ year: l.after_period_year, month: l.after_period_month });
    if (fechado.has(origem)) colisoes.push({ payment_id: l.payment_id, mes: origem, lado: "origem" });
    if (fechado.has(destino)) colisoes.push({ payment_id: l.payment_id, mes: destino, lado: "destino" });
  }
  return colisoes;
}

// ─── Núcleo ──────────────────────────────────────────────────────────────────

// 🔴 `due_date` e `paid_at` vêm como texto, de propósito.
//
//    O node-postgres converte colunas `date`/`timestamptz` em objetos `Date`.
//    A primeira versão disto comparava esse `Date` com a string do manifesto e
//    com `competenceFromDueDate`, que só aceita string — resultado: zero
//    candidatos, silenciosamente, como se não houvesse nada a corrigir. Só se
//    apanhou porque havia uma contagem independente para comparar.
//
//    Pedir o texto à base tira o `Date` do caminho e faz a comparação ser
//    entre o que está gravado e o que o manifesto diz, sem conversões pelo meio.
const SELECT_COLS =
  "id, company_id, due_date::text AS due_date, amount::text AS amount, status, " +
  "paid_at::text AS paid_at, period_year, period_month, " +
  "attachment_url, attachment_name, attachment_size, attachment_mime, " +
  "updated_at::text AS updated_at";

/**
 * Corre a reparação. Sem `apply`, não abre transação de escrita nem envia
 * `UPDATE` — valida tudo e diz o que faria.
 */
export async function runBackfill({
  client, manifesto, apply = false, projectRefEsperado = null, confirmProduction = null,
  log = () => {}, logErro = () => {},
}) {
  const v = validarManifesto(manifesto);
  if (!v.ok) { logErro("❌ MANIFESTO_INVALIDO: " + v.error); return { exitCode: 1, writes: 0 }; }

  if (apply && projectRefEsperado && confirmProduction !== projectRefEsperado) {
    logErro("❌ CONFIRM_PRODUCTION_MISMATCH — o project ref confirmado não é o da ligação. Nada foi escrito.");
    return { exitCode: 1, writes: 0 };
  }

  const ids = manifesto.map((l) => l.payment_id);

  // ── Períodos fechados ─────────────────────────────────────────────────────
  let periodos = [];
  try {
    const r = await client.query("SELECT * FROM public.financial_periods");
    periodos = r.rows ?? [];
  } catch {
    // A tabela pode não existir num ambiente de teste; ausência não é fecho.
    periodos = [];
  }
  const colisoes = periodosFechadosEnvolvidos(manifesto, periodos);
  if (colisoes.length > 0) {
    logErro(`❌ CLOSED_PERIOD_INTERSECTION — ${colisoes.length} colisão(ões) com período fechado. Nada foi escrito.`);
    for (const c of colisoes.slice(0, 10)) logErro(`   ${c.payment_id} · ${c.mes} (${c.lado})`);
    return { exitCode: 1, writes: 0, closedPeriodCollisions: colisoes.length };
  }

  // ── Sem --apply: valida e sai, sem abrir transação ────────────────────────
  if (!apply) {
    const r = await client.query(`SELECT ${SELECT_COLS} FROM public.fixed_variable_payments WHERE id = ANY($1)`, [ids]);
    const lidas = new Map((r.rows ?? []).map((x) => [x.id, x]));
    let elegiveis = 0; const stale = [];
    for (const l of manifesto) {
      const linha = lidas.get(l.payment_id);
      if (!linha) { stale.push({ payment_id: l.payment_id, motivo: "não encontrada" }); continue; }
      const difs = compararComManifesto(linha, l);
      if (difs.length) stale.push({ payment_id: l.payment_id, motivo: "difere em " + difs.join(",") });
      else elegiveis++;
    }
    log(`(dry-run) elegíveis: ${elegiveis}   desatualizadas: ${stale.length}`);
    for (const s of stale.slice(0, 10)) log(`   STALE ${s.payment_id}: ${s.motivo}`);
    log(`(dry-run) campos que seriam escritos: ${UPDATE_FIELD_WHITELIST.join(", ")}`);
    return { exitCode: stale.length ? 1 : 0, writes: 0, eligible: elegiveis, stale: stale.length, closedPeriodCollisions: 0 };
  }

  // ── Com --apply: tudo dentro de uma transação ─────────────────────────────
  let writes = 0;
  await client.query("BEGIN");
  try {
    const r = await client.query(
      `SELECT ${SELECT_COLS} FROM public.fixed_variable_payments WHERE id = ANY($1) FOR UPDATE`, [ids]);
    const lidas = new Map((r.rows ?? []).map((x) => [x.id, x]));

    if (lidas.size !== manifesto.length) {
      throw new Error(`STALE_MANIFEST — esperava ${manifesto.length} linhas, encontrei ${lidas.size}.`);
    }
    for (const l of manifesto) {
      const linha = lidas.get(l.payment_id);
      const difs = compararComManifesto(linha, l);
      if (difs.length) throw new Error(`STALE_MANIFEST — ${l.payment_id} mudou em: ${difs.join(", ")}`);
    }

    // Caixa: capturada antes, comparada depois. Nunca escrita.
    const antesCaixa = await client.query(
      `SELECT id, reference_id, date, amount, reference_type FROM public.cash_flow_entries
       WHERE reference_type = 'fixed_variable_payment' AND reference_id = ANY($1)`, [ids]);

    for (const l of manifesto) {
      // Payload explícito. Nunca espalhar a linha lida.
      const res = await client.query(
        `UPDATE public.fixed_variable_payments SET period_year = $1, period_month = $2 WHERE id = $3`,
        [l.after_period_year, l.after_period_month, l.payment_id]);
      if (res.rowCount !== 1) throw new Error(`UPDATE_FAILED — ${l.payment_id} afetou ${res.rowCount} linhas.`);
      writes++;
    }

    // ── Pós-condições, ainda antes do COMMIT ────────────────────────────────
    const depois = await client.query(
      `SELECT ${SELECT_COLS} FROM public.fixed_variable_payments WHERE id = ANY($1)`, [ids]);
    const finais = new Map((depois.rows ?? []).map((x) => [x.id, x]));
    if (finais.size !== manifesto.length) throw new Error("POSTCONDITION_FAILED — mudou o número de linhas.");

    for (const l of manifesto) {
      const f = finais.get(l.payment_id);
      if (Number(f.period_year) !== Number(l.after_period_year) || Number(f.period_month) !== Number(l.after_period_month)) {
        throw new Error(`POSTCONDITION_FAILED — ${l.payment_id} não ficou no mês esperado.`);
      }
      for (const campo of PROTECTED_FIELDS) {
        if (campo === "updated_at") continue; // a base pode carimbá-lo
        if (!igual(f[campo], valorEsperado(l, campo))) {
          throw new Error(`POSTCONDITION_FAILED — ${l.payment_id} alterou ${campo}, que devia ser imutável.`);
        }
      }
      const derivada = competenceFromDueDate(f.due_date);
      if (!derivada || derivada.year !== f.period_year || derivada.month !== f.period_month) {
        throw new Error(`POSTCONDITION_FAILED — ${l.payment_id} continua divergente.`);
      }
    }

    const depoisCaixa = await client.query(
      `SELECT id, reference_id, date, amount, reference_type FROM public.cash_flow_entries
       WHERE reference_type = 'fixed_variable_payment' AND reference_id = ANY($1)`, [ids]);
    const a = JSON.stringify((antesCaixa.rows ?? []).map((x) => [x.id, x.reference_id, String(x.date), String(x.amount)]).sort());
    const b = JSON.stringify((depoisCaixa.rows ?? []).map((x) => [x.id, x.reference_id, String(x.date), String(x.amount)]).sort());
    if (a !== b) throw new Error("POSTCONDITION_FAILED — o fluxo de caixa mudou, e não devia.");

    await client.query("COMMIT");
    log(`✔ ${writes} pagamento(s) movidos para o mês do vencimento.`);
    return { exitCode: 0, writes, eligible: writes, stale: 0, closedPeriodCollisions: 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    logErro("❌ ROLLBACK TOTAL: " + sanitizar(err.message));
    logErro("   Nenhum pagamento foi alterado.");
    return { exitCode: 1, writes: 0, rolledBack: true };
  }
}
