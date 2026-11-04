ALTER TABLE public.customer_payments
    DROP CONSTRAINT IF EXISTS customer_payments_amount_check;

ALTER TABLE public.customer_payments
    ADD CONSTRAINT customer_payments_amount_nonzero_check CHECK (amount <> 0);
