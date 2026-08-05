// ============================================================================
// GUARDAS DE SEGURANÇA DO RUNNER DE MIGRAÇÕES — testes unitários
// ============================================================================
// scripts/lib/migration-runner-guards.mjs — funções puras, sem rede/DB.
// Cobre a política de scripts/run-migrations.mjs (REGRA ZERO secção 9,
// docs/PRODUCTION-RUNBOOK.md secção 8): dry-run por padrão, --apply
// obrigatório para escrever, --confirm-production obrigatório em --apply,
// flags desconhecidas rejeitadas, combinações contraditórias bloqueadas.
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
  dbIdentityFromUrl,
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
});

describe("dbIdentityFromUrl", () => {
  it("liga via pooler: o project ref vem do username (postgres.<ref>), não do hostname", () => {
    // Formato real deste projeto — confirmado ao investigar por que a
    // primeira versão desta guarda (que só olhava para o hostname) falhava
    // sempre com --apply neste repositório: o hostname do pooler
    // (aws-x-region.pooler.supabase.com) é partilhado entre projetos, o
    // ref só aparece no username.
    const identity = dbIdentityFromUrl("postgresql://postgres.ceqzxgizhgmvcniapyla:senha@aws-1-eu-central-2.pooler.supabase.com:6543/postgres");
    expect(identity).toContain("ceqzxgizhgmvcniapyla");
  });

  it("liga direta: o project ref vem do hostname (db.<ref>.supabase.co)", () => {
    const identity = dbIdentityFromUrl("postgresql://postgres:senha@db.ceqzxgizhgmvcniapyla.supabase.co:5432/postgres");
    expect(identity).toContain("ceqzxgizhgmvcniapyla");
  });

  it("descodifica o username (password/username podem vir URL-encoded)", () => {
    const identity = dbIdentityFromUrl("postgresql://postgres.abc%2Ddef:senha@host.supabase.com:5432/postgres");
    expect(identity).toContain("abc-def");
  });
});

describe("validateProductionConfirmation", () => {
  const REF = "ceqzxgizhgmvcniapyla";
  // Identidade real deste projeto: host de pooler (sem o ref) + username
  // com o ref — dbIdentityFromUrl junta os dois, e é essa junção que tem
  // de conter o ref, não o host isolado.
  const IDENTITY_POOLER = `aws-1-eu-central-2.pooler.supabase.com postgres.${REF}`;
  const IDENTITY_SEM_REF = "aws-1-eu-central-2.pooler.supabase.com postgres.outro-projeto";
  const IDENTITY_DIRECT = `db.${REF}.supabase.co postgres`;

  it("dry-run (apply=false): sempre ok, não exige nada", () => {
    expect(validateProductionConfirmation({ apply: false, confirmProductionValue: null, projectRef: null, dbIdentity: null }).ok).toBe(true);
  });

  it("--apply sem NEXT_PUBLIC_SUPABASE_URL configurada: rejeitado", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: null, dbIdentity: IDENTITY_POOLER });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("--apply com identidade (host+username) que não contém o ref: rejeitado (evita escrever no projeto errado)", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbIdentity: IDENTITY_SEM_REF });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/não corresponde ao projeto/);
  });

  it("--apply sem --confirm-production (valor null): rejeitado mesmo com projeto/identidade corretos", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: null, projectRef: REF, dbIdentity: IDENTITY_POOLER });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--confirm-production/);
  });

  it("--apply com --confirm-production errado (projeto diferente): rejeitado", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: "outro-projeto", projectRef: REF, dbIdentity: IDENTITY_POOLER });
    expect(r.ok).toBe(false);
  });

  it("--apply com --confirm-production vazio: rejeitado (não é 'null' passa livre')", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: "", projectRef: REF, dbIdentity: IDENTITY_POOLER });
    expect(r.ok).toBe(false);
  });

  it("--confirm-production que CONTÉM o ref mas não é exatamente igual: rejeitado — a comparação nunca é por substring", () => {
    const r1 = validateProductionConfirmation({ apply: true, confirmProductionValue: `${REF}-extra`, projectRef: REF, dbIdentity: IDENTITY_POOLER });
    const r2 = validateProductionConfirmation({ apply: true, confirmProductionValue: REF.slice(0, -1), projectRef: REF, dbIdentity: IDENTITY_POOLER });
    const r3 = validateProductionConfirmation({ apply: true, confirmProductionValue: `prefixo-${REF}`, projectRef: REF, dbIdentity: IDENTITY_POOLER });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
  });

  it("--apply com tudo correto via pooler (ref só no username): aceite", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbIdentity: IDENTITY_POOLER });
    expect(r.ok).toBe(true);
  });

  it("--apply com tudo correto via ligação direta (ref no hostname): aceite", () => {
    const r = validateProductionConfirmation({ apply: true, confirmProductionValue: REF, projectRef: REF, dbIdentity: IDENTITY_DIRECT });
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
      dbIdentity: "host.example.com postgres.abc123",
    });
    expect(confirmation.ok).toBe(false);
  });

  it("`--apply --confirm-production <ref-certo>` com projeto/identidade corretos: fluxo completo aceite, formato pooler real", () => {
    const parsed = parseArgs(["--apply", "--confirm-production", "abc123"]);
    expect(validateArgCombination(parsed).ok).toBe(true);
    const confirmation = validateProductionConfirmation({
      apply: parsed.apply,
      confirmProductionValue: parsed.confirmProductionValue,
      projectRef: "abc123",
      dbIdentity: dbIdentityFromUrl("postgresql://postgres.abc123:senha@aws-1-eu-central-2.pooler.supabase.com:6543/postgres"),
    });
    expect(confirmation.ok).toBe(true);
  });
});
