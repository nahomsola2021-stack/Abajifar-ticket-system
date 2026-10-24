-- 009_supplier_bill_number.sql
--
-- Each supplier bill gets an office-generated number so it can be quoted on a
-- payment instruction and referenced in a reconciliation. The partner's own
-- invoice reference stays alongside it: that is the partner's identifier,
-- this is ours, and either can be missing.
--
-- Additive only. Existing bills keep a null number until one is assigned.

BEGIN;

ALTER TABLE public.supplier_bills
    ADD COLUMN bill_number VARCHAR(40);

CREATE UNIQUE INDEX uq_supplier_bills_bill_number
    ON public.supplier_bills (branch_id, bill_number)
    WHERE bill_number IS NOT NULL;

COMMIT;
