// ============================================================================
// GUARDAS DE SEGURANÇA DO RUNNER DE MIGRAÇÕES — testes unitários
// ============================================================================
// scripts/lib/migration-runner-guards.mjs — funções puras, sem rede/DB.
// Cobre a política de scripts/run-migrations.mjs (REGRA ZERO secção 9,
// docs/PRODUCTION-RUNBOOK.md secção 8): dry-run por padrão, --apply
// obrigatório para escrever, --confirm-production obrigatório em --apply,
// flags desconhecidas rejeitadas, combinações contraditórias bloqueadas,
// e (2026-08-05, revisão pós-incidente PR #32) extração ESTRUTURADA e
// comparação EXATA do project ref — nunca por substring.
//
// Nenhum destes testes liga a uma base real — nenhuma migration corre
// durante o desenvolvimento/validação desta guarda.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  parseArgs,
  validateArgCombination,
  effectiveMode,
  resolveProjectRef,
  extractDbProjectRef,
  validateProductionConfirmation,
  KNOWN_FLAGS,
} from "../../scripts/lib/migration-runner-guards.mjs";

describe("parseArgs", () => {
  it("sem argumentos: tudo false, sem flags desconhecidas", () => {
    const parsed = parseArgs([]);
    expect(parsed).toMatchObject({ dryRun: false, apply: false, baseline: false, seed: false, confirmProductionValue: null, unknownArgs: [] });
  });

  it("reconhece --dry-run, --apply, --baseline, --seed isoladamente", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--baseline"]).baseline).toBe(true);
    expect(parseArgs(["--seed"]).seed).toBe(true);
  });

  it("--confirm-production consome o valor seguinte, não o trata como flag desconhecida", () => {
    const parsed = parseArgs(["--apply", "--confirm-production", "abcxyz123"]);
    expect(parsed.confirmProductionValue).toBe("abcxyz123");
    expect(parsed.unknownArgs).toEqual([]);
  });

  it("--confirm-production sem valor a seguir dá null, não rebenta", () => {
    const parsed = parseArgs(["--apply", "--confirm-production"]);
    expect(parsed.confirmProductionValue).toBeNull();
  });

  it("regista qualquer flag fora da lista conhecida em unknownArgs", () => {
    const parsed = parseArgs(["--apply", "--force", "--yes"]);
    expect(parsed.unknownArgs).toEqual(["--force", "--yes"]);
  });

  it("KNOWN_FLAGS é exatamente o conjunto documentado", () => {
    expect(new Set(KNOWN_FLAGS)).toEqual(new Set(["--dry-run", "--apply", "--baseline", "--seed", "--confirm-production"]));
  });
});

