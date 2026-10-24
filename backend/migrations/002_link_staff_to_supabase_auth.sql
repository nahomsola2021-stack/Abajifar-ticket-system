BEGIN;

ALTER TABLE public.users
    ADD COLUMN auth_user_id UUID UNIQUE
        REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.users
    ALTER COLUMN password_hash DROP NOT NULL;

COMMIT;
