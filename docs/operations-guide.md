# Operations guide

How the ticket office runs day to day, and what every part of the system is
for. Written from the business side: what a person is doing, and what the
system guarantees for them.

---

## 1. What this system is

A travel agency sells seats on other companies' flights. The money moves in
two directions:

- **In**: the customer pays the agency for a ticket.
- **Out**: the agency pays an airline or consolidator for that ticket.

The system's job is to make sure every sale is traceable from the moment the
customer walks in to the moment the money is settled, and that no one can
change the past without a record of it.

The system does **not** talk to a GDS or an airline. It records what humans
negotiate and verify elsewhere. Every PNR, ticket number, and fare is
something a staff member looked up and typed in.

---

## 2. Who works here, and what they can touch

Five roles exist. A person can hold more than one.

| Role | What they are trusted with |
| --- | --- |
| **Administrator** | Everything, including staff accounts and office settings. |
| **Manager** | Everything except managing staff. Approves sensitive changes. |
| **Accountant** | The full money side: invoices, payments, allocations, all reports. |
| **Cashier** | The cash desk: takes a receipt and applies it to an invoice. Cannot raise or issue invoices. |
| **Agent** | The ticketing desk: customers, bookings, travelers, itineraries, ticketing requests. |

Two rules hold everywhere:

- **Offices are separate.** A booking, invoice, payment, or document belongs to
  one office. Staff only ever see their own office's work. The exception is
  the **customer directory**, which is shared nationwide, so the same customer
  is never created twice.
- **Nobody signs themselves up.** A person must be invited through Supabase
  first, and an administrator must then attach a staff profile, an office, and
  a role. Until that happens they get "no staff profile" and see nothing.

---

## 3. The daily cycle, step by step

This is the heart of the system — the path of one booking from a phone call to
a filed receipt.

### Step 1 — The customer arrives
The customer calls, walks in, or emails. Staff note **how they made contact**
on the booking: office, phone, email, website, WhatsApp, corporate, or other.
This matters later for understanding where the agency's bookings come from.

### Step 2 — Find or create the customer
Search the shared directory by name, email, or phone. If the customer is new,
register them as an **individual** or a **corporate** with a name, email, and
phone.

> A corporate customer is a company that books travel for its staff. The
> directory keeps them distinguishable so their invoices and balances can be
> reported separately from walk-in customers.

### Step 3 — Open the booking
Create the booking against the customer. The system generates a **booking
code** (`TO` + date + random characters) and the booking starts as
**Requested**.

