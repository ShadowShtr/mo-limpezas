/**
 * Decide se um script administrativo pode correr, e em que modo.
 *
 * Módulo **puro**: sem I/O, sem `process.exit`, sem rede. Segue o mesmo padrão
 * de `verify-target-guard.mjs` — a decisão é testável a sério, e
 * `scripts/lib/admin-db.mjs` limita-se a obedecer ao veredito.
 *
 * ---------------------------------------------------------------------------
 * O problema que isto resolve
 * ---------------------------------------------------------------------------
 * A T17-B1 leu os 15 scripts capazes de escrever com a chave administrativa e
 * encontrou o mesmo defeito em todos:
 *
 *   **nenhum sabia contra que base estava a correr, e nenhum o dizia antes de
 *   escrever.**
 *
 * Sete liam `.env.local` com um parser de regex próprio e escreviam onde quer
 * que esse ficheiro apontasse. Se lá estivessem as credenciais de produção — e
 * o incidente de 2026-08-06 mostrou que já estiveram — o script escrevia em
 * produção sem uma única linha a avisar. É exactamente o modo de falha que o
 * §9 do `AGENTS.md` proíbe: *"nunca usar valores padrão que apontem para
 * produção"*.
 *
 * ---------------------------------------------------------------------------
 * As regras
 * ---------------------------------------------------------------------------
 * 1. **O operador declara o alvo.** `--project-ref <ref>` é obrigatório e tem
 *    de coincidir com o projecto que o ambiente carregado realmente aponta.
 *    Não é burocracia: transforma "eu achava que estava a apontar para o
 *    projecto de testes" num erro em vez de num incidente.
 *
 * 2. **Dry-run por omissão.** Sem `--apply` nada é escrito. O modo tem de ser
 *    uma escolha, nunca o que acontece por descuido.
 *
 * 3. **Produção é recusada por omissão** — e o desconhecido conta como
 *    produção. Se não se souber qual é o projecto real, a resposta segura é
 *    tratar o alvo como se fosse ele. Um guard que só protege quando está bem
 *    configurado não protege nada no dia em que alguém se esquece de o
 *    configurar.
 *
 * 4. **`company_id` obrigatório para escrever.** A chave administrativa
 *    contorna o RLS; sem âmbito explícito, uma escrita atinge todas as
 *    empresas. Foi o que tornou `reset-operacao.mjs` capaz de apagar a
 *    operação de toda a gente.
 */

import { extractPublicProjectRef } from "./verify-target-guard.mjs";

export { extractPublicProjectRef };

/** UUID v4 canónico — o formato de `company_id` em toda a base. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FLAGS = {
  apply: "--apply",
  projectRef: "--project-ref",
  companyId: "--company-id",
  production: "--i-am-authorized-to-write-to-production",
};

/**
 * Lê as flags comuns de uma lista de argumentos.
 *
 * Aceita `--flag valor` e `--flag=valor`. Devolve também `rest`, para o script
 * poder ter argumentos próprios sem os ter de reimplementar.
 */
export function parseCommonArgs(argv = []) {
  const valorDe = (nome) => {
    const igual = argv.find((a) => a.startsWith(`${nome}=`));
    if (igual) return igual.slice(nome.length + 1);
    const i = argv.indexOf(nome);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
    return null;
  };

  const consumidas = new Set();
  for (const nome of Object.values(FLAGS)) {
    const i = argv.indexOf(nome);
    if (i >= 0) {
      consumidas.add(i);
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) consumidas.add(i + 1);
    }
    argv.forEach((a, j) => { if (a.startsWith(`${nome}=`)) consumidas.add(j); });
  }

  return {
    apply: argv.includes(FLAGS.apply),
    projectRef: valorDe(FLAGS.projectRef),
    companyId: valorDe(FLAGS.companyId),
    productionAuthorized: argv.includes(FLAGS.production),
    rest: argv.filter((_, i) => !consumidas.has(i)),
  };
}

/**
 * @param {object} entrada
 * @param {boolean} entrada.writes            o script escreve na base?
 * @param {boolean} [entrada.requiresCompanyId=true]  a escrita é por empresa?
 * @param {string|null|undefined} entrada.supabaseUrl        NEXT_PUBLIC_SUPABASE_URL carregada
 * @param {string|null|undefined} entrada.serviceKey         SUPABASE_SERVICE_ROLE_KEY carregada
 * @param {string|null|undefined} entrada.productionRef      MO_PRODUCTION_PROJECT_REF, se declarada
 * @param {ReturnType<typeof parseCommonArgs>} entrada.args
 * @returns {{ ok: true, mode: "dry-run"|"apply", targetRef: string, companyId: string|null,
 *             targetIsProduction: boolean, productionRefKnown: boolean, warnings: string[] }
 *          | { ok: false, error: string }}
 */
