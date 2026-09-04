# PAYROLL-SAFETY-01

## Contrato

Payroll records follow `rascunho -> aprovado -> pago`. Only draft values can
be changed. Unknown states, missing records, invalid totals, closed periods,
cross-company ids, and unauthorized actors fail closed.

Calculation, adjustment, approval, and payment use the candidate RPCs. The
lock helper follows the common 090 financial-period protocol.
Payment locks the financial period and payroll rows in one transaction, creates
at most one `payroll` cash entry, and writes its audit event in that transaction.
Retries are read-only once the paid state and matching cash entry exist.

The application resolves the actor through the authenticated user and its
profile/company role. The RPCs accept only a service-role execution path and
validate the actor/company pair again in the database.

## Verification

`src/__tests__/payroll-safety-postgres.test.ts` runs the migration in real
PostgreSQL and proves approval/payment atomicity, idempotent retry, two-session
payment concurrency, and the shared lock with period closing. Production
schema application remains DB-first and is intentionally outside this change.
The candidate has no assigned migration number and must be promoted only after
a fresh production-ledger read.