describe("validateArgCombination", () => {
  it("sem nenhuma flag: válido (dry-run implícito, decidido por effectiveMode)", () => {
    expect(validateArgCombination(parseArgs([])).ok).toBe(true);
  });

  it("--apply sozinho: válido nesta camada (confirmação de produção é validada à parte)", () => {
    expect(validateArgCombination(parseArgs(["--apply"])).ok).toBe(true);
  });

  it("rejeita flags desconhecidas antes de qualquer outra validação", () => {
    const r = validateArgCombination(parseArgs(["--yolo"]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--yolo/);
  });

  it("rejeita --dry-run e --apply juntos (contraditório)", () => {
    const r = validateArgCombination(parseArgs(["--dry-run", "--apply"]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mutuamente exclusivos/);
  });

  it("rejeita --baseline e --seed juntos (contraditório)", () => {
    const r = validateArgCombination(parseArgs(["--baseline", "--seed", "--apply"]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/não podem ser combinados/);
  });

  it("rejeita --baseline sem --apply", () => {
    const r = validateArgCombination(parseArgs(["--baseline"]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--apply/);
  });

  it("rejeita --seed sem --apply", () => {
    const r = validateArgCombination(parseArgs(["--seed"]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--apply/);
  });

  it("aceita --baseline --apply e --seed --apply isoladamente", () => {
    expect(validateArgCombination(parseArgs(["--baseline", "--apply"])).ok).toBe(true);
    expect(validateArgCombination(parseArgs(["--seed", "--apply"])).ok).toBe(true);
  });

  it("rejeita --confirm-production sem --apply — não é erro de segurança (dry-run não escreve), mas é sempre um engano do chamador", () => {
    const r = validateArgCombination(parseArgs(["--confirm-production", "algum-ref"]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--apply/);
  });

  it("--confirm-production com --apply: não é rejeitado por esta regra (a validação de valor correto é separada)", () => {
    const r = validateArgCombination(parseArgs(["--apply", "--confirm-production", "algum-ref"]));
    expect(r.ok).toBe(true);
  });
});

describe("effectiveMode", () => {
  it("sem --apply: dry-run, mesmo com outras flags de leitura", () => {
    expect(effectiveMode(parseArgs([]))).toBe("dry-run");
    expect(effectiveMode(parseArgs(["--dry-run"]))).toBe("dry-run");
  });

  it("com --apply: apply", () => {
    expect(effectiveMode(parseArgs(["--apply"]))).toBe("apply");
  });
});

describe("resolveProjectRef", () => {
  it("extrai o ref de uma URL Supabase normal", () => {
    expect(resolveProjectRef("https://ceqzxgizhgmvcniapyla.supabase.co")).toBe("ceqzxgizhgmvcniapyla");
  });

  it("devolve null para valores vazios/inválidos", () => {
    expect(resolveProjectRef(undefined)).toBeNull();
    expect(resolveProjectRef("")).toBeNull();
    expect(resolveProjectRef("not-a-url")).toBeNull();
    expect(resolveProjectRef("https://example.com")).toBeNull();
  });

  // 2026-08-05 (terceira revisão pós-incidente): a versão anterior usava uma
  // regex não ancorada ao fim do hostname — "https://abc123.supabase.co.evil.com"
  // batia no início e devolvia "abc123" indevidamente. Agora exige que o
  // hostname INTEIRO seja "<ref>.supabase.co", via parsing estrutural com URL.
  it("REJEITA hostname com sufixo depois de .supabase.co — domínio falso não passa", () => {
    expect(resolveProjectRef("https://abc123.supabase.co.evil.com")).toBeNull();
  });

  it("REJEITA hostname com subdomínio extra antes do ref (ref não é o hostname inteiro)", () => {
    expect(resolveProjectRef("https://x.abc123.supabase.co")).toBeNull();
  });

  it("REJEITA URL cujo hostname não termina exatamente em .supabase.co, mesmo contendo o texto", () => {
    expect(resolveProjectRef("https://supabase.co.abc123.example.com")).toBeNull();
    expect(resolveProjectRef("https://evil.com/?x=abc123.supabase.co")).toBeNull();
  });

  it("REJEITA URL malformada sem lançar exceção", () => {
    expect(resolveProjectRef("http://")).toBeNull();
    expect(resolveProjectRef(null)).toBeNull();
    expect(resolveProjectRef(123)).toBeNull();
  });
});

describe("extractDbProjectRef — extração estruturada, nunca por substring", () => {
  const REF = "ceqzxgizhgmvcniapyla";

  it("ligação via pooler: o ref vem do username (postgres.<ref>)", () => {
    expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@aws-1-eu-central-2.pooler.supabase.com:6543/postgres`)).toBe(REF);
  });

  it("ligação direta: o ref vem do hostname (db.<ref>.supabase.co)", () => {
    expect(extractDbProjectRef(`postgresql://postgres:senha@db.${REF}.supabase.co:5432/postgres`)).toBe(REF);
  });

  it("descodifica o username (pode vir URL-encoded) — refs reais do Supabase são só [a-z0-9]", () => {
    // %63 = 'c': confirma que a descodificação acontece antes do match,
    // sem introduzir um caráter fora do alfabeto real de um project ref.
    expect(extractDbProjectRef(`postgresql://postgres.%63${REF.slice(1)}:senha@aws-1.pooler.supabase.com:6543/postgres`)).toBe(REF);
  });

  it("REJEITA host com sufixo depois do ref — não é 'includes', é âncora completa", () => {
    expect(extractDbProjectRef(`postgresql://postgres:senha@db.${REF}-extra.supabase.co:5432/postgres`)).toBeNull();
  });

  it("REJEITA username com sufixo depois do ref", () => {
    expect(extractDbProjectRef(`postgresql://postgres.${REF}-extra:senha@aws-1.pooler.supabase.com:6543/postgres`)).toBeNull();
  });

  it("REJEITA host com prefixo antes do ref", () => {
    expect(extractDbProjectRef(`postgresql://postgres:senha@db.prefixo-${REF}.supabase.co:5432/postgres`)).toBeNull();
  });

  it("devolve null para hostname/username em formato completamente diferente (pooler partilhado sem ref no host)", () => {
    // O hostname do pooler é partilhado entre projetos — não deve ser
    // confundido com um ref válido só porque não há sufixo/prefixo óbvio.
    expect(extractDbProjectRef("postgresql://postgres:senha@aws-1-eu-central-2.pooler.supabase.com:6543/postgres")).toBeNull();
  });

  // 2026-08-05 (terceira revisão pós-incidente): o caminho do pooler validava
  // só o username (postgres.<ref>), aceitando esse username em QUALQUER
  // hostname — um username correto apontando para um servidor que não é o
  // pooler do Supabase extraía o ref na mesma. Agora exige username E
  // hostname simultaneamente.
  describe("REJEITA username postgres.<ref> correto num hostname que não é o pooler real", () => {
    it("hostname completamente alheio", () => {
      expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@evil.example.com:6543/postgres`)).toBeNull();
    });

    it("hostname que contém .pooler.supabase.com mas não termina nele (sufixo malicioso)", () => {
      expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@pooler.supabase.com.evil.com:6543/postgres`)).toBeNull();
    });

    it("hostname com sufixo malicioso depois do domínio real do pooler", () => {
      expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@aws-1.pooler.supabase.com.evil.com:6543/postgres`)).toBeNull();
    });

    it("qualquer hostname que não termine exatamente em .pooler.supabase.com", () => {
      expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@meu-servidor-privado.com:6543/postgres`)).toBeNull();
      expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@supabase.com:6543/postgres`)).toBeNull();
      expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@fake.supabase.com:6543/postgres`)).toBeNull();
    });
  });

  it("aceita username+hostname pooler reais em conjunto (região variável, sufixo fixo)", () => {
    expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@aws-1-eu-central-2.pooler.supabase.com:6543/postgres`)).toBe(REF);
    expect(extractDbProjectRef(`postgresql://postgres.${REF}:senha@aws-0-us-east-1.pooler.supabase.com:6543/postgres`)).toBe(REF);
  });
});

