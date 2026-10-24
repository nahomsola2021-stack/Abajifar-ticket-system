-- 010_fix_bookings_status_check.sql
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('requested','quoted','confirmed','ticketing_pending','partially_ticketed','ticketed','cancelled','expired','closed'));
