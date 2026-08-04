import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

const { Client } = pg;

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SHARED_DATABASE_URL = process.env.SUPABASE_DB_URL;

if (!TEST_DATABASE_URL) {
  throw new Error("Defina TEST_DATABASE_URL para um banco descartavel.");
}

if (SHARED_DATABASE_URL && TEST_DATABASE_URL === SHARED_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL aponta para o banco compartilhado.");
}

const ssl = /supabase\.com|pooler\.supabase\.com/.test(TEST_DATABASE_URL)
  ? { rejectUnauthorized: false }
  : false;

function id() {
  return crypto.randomUUID();
}

async function connect() {
  const client = new Client({ connectionString: TEST_DATABASE_URL, ssl });
  await client.connect();
  return client;
}

async function q(client, text, params = []) {
  return client.query(text, params);
}

async function createAuthUser(client, userId, email) {
  await q(client, `
    INSERT INTO auth.users (
      id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    )
    VALUES (
      $1, 'authenticated', 'authenticated', $2, 'test', now(),
      '{}'::jsonb, '{}'::jsonb, now(), now()
    )
    ON CONFLICT (id) DO NOTHING
  `, [userId, email]);
}

async function seedCompany(client, suffix) {
  const companyId = id();
  const actorId = id();
  const clientId = id();
  const locationId = id();
  const invoiceId = id();

  await q(client, "INSERT INTO public.companies(id, name, slug) VALUES ($1, $2, $3)", [
    companyId,
    `065 Test ${suffix}`,
    `065-test-${suffix}-${Date.now()}`
  ]);
  await createAuthUser(client, actorId, `065-${suffix}@example.test`);
  await q(client, `
    INSERT INTO public.profiles(id, company_id, full_name, email, role)
    VALUES ($1, $2, $3, $4, 'gestor')
  `, [actorId, companyId, `Actor ${suffix}`, `065-${suffix}@example.test`]);
  await q(client, `
    INSERT INTO public.clients(id, company_id, name, status)
    VALUES ($1, $2, $3, 'ativo')
  `, [clientId, companyId, `Cliente ${suffix}`]);
  await q(client, `
    INSERT INTO public.locations(id, company_id, client_id, name, address)
    VALUES ($1, $2, $3, $4, 'Rua Teste')
  `, [locationId, companyId, clientId, `Local ${suffix}`]);
  await q(client, `
    INSERT INTO public.invoices(
      id, company_id, client_id, invoice_number, invoice_date, total, status
    )
    VALUES ($1, $2, $3, $4, current_date, 123.45, 'pendente')
  `, [invoiceId, companyId, clientId, `T-${suffix}`]);

  return { companyId, actorId, clientId, locationId, invoiceId };
}

async function invoiceRevision(client, invoiceId) {
  const res = await q(client, "SELECT revision FROM public.invoices WHERE id = $1", [invoiceId]);
  return Number(res.rows[0].revision);
}

async function callInvoice(client, f, mutationId, status, expectedRevision, method = "transferencia") {
  const res = await q(client, `
    SELECT public.set_invoice_status_atomic($1, $2, $3, $4, $5, $6, $7) AS result
  `, [f.invoiceId, f.companyId, f.actorId, status, method, mutationId, expectedRevision]);
  return res.rows[0].result;
}

async function expectPgError(promise, message) {
  try {
    await promise;
  } catch (err) {
    assert.match(err.message, new RegExp(message));
    return;
  }
  throw new Error(`Esperava erro ${message}`);
}