Staff may also record the **PNR** (the airline's reservation locator) and the
**reservation system** it came from. This is a pointer for the humans to use
when they call the airline. The system does not verify it and does not reach
out to any airline.

### Step 4 — Add the travelers
For each traveler, record their name and their type: **ADT** (adult),
**CHD** (child), **INF** (infant).

> The name is **snapshotted** onto the booking at the moment it is entered. If
> the customer later corrects a spelling mistake in their profile, the booking
> still shows what was actually ticketed. History is not rewritten.

Traveler names are deliberately **never written to the audit log** — only the
traveler id and type are. A traveler name is personal data; the audit trail
needs to answer "who did what" without becoming a store of passenger data.

### Step 5 — Add the itinerary
Each flight leg, in order: origin and destination airport codes, the
airline, flight number, departure and arrival times, and the fare
conditions. The system enforces that times are timezone-aware, that arrival
is after departure, that airport codes are three letters, and that origin
and destination differ.

> **You cannot add travelers or flights once ticketing has begun.** A booking
> that is partially ticketed, ticketed, cancelled, expired, or closed is
> locked. The ticket coupons were already generated against the itinerary, so
> changing it afterwards would make the issued ticket meaningless.

### Step 6 — Quote and confirm
Move the booking **Requested → Quoted → Confirmed**.

> There is no pricing engine yet. "Quoted" records that a price was agreed;
> the actual number is entered later on the invoice. The `booking_quotes`
> table is built and waiting in the database for when pricing becomes
> automatic.

### Step 7 — Raise the ticketing request
Create a request against the airline, consolidator, or host agency that will
issue the ticket, and set the **ticketing deadline** — the time by which the
partner must respond.

This also records that partner on the booking as its ticketing partner, and
stores the deadline so overdue requests can be spotted.

The request starts as **Not Requested**.

### Step 8 — Send it to the partner
Move the request **Not Requested → Pending → Submitted**, attaching the
partner's own request reference if they gave one.

> **Side effect worth knowing:** if the booking was *Confirmed*, submitting the
> request automatically moves the booking to **Ticketing Pending**. This is the
> moment the agency is committed and waiting on the airline.

### Step 9 — Wait for the partner
The request becomes **Failed** (with notes on what went wrong) or
**Completed**.

> **A request cannot be completed until a ticket actually exists** on the
> booking. This stops the office believing it has a confirmed seat when it
> does not.

Record the **partner cost** and **currency** on the request. This is what the
agency owes the airline, and it is the seed of the profit number the system
does not calculate yet.

A failed, cancelled, or expired request can be **re-opened** back to Pending
or Submitted. A completed one is final.

### Step 10 — Record the sale and the ticket

A **sale** is one ticket sold to one traveller. The selling price sits on the
ticket next to the supplier cost, so the margin is a per-ticket figure.

There are two ways to record one, and they cover the same sale at different
moments.

**If the ticket already exists** (the partner has given you the number):
use *Record a partner-issued ticket*. Enter the traveller, the issuing
supplier, the ticket number, the fare the partner charged you, the price you
charged the customer, and the date the airline issued the ticket. You must
tick **"I verified this ticket number against the supplier-issued record"**.

The system checks that:
- the booking is Ticketing Pending or Partially Ticketed,
- the traveler is on **this** booking,
- the supplier is active and is an airline, consolidator, or host agency,
- **the itinerary already exists**,
- that traveler does not already hold an active ticket,
- and the ticket number is unique for that supplier.

Staff must tick **"verified"**, asserting they checked the number against the
partner's document. The system records who verified it and when.

> The system never issues a ticket. It records a ticket the partner already
> issued. Recording it creates the itinerary **coupons** (one per flight leg)
> and moves the booking forward **automatically** — to Partially Ticketed if
> some travelers have tickets, to Ticketed if they all do. Staff do not set
> the status by hand.

**If the ticket does not exist yet** (you have sold the seat, the partner has
not replied): use *Record a sale awaiting issuance*. Enter the traveller, the
ticketing partner, what the customer is paying, and what the partner is
charging you. Leave the ticket number out.

The sale is stored as **Pending**. It is a real sale — the customer has
committed — but it is **never counted as a ticketed flight**, and the booking
does not move to Ticketed because of it. When the partner replies with the
ticket number, the pending sale is updated in place rather than duplicated.

> A pending sale with a selling price but no ticket number is exactly how a
> sale is recorded honestly before issuance is confirmed. The system will
> never claim a ticket exists when it does not.

### Step 10a — Read the margin

The sale register (the **Ticket Sales** section in the sidebar) shows one row
per ticket: the customer, the traveller, the partner, the ticket number, the
selling price, the supplier cost, and the gross margin.

> **Margin is the selling price less the supplier cost, and it is only shown
> when both amounts are in the same currency.** A sale bought in dollars and
> sold in birr shows its two amounts side by side and reports **"Not
> comparable"** rather than a number. The system never converts one currency
> into another on its own, because a margin built on a hidden conversion is
> not a real margin.

The totals across the top of the register are split by currency, and they
cover the whole filtered set rather than only the page on screen. Voided and
refunded sales are left out, because they are not sales.

The booking's own totals are calculated from its tickets, never entered
separately.

### Step 11 — Bill the customer
Create a **draft invoice** for the booking with one line per charge: airfare,
tax, agency fee, change fee, cancellation fee, or other. The server does the
arithmetic — quantity × unit price per line, subtotal, plus tax, minus
discount.

Then **issue** it. Issuing requires at least one line item and a due date that
has not already passed. It stamps the issue date and writes an audit entry.

A customer can then download a proper **PDF invoice** with the office's
letterhead. Drafts cannot be printed.

> Issuing an invoice does not email the customer and does not take any money.
> It is a statement of what is owed.

### Step 12 — Take the money
Record the receipt: customer, currency, amount, method (cash, bank transfer,
mobile money, card gateway, cheque, other), receipt number, and any external
reference such as a bank transaction ID.

Then **allocate** the receipt to an invoice. The system refuses to:
- allocate money in a different currency from the invoice,
- allocate to a draft, void, or cancelled invoice,
- allocate more than the receipt has left, or
- allocate more than the invoice still owes.

Both limits are checked in the same database transaction, so two staff
members cannot both spend the same receipt at once.

The invoice status then moves on its own: **Issued → Partially Paid → Paid**.

> Allocating to the same invoice twice **adds to it** rather than replacing
> it, so a second instalment is recorded by allocating again.

### Step 13 — Attach the paperwork
Upload the confirmation, itinerary, e-ticket, passport or ID scan, or receipt
against the booking or the customer. Maximum 10 MB, and only PDF, JPEG, PNG,
WebP, or plain text.

Files are stored under a random server-generated name in a private directory
that is never served as static files. The original filename is kept only for
display. The system records a SHA-256 fingerprint of the bytes so you can
prove later that the file was not altered.

Downloads are checked against the office, so a document belonging to another
office is not reachable.

### Step 14 — Close out
Once the trip is done or the booking is dead, move it to **Closed**. Closed is
a one-way door — it goes nowhere else.

---

## 4. The two halves of a sale

The system deliberately keeps these apart:

| | Invoice | Payment |
| --- | --- | --- |
| Question it answers | What does the customer owe? | What did the customer pay? |
| Created when | You decide to bill | The money actually arrives |
| Becomes | Issued | Confirmed |
| Tied together by | **Allocations** | |

A customer can pay one receipt across several invoices, and several receipts
can settle one invoice. That many-to-many link is the whole point: it is what
lets the office answer "who still owes me, and for what".

### Money is never mixed between currencies

Every amount carries its own currency. Every report and every dashboard tile
is grouped by currency, and **amounts in different currencies are never added
together**. An office that bills in ETB, USD, and EUR sees three separate
numbers, never one misleading total.

There is also no currency conversion anywhere in the system yet. Cross-currency
exposure is tracked, not converted — which is why profit in a single currency
is not yet possible.

---

## 5. The screens

Ten screens, in the sidebar.

### Operations Overview (Dashboard)
The morning glance. Who you are, which office you are in, and:
- **Activity**: total bookings, tickets issued, bookings awaiting ticketing,
  flight legs departing in the next seven days.
- **Financial position**: today's sales, payments received today, outstanding
  customer balances, outstanding supplier balances, and business expenses for
  the month so far — each split by currency.
- **Office directory**: active branches, staff, and roles.
- **Recent activity**: the last eight entries from the audit trail.
- **Module cards** that jump to each area.

### Ticket Sales
The sale register: one row per ticket sold, showing the customer, the
traveller, the partner, the ticket number and status, the airline's issue
date, the selling price, the supplier cost, and the gross margin. Search by
customer, booking code, PNR, or ticket number, and filter by status. The
totals across the top are split by currency and cover the whole filtered set.

### Bookings & PNRs
The booking register. Search by booking code, PNR, or customer name; filter by
status. Create bookings, move them through the lifecycle, read the full status
history, and open **Travel details** — a panel holding the traveler list, the
itinerary, the ticketing requests, the recorded tickets, and the attachments.
It also carries the two sale forms: recording a partner-issued ticket, and
recording a sale that is still awaiting issuance.

### Customers & Corporate
The shared customer directory. Search, register individuals and companies,
paginated.

### Airline & Rail Suppliers
The partners who issue tickets. Airlines, consolidators, host agencies, GDSs,
hotels, and others. Managers and administrators can add a supplier, set its
settlement currency and account reference, and **activate or deactivate** it.

> Suppliers are never deleted, only deactivated. Every booking and ticket that
> referenced a supplier must keep pointing at something real.

### Financials & BSP
Four tabs:
- **Invoices**: the invoice register, a draft invoice builder, the invoice
  detail view, PDF download, and the "Mark as issued" action.
- **Issued sales**: billed totals for a date range, grouped by currency.
  This is **billed**, not collected, and not accounting revenue recognition.
- **Balances**: what each customer still owes, with **CSV export** for
  chasing and for the accountant.
- **Supplier balances**: what the office still owes each ticket partner, with
  **CSV export**, plus the reconciliation that puts each partner invoice next
  to the ticket fares behind it.

### Customer Payments
The cash register. The payment register with search, a "Record payment" form,
and an **Allocate** action on each row that applies a receipt to an issued
invoice.

### Supplier Payments
The payables register. Two tabs:
- **Partner bills**: every bill a partner has sent, with the office's own
  bill number, the partner's reference, the amount, what has been paid, and
  what is still owed. Record a new bill, **Pay** a bill, and **Void** a bill
  that was entered in error.
- **Payments made**: the register of money sent to partners, with the method,
  the bank reference, and the totals split by currency.

### Business Expenses
The running costs of the office, kept apart from what is owed to ticket
suppliers. The register has search, category and status filters, and totals
split by currency. Record an expense, and **Void** one that was recorded in
the wrong branch or against the wrong category. A voided expense keeps its
record and leaves the totals.

### User Management
Who can do what. Only a staff member with the `ADMIN` role sees this screen.
It shows every staff profile with their office, their roles, and whether the
account is active.

- **Add staff member** records the person against an office and a set of
  roles. It needs the work email, the full name, the office, and at least one
  role. Nothing else is required, and nothing is sent to anyone.
  - **Roles only, sign-in later** (the default) — the profile and its roles
    are saved. The person cannot sign in yet; their sign-in has to be joined
    to the profile first.
  - **They already have a Supabase sign-in** — joins an account that already
    exists for the address. Nothing is created or sent.
- The system never creates a Supabase account, never sends an invitation, and
  never generates a password. Adding someone to the office and giving them a
  way in are two separate things, and only the first happens here.
- A profile with roles but no sign-in shows a **No sign-in yet** marker, and a
  **Link** action beside it for when the person has been given a sign-in and
  you want to connect it.
- **Edit access** on any row changes that person's office, roles, and active
  flag. Roles are replaced, not added to, so unchecking a role removes it.
- A staff member must keep at least one role. With none, the server refuses
  every request they make.
- Adding someone who already has a staff profile is refused with a message
  naming the email, so nobody ends up with two records.
- Deactivating someone blocks their sign-in and every office action they
  could take. Their history stays intact.

The five roles and what each one can reach:

| Role | Can do |
| --- | --- |
| `ADMIN` | Everything, plus staff administration |
| `MANAGER` | Suppliers, invoices, payments, bills, expenses, reports |
| `ACCOUNTANT` | Invoices, payments, bills, expenses, reports |
| `CASHIER` | Record receipts and apply them to invoices |
| `AGENT` | Customers, bookings, ticketing requests, ticket sales |

An administrator cannot remove their own administrator role or deactivate
themselves, and the last active administrator cannot be demoted. The server
refuses both, so an office can never lock itself out.

---

## 6. The rules that protect the business

These are enforced by the server, not by the interface. A rule the server
enforces cannot be bypassed by a careless click.

- A booking can never be Ticketed with zero travelers, and "Partially Ticketed"
  means strictly some-but-not-all travelers hold tickets.
- Closed is a one-way door.
- You cannot issue an invoice with no line items, or with a due date that has
  already passed.
- A discount can never exceed subtotal plus tax.
- A receipt can never be over-allocated in either direction.
- Money can only ever be allocated in the invoice's own currency.
- A voided receipt cannot be allocated.
- A traveler can hold only one active ticket.
- Only an active airline, consolidator, or host agency can issue tickets or
  be a ticketing partner.
- A traveler can hold only one pending sale, and issuing it updates that
  sale rather than creating a second one.
- A ticket number must be verified before it is recorded.
- A selling price and its currency are entered together or not at all.
- Gross margin is only reported for same-currency sales.
- A payment to a partner must be in the bill's own currency and cannot exceed
  what is still owed on that bill.
- The same partner invoice reference cannot be recorded twice for that
  partner.
- A bill with payments against it cannot be voided.
- Money owed to a partner is never counted twice: the bill and the ticket
  fare are shown side by side with the difference, never added together.
- An administrator cannot demote or deactivate themselves, and the last active
  administrator cannot be removed.
- The branch must be active for any booking work.
- Attachments are private, size-limited, type-limited, and office-checked.

### Overdue is a display state, not a stored one

The database keeps an invoice as `issued` or `partially_paid` and only shows
**Overdue** when the due date has passed. Nothing has to run in the background
to keep it correct, and there is no risk of a stale "not overdue" flag.

---

## 7. The audit trail

Every meaningful change is written to `activity_logs` **in the same database
transaction as the change itself**. The log can never disagree with the data.

Recorded: bookings created and status changes, travelers and flight segments
added, tickets issued, invoices drafted and issued, payments recorded and
allocated, supplier bills recorded, voided, and paid, business expenses
recorded and voided, suppliers created and activated or deactivated,
ticketing requests created and moved, documents uploaded, and staff
provisioned or changed.

What the log deliberately does **not** hold: traveler names, passwords,
tokens, passport numbers, or card data.

Two places where the audit trail is thinner than you might expect:
- **Customer creation is not audited.** Every other write is.
- **The IP address column is never populated.**

---

## 8. What is not built yet

The database tables for all of these already exist, so they can be added
without redesigning anything.

| Missing | Table ready | What it would do |
| --- | --- | --- |
| Customer refunds | `customer_refunds` | Returning money to a customer. |
| Ticket voids, refunds, exchanges, reissues | `ticket_actions` | The change-and-refund workflow, with request and approval separated. |
| Profit calculation | `exchange_rates` | Needs revenue, cost, and expense data plus a conversion basis. The margin per ticket is already computed for same-currency sales, and the office running costs are now recorded. |
| Deadline reminders | `ticketing_requests.ticketing_deadline` | The deadline is stored; nothing notifies anyone. |
| Office settings screen | `branches` | Managing offices from the interface. |
| Quote engine | `booking_quotes` | Pricing at quote time, with versions. |

Smaller gaps:
- There is no way to delete an uploaded document. Both the database row and
  the stored file need manual removal.
- A ticketing request is never set to **Expired** automatically.
- A supplier payment cannot be voided through the interface yet, so a bill
  with a payment against it cannot be voided either.
- Records are create-only. Customers, bookings, invoices, and payments cannot
  be edited — only their status can be moved.
