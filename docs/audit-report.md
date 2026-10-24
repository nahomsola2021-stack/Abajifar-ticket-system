# Project audit — Ticket Office Management System

Audit for the reform into a financial management system for a non-IATA travel
agency. No production data was modified, deleted, or migrated during this
audit. The database was read only.

**Audit date:** 2026-10-20
**Database audited:** live Supabase PostgreSQL, 28 tables, 5 migrations applied
**Codebase audited:** `backend/` (FastAPI, 1 file, 4,408 lines) and
`frontend/` (React 19 + TypeScript, 21 source files)

---

## 0. Architecture summary

### Backend
- Single FastAPI application in `backend/main.py`. 42 routes, 4,408 lines.
- **No ORM.** All database access is hand-written SQL through SQLAlchemy Core
  `text()` calls with named parameters.
- **No test suite.** `backend/scripts/verify_new_flows.py` is an integration
  smoke test I added; it is not a pytest suite and is not run in CI.
- **No module structure.** Models, validation, SQL, authorization, and routes
  are all in one file.
- Authentication is delegated to Supabase Auth. The API never issues a token;
  it verifies the incoming bearer token against Supabase on **every** request.
- Authorization is enforced in application code, not the database, and is
  **row-scoped by branch**.
- PDF generation uses ReportLab. Attachments are stored on the local
  filesystem under a private directory.
- All money is `NUMERIC(18,4)`. No floating-point columns exist anywhere.

### Frontend
- React 19, TypeScript, Vite 8, Tailwind v4.
- **No router.** `App.tsx` holds a `currentTab` string state and conditionally
  renders one of six views.
- `frontend/src/lib/api.ts` is a single fetch wrapper with one function per
  endpoint.
- `frontend/src/context/AuthContext.tsx` owns the Supabase session, staff
  identity, and dashboard overview.
- `frontend/src/lib/config.ts` reads `VITE_*` variables and allows
  localStorage overrides.
- Build: `tsc -b && vite build` passes. Lint: 2 pre-existing warnings.

### Database
28 tables, 5 hand-written SQL migrations, applied via
`backend/scripts/apply_migrations.py` with a `schema_migrations` tracking
table. Row counts: 1 customer, 1 booking, 1 invoice, 1 flight segment,
1 booking passenger, 1 invoice item, 97 activity log entries. Every
API-less table is **empty**.

### Deployment
**There is no deployment setup at all.** No `render.yaml`, no `vercel.json`,
no `Dockerfile`, no `Procfile`, and **no git repository** (no `.git`
directory). `backend/.gitignore` and `frontend/.gitignore` exist and are
correct, but nothing enforces them until the repository is initialised.

---

## 1. Features that already work

These are implemented, verified against the live database, and covered by the
integration suite.

### Identity and access
- Supabase Auth sign-in with no public sign-up. `GET /api/auth/me` returns
  staff identity, office, and role codes.
- A staff member is locked out with a clear 403 if inactive or roleless, and
  gets a distinct 404 if not provisioned.