async function main() {
  const admin = await connect();
  try {
    const a = await seedCompany(admin, "a");
    const b = await seedCompany(admin, "b");

    const beforeSeq = await q(admin, `
      SELECT sequence FROM public.company_sync_state WHERE company_id = $1
    `, [a.companyId]);
    const beforeValue = beforeSeq.rows[0]?.sequence ?? null;

    await q(admin, "BEGIN");
    await q(admin, "SELECT public.next_company_sequence($1)", [a.companyId]);
    await q(admin, `
      INSERT INTO public.company_change_events(
        company_id, sequence, mutation_id, domain, event_type, entity_ids, scopes, payload
      )
      VALUES ($1, 999, $2, 'test', 'rollback_probe', ARRAY[$3]::uuid[], ARRAY['test'], '{}')
    `, [a.companyId, id(), a.invoiceId]);
    await q(admin, "ROLLBACK");

    const afterRollback = await q(admin, `
      SELECT sequence FROM public.company_sync_state WHERE company_id = $1
    `, [a.companyId]);
    assert.equal(afterRollback.rows[0]?.sequence ?? null, beforeValue);
    const rollbackEvents = await q(admin, `
      SELECT count(*)::int AS count
      FROM public.company_change_events
      WHERE company_id = $1 AND event_type = 'rollback_probe'
    `, [a.companyId]);
    assert.equal(rollbackEvents.rows[0].count, 0);

    const mut = id();
    const rev = await invoiceRevision(admin, a.invoiceId);
    const c1 = await connect();
    const c2 = await connect();
    try {
      const [r1, r2] = await Promise.all([
        callInvoice(c1, a, mut, "pago", rev),
        callInvoice(c2, a, mut, "pago", rev)
      ]);
      assert.deepEqual(r1, r2);
      assert.equal(r1.invoice.status, "pago");
      assert.equal(Number(r1.invoice.revision), rev + 1);
    } finally {
      await c1.end();
      await c2.end();
    }

    const eventCount = await q(admin, `
      SELECT count(*)::int AS count
      FROM public.company_change_events
      WHERE company_id = $1 AND mutation_id = $2
    `, [a.companyId, mut]);
    assert.equal(eventCount.rows[0].count, 1);

    const cashCount = await q(admin, `
      SELECT count(*)::int AS count
      FROM public.cash_flow_entries
      WHERE company_id = $1 AND reference_type = 'invoice' AND reference_id = $2
    `, [a.companyId, a.invoiceId]);
    assert.equal(cashCount.rows[0].count, 1);

    await expectPgError(
      callInvoice(admin, a, mut, "pendente", rev),
      "MUTATION_REUSE_CONFLICT"
    );

    await expectPgError(
      callInvoice(admin, a, id(), "pendente", rev),
      "REVISION_CONFLICT"
    );

    const revPaid = await invoiceRevision(admin, a.invoiceId);
    await callInvoice(admin, a, id(), "pago", revPaid);
    const cashAfterRepeatPayment = await q(admin, `
      SELECT count(*)::int AS count
      FROM public.cash_flow_entries
      WHERE company_id = $1 AND reference_type = 'invoice' AND reference_id = $2
    `, [a.companyId, a.invoiceId]);
    assert.equal(cashAfterRepeatPayment.rows[0].count, 1);

    const revPaidAgain = await invoiceRevision(admin, a.invoiceId);
    await callInvoice(admin, a, id(), "pendente", revPaidAgain, null);
    const cashAfterUnpay = await q(admin, `
      SELECT count(*)::int AS count
      FROM public.cash_flow_entries
      WHERE company_id = $1 AND reference_type = 'invoice' AND reference_id = $2
    `, [a.companyId, a.invoiceId]);
    assert.equal(cashAfterUnpay.rows[0].count, 0);

    const bRev = await invoiceRevision(admin, b.invoiceId);
    const rb = await callInvoice(admin, b, id(), "pago", bRev);
    assert.equal(Number(rb.sequence), 1);

    const aState = await q(admin, "SELECT sequence FROM public.company_sync_state WHERE company_id = $1", [a.companyId]);
    const bState = await q(admin, "SELECT sequence FROM public.company_sync_state WHERE company_id = $1", [b.companyId]);
    assert.equal(Number(bState.rows[0].sequence), 1);
    assert.ok(Number(aState.rows[0].sequence) >= 3);

    await expectPgError(
      q(admin, `
        SELECT public.set_invoice_status_atomic($1, $2, $3, 'pago', NULL, $4, $5)
      `, [a.invoiceId, a.companyId, b.actorId, id(), await invoiceRevision(admin, a.invoiceId)]),
      "ACTOR_COMPANY_MISMATCH"
    );

    const roleCheck = await q(admin, "SELECT 1 FROM pg_roles WHERE rolname = 'anon'");
    if (roleCheck.rowCount === 1) {
      const anonRevision = await invoiceRevision(admin, a.invoiceId);
      await q(admin, "SET ROLE anon");
      await expectPgError(
        q(admin, `
          SELECT public.set_invoice_status_atomic($1, $2, $3, 'pago', NULL, $4, $5)
        `, [a.invoiceId, a.companyId, a.actorId, id(), anonRevision]),
        "permission denied|must be owner|does not exist"
      );
      await q(admin, "RESET ROLE");
    }

    const historyClient = await seedCompany(admin, "history");
    const serviceId = id();
    await q(admin, `
      INSERT INTO public.services(
        id, company_id, location_id, reference_number, scheduled_start, scheduled_end, status
      )
      VALUES ($1, $2, $3, $4, now() - interval '1 day', now(), 'concluido')
    `, [serviceId, historyClient.companyId, historyClient.locationId, `S-${serviceId.slice(0, 8)}`]);
    await expectPgError(
      q(admin, `
        SELECT public.delete_empty_client_atomic($1, $2, $3, $4, $5)
      `, [
        historyClient.clientId,
        historyClient.companyId,
        historyClient.actorId,
        id(),
        await q(admin, "SELECT revision FROM public.clients WHERE id = $1", [historyClient.clientId]).then(r => r.rows[0].revision)
      ]),
      "CLIENT_HAS_HISTORY"
    );

    const archiveClient = await seedCompany(admin, "archive");
    const contractId = id();
    const futureServiceId = id();
    await q(admin, `
      INSERT INTO public.contracts(id, company_id, location_id, frequency, schedule_days, starts_on, status)
      VALUES ($1, $2, $3, 'weekly', '[]'::jsonb, current_date, 'ativo')
    `, [contractId, archiveClient.companyId, archiveClient.locationId]);
    await q(admin, `
      INSERT INTO public.services(
        id, company_id, location_id, contract_id, reference_number, scheduled_start, scheduled_end, status
      )
      VALUES ($1, $2, $3, $4, $5, now() + interval '1 day', now() + interval '1 day 1 hour', 'agendado')
    `, [futureServiceId, archiveClient.companyId, archiveClient.locationId, contractId, `S-${futureServiceId.slice(0, 8)}`]);
    const archiveRev = await q(admin, "SELECT revision FROM public.clients WHERE id = $1", [archiveClient.clientId]).then(r => r.rows[0].revision);
    const archived = await q(admin, `
      SELECT public.archive_client_atomic($1, $2, $3, $4, $5) AS result
    `, [archiveClient.clientId, archiveClient.companyId, archiveClient.actorId, id(), archiveRev]);
    assert.equal(archived.rows[0].result.client.status, "inativo");

    const emptyClient = await seedCompany(admin, "empty");
    await q(admin, "DELETE FROM public.invoices WHERE id = $1", [emptyClient.invoiceId]);
    const emptyRev = await q(admin, "SELECT revision FROM public.clients WHERE id = $1", [emptyClient.clientId]).then(r => r.rows[0].revision);
    const deleted = await q(admin, `
      SELECT public.delete_empty_client_atomic($1, $2, $3, $4, $5) AS result
    `, [emptyClient.clientId, emptyClient.companyId, emptyClient.actorId, id(), emptyRev]);
    assert.equal(deleted.rows[0].result.client_id, emptyClient.clientId);

    console.log("065 PostgreSQL tests passed");
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
