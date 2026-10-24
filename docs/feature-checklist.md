# Feature checklist

Status of the ticket-office management system against the agreed feature list.
"Done" means the backend endpoint, the database support, and the frontend
screen are all in place and were verified against the live database.

## Done

### Customer payments
- Record a receipt with customer, currency, amount, method, and optional
  receipt number or external reference. `POST /api/payments`
- Branch-scoped payment register with search. `GET /api/payments`
- Apply money from a payment to an invoice. `POST /api/payments/{id}/allocations`
- Payment and invoice currencies must match; an allocation cannot exceed the
  payment's unallocated balance or the invoice's unpaid balance.
- Only an `issued` or `partially_paid` invoice can receive money, so cash is
  never tied to a draft, void, or cancelled invoice.
- The invoices that can still take money, with the balance still owing on
  each, are listed for the allocation form. `GET /api/invoices/allocatable`
- An invoice appears in that list while money is still outstanding on it,
  whatever its status, so a partly paid invoice is offered with the amount
  left owing rather than being hidden.
- Allocating again to the same invoice increases the existing allocation
  instead of failing.
- Invoice status moves to `partially_paid` and then `paid` automatically.
- `customer_payments.branch_id` records the office that took the money.
- Every payment and allocation is written to `activity_logs`.
- Frontend: payment register, receipt form, and invoice allocation in
  `frontend/src/components/dashboard/PaymentsView.tsx`.

### Ticket sales
- A sale is one ticket sold to one traveller. The selling price sits on the
  ticket next to the supplier cost, so gross margin is a per-ticket figure.
  Booking totals are calculated from the associated tickets, never entered
  independently. Migration `006_ticket_sales.sql`.
- A sale can be recorded before the partner issues the ticket number. Such a
  sale is `pending` and is never counted as ticketed.
  `POST /api/ticket-sales`
- Issuing a pending sale records the ticket number and the airline's issue
  date, creates the itinerary coupons, and advances the booking.
  `PATCH /api/ticket-sales/{id}`
- Sale register with search, status filter, and per-currency totals.
  `GET /api/ticket-sales`
- Booking-level totals derived from the tickets.
  `GET /api/bookings/{id}/sale-summary`
- Gross margin is reported only when the selling price and the supplier cost
  are in the same currency. A cross-currency sale reports no margin rather
  than a silently converted one.
- One pending sale per traveller, enforced by a database constraint.
- A ticket number must be verified before it is recorded.
- Frontend: `frontend/src/components/dashboard/TicketSalesView.tsx` and the
  sale forms in
  `frontend/src/components/dashboard/BookingDetailsPanel.tsx`.

### Documents and attachments
- Upload a file against a booking or a customer. `POST /api/documents`
- 10 MB limit, and only PDF, JPEG, PNG, WebP, or plain text.
- Files are stored under a server-generated object key in a private directory
  and are never served as static files.
- SHA-256 of the stored bytes is recorded for integrity.
- Download is branch-scoped and ownership-checked.
  `GET /api/documents/{id}/download`
- Frontend: attachments panel in
  `frontend/src/components/dashboard/BookingDetailsPanel.tsx`.

### Dashboard
- `GET /api/dashboard/overview` reports total and open bookings, tickets
  issued, exchanged, voided, and refunded, bookings awaiting ticketing, flight
  legs departing within seven days, overdue invoice count, today's sales,
  today's payments received, outstanding customer balances, outstanding
  supplier bills, business expenses for the month so far, and the eight most
  recent audit entries.
- Every money figure is grouped by currency; amounts in different currencies
  are never summed together.
- Frontend: `frontend/src/components/dashboard/OperationsOverview.tsx`.

### Ticketing requests
- A booking and its ticketing request are separate records with separate
  statuses.
- Raise a request against an active airline, consolidator, or host agency.
  `POST /api/bookings/{id}/ticketing-requests`
