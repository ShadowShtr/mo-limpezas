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

// ============================================================================
// Capacidade de escrita através de módulos
// ============================================================================
//
// `writeCapableExports` acima resolve a delegação **dentro** de um ficheiro. Um
// teste de mutação mostrou que isso não chega: bastou pôr a materialização de
// mês noutro módulo e importá-la de volta para `getPayments` voltar a escrever
// **sem nenhuma guarda dar por isso**.
//
//     // payments.ts
//     import { ensureMonth } from "@/lib/payments-month-materialization";
//     export async function getPayments() { await ensureMonth(...); ... }
//
// O corpo de `getPayments` não tem `.insert(`, e `ensureMonth` não é uma função
// local — para o detector anterior, leitura pura. É a mesma família de erro que
// este projecto já apanhou várias vezes: **reconhecer só o caminho conhecido dá
// um "seguro" falso**, e um falso seguro é pior do que nenhuma guarda, porque
// dispensa quem lê de olhar.
//
// Estas funções seguem os imports locais. Pacotes externos ficam de fora — não
// são código do repositório e não é aqui que se auditam.

interface ImportedSymbol { rel: string; orig: string }

function parseImports(
  code: string,
  fromRel: string,
  exists: (rel: string) => boolean,
): Map<string, ImportedSymbol> {
  const out = new Map<string, ImportedSymbol>();
  for (const m of code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (m[1]) continue;                      // `import type` não corre
    const alvo = resolveImport(fromRel, m[3], exists);
    if (!alvo) continue;                     // pacote externo
    for (const peca of m[2].split(",")) {
      const t = peca.trim();
      if (!t || t.startsWith("type ")) continue;
      const [orig, alias] = t.split(/\s+as\s+/).map((s) => s.trim());
      out.set(alias || orig, { rel: alvo, orig });
    }
  }
  return out;
}

export interface WriteCapabilityResolver {
  /** Aquele símbolo, exportado por aquele ficheiro, escreve na base? */
  writes(rel: string, name: string): boolean;
  /** As exportações de um ficheiro que escrevem, incluindo via outros módulos. */
  exportsThatWrite(rel: string): string[];
}

/**
 * Resolve capacidade de escrita seguindo a delegação através de ficheiros.
 *
 * Memoizado por ficheiro, e à prova de ciclos: um símbolo já em análise conta
 * como "não conclui nada" em vez de recorrer para sempre.
 */
export function createWriteCapabilityResolver(
  readFile: (rel: string) => string | null,
): WriteCapabilityResolver {
  const exists = (rel: string) => readFile(rel) != null;

  interface Analise {
    bodies: Map<string, string>;
    imports: Map<string, ImportedSymbol>;
    exported: string[];
  }
  const analises = new Map<string, Analise | null>();

  function analisar(rel: string): Analise | null {
    if (analises.has(rel)) return analises.get(rel)!;
    const raw = readFile(rel);
    if (raw == null) { analises.set(rel, null); return null; }
    const code = stripComments(raw);

    const bodies = new Map<string, string>();
    for (const m of code.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) {
      bodies.set(m[1], functionBody(code, m.index));
    }
    // Também as arrow functions atribuídas a const — comuns em helpers.
    for (const m of code.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) {
      if (!bodies.has(m[1])) bodies.set(m[1], functionBody(code, m.index));
    }

    const exported: string[] = [];
    for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)) {
      exported.push(m[1]);
    }

    const a: Analise = { bodies, imports: parseImports(code, rel, exists), exported };
    analises.set(rel, a);
    return a;
  }

  const cache = new Map<string, boolean>();
  const emCurso = new Set<string>();

  function writes(rel: string, name: string): boolean {
    const chave = `${rel}#${name}`;
    const hit = cache.get(chave);
    if (hit !== undefined) return hit;
    if (emCurso.has(chave)) return false;    // ciclo: não conclui nada
    emCurso.add(chave);

    let resultado = false;
    const a = analisar(rel);
    const body = a?.bodies.get(name) ?? "";

    if (body && (countDirectDbMutations(body) > 0 || REST_WRITE.test(body) || AUTH_WRITE.test(body))) {
      resultado = true;
    } else if (a && body) {
      for (const chamado of new Set(
        [...body.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]),
      )) {
        if (chamado === name) continue;
        if (a.bodies.has(chamado)) {
          if (writes(rel, chamado)) { resultado = true; break; }
        } else {
          const imp = a.imports.get(chamado);
          if (imp && writes(imp.rel, imp.orig)) { resultado = true; break; }
        }
      }
    }

    emCurso.delete(chave);
    cache.set(chave, resultado);
    return resultado;
  }

  return {
    writes,
    exportsThatWrite: (rel) => {
      const a = analisar(rel);
      if (!a) return [];
      return [...new Set(a.exported.filter((n) => writes(rel, n)))].sort();
    },
  };
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

