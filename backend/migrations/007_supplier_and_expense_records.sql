-- 007_supplier_and_expense_records.sql
--
-- Connects the supplier and expense tables that already exist in the schema
-- to the rest of the system, so the money the company owes its partners and
-- the money it spends can actually be recorded and reported.
--
-- All changes are additive. No existing row is modified except the backfill
-- of supplier_bills.branch_id, which copies the office from the linked
-- booking.

BEGIN;

-- ---------------------------------------------------------------------------
-- Supplier bills
-- ---------------------------------------------------------------------------

-- A supplier bill is an obligation, and it belongs to an office. The office
-- was previously only implied through the linked booking, which meant a bill
-- for a general agency invoice (no booking) could not be recorded at all,
-- and could never be reported per office.
ALTER TABLE public.supplier_bills
    ADD COLUMN branch_id BIGINT REFERENCES public.branches(id) ON DELETE RESTRICT;

UPDATE public.supplier_bills AS bills
SET branch_id = bookings.branch_id
FROM public.bookings AS bookings
WHERE bookings.id = bills.booking_id
    AND bills.branch_id IS NULL;

ALTER TABLE public.supplier_bills
    ALTER COLUMN branch_id SET NOT NULL;

-- A partner's own invoice reference is unique per supplier, so the same bill
-- cannot be entered twice. The reference is optional, so only non-null
-- values are constrained.
CREATE UNIQUE INDEX uq_supplier_bill_reference
    ON public.supplier_bills (supplier_id, supplier_invoice_reference)
    WHERE supplier_invoice_reference IS NOT NULL;

-- A bill cannot be for less than nothing.
ALTER TABLE public.supplier_bills
    ADD CONSTRAINT supplier_bills_amount_positive
    CHECK (amount > 0);

-- ---------------------------------------------------------------------------
-- Business expenses
-- ---------------------------------------------------------------------------

-- Expenses get an office number so they can be quoted on a receipt and
-- referenced in a report, and a status so a mistake can be voided with a
-- reason rather than deleted.
ALTER TABLE public.business_expenses
    ADD COLUMN expense_number VARCHAR(40),
    ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'recorded',
    ADD COLUMN voided_at TIMESTAMPTZ,
    ADD COLUMN voided_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN void_reason TEXT;

ALTER TABLE public.business_expenses
    ADD CONSTRAINT business_expenses_status_check
    CHECK (status IN ('recorded', 'void'));

-- One expense number per office.
CREATE UNIQUE INDEX uq_business_expenses_number
    ON public.business_expenses (branch_id, expense_number)
    WHERE expense_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Documents attached to financial records
-- ---------------------------------------------------------------------------

-- A receipt, a supplier invoice, or a bill receipt needs to be traceable to
-- the financial record it evidences. The document points at the record; the
-- record is not modified to point back, so there is no circular reference.
ALTER TABLE public.documents
    ADD COLUMN invoice_id BIGINT REFERENCES public.invoices(id) ON DELETE CASCADE,
    ADD COLUMN payment_id BIGINT REFERENCES public.customer_payments(id) ON DELETE CASCADE,
    ADD COLUMN expense_id BIGINT REFERENCES public.business_expenses(id) ON DELETE CASCADE,
    ADD COLUMN supplier_bill_id BIGINT REFERENCES public.supplier_bills(id) ON DELETE CASCADE;

-- A document evidences at most one financial record. It may still be
-- attached to a booking and a customer at the same time, which is how
-- confirmations and receipts are already filed.
ALTER TABLE public.documents
    ADD CONSTRAINT documents_single_financial_owner
    CHECK (num_nonnulls(invoice_id, payment_id, expense_id, supplier_bill_id) <= 1);

CREATE INDEX idx_documents_invoice ON public.documents (invoice_id);
CREATE INDEX idx_documents_payment ON public.documents (payment_id);
CREATE INDEX idx_documents_expense ON public.documents (expense_id);
CREATE INDEX idx_documents_supplier_bill ON public.documents (supplier_bill_id);

-- ---------------------------------------------------------------------------
-- Reporting support
-- ---------------------------------------------------------------------------

CREATE INDEX idx_supplier_bills_branch ON public.supplier_bills (branch_id, status);
CREATE INDEX idx_business_expenses_expense_date ON public.business_expenses (branch_id, expense_date DESC);

COMMIT;
