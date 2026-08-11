// ============================================================================
// Superfície de escrita do Financeiro — análise determinística
// ============================================================================
//
// Existe para o cliquet do orçamento de escrita
// (`src/__tests__/financeiro-v2-write-budget.test.ts`) poder ser **provado em
// qualquer ambiente**.
//
// ---------------------------------------------------------------------------
// Porque não `git diff`
// ---------------------------------------------------------------------------
// A primeira versão do teste comparava o código com o ramo base
// (`git diff --name-only fix/...`). Passava localmente, onde esse ramo existe,
// e **falhava no CI**, que faz checkout do SHA da PR com profundidade 1 e não
// tem ramo nenhum:
//
//     fatal: ambiguous argument 'fix/t17b3-action-query-errors':
//     unknown revision or path not in the working tree
//
// Pior do que falhar: o invariante mais importante da ronda nunca chegou a ser
// verificado no ambiente que interessa. Um teste de segurança que depende de
// história de git, nome de ramo ou profundidade de checkout não é uma prova —
// é uma coincidência do ambiente de quem o escreveu.
//
// Estas funções são puras e olham só para o código presente. Sem git, sem
// ramos, sem rede.
// ============================================================================

/** Tira comentários — para medir o código, não a documentação. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * Mutação directa na base.
 *
 * ⚠️ Não confundir com métodos de colecções do JavaScript. `payroll-client.tsx`
 * faz `next.delete(id)` sobre um `Set`, e um contador ingénuo de `.delete(`
 * classificá-lo-ia como escrita na base — medindo a coisa errada e dando um
 * número que ninguém consegue interpretar.
 *
 * Por isso exige-se a **cadeia do Supabase**: a chamada tem de vir depois de
 * `.from("tabela")`, ou ser um `.rpc(`.
 */
export function countDirectDbMutations(src: string): number {
  const code = stripComments(src);
  let total = 0;

  // Por instrução, não por janela de caracteres.
  //
  // A primeira versão contava mutações numa janela de 400 caracteres a seguir
  // a `.from("tabela")` — e falhava quando o guard de autorização entre a
  // leitura do perfil e a escrita era maior do que isso. `createCashFlowEntry`
  // tem exactamente esse feitio, e passava por não-escritora.
  //
  // Uma instrução completa é a unidade certa: a cadeia do Supabase vive toda
  // dentro dela, e `next.delete(id)` sobre um `Set` vive noutra.
  for (const statement of code.split(";")) {
    const mutations = statement.match(/\.(insert|update|upsert|delete|rpc)\s*\(/g) ?? [];
    if (mutations.length === 0) continue;
    // A cadeia tem de ser reconhecidamente da base.
    if (!/\.from\s*\(\s*["'`][\w.]+["'`]\s*\)|\b(?:admin|supabase|sb)\s*\./.test(statement)) continue;
    total += mutations.length;
  }
  return total;
}

/**
 * O corpo de uma função, saltando a lista de parâmetros e a anotação de
 * retorno.
 *
 * Um `indexOf("{")` a partir do nome apanharia a chaveta do **tipo** do
 * parâmetro (`function createPayment(input: { kind: … })`) ou do tipo de
 * retorno (`: Promise<{ ok: true }>`) — e o "corpo" seria a assinatura. Foi
 * esse erro que, num inventário anterior, fez `createPayment` aparecer como
 * leitura.
 */
export function functionBody(src: string, startIdx: number): string {
  let i = src.indexOf("(", startIdx);
  if (i < 0) return "";
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") { paren--; if (paren === 0) { i++; break; } }
  }
  let angle = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "<") angle++;
    else if (c === ">") angle--;
    else if (c === "{" && angle === 0) break;
  }
  if (i >= src.length) return "";
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}

const REST_WRITE = /method:\s*["'](POST|PATCH|PUT|DELETE)["']/i;
const AUTH_WRITE = /auth\.admin\.(create|delete|update)/;

/**
 * As actions exportadas de um ficheiro que **escrevem**, incluindo por
 * delegação.
 *
 * O fecho transitivo sobre chamadas locais não é um luxo: é o que apanha
 * `calculateAndSavePayroll`, cujo corpo só chama `runPayrollCalculation`, e
 * sobretudo **`getPayments`**, que parece leitura e chama `ensureMonth`, que
 * insere. Sem isto, o cliquet declararia segura uma página que gera dados só
 * por ser aberta.
 */
export function writeCapableExports(src: string): string[] {
  const code = stripComments(src);

  const bodies = new Map<string, string>();
  for (const m of code.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) {
    bodies.set(m[1], functionBody(code, m.index));
  }

  const writesDirectly = (name: string): boolean => {
    const body = bodies.get(name) ?? "";
    return countDirectDbMutations(body) > 0 || REST_WRITE.test(body) || AUTH_WRITE.test(body);
  };

  const cache = new Map<string, boolean>();
  const resolve = (name: string, seen = new Set<string>()): boolean => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    if (seen.has(name)) return false;      // recursão: não conclui nada
    seen.add(name);

    let writes = writesDirectly(name);
    if (!writes) {
      const body = bodies.get(name) ?? "";
      for (const other of bodies.keys()) {
        if (other === name) continue;
        if (new RegExp(`\\b${other}\\s*\\(`).test(body) && resolve(other, seen)) { writes = true; break; }
      }
    }
    cache.set(name, writes);
    return writes;
  };

  const out: string[] = [];
  for (const m of code.matchAll(/export\s+async\s+function\s+(\w+)/g)) {
    if (resolve(m[1])) out.push(m[1]);
  }
  return [...new Set(out)].sort();
}

/** Quais destas actions de escrita um ficheiro chama. */
export function writeActionsUsedBy(src: string, writeActions: Iterable<string>): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const a of writeActions) {
    if (new RegExp(`\\b${a}\\s*\\(`).test(code)) out.push(a);
  }
  return out.sort();
}

export interface CeilingVerdict {
  /** Capacidade nova, não inventariada. Falha sempre. */
  added: string[];
  /** Capacidade que saiu — o tecto tem de descer, senão deixa de ser prova. */
  removed: string[];
}

/**
 * Compara o observado com o inventariado.
 *
 * Nos dois sentidos, de propósito. Um tecto que só olha para cima deixa de
 * medir assim que o código melhora: fica alto, e a próxima escrita nova cabe
 * lá dentro sem ninguém dar por isso.
 */
export function compareToCeiling(actual: string[], ceiling: string[]): CeilingVerdict {
  const a = new Set(actual);
  const c = new Set(ceiling);
  return {
    added: [...a].filter((x) => !c.has(x)).sort(),
    removed: [...c].filter((x) => !a.has(x)).sort(),
  };
}
