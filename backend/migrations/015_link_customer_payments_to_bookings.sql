ALTER TABLE public.customer_payments
    ADD COLUMN booking_id BIGINT REFERENCES public.bookings(id) ON DELETE SET NULL;

CREATE INDEX idx_customer_payments_booking
    ON public.customer_payments(booking_id, received_at DESC)
    WHERE booking_id IS NOT NULL;

WITH payment_booking_links AS (
    SELECT
        allocations.payment_id,
        MIN(invoices.booking_id) AS booking_id
    FROM public.payment_allocations AS allocations
    JOIN public.invoices AS invoices ON invoices.id = allocations.invoice_id
    WHERE invoices.booking_id IS NOT NULL
    GROUP BY allocations.payment_id
    HAVING COUNT(DISTINCT invoices.booking_id) = 1
)
UPDATE public.customer_payments AS payments
SET booking_id = payment_booking_links.booking_id
FROM payment_booking_links
WHERE payments.id = payment_booking_links.payment_id;

UPDATE public.customer_payments AS payments
SET booking_id = bookings.id
FROM public.bookings AS bookings
WHERE payments.booking_id IS NULL
    AND payments.customer_id = bookings.customer_id
    AND payments.notes ILIKE '%' || bookings.booking_code || '%';