- List the requests on a booking.
  `GET /api/bookings/{id}/ticketing-requests`
- Move a request through `not_requested → pending → submitted → completed`,
  with `failed`, `cancelled`, and `expired` as exception states.
  `PATCH /api/ticketing-requests/{id}`
- A request can only be completed once an issued or exchanged ticket exists for
  the booking.
- Partner cost and currency are recorded on the request, so the office's
  liability to the partner is traceable.
- Submitting a request moves a `confirmed` booking to `ticketing_pending`.
- Frontend: ticketing request workflow in
  `frontend/src/components/dashboard/BookingDetailsPanel.tsx`.

### Financial reports
- Issued invoice sales for an inclusive date range, grouped by currency.
  `GET /api/financial-reports/invoices`
- What each customer still owes on issued invoices, after confirmed payments
  are applied. `GET /api/financial-reports/customer-balances`
- CSV export of the same report.
  `GET /api/financial-reports/customer-balances.csv`
- What the office still owes each ticket supplier, taken from the bills
  recorded against that partner. `GET /api/financial-reports/supplier-balances`
- CSV export of the same report.
  `GET /api/financial-reports/supplier-balances.csv`
- Business expenses for the branch, grouped by currency and by category.
  `GET /api/financial-reports/expense-summary`
- Frontend: `frontend/src/components/dashboard/FinancialsView.tsx`.

### Supplier bills and payments
- A bill is what a partner has invoiced the office. The office generates its
  own bill number and keeps the partner's reference alongside it.
  `POST /api/supplier-bills`
- The bill amount is the obligation. Payments settle it, and the bill status
  moves `unpaid` → `partially_paid` → `paid` automatically.
  `POST /api/supplier-bills/{id}/payments`
- Branch-scoped bill register with search, status filter, and per-currency
  outstanding totals. `GET /api/supplier-bills`
- Branch-scoped register of payments made to suppliers.
  `GET /api/supplier-payments`
- A payment must be in the same currency as the bill, and cannot exceed the
  amount still owed on it. Amounts in different currencies are never
  converted.
- A repeated partner invoice reference for the same supplier is rejected, so
  the same invoice cannot be entered twice.
- A bill can be voided only while no payment has been recorded against it.
  Voiding keeps the record and removes it from the outstanding balances.
  `POST /api/supplier-bills/{id}/void`
- Every bill, payment, and void is written to `activity_logs`.
- Frontend: `frontend/src/components/dashboard/SupplierPaymentsView.tsx`.

### Business expenses
- Office running costs, kept apart from what is owed to ticket suppliers.
  `POST /api/expenses`
- The category is a controlled list so the category report stays accurate.
  `GET /api/expense-categories`
- Branch-scoped expense register with search, category filter, status filter,
  and per-currency totals. `GET /api/expenses`
- An expense can be voided with a reason. Voiding keeps the record and
  removes the amount from the totals. `POST /api/expenses/{id}/void`
- Frontend: `frontend/src/components/dashboard/ExpensesView.tsx`.

### Cost reconciliation
- The office's liability to a partner comes from the bills. The ticket fare
  is what the partner's price list said at the time of issue. Where a booking
  has both, the two are shown side by side with the difference as a variance,
  rather than added together. This is what stops the same cost being counted
  twice.
- Reconciliation rows are per booking, per supplier, per currency.
- Frontend: the "Supplier balances" tab in
  `frontend/src/components/dashboard/FinancialsView.tsx`.

### Statuses
- Invoice statuses extended with `overdue` and `cancelled`
  (migration `004_extend_invoice_statuses.sql`).
- Ticketing request statuses aligned with the Not Requested / Pending /
  Submitted / Failed / Completed workflow
  (migration `005_ticketing_request_statuses.sql`).

### Staff administration and roles
- The staff register with each person's office, roles, and active flag.
  `GET /api/admin/staff`
- The role list and the active office list the screen needs.
  `GET /api/admin/staff/options`