// ============================================================================
// Grafo de renderização
// ============================================================================
//
// O detector anterior só olhava para `page.tsx` dentro das pastas financeiras.
// Falhou-lhe **exactamente** este caminho:
//
//     finance-shell.tsx  →  PaymentsReminderBanner  →  getPaymentsReminder
//                        →  ensureMonth  →  insert
//
// O banner nem sequer vive numa pasta financeira (`dashboard/_components/`), e
// não é uma página. Uma regra baseada em pastas e em nomes de ficheiro não
// podia chegar lá.
//
// A pergunta certa não é "onde está o ficheiro?" mas **"o que corre quando
// esta página é renderizada?"**. É um grafo, e percorre-se.

/** Um componente de cliente. A partir daqui já não é render de servidor. */
export function isClientComponent(src: string): boolean {
  return /^\s*["']use client["']/m.test(src);
}

/**
 * Um módulo de server actions.
 *
 * Também é fronteira do grafo, e a razão não é óbvia: um módulo `"use server"`
 * **define** operações de escrita, não as executa ao ser importado. Entrar nele
 * faria toda a página que importa `@/app/actions/…` parecer que escreve durante
 * o render — a primeira versão desta travessia deu 27 falsos positivos assim,
 * um por cada action definida nos módulos importados.
 *
 * O que interessa é quais destas actions a página **chama**, e isso mede-se no
 * próprio ficheiro da página, pelo nome.
 */
export function isServerActionModule(src: string): boolean {
  return /^\s*["']use server["']/m.test(src);
}

/**
 * Resolve um especificador de import para um caminho do repositório.
 *
 * Devolve `null` para pacotes externos — que não fazem parte do grafo.
 */
export function resolveImport(fromRel: string, spec: string, exists: (rel: string) => boolean): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = `src/${spec.slice(2)}`;
  } else if (spec.startsWith(".")) {
    const dir = fromRel.split("/").slice(0, -1);
    for (const part of spec.split("/")) {
      if (part === ".") continue;
      else if (part === "..") dir.pop();
      else dir.push(part);
    }
    base = dir.join("/");
  } else {
    return null;
  }

  for (const c of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (exists(c)) return c;
  }
  return null;
}

/**
 * Todos os ficheiros que correm **no servidor** ao renderizar as raízes.
 *
 * A travessia pára num componente de cliente, e a distinção é o coração desta
 * ferramenta:
 *
 * - **CAPABILITY** — o código consegue escrever;
 * - **RENDER_TRIGGER** — corre durante o render no servidor;
 * - **CLICK_TRIGGER** — só corre depois de o utilizador agir.
 *
 * Um componente de cliente que importa `deletePayment` para o pôr num `onClick`
 * tem capacidade, não gatilho de render. Tratá-los como a mesma coisa daria uma
 * lista cheia de falsos positivos — e uma guarda cheia de falsos positivos é
 * desligada, deixando de proteger do caso verdadeiro.
 */
export function collectServerRenderGraph(
  roots: string[],
  readFile: (rel: string) => string | null,
): string[] {
  const exists = (rel: string) => readFile(rel) != null;
  const visited = new Set<string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (visited.has(rel)) continue;

    const raw = readFile(rel);
    if (raw == null) continue;
    // Fronteiras do grafo:
    //  - componente de cliente → o que lá está dentro já não é render;
    //  - módulo de server actions → define escrita, não a executa ao importar.
    if (isClientComponent(raw) || isServerActionModule(raw)) continue;

    visited.add(rel);

    const code = stripComments(raw);
    for (const m of code.matchAll(/(?:^|\n)\s*import\s[\s\S]*?from\s*["']([^"']+)["']/g)) {
      const alvo = resolveImport(rel, m[1], exists);
      if (alvo && !visited.has(alvo)) queue.push(alvo);
    }
  }

  return [...visited].sort();
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
