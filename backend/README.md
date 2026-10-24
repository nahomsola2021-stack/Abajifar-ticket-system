# Backend development

## Supabase Auth

Copy `.env.example` values into the existing `backend/.env` file. Use the
Supabase project URL and publishable (legacy anon) key from **Project Settings
→ API Keys**. The publishable/anon key is intended for client use; never put a
service-role or secret key in the frontend.

The React app uses the same URL and publishable/anon key in
`frontend/.env.local`, prefixed with `VITE_`. Keep the database credentials in
`backend/.env` only.

Start FastAPI from this directory:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --reload
```

`GET /api/health` checks the database. `GET /api/auth/me` requires a Supabase
access token in the `Authorization: Bearer <token>` header and verifies it
with Supabase Auth, then requires an active staff profile with an assigned
role. It returns `404` when the staff profile has not been provisioned and
`403` when the profile is inactive or has no assigned role. The application
does not expose public sign-up.

The Customers & Corporate directory uses `GET /api/customers` with optional
`q`, `limit` (1-100), and `offset` query parameters, and `POST /api/customers`
with `customer_type` (`individual` or `corporate`), `display_name`, and
optional `email` and `phone`. Both endpoints require an active staff profile
with an assigned role. Customer records are shared across branches by the
current database schema.

The first Bookings & PNRs release provides `GET /api/bookings` with optional
`q`, `status`, `limit` (1-100), and `offset` query parameters, and
`POST /api/bookings` with a `customer_id`, `booking_channel`, and optional
`external_pnr`, `reservation_system`, and `customer_notes`. Both endpoints
require an active staff profile, an assigned role, and an active branch.
Booking records are scoped to the staff member's branch, and new records start
in `requested` status. PNR entry records a locator only; it does not look up
or change data in an external reservation system.

`PATCH /api/bookings/{id}/status` records controlled lifecycle changes and
`GET /api/bookings/{id}/history` returns their actor and timestamp. Allowed
transitions follow the booking workflow; moving to `partially_ticketed` or
`ticketed` requires corresponding issued or exchanged ticket records for the
booking passengers. Every booking status change, including initial creation,
is written to `activity_logs` in the same transaction.

`GET /api/bookings/{id}/details` returns the booking's traveler name snapshots
and ordered flight segments. Add records with
`POST /api/bookings/{id}/passengers` or
`POST /api/bookings/{id}/segments`. Flight times must include a timezone and
arrival must be after departure. Traveler and itinerary details cannot be
added after a booking is partially ticketed, ticketed, cancelled, expired, or
closed. These changes are also audited without logging traveler names.

Ticket recording uses `GET /api/suppliers` to list active airline, consolidator,
and host-agency suppliers, then `POST /api/bookings/{id}/tickets` with a
booking passenger, supplier, ticket number, optional fare/currency pair, and
`verified: true`. This records a partner-issued ticket; it does not issue a
ticket through a GDS or airline. The API requires a ticketing-pending or
partially-ticketed booking, a matching traveler, and at least one itinerary
segment. Ticket creation, itinerary coupon creation, audit logging, and the
booking transition to partially-ticketed or ticketed occur in one transaction.
The selected supplier must already be active in the database.

Supplier management uses `GET /api/suppliers` to list all supplier records and
`POST /api/suppliers` to create a record with its type, legal name, optional
trading/contact details, account reference, settlement currency, and notes.
`PATCH /api/suppliers/{id}/status` activates or deactivates a supplier without
deleting history. Listing requires an active staff member with a branch;
creation and status changes require the `ADMIN` or `MANAGER` role and are
written to `activity_logs`.

Customer invoices use `GET /api/invoices` for branch-scoped search,
`GET /api/invoices/{id}` for details, and `POST /api/invoices` to create a
draft with server-calculated line totals. `POST /api/invoices/{id}/issue`
transitions a draft to `issued`, stamps the issue date, and writes an audit
entry. Issuing requires an active finance writer (`ADMIN`, `MANAGER`, or
`ACCOUNTANT`), at least one line item, and a valid due date. Issued invoices
can be downloaded from `GET /api/invoices/{id}/pdf`; access is branch-scoped
and draft invoices cannot be downloaded. `GET /api/financial-reports/invoices`
returns issued invoice sales for an inclusive date range, grouped by currency.
It reports billed totals, not receipts or accounting revenue recognition.
Issuing does not email the customer or record payment.

## First administrator

The initial schema migration is `migrations/001_initial_schema.sql`. Apply each
migration once, in numeric order, to the Supabase project.

| Migration | Purpose |
| --- | --- |
| `001_initial_schema.sql` | Full base schema (offices, staff, customers, bookings, tickets, invoices, payments, suppliers, documents, audit log) |
| `002_link_staff_to_supabase_auth.sql` | Links `public.users` rows to Supabase Auth accounts and makes the local password hash optional |
| `003_link_payments_to_branch.sql` | Records which branch collected each payment so balances and cash reporting stay branch-scoped |
| `004_extend_invoice_statuses.sql` | Adds the `overdue` and `cancelled` invoice lifecycle states |
| `005_ticketing_request_statuses.sql` | Aligns the ticketing request lifecycle with the Not Requested / Pending / Submitted / Failed / Completed workflow |
| `006_ticket_sales.sql` | Adds the ticket sale model: selling price and currency on the ticket, a business issue date, sale notes, and a `pending` sale state for sales recorded before the partner issues the ticket number |
| `007_supplier_and_expense_records.sql` | Gives supplier bills and business expenses their own branch, numbering, status, and indexing, and records which branch owns each financial document |
| `008_document_number_sequences.sql` | Adds the branch-scoped number sequences behind `INV-`, `RCP-`, `BILL-`, and `EXP-` document numbers |
| `009_supplier_bill_number.sql` | Gives each supplier bill an office-generated number alongside the partner's own invoice reference |

Apply the migrations with the runner, from the backend directory:

```powershell
.\.venv\Scripts\python.exe scripts\apply_migrations.py
```

The runner creates a `schema_migrations` table, applies every `.sql` file in
`migrations/` in numeric order that has not been applied yet, and records each
one. Each file runs in its own transaction, and the runner strips a file-level
`BEGIN;` / `COMMIT;` wrapper so it owns the transaction. If a migration fails,
the runner stops and leaves the remaining migrations unapplied, so the failure
can be fixed and the script re-run. Migrations `001` and `002` were applied
before the runner existed; the runner detects the core tables and records them
as already applied rather than trying to recreate them.

After inviting the first staff member in Supabase Auth and applying every
migration, run this once from the backend directory to create the first
branch and link that invited account to the `ADMIN` role:

```powershell
.\.venv\Scripts\python.exe scripts\provision_first_admin.py
```

The script refuses to run if a staff profile already exists. It asks for the
invited email, administrator name, and branch details, then confirms before
creating records. It uses the existing backend database connection; do not
paste database credentials or service-role keys into the script.

## Customer payments and allocations

Payments are the cash side of a sale and are kept separate from the invoice
that raised the demand.

- `GET /api/payments` lists branch-scoped payments with optional `q` search
  over customer name, receipt number, and external reference. Each row reports
  `allocated_total` and `unallocated_total`.
- `POST /api/payments` records a receipt with its customer, currency, amount,
  method (`cash`, `bank_transfer`, `mobile_money`, `card_gateway`, `cheque`,
  `other`), status, optional receipt number, and optional external reference.
  Requires the cash desk role: `ADMIN`, `MANAGER`, `ACCOUNTANT`, or `CASHIER`.
- `POST /api/payments/{id}/allocations` applies money to one invoice. The
  payment and invoice currencies must match, the invoice must already be
  `issued` or `partially_paid`, and the allocation cannot exceed either the
  payment's unallocated balance or the invoice's unpaid balance. Both limits
  are checked inside the same database transaction. Allocating to the same
  invoice again increases the existing allocation instead of replacing it.

A cashier takes money and applies it to an invoice, but does not raise or
issue invoices. Those stay with `ADMIN`, `MANAGER`, or `ACCOUNTANT`.

Allocations drive the invoice status automatically. An invoice with a payment
but a remaining balance becomes `partially_paid`; an invoice whose allocations
reach its grand total becomes `paid`. Every payment and allocation is written
to `activity_logs` in the same transaction.

`customer_payments.branch_id` records the office that took the money, so a
branch never reports another branch's cash. See migration `003`.

## Ticketing requests

A booking and its ticketing request are separate records with separate
statuses, so a booking can be confirmed while the request is still pending.

- `GET /api/bookings/{id}/ticketing-requests` lists the requests on a booking.
- `POST /api/bookings/{id}/ticketing-requests` raises a request against an
  active airline, consolidator, or host agency, and records that supplier as
  the booking's ticketing partner together with the ticketing deadline.
- `PATCH /api/ticketing-requests/{id}` moves a request through the controlled
  transitions `not_requested → pending → submitted → completed`, with `failed`,
  `cancelled`, and `expired` as exception states. A request can only be
  completed once an issued or exchanged ticket exists for the booking. The
  partner cost and currency are recorded on the request so the office's
  liability to the partner is traceable.

Submitting a request moves a `confirmed` booking to `ticketing_pending`.

## Documents and attachments

`POST /api/documents` accepts a `multipart/form-data` upload with a `file`, a
`document_type` (`booking_confirmation`, `itinerary`, `e_ticket`, `passport`,
`receipt`, `other`), and a `booking_id` or `customer_id`. Files are limited to
10 MB and to PDF, JPEG, PNG, WebP, or plain text.

Attachments are written to a private directory (`DOCUMENT_STORAGE_DIR`, or
`backend/storage/documents` by default) under a server-generated object key.
The original filename is recorded for display only, and the stored bytes are
hashed with SHA-256 for integrity. `GET /api/documents/{id}/download` streams
the file back and checks branch ownership first, so a document attached to a
booking in another branch is not reachable. Nothing in the storage directory
is served as a static file.

## Dashboard

`GET /api/dashboard/overview` returns operational metrics for the branch:
total and open bookings, tickets issued, exchanged, voided, and refunded,
bookings awaiting ticketing, flight legs departing within seven days,
overdue invoice count, today's sales, today's payments received, outstanding
customer balances, outstanding supplier bills, business expenses for the
month so far, and the eight most recent audit entries.

Every money figure is grouped by currency. Amounts in different currencies are
never summed together.

## Financial reports

- `GET /api/financial-reports/invoices` returns issued invoice sales for an
  inclusive date range, grouped by currency. It reports billed totals, not
  receipts or accounting revenue recognition.
- `GET /api/financial-reports/customer-balances` returns what each customer
  still owes on issued invoices, after confirmed payments are applied.
- `GET /api/financial-reports/customer-balances.csv` exports the same report
  as CSV.
- `GET /api/financial-reports/supplier-balances` returns what the office
  still owes each supplier, with the cost reconciliation.
- `GET /api/financial-reports/supplier-balances.csv` exports the same report
  as CSV.
- `GET /api/financial-reports/expense-summary` returns business expenses for
  the branch, with the total per currency and a breakdown per category.

## Staff administration and roles

Roles live in `public.roles` and are assigned through `public.user_roles`, one
row per role, so a staff member can hold several at once. The five roles are
`ADMIN`, `MANAGER`, `ACCOUNTANT`, `CASHIER`, and `AGENT`.

- `GET /api/admin/staff/options` returns the role list and the active
  branches.
- `GET /api/admin/staff` returns every staff profile with its office, roles,
  active flag, and whether a sign-in is joined to it.
- `POST /api/admin/staff` records a person as a staff profile with an office
  and a set of roles. The `sign_in_method` decides how they get in: `none`
  (the default, the roles are recorded and the sign-in is joined later) or
  `existing` (joins a Supabase account that already exists for the address).
- `POST /api/admin/staff/{staff_id}/link-sign-in` joins a Supabase sign-in to
  a profile that was recorded without one, matching on the email.
- `PATCH /api/admin/staff/{staff_id}` changes a person's office, roles, and
  active flag. Roles are replaced, not appended.

A staff profile does not need a Supabase account. `users.auth_user_id` is
nullable, and the role checks run entirely against `public.users` and
`public.user_roles`. A profile without a sign-in cannot sign in: `GET
/api/auth/me` refuses it, and no authentication attempt joins a sign-in as a
side effect.

The API never creates a Supabase account, never sends an invitation, and never
generates a password. No `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`
is needed for any of it, and the request model rejects those methods
outright. Adding a second profile for an email that already has one is
refused with a message naming the email and pointing at editing the existing
profile.

All four require the `ADMIN` role, checked on every request, so a role change
takes effect immediately. An administrator cannot remove their own
administrator role or deactivate themselves, and the last active administrator
cannot be demoted. A staff member must keep at least one role: with none, the
server refuses every request they make.

## Not yet implemented

Customer refunds, ticket reissues and exchanges, profit calculation, deadline
reminders, and the office settings screen. The database schema already
carries the tables for these (`customer_refunds`, `ticket_actions`,
`exchange_rates`), so they can be added without redesigning the model.

## Supplier bills and payments

A supplier bill is what a partner has invoiced the office. It is the
obligation; payments settle it.

- `GET /api/supplier-bills` lists branch-scoped bills with optional `q`
  search over supplier name, bill number, partner reference, and booking
  code, plus `status`, `currency`, and `booking_id` filters. Each row reports
  `paid_total` and `outstanding_total`, and the response carries the
  outstanding total per currency.
- `POST /api/supplier-bills` records a bill against an active supplier with
  its currency, bill date, optional due date, optional linked booking, and
  optional partner invoice reference. The office generates the bill number
  (`BILL-HQ-000001`); the partner's reference is kept alongside it. A
  repeated partner reference for the same supplier is rejected.
- `POST /api/supplier-bills/{id}/payments` records a payment against a bill.
  The payment currency must equal the bill currency and the payment cannot
  exceed the amount still owed. Both limits are checked inside the same
  transaction, with the bill row locked.
- `GET /api/supplier-payments` lists branch-scoped payments made to suppliers.
- `POST /api/supplier-bills/{id}/void` voids a bill. This is refused once a
  payment has been recorded against it, so a settled bill is never silently
  removed from the record.

The bill status follows the payments automatically: `unpaid` becomes
`partially_paid` once any money is recorded, and `paid` when the payments
reach the bill amount. Amounts in different currencies are never converted.

## Business expenses

Office running costs are kept apart from what is owed to ticket suppliers.

- `GET /api/expenses` lists branch-scoped expenses with `q` search, category
  and status filters, and optional date range. The response carries the total
  per currency.
- `POST /api/expenses` records an expense with its date, category,
  description, currency, amount, and payment method. The category is a
  controlled list so the category report stays accurate;
  `GET /api/expense-categories` returns it with display labels.
- `POST /api/expenses/{id}/void` voids an expense with a reason. The record
  is kept and the amount leaves the totals.

Recording requires a finance writer (`ADMIN`, `MANAGER`, or `ACCOUNTANT`).
Reading is open to the cash desk as well.

## Cost reconciliation

The office's liability to a partner comes from the bills. The ticket fare is
what the partner's price list said at the time of issue. Where a booking has
both, the two are shown side by side with the difference as a variance
rather than added together, so the same cost is never counted twice.

`GET /api/financial-reports/supplier-balances` returns:

- `items`: what the office still owes each supplier, per supplier and per
  currency, with the billed total, the paid total, the outstanding total,
  the overdue total, the overdue bill count, and the oldest due date.
- `totals_by_currency`: the same figures rolled up per currency. Currencies
  are never combined.
- `reconciliation`: per booking, per supplier, per currency, the billed
  amount next to the ticket fare, with the difference as the variance.

`GET /api/financial-reports/supplier-balances.csv` exports the balances.

## Ticket sales

A sale is one ticket sold to one traveller. The selling price sits on the
ticket next to the supplier cost, so gross margin is a per-ticket figure.
Booking totals are calculated from the associated tickets and are never
entered separately.

- `GET /api/ticket-sales` returns the sale register with search, status
  filter, date filters, and per-currency totals for the whole filtered set.
- `POST /api/ticket-sales` records a sale. A sale with a ticket number is
  issued; a sale without one is `pending`, meaning sold but not yet ticketed.
  A pending sale is never counted as a ticketed flight.
- `PATCH /api/ticket-sales/{id}` updates a sale, or issues a pending one by
  supplying the ticket number and issue date. Issuing creates the itinerary
  coupons and advances the booking in the same transaction.
- `GET /api/bookings/{id}/sale-summary` returns the booking's selling total,
  supplier cost total, and gross margin, each grouped by currency.

Gross margin is the selling price less the supplier cost. It is reported only
when both amounts are in the same currency, because amounts in different
currencies are never converted. A cross-currency sale shows its selling price
and its cost separately and reports no margin.

## Verifying the implementation

`scripts/verify_new_flows.py` exercises the payment, allocation, ticketing
request, dashboard, and document endpoints against the configured database and
then removes everything it created:

```powershell
.\.venv\Scripts\python.exe scripts\verify_new_flows.py
```

`scripts/verify_ticket_sales.py` covers the ticket sale workflow, including
the margin rules and the pending-to-issued transition:

```powershell
.\.venv\Scripts\python.exe scripts\verify_ticket_sales.py
```

`scripts/verify_cashier_role.py` checks that a cashier can take money but
cannot raise an invoice:

```powershell
.\.venv\Scripts\python.exe scripts\verify_cashier_role.py
```

`scripts/verify_supplier_finance.py` covers supplier bills, supplier
payments, business expenses, the supplier balance report, and the cost
reconciliation:

```powershell
.\.venv\Scripts\python.exe scripts\verify_supplier_finance.py
```

`scripts/verify_staff_access.py` covers staff administration with no Supabase
administrative credentials present: adding a staff member with one role and
with several, the duplicate refusal, the office and role validation, the
administrator protections, and the rule that a profile with no joined sign-in
cannot sign in:

```powershell
.\.venv\Scripts\python.exe scripts\verify_staff_access.py
```

All five create a throwaway customer, booking, and invoices, drive the real
API handlers, check the resulting state and the rejected cases, and clean up
both the database rows and the stored document files. They need an active
staff profile that is already linked to a Supabase Auth account.

## Deployment

The API reads its database settings from `DATABASE_URL`, or from the separate
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` values when a
connection string is not given. `CORS_ORIGINS` holds the browser origins
allowed to call the API as a comma-separated list. The local development
origins are always allowed and a wildcard is refused, because the API
authenticates with a bearer token.

- `render.yaml` deploys the API as a Python web service. Its release command
  runs `python scripts/apply_migrations.py`, so outstanding migrations are
  applied before the service takes traffic.
- `vercel.json` deploys the frontend to Vercel.
- `backend/Dockerfile` builds the API image, and `docker-compose.yml` runs
  the API and the frontend together for local work.

The frontend needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and
`VITE_API_URL`. The API needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, its
database settings, and `CORS_ORIGINS` set to the deployed frontend origin.
