import pg from "pg";
import { randomUUID } from "node:crypto";
const PORT = process.argv[2];
const COMPANY = "11111111-1111-4111-8111-111111111111";
const LOCK = 81082026;
const pool = new pg.Pool({ host: "127.0.0.1", port: +PORT, user: "postgres", database: "smoke", max: 12 });

async function reset() {
  await pool.query("TRUNCATE cash_flow_entries, fixed_variable_payments, companies CASCADE");
  await pool.query("DROP TRIGGER IF EXISTS pause_rpc_cash_insert ON cash_flow_entries");
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'T')", [COMPANY]);
}
async function race(over) {
  await reset();
  const pid = randomUUID();
  await pool.query(`INSERT INTO fixed_variable_payments(id,company_id,kind,description,amount,status,recurring,period_year,period_month) VALUES($1,$2,'variavel','Race payment',100,'pendente',false,2026,7)`, [pid, COMPANY]);
  await pool.query(`
    CREATE OR REPLACE FUNCTION pause_rpc_cash_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.description='Race payment' THEN PERFORM pg_advisory_xact_lock(${LOCK}); END IF; RETURN NEW; END $fn$;
    CREATE TRIGGER pause_rpc_cash_insert BEFORE INSERT ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION pause_rpc_cash_insert();`);
  const blocker = new pg.Client({ host:"127.0.0.1", port:+PORT, user:"postgres", database:"smoke" });
  const actor = new pg.Client({ host:"127.0.0.1", port:+PORT, user:"postgres", database:"smoke", application_name:"race-actor" });
  await blocker.connect(); await actor.connect();
  let outcome;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    const marking = actor.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [COMPANY, pid, "2026-08-26"]).then(r=>({ok:r}),e=>({err:e}));
    const dl = Date.now()+10000;
    while (Date.now()<dl) { const r = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name='race-actor' AND wait_event_type='Lock' AND wait_event='advisory'`); if (r.rowCount===1) break; await new Promise(x=>setTimeout(x,20)); }
    const intruder = randomUUID();
    await pool.query(`INSERT INTO cash_flow_entries(id,company_id,type,amount,description,category,date,reference_type,reference_id,status) VALUES($1,$2,$3,$4,'Concurrent incompatible row','despesa','2026-07-10','fixed_variable_payment',$5,$6)`,
      [intruder, over.company_id??COMPANY, over.type??"saida", over.amount??100, pid, over.status??"pendente"]);
    await blocker.query("COMMIT");
    outcome = await marking;
    const pay = (await pool.query("SELECT status FROM fixed_variable_payments WHERE id=$1",[pid])).rows[0];
    const rows = (await pool.query("SELECT id::text,type,amount::text,status FROM cash_flow_entries WHERE reference_id=$1",[pid])).rows;
    return { outcome, pay, rows, intruder };
  } finally { try{await blocker.query("ROLLBACK")}catch{}; await blocker.end(); await actor.end(); }
}
const cases = [["wrong type",{type:"entrada"}],["wrong amount",{amount:999}],["wrong status",{status:"pendente"}]];
let allGood = true;
for (const [label, over] of cases) {
  const r = await race(over);
  const blocked = !!r.outcome.err;
  const code = r.outcome.err?.message ?? "ACEITE (BUG)";
  const payOk = r.pay.status === "pendente";
  const ok = blocked && payOk;
  if (!ok) allGood = false;
  console.log(`${ok?"PASS":"FAIL"} | ${label.padEnd(13)} | rpc=${blocked?"RAISED":"accepted"} | ${code.slice(0,40).padEnd(40)} | payment=${r.pay.status}`);
}
// caso legitimo: linha concorrente CORRETA deve ser adotada, nao rejeitada
const good = await race({});
const okGood = !good.outcome.err && good.pay.status==="pago" && good.rows.length===1 && good.rows[0].status==="confirmado" && good.rows[0].id===good.intruder;
if (!okGood) allGood=false;
console.log(`${okGood?"PASS":"FAIL"} | ${"compatible row".padEnd(13)} | adopted=${good.rows[0]?.id===good.intruder} | status=${good.rows[0]?.status} | payment=${good.pay.status}`);
await pool.end();
console.log(allGood ? "\nF14_A = FIXED_AND_FAIL_CLOSED" : "\nF14_A = STILL_BROKEN");
process.exit(allGood?0:1);