- Link a person to a staff profile, an office, and a set of roles.
  `POST /api/admin/staff`
- The sign-in is optional and separate. A profile is recorded with its office
  and its roles and no Supabase account at all, so the office can set up the
  whole team without touching Supabase. The two are joined on the email by
  `POST /api/admin/staff/{id}/link-sign-in`, or at creation time with
  `sign_in_method: "existing"`, which joins an account that already exists.
- The API never creates a Supabase account, never sends an invitation, and
  never generates a password. No `SUPABASE_SERVICE_ROLE_KEY` or
  `SUPABASE_SECRET_KEY` is needed, or accepted, for any of it.
- A staff profile with no joined sign-in cannot sign in: `GET /api/auth/me`
  refuses it, and the sign-in is never joined as a side effect of an
  authentication attempt.
- Adding a second profile for an email that already has one is refused with
  a message naming the email and pointing at editing the existing profile.
- The staff register shows which profiles have no sign-in joined yet, via
  `has_sign_in`.
- Change a person's office, roles, and active flag. Roles are replaced, not
  appended. `PATCH /api/admin/staff/{id}`
- Only a staff member with the `ADMIN` role can reach any of it, and the
  server re-checks on every request, so a role change takes effect at once.
- An administrator cannot remove their own administrator role or deactivate
  themselves, and the last active administrator cannot be demoted. The check
  is done under a transaction-scoped lock so two concurrent changes cannot
  both slip through.
- A staff member must keep at least one role. With none, the server refuses
  every request they make.
- Every provisioning and access change is written to `activity_logs`.
- Frontend: `frontend/src/components/dashboard/StaffManagementView.tsx`, with
  a "User Management" sidebar entry that only an administrator sees.

### Database operations
- Migration runner `backend/scripts/apply_migrations.py` applies every
  unapplied file in numeric order, records it in `schema_migrations`, and owns
  the transaction for each file.
- Migrations `003` through `009` are applied to the live database.
- Verification scripts drive the real handlers against the live database and
  clean up after themselves:
  `backend/scripts/verify_new_flows.py`,
  `backend/scripts/verify_ticket_sales.py`,
  `backend/scripts/verify_supplier_finance.py`,
  `backend/scripts/verify_staff_access.py`, and
  `backend/scripts/verify_cashier_role.py`.

### Deployment
- `CORS_ORIGINS` on the API is a comma-separated list of the exact browser
  origins allowed to call it. The local development origins are always
  allowed and a wildcard is refused.
- `render.yaml` deploys the API as a Python web service with the migration
  runner as the release command, and the frontend as a static site.
- `vercel.json` deploys the frontend to Vercel.
- `backend/Dockerfile` and `docker-compose.yml` run the same stack locally.

## Not done

The schema already carries the tables for these, so they can be added without
redesigning the model.

| Feature | Schema support | Notes |
| --- | --- | --- |
| Customer refunds | `customer_refunds` | Returning money to a customer and reversing the related allocation. |
| Ticket reissues and exchanges | `ticket_actions`, `tickets` | Void, reissue, and exchange flows for issued tickets. |
| Profit calculation | `exchange_rates`, `business_expenses` | Needs revenue, cost, and expense data plus a currency conversion basis. The mixed-currency conversion policy is still undecided. |
| Deadline reminders | `ticketing_requests.ticketing_deadline` | The deadline is already stored; no scheduled notification exists. |
| Office settings screen | `branches` | No screen for branch profile, currency, and operational settings. Offices are managed from the database today. |

### Known gaps that are not new features
- There is no endpoint for deleting an uploaded document. The database row and
  the stored file both need a manual removal.
- Ticketing request `expired` is a valid state, but nothing sets it
  automatically when the deadline passes.
- A supplier bill can be voided but not deleted, and a supplier payment
  cannot be voided through the API yet. Both would need the same audit trail
  that the customer payment side already has.