describe("validateProductionConfirmation", () => {
  const REF = "ceqzxgizhgmvcniapyla";

  it("dry-run (apply=false): sempre ok, não exige nada", () => {
    expect(validateProductionConfirmation({ apply: false, confirmProductionValue: null, projectRef: null, dbProjectRef: null }).ok).toBe(true);
  });

  it("--apply sem NEXT_PUBLIC_SUPABASE_URL configurada: rejeitado", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: null, dbProjectRef: REF });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("--apply sem conseguir extrair o ref de SUPABASE_DB_URL (formato inesperado): rejeitado", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbProjectRef: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Não foi possível extrair/);
  });

  it("--apply com dbProjectRef diferente do projectRef: rejeitado (evita escrever no projeto errado)", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbProjectRef: "outro-projeto" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/não corresponde ao projeto/);
  });

  it("--apply com dbProjectRef que É o projectRef mais um sufixo: rejeitado — nunca por substring", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbProjectRef: `${REF}-extra` });
    expect(r.ok).toBe(false);
  });

  it("--apply sem --confirm-production (valor null): rejeitado mesmo com projeto/dbProjectRef corretos", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: null, projectRef: REF, dbProjectRef: REF });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--confirm-production/);
  });

  it("--apply com --confirm-production vazio: rejeitado", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: "", projectRef: REF, dbProjectRef: REF });
    expect(r.ok).toBe(false);
  });

  it("--confirm-production que CONTÉM o ref mas não é exatamente igual: rejeitado — a comparação nunca é por substring", () => {
    const r1 = validateProductionConfirmation({ apply: true, confirmProductionValue: `${REF}-extra`, projectRef: REF, dbProjectRef: REF });
    const r2 = validateProductionConfirmation({ apply: true, confirmProductionValue: REF.slice(0, -1), projectRef: REF, dbProjectRef: REF });
    const r3 = validateProductionConfirmation({ apply: true, confirmProductionValue: `prefixo-${REF}`, projectRef: REF, dbProjectRef: REF });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
  });

  it("--apply com --confirm-production errado (projeto diferente): rejeitado", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: "outro-projeto", projectRef: REF, dbProjectRef: REF });
    expect(r.ok).toBe(false);
  });

  it("--apply com tudo correto via pooler (ref extraído do username): aceite", () => {
    const dbProjectRef = extractDbProjectRef(`postgresql://postgres.${REF}:senha@aws-1.pooler.supabase.com:6543/postgres`);
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbProjectRef });
    expect(r.ok).toBe(true);
  });

  it("--apply com tudo correto via ligação direta (ref extraído do hostname): aceite", () => {
    const dbProjectRef = extractDbProjectRef(`postgresql://postgres:senha@db.${REF}.supabase.co:5432/postgres`);
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbProjectRef });
    expect(r.ok).toBe(true);
  });
});