export function resolveAdminScriptGuard({
  writes,
  requiresCompanyId = true,
  supabaseUrl,
  serviceKey,
  productionRef,
  args,
}) {
  const warnings = [];

  if (!supabaseUrl) {
    return { ok: false, error: "NEXT_PUBLIC_SUPABASE_URL não está definida. Sem alvo, não se corre nada." };
  }
  if (!serviceKey) {
    return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY não está definida." };
  }

  const targetRef = extractPublicProjectRef(supabaseUrl);
  if (!targetRef) {
    return {
      ok: false,
      error:
        "Não foi possível identificar o project ref a partir de NEXT_PUBLIC_SUPABASE_URL. "
        + "Sem saber contra que projeto se corre, não há como garantir que não é o real.",
    };
  }

  // Regra 1 — o operador declara o alvo, e a declaração é confrontada com a
  // realidade. Sem isto, o único sítio onde o alvo está escrito é um ficheiro
  // que ninguém relê.
  const declarado = args.projectRef ? String(args.projectRef).trim() : "";
  if (!declarado) {
    return {
      ok: false,
      error:
        `${FLAGS.projectRef} <ref> é obrigatório. O ambiente carregado aponta para "${targetRef}" — `
        + "declara-o explicitamente para provar que sabes onde estás a mexer.",
    };
  }
  if (declarado !== targetRef) {
    return {
      ok: false,
      error:
        `Alvo declarado ("${declarado}") não corresponde ao do ambiente carregado ("${targetRef}"). `
        + "Ou o .env.local não é o que pensas, ou a flag está errada. Nenhuma das duas se resolve escrevendo.",
    };
  }

  const productionRefKnown = Boolean(productionRef && String(productionRef).trim());
  // Regra 3 — desconhecido conta como produção.
  const targetIsProduction = productionRefKnown
    ? targetRef === String(productionRef).trim()
    : true;

  if (!productionRefKnown) {
    warnings.push(
      "MO_PRODUCTION_PROJECT_REF não está definida, por isso este alvo é tratado "
      + "como se fosse produção. Define-a para poder distinguir bases descartáveis.",
    );
  }

  // Regra 2 — dry-run por omissão. Um script que não escreve nunca precisa de
  // mais nada: pode ler e sair.
  if (!writes || !args.apply) {
    return {
      ok: true,
      mode: "dry-run",
      targetRef,
      companyId: args.companyId ?? null,
      targetIsProduction,
      productionRefKnown,
      warnings,
    };
  }

  // A partir daqui vai escrever-se.
  if (targetIsProduction && !args.productionAuthorized) {
    return {
      ok: false,
      error:
        `RECUSADO: escrita em "${targetRef}", que é `
        + (productionRefKnown ? "o projeto de PRODUÇÃO" : "de origem desconhecida e por isso tratado como PRODUÇÃO")
        + ".\n\n"
        + "  Produção é um sistema vivo, usado diariamente por pessoas reais.\n"
        + `  Ver AGENTS.md (REGRA ZERO): esta ação exige autorização explícita do\n`
        + "  proprietário, escrita na tarefa atual. Uma autorização antiga não serve.\n\n"
        + `  Com essa autorização, e só com ela: ${FLAGS.production}`,
    };
  }

  // Regra 4 — a chave administrativa contorna o RLS; sem âmbito, a escrita é global.
  if (requiresCompanyId) {
    const empresa = args.companyId ? String(args.companyId).trim() : "";
    if (!empresa) {
      return {
        ok: false,
        error:
          `${FLAGS.companyId} <uuid> é obrigatório para escrever. A chave administrativa `
          + "contorna o RLS: sem âmbito de empresa, a escrita atinge todas.",
      };
    }
    if (!UUID.test(empresa)) {
      return { ok: false, error: `company_id inválido: "${empresa}" não é um UUID.` };
    }
    return {
      ok: true, mode: "apply", targetRef, companyId: empresa,
      targetIsProduction, productionRefKnown, warnings,
    };
  }

  return {
    ok: true, mode: "apply", targetRef, companyId: args.companyId ?? null,
    targetIsProduction, productionRefKnown, warnings,
  };
}
