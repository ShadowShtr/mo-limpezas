# PAYROLL-SAFETY-01

## Contrato

Payroll records follow `rascunho -> aprovado -> pago`. Only draft values can
be changed. Unknown states, missing records, invalid totals, closed periods,
cross-company ids, and unauthorized actors fail closed.

Calculation, adjustment, approval, and payment use the candidate RPCs. The
lock helper follows the common 090 financial-period protocol. Payment derives
one canonical lock set containing every payroll competence, every validated
existing cashflow date, and the date of a new cashflow. It then locks the
periods and payroll rows in one transaction, creates at most one `payroll` cash
entry with native UUID provenance, and writes a per-item audit event in that
transaction. Retries are read-only once the paid state and matching cash entry
exist.

An existing compatible cashflow may be explicitly adopted for an approved
payroll; its date is locked and preserved. A paid payroll without a compatible
cashflow, or any mismatch in company, reference, amount, type, category, or
status, fails closed.

The application resolves the actor through the authenticated user and its
profile/company role. The RPCs accept only a service-role execution path and
validate the actor/company pair again in the database.

## Verification

`src/__tests__/payroll-safety-postgres.test.ts` loads the production-schema
fixture, the real 024 reference index, and the canonical 090 migration before
running PAYROLL-SAFETY-01 in real PostgreSQL. It proves UUID compatibility,
approval/payment atomicity, idempotent retry, adoption, two-session payment
concurrency, multi-period locking, period closing, adjustment concurrency,
audit rollback, and response contracts. Production schema application remains
DB-first and is intentionally outside this change.
The candidate has no assigned migration number and must be promoted only after
a fresh production-ledger read.
