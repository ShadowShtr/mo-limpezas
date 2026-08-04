import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration065 = fs.readFileSync(path.join(root, "docs/atomicidade-audit/frozen/065_fix_domain_atomicity_outbox.sql"), "utf8");
const clientesAction = fs.readFileSync(path.join(root, "src/app/actions/clientes.ts"), "utf8");
const clientesTable = fs.readFileSync(
  path.join(root, "src/app/(dashboard)/dashboard/clientes/_components/table.tsx"),
  "utf8",
);

function bodyOf(sql: string, fnName: string) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = sql.indexOf("BEGIN", start);
  const bodyEnd = sql.indexOf("END;\n$$;", bodyStart);
  expect(bodyStart).toBeGreaterThan(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, bodyEnd);
}

function actionBody(name: string, nextName?: string) {
  const start = clientesAction.indexOf(`export async function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nextName
    ? clientesAction.indexOf(`export async function ${nextName}`, start)
    : clientesAction.length;
  expect(end).toBeGreaterThan(start);
  return clientesAction.slice(start, end);
}

describe("065 local static guards", () => {
  it("actions ativas nao chamam delete_client_atomic", () => {
    expect(clientesAction).not.toContain('rpc("delete_client_atomic"');
    expect(clientesAction).not.toContain("rpc('delete_client_atomic'");
  });

  it("deleteCliente chama delete_empty_client_atomic com actor, empresa, mutation id e revisao", () => {
    const body = actionBody("deleteCliente");

    expect(body).toContain('admin.rpc("delete_empty_client_atomic"');
    expect(body).toContain("p_company_id: profile.company_id");
    expect(body).toContain("p_actor: user.id");
    expect(body).toContain("p_mutation_id: mutationId");
    expect(body).toContain("p_expected_revision: expectedRevision");
    expect(body).toContain('code: "CLIENT_HAS_HISTORY"');
    expect(body).not.toContain("archiveCliente(");
    expect(body).not.toContain("archive_client_atomic");
  });

  it("archiveCliente chama archive_client_atomic com actor, empresa, mutation id e revisao", () => {
    const body = actionBody("archiveCliente", "updateCliente");

    expect(body).toContain('admin.rpc("archive_client_atomic"');
    expect(body).toContain("p_company_id: profile.company_id");
    expect(body).toContain("p_actor: user.id");
    expect(body).toContain("p_mutation_id: mutationId");
    expect(body).toContain("p_expected_revision: expectedRevision");
  });

  it("revisao critica nao e opcional nas actions nem nas RPCs", () => {
    expect(clientesAction).toContain("deleteCliente(id: string, expectedRevision: number");
    expect(clientesAction).toContain("archiveCliente(id: string, expectedRevision: number");
    expect(migration065).toContain("p_expected_revision bigint\n)");
    expect(migration065).not.toContain("p_expected_revision bigint DEFAULT NULL");
  });

  it("domain_mutations e a unica estrutura de idempotencia e usa succeeded/rejected", () => {
    expect(migration065).toContain("CREATE TABLE IF NOT EXISTS public.domain_mutations");
    expect(migration065).not.toContain("CREATE TABLE IF NOT EXISTS public.domain_mutation_receipts");
    expect(migration065).toContain("status text NOT NULL DEFAULT 'succeeded'");
    expect(migration065).toContain("CHECK (status IN ('succeeded', 'rejected'))");
    expect(migration065).toContain("UNIQUE(company_id, mutation_id)");
  });

  it("CLIENT_HAS_HISTORY usa recibo rejected sem evento, delete ou arquivamento", () => {
    const body = bodyOf(migration065, "delete_empty_client_atomic");
    const rejection = body.slice(body.indexOf("'CLIENT_HAS_HISTORY'"), body.indexOf("DELETE FROM public.services"));

    expect(rejection).toContain("'rejected'");
    expect(rejection).toContain("'client_id', p_client_id");
    expect(rejection).toContain("'revision', v_client.revision");
    expect(rejection).toContain("'history', v_history");
    expect(rejection).not.toContain("'completed'");
    expect(rejection).not.toContain("record_company_change_event");
    expect(rejection).not.toContain("DELETE FROM");
    expect(rejection).not.toContain("archive_client_atomic");
  });

  it("replay devolve recibo existente e conflito de mutation_id e estruturado", () => {
    const helper = bodyOf(migration065, "find_or_conflict_domain_mutation");

    expect(helper).toContain("RETURN v_existing.result");
    expect(helper).toContain("'MUTATION_REUSE_CONFLICT'");
    expect(helper).not.toContain("RAISE EXCEPTION 'MUTATION_REUSE_CONFLICT'");

    for (const fnName of ["set_invoice_status_atomic", "archive_client_atomic", "delete_empty_client_atomic"]) {
      const body = bodyOf(migration065, fnName);
      expect(body).toContain("public.find_or_conflict_domain_mutation");
      expect(body).toContain("IF v_existing IS NOT NULL THEN");
      expect(body).toContain("RETURN v_existing");
    }
  });

  it("RPCs criticas autorizam antes do lock e consultam recibo depois do lock", () => {
    for (const fnName of ["set_invoice_status_atomic", "archive_client_atomic", "delete_empty_client_atomic"]) {
      const body = bodyOf(migration065, fnName);
      const auth = body.indexOf("public.assert_company_manager");
      const lock = body.indexOf("public.lock_domain_mutation");
      const receipt = body.indexOf("public.find_or_conflict_domain_mutation");

      expect(auth).toBeGreaterThanOrEqual(0);
      expect(lock).toBeGreaterThan(auth);
      expect(receipt).toBeGreaterThan(lock);
      expect(body).toContain("'FORBIDDEN_ACTOR'");
      expect(body).toContain("'code', 'OK'");
      expect(body).toContain("'REVISION_CONFLICT'");
    }
  });

  it("delete_empty_client_atomic considera service_payment como historico", () => {
    const body = bodyOf(migration065, "delete_empty_client_atomic");

    expect(body).toContain("reference_type = 'service_payment'");
    expect(body).toContain("'CLIENT_HAS_HISTORY'");
    expect(body).toContain("'cash_flow_entries', v_cash_flow_history");
    expect(body).not.toContain("DELETE FROM public.cash_flow_entries");
  });

  it("065 remove qualquer trigger de fn_increment_revision e recria um canonico por tabela", () => {
    expect(migration065).toContain("FROM pg_trigger t");
    expect(migration065).toContain("p.proname = 'fn_increment_revision'");
    expect(migration065).toContain("DROP TRIGGER IF EXISTS %I ON public.%I");
    expect(migration065).toContain("CREATE TRIGGER %I BEFORE UPDATE ON public.%I");
    expect(migration065).toContain("IF v_count <> 1 THEN");

    for (const table of ["clients", "locations", "contracts", "services", "teams", "team_members", "invoices", "invoice_items"]) {
      expect(migration065).toContain(`'${table}'`);
      expect(migration065).toContain(`'trg_' || v_table || '_revision'`);
    }
  });

  it("065 interrompe conflito com outra funcao que altere revision", () => {
    expect(migration065).toContain("REVISION_TRIGGER_CONFLICT table=%, trigger=%, function=%");
    expect(migration065).toContain("pg_get_functiondef(p.oid)");
    expect(migration065).toContain("NEW.REVISION");
    expect(migration065).toContain("NOT (pn.nspname = 'public' AND p.proname = 'fn_increment_revision')");
  });

  it("UI gera nova mutation ID por acao e preserva textos UTF-8 esperados", () => {
    expect(clientesTable).toContain("deleteCliente(c.id, c.revision)");
    expect(clientesAction).toContain("mutationId = crypto.randomUUID()");
    expect(clientesTable).toContain("intervenções");
    expect(clientesTable).toContain("Esta ação não pode ser desfeita.");
    expect(clientesTable).toContain("Ainda não há clientes.");
    expect(clientesTable).toContain("Abrir ficha (locais, chave/código)");
    expect(clientesTable).toContain("—");
  });

  it("trechos modificados nao usam as any, as never ou comentarios de supressao", () => {
    const modified = [
      actionBody("archiveCliente", "updateCliente"),
      actionBody("deleteCliente"),
      bodyOf(migration065, "set_invoice_status_atomic"),
      bodyOf(migration065, "archive_client_atomic"),
      bodyOf(migration065, "delete_empty_client_atomic"),
    ].join("\n");

    expect(modified).not.toMatch(/\bas any\b/);
    expect(modified).not.toMatch(/\bas never\b/);
    expect(modified).not.toContain("@ts-ignore");
    expect(modified).not.toContain("@ts-expect-error");
  });

  it("RPC destrutiva antiga fica desativada e sem grants ao frontend", () => {
    expect(migration065).toContain("CREATE OR REPLACE FUNCTION public.delete_client_atomic");
    expect(migration065).toContain("DESTRUCTIVE_CLIENT_DELETE_DISABLED_USE_ARCHIVE_OR_DELETE_EMPTY");
    expect(migration065).toContain("REVOKE ALL ON FUNCTION public.delete_client_atomic");
    expect(migration065).not.toContain("GRANT EXECUTE ON FUNCTION public.delete_client_atomic");
  });

  it("query estatica de auditoria de triggers esta documentada", () => {
    expect(migration065).toContain("action_statement ILIKE '%fn_increment_revision%'");
  });
});
