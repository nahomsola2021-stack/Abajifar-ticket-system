-- 008_document_number_sequences.sql
--
-- Office-generated numbers for records that need one: supplier bills,
-- business expenses, and payment receipts.
--
-- The counter is a row that is incremented with a single atomic upsert, so
-- two staff members pressing the button at the same time cannot be handed
-- the same number. The row is locked by the upsert for the duration of the
-- statement.
--
-- Format: <KIND>-<BRANCH CODE>-<6 DIGITS>, for example EXP-HQ-000001.

BEGIN;

CREATE TABLE public.document_number_sequences (
    branch_id BIGINT NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    kind VARCHAR(40) NOT NULL,
    next_value BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (branch_id, kind)
);

CREATE OR REPLACE FUNCTION public.next_document_number(
    p_branch_id BIGINT,
    p_kind TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_value BIGINT;
    v_branch_code TEXT;
BEGIN
    INSERT INTO public.document_number_sequences (branch_id, kind, next_value)
    VALUES (p_branch_id, p_kind, 1)
    ON CONFLICT (branch_id, kind)
    DO UPDATE
    SET next_value = public.document_number_sequences.next_value + 1,
        updated_at = NOW()
    RETURNING next_value INTO v_value;

    SELECT code INTO v_branch_code
    FROM public.branches
    WHERE id = p_branch_id;

    RETURN upper(p_kind) || '-' || COALESCE(v_branch_code, 'HQ') || '-' || lpad(v_value::TEXT, 6, '0');
END;
$$;

-- Invoice numbers become office-generated too. The existing invoices keep
-- their manually entered numbers; only new ones are generated.
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_branch_id BIGINT)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT public.next_document_number(p_branch_id, 'INV');
$$;

CREATE OR REPLACE FUNCTION public.next_receipt_number(p_branch_id BIGINT)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT public.next_document_number(p_branch_id, 'RCP');
$$;

CREATE OR REPLACE FUNCTION public.next_supplier_bill_number(p_branch_id BIGINT)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT public.next_document_number(p_branch_id, 'BILL');
$$;

CREATE OR REPLACE FUNCTION public.next_expense_number(p_branch_id BIGINT)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT public.next_document_number(p_branch_id, 'EXP');
$$;

COMMIT;
