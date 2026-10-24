-- Extend the invoice lifecycle to cover overdue and cancelled documents.
--
-- 'overdue' is derived in the API from due_date plus the stored lifecycle status,
-- so the stored value stays 'issued' or 'partially_paid' and no background job is
-- required. It is still permitted as a stored value so a manual correction or a
-- later scheduled update remains possible.

BEGIN;

ALTER TABLE public.invoices
    DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE public.invoices
    ADD CONSTRAINT invoices_status_check
    CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void', 'cancelled'));

COMMIT;
