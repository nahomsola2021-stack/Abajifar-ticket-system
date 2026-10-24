-- 006_ticket_sales.sql
--
-- Ticket sales: record what a ticket was sold for, next to what it cost.
--
-- The selling price lives on the ticket, not on the booking, so that gross
-- margin is a per-ticket figure. Booking totals are derived from the
-- associated tickets rather than entered independently.
--
-- A sale can be recorded before the airline issues the ticket. Such a sale
-- has status 'pending' and no ticket number, and must never be counted as
-- ticketed. This extends, rather than replaces, the existing ticket model.

BEGIN;

-- ---------------------------------------------------------------------------
-- Selling price, business issue date, and notes on the sale itself.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tickets
    ADD COLUMN selling_price NUMERIC(18,4),
    ADD COLUMN selling_currency CHAR(3),
    ADD COLUMN issue_date DATE,
    ADD COLUMN notes TEXT;

ALTER TABLE public.tickets
    ADD CONSTRAINT tickets_selling_price_check
    CHECK (selling_price IS NULL OR selling_price >= 0);

-- A selling price and its currency are entered together or not at all. A
-- half-entered amount is a reporting error waiting to happen.
ALTER TABLE public.tickets
    ADD CONSTRAINT tickets_selling_price_currency_pair
    CHECK ((selling_price IS NULL) = (selling_currency IS NULL));

-- ---------------------------------------------------------------------------
-- A sale may exist before the ticket is issued.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tickets
    ALTER COLUMN ticket_number DROP NOT NULL;

ALTER TABLE public.tickets
    DROP CONSTRAINT tickets_ticket_status_check;

ALTER TABLE public.tickets
    ADD CONSTRAINT tickets_ticket_status_check
    CHECK (ticket_status IN ('issued', 'pending', 'voided', 'refunded', 'exchanged'));

-- 'issued' and 'exchanged' mean a real ticket number exists. The other states
-- do not require one.
ALTER TABLE public.tickets
    ADD CONSTRAINT tickets_issued_number_required
    CHECK (ticket_status NOT IN ('issued', 'exchanged') OR ticket_number IS NOT NULL);

-- One pending sale per traveller. When the ticket is issued the pending sale
-- is updated in place rather than duplicated.
CREATE UNIQUE INDEX uq_one_pending_sale_per_passenger
    ON public.tickets (booking_passenger_id)
    WHERE ticket_status = 'pending';

-- ---------------------------------------------------------------------------
-- Reporting support.
-- ---------------------------------------------------------------------------

-- The sale register is read by customer, status, and sale date.
CREATE INDEX idx_tickets_sale_status
    ON public.tickets (ticket_status);

CREATE INDEX idx_tickets_issued_by_supplier
    ON public.tickets (issued_by_supplier_id, issue_date DESC);

COMMIT;