describe("integração: fluxo completo a partir de argv cru", () => {
  it("`node run-migrations.mjs` (sem nada) é sempre seguro: combinação válida, modo dry-run", () => {
    const parsed = parseArgs([]);
    expect(validateArgCombination(parsed).ok).toBe(true);
    expect(effectiveMode(parsed)).toBe("dry-run");
  });

  it("`--apply` sozinho passa a combinação de argumentos mas falha na confirmação de produção sem --confirm-production", () => {
    const parsed = parseArgs(["--apply"]);
    expect(validateArgCombination(parsed).ok).toBe(true);
    const confirmation = validateProductionConfirmation({
      apply: parsed.apply,
      confirmProductionValue: parsed.confirmProductionValue,
      projectRef: "abc123",
      dbProjectRef: "abc123",
    });
    expect(confirmation.ok).toBe(false);
  });

  it("`--apply --confirm-production <ref-certo>` com projeto/ligação corretos (formato pooler real): fluxo completo aceite", () => {
    const parsed = parseArgs(["--apply", "--confirm-production", "abc123"]);
    expect(validateArgCombination(parsed).ok).toBe(true);
    const dbProjectRef = extractDbProjectRef("postgresql://postgres.abc123:senha@aws-1-eu-central-2.pooler.supabase.com:6543/postgres");
    const confirmation = validateProductionConfirmation({
      apply: parsed.apply,
      confirmProductionValue: parsed.confirmProductionValue,
      projectRef: "abc123",
      dbProjectRef,
    });
    expect(confirmation.ok).toBe(true);
  });

  it("host com sufixo (abc123-extra) nunca passa mesmo confirmando abc123 corretamente — a extração já rejeita antes da comparação", () => {
    const parsed = parseArgs(["--apply", "--confirm-production", "abc123"]);
    const dbProjectRef = extractDbProjectRef("postgresql://postgres:senha@db.abc123-extra.supabase.co:5432/postgres");
    expect(dbProjectRef).toBeNull();
    const confirmation = validateProductionConfirmation({
      apply: parsed.apply,
      confirmProductionValue: parsed.confirmProductionValue,
      projectRef: "abc123",
      dbProjectRef,
    });
    expect(confirmation.ok).toBe(false);
  });
});
