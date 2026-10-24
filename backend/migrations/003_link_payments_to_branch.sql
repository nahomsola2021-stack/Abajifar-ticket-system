-- Link customer payments to the branch that received them.
-- A payment is collected at one office, so recording the branch keeps balances and
-- cash reporting correctly scoped instead of inferring it from allocations alone.

BEGIN;

ALTER TABLE public.customer_payments
    ADD COLUMN branch_id BIGINT REFERENCES branches(id) ON DELETE RESTRICT;

-- Backfill payments that were already applied to invoices: the branch comes from
-- the booking that owns the invoice the money was allocated to.
UPDATE public.customer_payments AS payments
SET branch_id = source.branch_id
FROM (
    SELECT DISTINCT allocations.payment_id, bookings.branch_id
    FROM public.payment_allocations AS allocations
    JOIN public.invoices AS invoices ON invoices.id = allocations.invoice_id
    JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
) AS source
WHERE source.payment_id = payments.id
  AND payments.branch_id IS NULL;

-- New payments always record a branch. Rows that predate this migration and were
-- never allocated keep a NULL branch and are excluded from branch-scoped lists
-- rather than being exposed to the wrong office.
CREATE INDEX idx_customer_payments_branch ON customer_payments(branch_id, received_at DESC);
CREATE INDEX idx_customer_payments_branch_customer
    ON customer_payments(branch_id, customer_id, received_at DESC);

COMMIT;
