-- Align the ticketing request lifecycle with the documented workflow statuses:
-- Not Requested, Pending, Submitted, Failed, Completed.
--
-- 'draft' becomes 'not_requested' (nothing has been sent to the partner yet),
-- 'rejected' becomes 'failed', 'partner_confirmed' and 'ticketed' both collapse
-- into 'completed' because a partner-confirmed request is finished once the
-- ticket has been recorded.

BEGIN;

ALTER TABLE public.ticketing_requests
    DROP CONSTRAINT IF EXISTS ticketing_requests_status_check;

UPDATE public.ticketing_requests SET status = 'not_requested' WHERE status = 'draft';
UPDATE public.ticketing_requests SET status = 'failed' WHERE status = 'rejected';
UPDATE public.ticketing_requests SET status = 'completed' WHERE status IN ('partner_confirmed', 'ticketed');

ALTER TABLE public.ticketing_requests
    ADD CONSTRAINT ticketing_requests_status_check
    CHECK (status IN ('not_requested', 'pending', 'submitted', 'failed', 'completed', 'cancelled', 'expired'));

CREATE INDEX IF NOT EXISTS idx_ticketing_requests_deadline
    ON public.ticketing_requests(status, ticketing_deadline)
    WHERE ticketing_deadline IS NOT NULL;

COMMIT;
