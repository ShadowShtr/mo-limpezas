// ============================================================================
// SQL CONGELADO DA T09 — GUARDAS ESTÁTICAS
// ============================================================================
// Mesmas garantias estruturais da T08, mais as que a escrita atómica exige:
// isolamento por empresa, serialização por contrato, privilégios mínimos e
// recusa de sobrescrever decisões humanas mesmo quando o plano vem errado.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const FROZEN = path.join(ROOT, "supabase", "frozen", "T09_atomic_contract_sync.sql");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

const sql = fs.readFileSync(FROZEN, "utf8");
const executavel = sql
  .split("\n")
  .filter((linha) => !linha.trimStart().startsWith("--"))
  .join("\n");

// ─── inaplicável ────────────────────────────────────────────────────────────

describe("o SQL da T09 é inaplicável pelo runner", () => {
  it("está fora de supabase/migrations/", () => {
    expect(fs.existsSync(FROZEN)).toBe(true);
    const migrations = fs.readdirSync(MIGRATIONS_DIR);
    expect(migrations.some((f) => f.includes("T09") || f.includes("t09"))).toBe(false);
    expect(migrations.some((f) => f.includes("sync_contract"))).toBe(false);
  });

  it("declara que não é migration e que depende da T08", () => {
    expect(sql).toMatch(/NÃO É UMA MIGRATION/);
    expect(sql).toMatch(/DEPENDE DA T08/);
  });

  it("não toca na migration 070", () => {
    expect(executavel).not.toMatch(/profile_managed_fields/);
    expect(sql).toMatch(/070 continua intocada/);
  });
});

// ─── segurança ──────────────────────────────────────────────────────────────

describe("segurança da função", () => {
  it("NÃO é SECURITY DEFINER", () => {
    // Correndo como quem chama, a RLS de services/contracts continua a valer.
    expect(executavel).not.toMatch(/SECURITY DEFINER/i);
  });

  it("fixa o search_path à mesma", () => {
    // Impede que um schema no caminho de pesquisa do chamador desvie o corpo.
    expect(executavel).toMatch(/SET search_path = public, pg_temp/);
  });

  it("revoga o acesso público e só concede ao papel autenticado", () => {
    expect(executavel).toMatch(/REVOKE ALL ON FUNCTION public\.sync_contract_occurrences[\s\S]*FROM PUBLIC/);
    expect(executavel).toMatch(/GRANT EXECUTE ON FUNCTION public\.sync_contract_occurrences[\s\S]*TO authenticated/);
    expect(executavel).not.toMatch(/GRANT[^\n]*TO anon/i);
  });

  it("valida a empresa antes de fazer o que quer que seja", () => {
    const corpo = executavel.slice(executavel.indexOf("BEGIN"), executavel.indexOf("PERFORM pg_advisory"));
    expect(corpo).toMatch(/FROM public\.contracts[\s\S]*company_id = p_company_id/);
    expect(corpo).toMatch(/RAISE EXCEPTION/);
  });

  it("toda a escrita filtra por company_id", () => {
    // Nenhum UPDATE/DELETE pode escapar ao isolamento por empresa.
    for (const bloco of executavel.split(/(?=UPDATE public\.|DELETE FROM public\.)/).slice(1)) {
      const ateAoFim = bloco.slice(0, bloco.indexOf(";"));
      expect(ateAoFim, ateAoFim.slice(0, 60)).toMatch(/company_id|p_company_id/);
    }
  });

  it("não apaga por outro critério que não a identidade da ocorrência", () => {
    const deletes = executavel.match(/DELETE FROM public\.\w+[\s\S]*?;/g) ?? [];
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatch(/occurrence_date =/);
    expect(deletes[0]).toMatch(/is_exception\s+= false/);
    expect(deletes[0]).toMatch(/status\s+= 'agendado'/);
  });
});

// ─── concorrência e idempotência ────────────────────────────────────────────