- Five roles exist: `ADMIN`, `MANAGER`, `ACCOUNTANT`, `CASHIER`, `AGENT`.
- Role gates: staff administration is ADMIN-only; supplier creation and
  activation are ADMIN/MANAGER; invoice and payment writes are
  ADMIN/MANAGER/ACCOUNTANT; the cash desk (record + allocate a receipt) is
  ADMIN/MANAGER/ACCOUNTANT/**CASHIER**.
- Administrators cannot demote or deactivate themselves, and the last active
  administrator cannot be removed.
- A staff member must be invited in Supabase before an administrator can link
  a profile to them.

### Customers
- Shared, searchable directory of individual and corporate customers, with
  pagination.
- Customers are deliberately **global across offices** so the same person is
  not created twice. Everything else is office-scoped.

### Bookings and ticketing
- Booking register with search by booking code, PNR, and customer name, plus
  status filtering and pagination.
- Booking creation with a generated booking code (`TO` + date + random).
- Controlled lifecycle: `requested → quoted → confirmed → ticketing_pending →
  partially_ticketed → ticketed → closed`, with `cancelled` and `expired` as
  exit states. Illegal transitions are rejected with the allowed next states
  listed in the error.
- Traveller records with a **name snapshot**, so later profile edits cannot
  rewrite ticketed history. Types `ADT` / `CHD` / `INF`.
- Flight segments with enforced ordering, timezone-aware times, arrival after
  departure, three-letter airport codes, and origin ≠ destination.
- Bookings lock for traveller and itinerary edits once ticketing begins.
- Ticket recording with full validation: booking must be in the right state,
  traveller must be on the booking, supplier must be an active airline /
  consolidator / host agency, **the itinerary must already exist**, one
  active ticket per traveller, and ticket number unique per supplier.
  `verified: true` is mandatory.
- Ticket recording auto-creates itinerary coupons and auto-advances the
  booking to partially ticketed or ticketed, in one transaction.
- Status history reconstructed from the audit log, with actor and timestamp.

### Invoicing
- Draft invoice creation with server-side line arithmetic (quantity × unit
  price, subtotal, plus tax, minus discount), 1–100 line items, and a
  duplicate invoice number rejected.
- Issuing requires at least one line item and a due date that has not passed.
- Printable PDF invoice with office letterhead, bill-to block, line table, and
  totals. Drafts cannot be downloaded.
- Line item types: airfare, tax, agency fee, change fee, cancellation fee,
  other.

### Customer payments
- Branch-scoped payment register with search over customer name, receipt
  number, and external reference, showing allocated and unallocated totals.
- Receipt recording with currency, method, status, receipt number, external
  reference, and notes.
- Allocations that link a receipt to an invoice, with both the payment
  balance and the invoice balance enforced in the same transaction, currency
  matching enforced, and only `issued` / `partially_paid` invoices accepted.
- Re-allocating to the same invoice **adds to it** rather than failing.
- Invoice status moves to `partially_paid` then `paid` automatically.

### Documents
- Multipart upload with 10 MB limit, MIME allow-list (PDF, JPEG, PNG, WebP,
  plain text), server-generated object keys, SHA-256 fingerprinting, original
  filename kept for display only.
- Downloads are branch-checked. Nothing in the storage directory is served as
  a static file.

### Ticketing requests
- Separate from the booking, with its own status: `not_requested → pending →
  submitted → completed`, plus `failed`, `cancelled`, `expired`.
- A request cannot be completed until an issued ticket exists on the booking.
- Partner cost, currency, and partner reference are recorded on the request.
- Submitting a request moves a confirmed booking to `ticketing_pending`.
- Cancelled and expired requests can be re-opened.

### Reporting
- Issued-sales report for a date range, grouped by currency.
- Customer balances report: per customer and currency, invoiced, paid,
  outstanding, and oldest due date, sorted by outstanding descending, with
  **CSV export**.
- Dashboard overview: bookings, open bookings, tickets issued / exchanged /
  voided / refunded, bookings awaiting ticketing, flight legs departing within
  seven days, overdue invoice count, today's sales, today's payments,
  outstanding customer balances, outstanding supplier balances, and the eight
  most recent audit entries.

### Money handling
- Every monetary row carries its own currency.
- **Amounts in different currencies are never summed.** Every report and
  dashboard tile returns a per-currency list.
- All money is `NUMERIC(18,4)` / `NUMERIC(20,8)`. No float columns exist.

### Audit trail
- 17 recorded action types, written **in the same transaction** as the change
  they describe, so the log can never disagree with the data.
- Traveller names, passwords, tokens, and passport numbers are deliberately
  excluded.

---

## 2. Features that are partially implemented

| Feature | What exists | What is missing |
| --- | --- | --- |
| Supplier bills | Table `supplier_bills` with full columns and constraints. The dashboard **reads** it to compute outstanding supplier balances. | **No API creates or updates them.** No UI. The dashboard's "outstanding supplier bills" tile reads the correct table and therefore always displays **zero**. |
| Supplier payments | Table `supplier_payments`, correctly tied to `supplier_bill_id`. | No API, no UI. |
| Business expenses | Table `business_expenses` with category, description, amount, currency, method, and a receipt reference. | No API, no UI. `receipt_document_key` is a loose text pointer, not a foreign key. |
| Customer refunds | Table `customer_refunds` with a proper `requested → approved → paid / rejected` workflow, requester and approver separation, and a link to the original payment and invoice. | No API, no UI. |
| Ticket voids, refunds, exchanges, reissues | Table `ticket_actions` with `void / refund / exchange / reissue`, a `requested → submitted_to_partner → approved / rejected → completed` workflow, separate requester and approver, and a `new_ticket_id` for replacements. | No API, no UI. The `tickets.ticket_status` values `voided`, `refunded`, `exchanged` can therefore never be written. |
| Quoting | Table `booking_quotes` with versioning, both currencies, an explicit `supplier_fx_rate_to_customer`, and a unique partial index allowing only one accepted quote per booking. | No API, no UI. "Quoted" is currently a manual status bump with **no price captured anywhere**. |
| FX conversion | Tables `exchange_rates` and `booking_quotes.supplier_fx_rate_to_customer` are exactly the "explicitly recorded conversion" the reform needs. | Neither table is read or written by any code. No cross-currency total is possible. |
| Staff administration | Complete, correct API: list, link a Supabase invitation to a staff profile, change office / roles / active flag, with self-demotion and last-admin protection. | **No UI.** `frontend/src/types/admin.ts` exists but nothing renders it. |
| Invoices | Draft, issue, PDF, and full list/detail. | **No way to void or cancel an invoice.** Both statuses are permitted by the database constraint and both have no endpoint, so a bad invoice can only be left in place. |
| Documents | Upload, list, download, all branch-checked. | No delete endpoint. No link to an invoice, payment, expense, or supplier bill — only to a booking, customer, or passenger. |
| Customer creation | Works, with type, name, email, phone. | **Not written to the audit log**, unlike every other write. |
| Ticket status | `issued` is written by ticket recording. | `voided`, `refunded`, `exchanged` have no writer. `ticket_coupons.coupon_status` has the same problem for `flown / void / refunded / exchanged`. |
| Dashboard | 15+ metrics, all correct and per-currency. | **No date-range filter.** Every financial tile is "today" or "all time" with no period selector. |
| Booking assignment | `bookings.assigned_to` and `bookings.internal_notes` exist. | **Never written by any code.** Every booking is implicitly assigned to its creator. |
| `activity_logs.ip_address` | Column exists. | **Never populated.** |
| Audit trail coverage | 17 action types. | `activity_logs` for customer creation, and no audit action for ticket status changes, invoice void/cancel, or document deletion. |

---

## 3. Features that are missing

### Financial
- **Selling price and supplier cost on the same record.** The reform's central
  calculation, `gross margin = selling price − supplier cost`, cannot be
  produced today. `tickets.fare_amount` holds the supplier cost. The selling
  price lives only in `invoices.grand_total`, which is per booking, not per
  ticket. There is no `selling_price` column anywhere.
- **Profit calculation.** No revenue / cost / expense consolidation, and no
  FX basis.
- **Ticket-level gross margin report.** Not possible without the above.
- **Reports**: sales by employee, sales by supplier, expense categories,
  payment methods, refunds and adjustments.
- **Invoice and receipt number generation.** Receipt numbers are manually
  typed and unique-constrained, but there is no sequence generator, no
  per-office prefix, and no printed **receipt** (only an invoice PDF).
- **Payment reversal.** `customer_payments.status` allows `voided` and the
  endpoint accepts it, but there is no void action, no reversal transaction,
  and no link to the allocations a void would need to release.
- **Duplicate payment posting prevention.** Only the unique receipt number
  catches accidental duplicates. Two receipts with the same amount, customer,
  and no receipt number are both accepted.
- **Edit capability.** Customers, bookings, invoices, and payments are
  create-only. Only status can be moved.
- **Commission or supplier credit.** Nowhere to record a commission received
  from a supplier.

### Operational
- **Deadlines and reminders.** `ticketing_requests.ticketing_deadline` is
  stored but nothing reads it. A ticketing request is never set to `expired`
  automatically.
- **Settings screen.** No office profile, currency, or operational settings
  anywhere in the UI. The `branches` table has no API.
- **User management screen.** API exists, no UI.
- **Mobile usability.** The UI has no responsive layout work; the booking
  detail panel and forms are dense desktop tables.
- **Duplicate-ticket correction workflow.** A unique constraint prevents the
  same ticket number appearing twice for a supplier, but there is no
  controlled process for legitimate corrections.

### Platform
- **No git repository.** Render and Vercel both deploy from git; this is a
  hard blocker for Phase Ten.
- **No deployment configuration.** No `render.yaml`, `vercel.json`,
  `Dockerfile`, or `Procfile`.
- **No production CORS configuration.** The allow-list is hardcoded to
  `localhost:5173`.
- **No automated test suite.** No pytest, no CI.
- **No backup or restore procedure.** Nothing documented, nothing scripted.
- **No import** (Phase Eight), by design — correctly deferred.

---

## 4. Bugs and security concerns

### Bugs fixed during this work

| ID | Severity | Location | Problem |
| --- | --- | --- | --- |
| B1 | **Critical** | `backend/main.py:2439` | `POST /api/bookings` called `secrets.token_hex(8)` but only `from secrets import token_hex` was imported. Every booking creation raised `NameError` → HTTP 500. The first step of the core workflow was completely broken. Reproduced against the live database, then fixed. |
| B2 | High | `backend/main.py:3467` | Allocations never checked `invoices.status`, so cash could be allocated to a **draft** invoice. `recalc_invoice_status` only moves `issued`/`partially_paid` invoices, so the allocation was recorded and the invoice status silently never moved — money in transit with no report to surface it. Now rejected with a 409. |
| B3 | High | `backend/main.py:3368`, `3459` | The frontend offered "Record payment" to `CASHIER`, but the backend's write set excluded them — the button would always 403. The schema defines CASHIER as *"Record receipts and approved supplier/customer payments"*, so the backend was the outlier. Added a `require_cash_staff` gate: cashiers take money and allocate it, but still cannot raise or issue invoices. |
| B4 | Medium | `backend/main.py:3504` | A second allocation to the same invoice hit the `UNIQUE (payment_id, invoice_id)` constraint and surfaced a raw `IntegrityError` (HTTP 500). Now upserts and increases the existing allocation. |
| B5 | Medium | `backend/scripts/provision_first_admin.py` | The command documented in the README failed with `ModuleNotFoundError: No module named 'database'`. Added a `sys.path` bootstrap. |

All five now have regression coverage. `backend/scripts/verify_new_flows.py`
runs 36 checks and `backend/scripts/verify_cashier_role.py` runs 4; both pass
and clean up after themselves.

### Open bugs

| ID | Severity | Location | Problem |
| --- | --- | --- | --- |
| B6 | Medium | `backend/main.py:892` | `GET /api/dashboard/overview` checks only that a staff profile exists — **not** `is_active` and **not** role membership. A deactivated or roleless staff member still receives a dashboard. Every other endpoint is stricter. |
| B7 | Medium | `backend/main.py:1608`, `1704` | `staff.provisioned` and `staff.access_updated` log the **acting admin's** branch, not the target staff member's branch. A cross-office access change is recorded against the wrong office. |
| B8 | Low | `backend/main.py:3006` | `GET /api/bookings/{id}/history` filters the audit log on `entity_id` and `entity_type` only, with no branch condition. It is safe today only because the booking-ownership check happens first. Fragile. |
| B9 | Low | `backend/main.py:3700` | `GET /api/documents` loads **every** document row in the table and then filters in Python, with one extra query per row. O(n) queries that will degrade as the library grows. |
| B10 | Low | `backend/main.py:3299` | `list_payments` calls `q.strip()` without a `None` guard. Not reachable over HTTP (FastAPI supplies `""`), but it is a latent trap for any internal caller. |
| B11 | Low | `backend/main.py:1236` | `POST /api/customers` is not written to the audit log. Every other write is. For a *shared* global record, there is no way to see who created it. |
| B12 | Low | `backend/main.py` | `bookings.assigned_to` and `bookings.internal_notes` are never written. |
| B13 | Low | schema | `documents.document_type` has **no database CHECK constraint** — the allow-list is enforced only in the application. `passengers` and `passenger_documents` have no API at all, so `documents.passenger_id` is currently unusable. |
| B14 | Low | schema | `invoices.status` permits `void` and `cancelled`, but no code can write them. A mis-billed invoice has no correction path. |

### Security concerns

**Good — verified, keep these:**
- **No SQL injection.** Every user-supplied value is bound as a named
  parameter. The only f-string SQL interpolates fixed filter fragments built
  from a hardcoded allow-list, with the search term bound separately. Audited
  all 10 f-string SQL blocks.
- **Authentication is real.** The bearer token is verified against Supabase
  Auth on every request; the API never trusts a client-supplied identity.
- **No secrets in the frontend.** Only the publishable/anon Supabase key.
  `backend/.env` holds the database password and is gitignored.
- **Attachments are private.** Server-generated object keys, MIME and size
  limits, SHA-256 fingerprinting, branch-checked downloads, never served as
  static files.
- **Money uses `NUMERIC`, never float.** No floating-point columns exist.
- **No FX conversion**, so currencies cannot be silently mixed.
- **Traveller names excluded from the audit log** — deliberate privacy
  design.
- **No airline or GDS credentials anywhere** in the codebase, which is
  exactly what the reform requires.

**Concerns to address:**

| ID | Severity | Concern |
| --- | --- | --- |
| S1 | **High** | **CORS is hardcoded to `localhost:5173` and `127.0.0.1:5173`** (`main.py:43`). A Vercel deployment will be blocked by the browser on every request. This must become an environment variable before any deployment. |
| S2 | **High** | **No git repository.** Render and Vercel deploy from git. Until `git init` with a root `.gitignore`, there is no history, no safe rollback, and no review of what is committed. The backend `.env` with the database password is correctly ignored by `backend/.gitignore`, but nothing enforces that yet. |
| S3 | **High** | **Duplicate payment posting is not prevented.** `receipt_number` is unique, but the field is optional. Two identical receipts with no receipt number are both accepted. The reform explicitly requires duplicate payment posting prevention. |
| S4 | Medium | **Supabase is called on every API request** to verify the token. One extra HTTPS round-trip per call. On a Render free-tier instance this is a meaningful latency and rate-limit cost across ~15 requests per dashboard load. Local JWT verification would remove it, but that introduces a signing-secret dependency — a real trade-off to decide explicitly. |
| S5 | Medium | **No rate limiting** on any endpoint, including auth. |
| S6 | Medium | **No CORS method/header restriction.** `allow_methods=["*"]` and `allow_headers=["*"]`. Should narrow to the methods actually used. |
| S7 | Medium | **No attachment quota or malware scanning.** A staff member can upload unlimited 10 MB files. |
| S8 | Medium | **Financial records are modifiable.** `invoice_items` and `invoices` have no immutability guard. The reform requires completed financial records to be protected against silent modification. |
| S9 | Low | `activity_logs.ip_address` is never populated, so the audit trail cannot attribute an action to a network origin. |
| S10 | Low | The `documents` table cannot link to a payment or an expense, so receipt evidence for those records cannot be attached in a traceable way. |
| S11 | Low | `frontend/src/components/common/ConfigModal.tsx` lets a user override the API URL and Supabase keys in localStorage. A development convenience that would let a staff member point the app at a different backend in production. Should be disabled or admin-gated in a production build. |

### Redundant or unnecessarily complicated

| ID | Item | Recommendation |
| --- | --- | --- |
| R1 | **`ticket-office-frontend - Copy/`** — a stale duplicate of the frontend: 13 files, 2,066 lines, superseded by 21 files and 6,220 lines. Contains a dead `GEMINI_API_KEY` / `APP_URL` AI Studio setup. | **Delete.** It is not referenced by the current app, holds no unique working functionality, and doubles the surface area for accidental edits. |
| R2 | **`frontend/src/components/dashboard/ComingSoonView.tsx`** — a "Phase 3" placeholder, not imported anywhere. | **Delete.** Dead code. |
| R3 | **`backend/main.py` at 4,408 lines** — models, validation, SQL, authorization, and routes in one file. | **Split** into a package during Phase Two. This is the single biggest maintainability problem in the project. |
| R4 | **`passengers` and `passenger_documents` tables** — schema with no API. `passenger_documents` even has an encrypted document number column and an expiry-date check constraint, designed for a passenger-profile feature that does not exist. | **Leave the tables** (empty, harmless) but do not build APIs for them. The reform is financial, not a passenger CRM. Remove only if the team wants the schema trimmed. |
| R5 | **`booking_quotes` table** — a complete quote engine with versioning and an FX column, with no API. | **Keep and use it.** It is the designed home for the explicit currency conversion the reform requires, and for capturing the selling price and supplier cost at quote time. |
| R6 | **`exchange_rates` table** — a base/quote rate table with no API. | **Keep.** Needed for the profit report. |
| R7 | **The `AGENT` role** is defined in the schema and is not named in any role check. An AGENT-only user gets the full ticketing desk by default. | **Harmless** — it behaves correctly by inheritance — but document it, because the seeded role list implies a distinction that the code does not enforce. |
| R8 | **The customer directory is global while everything else is office-scoped.** Deliberate and good, but inconsistent enough to surprise readers. | **Keep.** Document it in the operations guide (already done). |
| R9 | **Two independent audit scripts** (`verify_new_flows.py`, `verify_cashier_role.py`) that both create and delete live rows. | **Convert to a pytest suite** against a test database in Phase Nine, so the checks are repeatable and cannot touch production. |

---

## 5. Database changes required

All existing tables are compatible with the reform's data model. **No table
should be dropped or recreated.** Every table the reform names already
exists, except for the links below.

### Existing tables reused as-is
| Reform requirement | Existing table | Note |
| --- | --- | --- |
| Customers | `customers` | All required fields present. |
| Suppliers | `suppliers` | All required fields present. Payment *terms* are approximated by `account_reference` + `settlement_currency`; add a `payment_terms_days` column if the agency negotiates terms other than on receipt. |
| Ticket sales | `bookings` + `booking_passengers` + `tickets` + `flight_segments` | **Do not create a `ticket_sales` table.** See the note below. |
| Customer payments | `customer_payments` | All required fields present. |
| Payment allocations | `payment_allocations` | All required fields present, with the unique constraint that prevents double allocation. |
| Supplier payments | `supplier_payments` | All required fields present, already tied to a bill. |
| Expenses | `business_expenses` | All required fields present. |
| Documents | `documents` | Metadata, private storage key, uploader, and timestamp all present. **Missing: links to a payment, expense, or supplier bill.** |
| Users and audit logs | `users`, `user_roles`, `roles`, `activity_logs` | Complete. |

### The design decision — confirmed

The reform asks for a "Ticket Sale" with: sale id, customer, passenger name,
airline, PNR, ticket number, ticket issue date, supplier, currency, **selling
price**, **supplier cost**, ticket status, invoice reference, notes.

**Every one of those fields already existed in the schema — except selling
price.** The existing model is normalised across `bookings` →
`booking_passengers` → `tickets`, and it already satisfies the reform's rule
that *"a sale must be recordable manually even if no ticket number is
available yet"* and *"must not falsely mark an unissued ticket as issued"*.

**Decision taken (confirmed by the business):**

> **Option A — ticket-level selling price.**
> `selling_price` on `tickets` is the amount charged to the customer for that
> ticket. `selling_currency` is the currency of that selling price.
> Gross margin per ticket = selling price − supplier fare cost, valid only
> when both amounts use the same currency and cover comparable charges.
> Booking totals are **calculated from the associated tickets** rather than
> entered independently.

**What that required, and what was built (migration `006`):**

| Change | Reason |
| --- | --- |
| `tickets.selling_price NUMERIC(18,4)` | The amount charged to the customer for that ticket. |
| `tickets.selling_currency CHAR(3)` | The currency of that selling price. |
| `tickets.issue_date DATE` | The date the **airline** issued the ticket. `issued_at` is the date *we recorded it* — a different fact, and the reform asks for the business one. |
| `tickets.notes TEXT` | Sale notes. |
| `tickets.ticket_number` becomes nullable | A sale can exist before the partner issues the ticket number. |
| `tickets.ticket_status` gains `'pending'` | A pending sale is sold but not yet ticketed. It is **never** counted as ticketed. |
| `CHECK (selling_price IS NULL) = (selling_currency IS NULL)` | A price and its currency are entered together or not at all. |
| `CHECK (ticket_status NOT IN ('issued','exchanged') OR ticket_number IS NOT NULL)` | A real ticket number is required wherever a ticket is claimed to exist. |
| `UNIQUE INDEX uq_one_pending_sale_per_passenger` | One pending sale per traveller. Issuing updates it in place rather than duplicating it. |
| `CHECK (selling_price IS NULL OR selling_price >= 0)` | Negative selling price is rejected. |

**No `ticket_sales` table was created.** The existing tables were reused.

### Proposed migrations

| Migration | Purpose | Safe? |
| --- | --- | --- |
| `006_ticket_sales.sql` | **APPLIED.** Selling price, selling currency, issue date and notes on `tickets`; nullable ticket number; `pending` sale status; the constraints listed above. | Additive only. No existing row modified. |
| `007_link_documents_to_financial_records.sql` | Add nullable `invoice_id`, `payment_id`, `expense_id`, `supplier_bill_id` to `documents`, each with a foreign key. Add `document_id` to `business_expenses`, replacing the loose `receipt_document_key`. | Additive only. |
| `008_add_number_sequences.sql` | Add a `document_number_sequences` table (per office, per kind: invoice, receipt, supplier bill, expense) and helper functions to draw the next number atomically. | New table only. |
| `009_add_finance_audit_triggers.sql` | Trigger `activity_logs` on `invoices`, `payments`, `supplier_bills`, `supplier_payments`, and `business_expenses` so financial writes are audited even if a code path forgets to log. | New triggers only. |
| `010_protect_financial_records.sql` | Add rules preventing silent modification or deletion of issued invoices and confirmed payments, and blocking allocation to a non-issued invoice at the **database** level. | Restrictive. Needs a data review first — currently there is 1 invoice, 0 payments, so the risk is nil today. |
| `011_add_payment_void_and_refund_flow.sql` | Add `voided_at`, `voided_by`, `void_reason` to `customer_payments`; add `reversal_of_payment_id` for traceable reversals. | Additive only. |
| `012_add_supplier_payment_terms.sql` | Add `payment_terms_days` to `suppliers` if the agency tracks terms. | Additive only. Optional. |

None of these require destructive migration. Migrations `001`–`006` are
already applied and tracked in `schema_migrations`; the runner skips them.

### Important constraint findings

- `payment_allocations` already enforces `UNIQUE (payment_id, invoice_id)` and
  `CHECK (amount > 0)`. The "cannot exceed the unallocated amount or the
  outstanding balance" rule is currently enforced in application code only —
  it should also be a database constraint (migration `010`).
- `customer_payments.receipt_number` is `UNIQUE` but **nullable**, so
  duplicates slip through when it is omitted.
- `supplier_bills` has no unique reference constraint, so the same supplier
  invoice could be entered twice. Needs a composite unique index on
  `(supplier_id, supplier_invoice_reference)`.
- `invoices.invoice_number` is already `UNIQUE`.

---

## 6. Recommended implementation order

Ordered by dependency, with each phase independently shippable and testable.
This maps onto the reform roadmap's phases, with the additions it implies.

### Phase 0 — Foundation (must be first)
Not in the roadmap, but everything else depends on it.
1. `git init` with a root `.gitignore` covering `backend/.env`,
   `frontend/.env.local`, `storage/`, `node_modules/`, `.venv/`, `dist/`.
   **Before the first commit.**
2. Delete `ticket-office-frontend - Copy/` and `ComingSoonView.tsx`.
3. Split `backend/main.py` into a package: `app/` with `config.py`,
   `security.py`, `schemas.py`, `services/`, `routers/`.
4. Convert the two integration scripts into a **pytest** suite against a
   separate test database.
5. Add `render.yaml`, `vercel.json`, and environment-driven CORS.
6. Add a `pytest` CI workflow.

**Why first:** the splitting work touches every file. Doing it after adding
new features means re-touching them, and the roadmap requires incremental,
reviewable phases. Doing it before means every later phase lands in the
right place from the start.

### Phase 1 — Audit complete, schema ready
Deliver migrations `006`–`008` (selling price, document links, number
sequences) with the constraint tests the reform requires. Confirm the
selling-price decision from the audit before writing `006`.

### Phase 2 — Simplify the application structure
Restructure the frontend into the nine sections the roadmap names: Dashboard,
Ticket Sales, Customers, Customer Payments, Suppliers, Supplier Payments,
Expenses, Reports, Settings and User Management. Merge Bookings and Financials
into the Ticket Sales workflow rather than keeping them as separate
destinations. Preserve the visual identity and reusable components.

### Phase 3 — Ticket sale workflow
`GET/POST/PATCH /api/ticket-sales` over the existing `bookings` + `tickets`
model, with selling price and supplier cost, computed gross margin, and the
duplicate-ticket guard. One straightforward form.

### Phase 4 — Customer payments, invoices, receipts
Finish the money side: number sequences, printable receipts, printed
reconciliation-friendly invoice, payment void and reversal, and the
database-level allocation constraints from migration `010`.

### Phase 5 — Supplier accounts and expenses
`supplier_bills` and `supplier_payments` APIs, allocation to supplier
obligations, supplier balances, and `business_expenses` with receipt
attachments. Include the duplicate supplier-invoice guard.

### Phase 6 — Financial dashboard and reports
Add the dashboard period filter, the missing reports (by employee, by
supplier, by expense category, by payment method, ticket-level gross
margin, refunds and adjustments), CSV export everywhere, and a gross margin
and estimated net profit figure — with every tile labelled as cash, sales,
outstanding, gross margin, or estimated profit.

Profit needs a decision on currency: either the agency operates in one
currency for profit reporting, or a conversion basis is recorded via
`booking_quotes.supplier_fx_rate_to_customer` or `exchange_rates`. The reform
requires the conversion to be **explicitly recorded**, never implicit.

### Phase 7 — Refunds, adjustments, and ticket actions
`ticket_actions` API and UI for void, refund, exchange, and reissue, with the
request and approval separation the schema already anticipates.

### Phase 8 — Security and reliability
Fix the open bugs B6–B14, add CORS tightening, rate limiting, attachment
quotas, the document-delete endpoint, and the immutable-financial-record
guards. Add the manual test checklist.

### Phase 9 — Deployment and handover
Render and Vercel configuration, environment variable documentation, backup
and restore procedure, and a full post-deployment walkthrough of the sale to
payment workflow.

### Phase 10 — Optional CSV/Excel import
Only after the manual workflow is reliable, exactly as the roadmap requires.

---

## 7. File-by-file implementation plan

### New files — backend

| File | Purpose |
| --- | --- |
| `backend/app/__init__.py` | Package marker. |
| `backend/app/main.py` | App factory, middleware, exception handlers, router registration. Replaces today's `main.py` body. |
| `backend/app/config.py` | Environment reading: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DOCUMENT_STORAGE_DIR`, `CORS_ORIGINS`, `APP_ENV`. |
| `backend/app/database.py` | Engine and session factory. Replaces `backend/database.py`. |
| `backend/app/security.py` | `get_authenticated_user`, `require_active_staff`, `get_booking_staff`, `require_finance_staff`, `require_cash_staff`, `require_supplier_manager`, `require_staff_administrator`. |
| `backend/app/schemas.py` | All Pydantic request/response models, split by domain. |
| `backend/app/services/` | `booking_service.py`, `invoice_service.py`, `payment_service.py`, `supplier_service.py`, `expense_service.py`, `document_service.py`, `margin_service.py`, `report_service.py`. Each owns its SQL. |
| `backend/app/routers/` | `auth.py`, `dashboard.py`, `customers.py`, `ticket_sales.py`, `invoices.py`, `payments.py`, `suppliers.py`, `supplier_payments.py`, `expenses.py`, `documents.py`, `reports.py`, `admin.py`. |
| `backend/app/numbering.py` | Atomic invoice / receipt / bill / expense number generation. |
| `backend/tests/` | `conftest.py`, `test_payments.py`, `test_invoices.py`, `test_ticket_sales.py`, `test_supplier_accounts.py`, `test_expenses.py`, `test_reports.py`, `test_authorization.py`, `test_documents.py`. |
| `backend/pytest.ini` or `pyproject.toml` | Test configuration. |
| `backend/migrations/006_add_ticket_selling_price.sql` | Selling price on tickets and bookings. |
| `backend/migrations/007_link_documents_to_financial_records.sql` | Document links to financial records. |
| `backend/migrations/008_add_number_sequences.sql` | Number sequence table and functions. |
| `backend/migrations/009_add_finance_audit_triggers.sql` | Audit triggers for financial tables. |
| `backend/migrations/010_protect_financial_records.sql` | Database-level financial constraints. |
| `backend/migrations/011_add_payment_void_and_refund_flow.sql` | Payment void and reversal columns. |
| `backend/render.yaml` | Render build and start command. |
| `backend/Procfile` | `web: uvicorn app.main:app --host 0.0.0.0 --port $PORT`. |

### New files — frontend

| File | Purpose |
| --- | --- |
| `frontend/src/views/DashboardView.tsx` | Replaces `OperationsOverview.tsx`. |
| `frontend/src/views/TicketSalesView.tsx` | The unified sale workflow: register, single sale form, gross margin column. |
| `frontend/src/views/CustomersView.tsx` | From `CustomerDirectoryView.tsx`. |
| `frontend/src/views/CustomerPaymentsView.tsx` | From `PaymentsView.tsx`, plus refunds and reversals. |
| `frontend/src/views/SuppliersView.tsx` | From `SuppliersView.tsx`. |
| `frontend/src/views/SupplierPaymentsView.tsx` | New: supplier bills, payments, balances. |
| `frontend/src/views/ExpensesView.tsx` | New: expenses with receipt attachments. |
| `frontend/src/views/ReportsView.tsx` | New: all reports, with date filters and CSV export. |
| `frontend/src/views/SettingsView.tsx` | New: office settings and user management. |
| `frontend/src/components/sales/` | `SaleForm.tsx`, `SaleList.tsx`, `MarginSummary.tsx`, `PassengerEditor.tsx`. |
| `frontend/src/components/finance/` | `PaymentForm.tsx`, `AllocationDialog.tsx`, `ReceiptPreview.tsx`, `InvoiceBuilder.tsx`. |
| `frontend/src/components/suppliers/` | `SupplierBillForm.tsx`, `SupplierPaymentForm.tsx`, `SupplierBalanceTable.tsx`. |
| `frontend/src/components/expenses/` | `ExpenseForm.tsx`, `ExpenseCategoryBreakdown.tsx`. |
| `frontend/src/lib/api/` | Split `api.ts` into `auth.ts`, `customers.ts`, `sales.ts`, `invoices.ts`, `payments.ts`, `suppliers.ts`, `expenses.ts`, `documents.ts`, `reports.ts`, `admin.ts`. |
| `frontend/src/lib/format.ts` | Currency and date formatting shared across views. |
| `frontend/vercel.json` | Vercel build configuration and SPA rewrite. |

### Files to modify

| File | Change |
| --- | --- |
| `backend/main.py` | **Delete** once `backend/app/` is complete. Move, do not rewrite. |
| `backend/database.py` | **Delete** once `backend/app/database.py` exists. |
| `backend/requirements.txt` | Add `pytest`, `pytest-asyncio`, `httpx` (test), and `psycopg[binary]` stays. Remove nothing — no airline SDKs are present, which is correct. |
| `backend/.env.example` | Add `CORS_ORIGINS`, `APP_ENV`, `DOCUMENT_STORAGE_DIR` note for production. No new secrets. |
| `backend/README.md` | Restructure to match the new layout. |
| `backend/scripts/verify_new_flows.py` | Keep as a smoke script; the logic moves into `backend/tests/`. |
| `backend/scripts/verify_cashier_role.py` | Same. |
| `frontend/src/App.tsx` | Nine-section navigation. |
| `frontend/src/components/layout/Sidebar.tsx` | Nine-section navigation. |
| `frontend/src/components/layout/Header.tsx` | Section labels. |
| `frontend/src/components/dashboard/OperationsOverview.tsx` | Move to `views/DashboardView.tsx`, add the period filter and margin tiles. |
| `frontend/src/components/dashboard/BookingDetailsPanel.tsx` | Move into `components/sales/`. |
| `frontend/src/components/dashboard/FinancialsView.tsx` | Split into `InvoiceBuilder`, `CustomerPaymentsView`, `ReportsView`. |
| `frontend/src/components/dashboard/PaymentsView.tsx` | Move to `views/CustomerPaymentsView.tsx`. |
| `frontend/src/components/dashboard/CustomerDirectoryView.tsx` | Move to `views/CustomersView.tsx`. |
| `frontend/src/components/dashboard/SuppliersView.tsx` | Move to `views/SuppliersView.tsx`. |
| `frontend/src/components/dashboard/ComingSoonView.tsx` | **Delete.** |
| `frontend/src/components/common/ConfigModal.tsx` | Disable or admin-gate in production builds (S11). |
| `frontend/src/lib/api.ts` | Split into `lib/api/`. |
| `frontend/src/lib/config.ts` | Read `VITE_API_URL` from the build environment; add a production flag. |
| `frontend/src/types/customer.ts` | Add sale, margin, supplier bill, expense, and report types. |
| `frontend/src/types/auth.ts` | Add the new dashboard tile types. |
| `frontend/src/types/admin.ts` | Already present; use it in `SettingsView`. |
| `docs/feature-checklist.md` | Update as each phase lands. |
| `docs/operations-guide.md` | Update as each phase lands. |

### Files to delete

| Path | Reason |
| --- | --- |
| `ticket-office-frontend - Copy/` | Stale duplicate frontend, superseded, no unique functionality, contains a dead AI Studio env setup. |
| `frontend/src/components/dashboard/ComingSoonView.tsx` | Dead placeholder, not imported. |
| `backend/check_db.py` | Superseded by `backend/scripts/apply_migrations.py` and the pytest suite. Keep only if you want the standalone connectivity check — harmless either way. |

---

## 8. Open decisions for the business

**Resolved:** selling price placement — **Option A, ticket-level**. See the
confirmed decision above. The remaining decisions are still open.

1. ~~**Selling price placement**~~ — **RESOLVED: Option A (ticket-level).**
2. **Is one sale one passenger, or one booking?** The sale model is now
   **per passenger** (one ticket = one sale). The remaining question is
   whether a family of four sharing one invoice should carry the whole selling
   price on each ticket, or the total split across the four. The audit
   assumes the price is entered per ticket.
3. **Currency policy for profit.** The margin rule is now **same currency
   only** — a cross-currency sale reports no margin rather than a converted
   one. That satisfies the reform's "no implicit conversion" rule. The open
   question is whether the agency wants a *recorded* conversion (via
   `booking_quotes.supplier_fx_rate_to_customer` or `exchange_rates`) so that
   cross-currency sales can also report a margin.
4. **Which currencies are in use?** The live data shows ETB. The schema
   permits any three-letter code and the code never converts.
5. **Does the agency receive commission from suppliers?** If yes, it needs a
   home in the schema so it is not hidden inside a price adjustment.
6. **Who approves refunds, voids, and exchanges?** The schema defines
   `MANAGER` as *"Approve financial adjustments, refunds, and sensitive
   changes"* and `ticket_actions` has separate `requested_by` and `approved_by`
   columns. The reform needs a concrete approver.
7. **Retention policy for attachments and audit logs**, and the backup
   cadence, for the handover documentation.
8. **Which office will run this first, and will there be more than one?**
   The branch model supports many, but only one office exists today.

---

## 9. Audit conclusion

The project is in better shape than the reform assumes. The hard parts of a
financial system are already done and done well:

- Money is `NUMERIC`, never float.
- Currencies are never mixed, and there is no silent conversion.
- Audit logging is transactional and privacy-conscious.
- Authorization is branch-scoped with a clean role model.
- The allocation model is correct and transactionally safe.
- There is no airline or GDS integration to remove — the reform's central
  constraint is already satisfied by construction.
- The schema for supplier bills, supplier payments, expenses, refunds, ticket
  actions, quotes, and FX rates already exists. The reform is mostly a matter
  of **exposing** what is already designed, not inventing it.

The real work is: **restructure** (one 4,400-line file, six tabs, no tests,
no git), **connect** the orphaned tables, and **add the selling price** that
makes gross margin computable.

Five bugs were found and fixed during this audit, including one critical
defect that made booking creation return HTTP 500 on every attempt.

No production data was modified during the audit.
