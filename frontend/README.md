# Frontend development

Copy `.env.example` to `.env.local` and fill in the Supabase project URL and
publishable (legacy anon) key from **Project Settings → API Keys**. Never use a
service-role or secret key in frontend configuration.

The matching `SUPABASE_URL` and `SUPABASE_ANON_KEY` values must also be added
to `backend/.env`; do not replace the existing database settings in that file.
Restart both development servers after updating environment files.

Install dependencies and start Vite:

```powershell
npm install
npm run dev
```

Staff sign in with email and password. Public sign-up is intentionally not
implemented; create or invite staff through Supabase Auth.

The Customers & Corporate module provides an authenticated, searchable shared
directory and customer registration for individual and corporate records.
Customer entries are shared across branches in the current database schema;
the initial registration form stores a name and optional email and phone.
The Bookings & PNRs module provides a branch-scoped booking register with
customer selection, search, status filters, booking creation, controlled
lifecycle updates, and status history. New bookings start in `Requested`
status; a recorded PNR is a locator only and does not connect to an external
reservation system. `Ticketed` status requires an issued or exchanged ticket
for every booking passenger. Booking travel details support passenger name
snapshots and ordered flight segments; they do not store passport data or
issue tickets through a GDS. Staff can record and verify partner-issued ticket
numbers per traveler; the workflow creates itinerary coupons and advances the
booking status automatically. Active airline, consolidator, or host-agency
supplier records must already exist. Administrators and managers can create
and activate supplier records in the Suppliers module. The Financials module
supports branch-scoped draft invoices, issue status, downloadable invoice PDFs,
and an issued-sales report grouped by currency and date range. The report shows
billed totals, not cash collected. The Payments module provides a branch-scoped
payment register, receipt recording, and invoice allocation, with the invoice
status moving to `Partially Paid` or `Paid` as allocations are applied. The
Financials module also reports what each customer still owes on issued invoices
and exports that report as CSV. The booking detail panel accepts document
attachments (PDF, JPEG, PNG, WebP, or plain text, up to 10 MB) and tracks the
ticketing request for a booking through its Not Requested, Pending, Submitted,
Failed, and Completed states. Refunds and BSP reconciliation remain under
development.