describe("concorrência", () => {
  it("serializa por contrato com advisory lock de transação", () => {
    expect(executavel).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_contract_id::text, 0\)\)/);
  });

  it("o lock é por transação, não de sessão (liberta sozinho)", () => {
    // Um lock de sessão esquecido bloquearia o contrato indefinidamente.
    expect(executavel).not.toMatch(/pg_advisory_lock\(/);
    expect(executavel).not.toMatch(/pg_advisory_unlock/);
  });

  it("a criação é retry-safe via ON CONFLICT DO NOTHING", () => {
    expect(executavel).toMatch(/ON CONFLICT \(company_id, contract_id, occurrence_date\)/);
    expect(executavel).toMatch(/WHERE contract_id IS NOT NULL AND occurrence_date IS NOT NULL/);
    expect(executavel).toMatch(/DO NOTHING/);
    expect(executavel).not.toMatch(/DO UPDATE/);
  });

  it("tudo corre numa transação só", () => {
    const begins = (executavel.match(/^BEGIN;/gm) ?? []).length;
    const commits = (executavel.match(/^COMMIT;/gm) ?? []).length;
    expect(begins).toBe(commits);
    expect(begins).toBeGreaterThan(0);
  });
});

// ─── decisões humanas protegidas ────────────────────────────────────────────

describe("a base recusa sobrescrever decisões humanas", () => {
  it("o UPDATE nunca toca em exceções, cancelamentos ou realizados", () => {
    const update = executavel.slice(
      executavel.indexOf("UPDATE public.services SET"),
      executavel.indexOf("WHEN 'REMOVE_ORPHAN'"),
    );
    expect(update).toMatch(/is_exception\s+= false/);
    expect(update).toMatch(/status\s+= 'agendado'/);
  });

  it("declara a sincronização legítima com contract_synced_at", () => {
    // Sem isto o trigger da migration 059 marcaria a escrita como manual.
    expect(executavel).toMatch(/contract_synced_at\s+= now\(\)/);
  });

  it("🔴 a remoção regista a occurrence_date em excluded_dates, não a data agendada", () => {
    // O defeito encontrado na T08: apagar um serviço reagendado excluía a data
    // errada e a ocorrência canónica voltava na corrida seguinte.
    const remove = executavel.slice(
      executavel.indexOf("WHEN 'REMOVE_ORPHAN'"),
      executavel.indexOf("END CASE"),
    );
    expect(remove).toMatch(/UPDATE public\.contracts[\s\S]*excluded_dates/);
    expect(remove).toMatch(/v_item->>'occurrence_date'/);
    expect(remove).not.toMatch(/scheduled_start/);
    // A exclusão vem ANTES do DELETE.
    expect(remove.indexOf("excluded_dates")).toBeLessThan(remove.indexOf("DELETE FROM"));
  });

  it("decisões que não escrevem são ignoradas em vez de assumidas", () => {
    expect(executavel).toMatch(/ELSE[\s\S]*v_skipped := v_skipped \+ 1/);
  });
});

// ─── resultado autoritativo ─────────────────────────────────────────────────

describe("resultado", () => {
  it("devolve contagens e o estado final, não um sucesso vazio", () => {
    expect(executavel).toMatch(/'created',\s+v_created/);
    expect(executavel).toMatch(/'updated',\s+v_updated/);
    expect(executavel).toMatch(/'removed',\s+v_removed/);
    expect(executavel).toMatch(/'skipped',\s+v_skipped/);
    expect(executavel).toMatch(/'services',\s+COALESCE\(/);
  });

  it("o snapshot devolvido é filtrado por empresa e contrato", () => {
    const retorno = executavel.slice(executavel.indexOf("RETURN jsonb_build_object"));
    expect(retorno).toMatch(/s\.company_id\s+= p_company_id/);
    expect(retorno).toMatch(/s\.contract_id = p_contract_id/);
  });

  it("inclui rollback e validação", () => {
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.sync_contract_occurrences/);
    expect(sql).toMatch(/PASSO 2 — VALIDAÇÃO/);
    expect(sql).toMatch(/prosecdef/); // como confirmar que não é SECURITY DEFINER
  });
});
