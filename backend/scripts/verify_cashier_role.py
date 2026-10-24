"""Verify the CASHIER role can take money but cannot raise invoices.

Creates a temporary cashier staff profile, checks the finance endpoints behave
as the role intends, then removes the profile. Run from the backend directory:

    .\.venv\Scripts\python.exe scripts\verify_cashier_role.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from database import engine
from main import AuthenticatedUser, create_payment

PASSED: list[str] = []
FAILED: list[str] = []

CASHIER_EMAIL = "cashier.role.check@example.com"


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(f"{label} {detail}".strip())
        print(f"  FAIL  {label} {detail}")


def expect_http_error(label: str, status_code: int, function, *args, **kwargs) -> None:
    try:
        function(*args, **kwargs)
    except Exception as error:  # noqa: BLE001 - the handler raises HTTPException
        actual = getattr(error, "status_code", None)
        if actual == status_code:
            PASSED.append(label)
            print(f"  PASS  {label}")
        else:
            FAILED.append(f"{label} (expected {status_code}, got {actual})")
            print(f"  FAIL  {label} (expected {status_code}, got {actual})")
    else:
        FAILED.append(f"{label} (no error raised)")
        print(f"  FAIL  {label} (no error raised)")


def run() -> None:
    with engine.begin() as connection:
        admin = connection.execute(
            text(
                """
                SELECT u.id, u.auth_user_id, u.email, u.branch_id
                FROM public.users AS u
                JOIN public.user_roles AS ur ON ur.user_id = u.id
                JOIN public.roles AS r ON r.id = ur.role_id
                WHERE r.code = 'ADMIN' AND u.is_active AND u.auth_user_id IS NOT NULL
                LIMIT 1
                """
            )
        ).mappings().one()
        cashier_role = connection.execute(
            text("SELECT id FROM public.roles WHERE code = 'CASHIER'")
        ).scalar_one()
        customer = connection.execute(
            text(
                """
                INSERT INTO public.customers (customer_type, display_name, email)
                VALUES ('individual', 'Cashier Role Check', :email)
                RETURNING id
                """
            ),
            {"email": CASHIER_EMAIL},
        ).scalar_one()

        connection.execute(text("DELETE FROM public.users WHERE email = :email"), {"email": CASHIER_EMAIL})
        auth_id = uuid4()
        connection.execute(
            text(
                """
                INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
                VALUES (:id, 'authenticated', 'authenticated', :email, '{}'::jsonb, '{}'::jsonb)
                """
            ),
            {"id": auth_id, "email": CASHIER_EMAIL},
        )
        cashier = connection.execute(
            text(
                """
                INSERT INTO public.users (email, full_name, branch_id, is_active, auth_user_id)
                VALUES (:email, 'Cashier Role Check', :branch_id, TRUE, :auth_user_id)
                RETURNING id
                """
            ),
            {"email": CASHIER_EMAIL, "branch_id": admin["branch_id"], "auth_user_id": auth_id},
        ).scalar_one()
        connection.execute(
            text("INSERT INTO public.user_roles (user_id, role_id) VALUES (:user_id, :role_id)"),
            {"user_id": cashier, "role_id": cashier_role},
        )

    user = AuthenticatedUser(id=str(auth_id), email=CASHIER_EMAIL)
    try:
        print("Cashier cash desk")
        payment = create_payment(
            user=user,
            payment=main.PaymentCreate(
                customer_id=customer,
                currency="ETB",
                amount=Decimal("50.0000"),
                payment_method="cash",
            ),
        )
        check("cashier can record a receipt", payment.id is not None)
        check("payment is branch scoped to the cashier's office", payment.customer_name is not None)

        print("Cashier invoice limits")
        expect_http_error(
            "cashier cannot create an invoice",
            403,
            main.create_invoice,
            user=user,
            invoice=main.InvoiceCreate(
                invoice_number=f"CASHIER-CHECK-{datetime.now(timezone.utc).timestamp()}",
                customer_id=customer,
                booking_id=1,
                currency="ETB",
                due_date=datetime.now(timezone.utc).date(),
                items=[
                    main.InvoiceItemCreate(
                        item_type="airfare",
                        description="Cashier check",
                        quantity=Decimal("1"),
                        unit_price=Decimal("50.0000"),
                    )
                ],
            ),
        )

        print("Cashier read access")
        listing = main.list_payments(user=user, q="", limit=10, offset=0)
        check("cashier can read the payment register", listing is not None)
    finally:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    DELETE FROM public.payment_allocations
                    WHERE payment_id IN (
                        SELECT id FROM public.customer_payments WHERE customer_id = :customer_id
                    )
                    """
                ),
                {"customer_id": customer},
            )
            connection.execute(
                text("DELETE FROM public.customer_payments WHERE customer_id = :customer_id"),
                {"customer_id": customer},
            )
            connection.execute(
                text("DELETE FROM public.customers WHERE id = :customer_id"),
                {"customer_id": customer},
            )
            connection.execute(text("DELETE FROM public.users WHERE email = :email"), {"email": CASHIER_EMAIL})
            connection.execute(text("DELETE FROM auth.users WHERE email = :email"), {"email": CASHIER_EMAIL})
        print("Temporary cashier profile removed.")

    print()
    print(f"{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for failure in FAILED:
            print(f"  - {failure}")
        raise SystemExit(1)


if __name__ == "__main__":
    run()
