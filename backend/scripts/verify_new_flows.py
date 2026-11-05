"""End-to-end check of the payment, allocation, and ticketing request flows.

Runs against the configured database using the real API handlers, then removes
everything it created. Run from the backend directory:

    .\.venv\Scripts\python.exe scripts\verify_new_flows.py
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import text

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from database import engine
from main import (
    AuthenticatedUser,
    allocate_payment_to_invoice,
    create_booking,
    create_payment,
    create_ticketing_request,
    customer_balance_report,
    customer_balance_report_csv,
    dashboard_overview,
    download_document,
    list_documents,
    list_payments,
    update_ticketing_request,
)

PASSED: list[str] = []
FAILED: list[str] = []


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
    remove_leftovers()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    with engine.begin() as connection:
        staff = connection.execute(
            text(
                """
                SELECT id, auth_user_id, email, branch_id
                FROM public.users
                WHERE is_active = TRUE
                ORDER BY id
                LIMIT 1
                """
            )
        ).mappings().one_or_none()
        if staff is None:
            raise SystemExit("No active staff profile exists; provision one first.")
        if staff["auth_user_id"] is None:
            raise SystemExit("The staff profile is not linked to a Supabase Auth account.")

        customer = connection.execute(
            text(
                """
                INSERT INTO public.customers (customer_type, display_name, phone, email)
                VALUES ('individual', 'Verification Customer', '+255900000000', 'verify@example.com')
                RETURNING id
                """
            )
        ).scalar_one()
        booking = connection.execute(
            text(
                """
                INSERT INTO public.bookings (
                    booking_code, branch_id, customer_id, status, booking_channel
                )
                VALUES (
                    :code, :branch_id, :customer_id, 'confirmed', 'office'
                )
                RETURNING id
                """
            ),
            {
                "code": f"VERIFY-TEST-{run_id}",
                "branch_id": staff["branch_id"],
                "customer_id": customer,
            },
        ).scalar_one()
        supplier = connection.execute(
            text(
                """
                SELECT id FROM public.suppliers
                WHERE is_active = TRUE
                  AND supplier_type IN ('airline', 'consolidator', 'host_agency')
                ORDER BY id
                LIMIT 1
                """
            )
        ).scalar_one()

    user = AuthenticatedUser(id=str(staff["auth_user_id"]), email=staff["email"])
    try:
        print("Bookings")
        created = create_booking(
            user=user,
            booking=main.BookingCreate(customer_id=customer, booking_channel="office"),
        )
        check("booking is created", created.id is not None)
        check("booking starts as requested", created.status == "requested", created.status)
        check(
            "booking code is generated",
            created.booking_code.startswith("TO") and len(created.booking_code) == 24,
            created.booking_code,
        )

        print("Payments and allocations")
        payment = create_payment(
            user=user,
            payment=main.PaymentCreate(
                customer_id=customer,
                currency="ETB",
                amount=Decimal("1000.0000"),
                payment_method="bank_transfer",
                receipt_number=f"VERIFY-RCP-{run_id}",
            ),
        )
        check("payment records the amount", payment.amount == Decimal("1000.0000"), str(payment.amount))
        check("payment starts unallocated", payment.unallocated_total == Decimal("1000.0000"))
        check("payment is branch scoped", payment.customer_name == "Verification Customer")

        invoice = create_invoice_for(booking, customer, f"VERIFY-INV-{run_id}-1", "1000.0000")
        check("invoice starts issued", invoice["status"] == "issued", invoice["status"])

        allocation = allocate_payment_to_invoice(
            user=user,
            payment_id=payment.id,
            allocation=main.PaymentAllocationCreate(invoice_id=invoice["id"], amount=Decimal("400.0000")),
        )
        check("partial allocation is accepted", allocation.amount == Decimal("400.0000"))
        check(
            "invoice becomes partially_paid",
            invoice_status(invoice["id"]) == "partially_paid",
            invoice_status(invoice["id"]),
        )

        expect_http_error(
            "over-allocation is rejected",
            409,
            allocate_payment_to_invoice,
            user=user,
            payment_id=payment.id,
            allocation=main.PaymentAllocationCreate(invoice_id=invoice["id"], amount=Decimal("900.0000")),
        )

        foreign = create_payment(
            user=user,
            payment=main.PaymentCreate(
                customer_id=customer,
                currency="USD",
                amount=Decimal("100.0000"),
                payment_method="cash",
            ),
        )
        expect_http_error(
            "currency mismatch is rejected",
            409,
            allocate_payment_to_invoice,
            user=user,
            payment_id=foreign.id,
            allocation=main.PaymentAllocationCreate(invoice_id=invoice["id"], amount=Decimal("10.0000")),
        )

        draft_invoice = create_invoice_for(
            booking, customer, f"VERIFY-INV-{run_id}-DRAFT", "100.0000", status="draft"
        )
        expect_http_error(
            "payment cannot be allocated to a draft invoice",
            409,
            allocate_payment_to_invoice,
            user=user,
            payment_id=payment.id,
            allocation=main.PaymentAllocationCreate(
                invoice_id=draft_invoice["id"], amount=Decimal("10.0000")
            ),
        )

        allocate_payment_to_invoice(
            user=user,
            payment_id=payment.id,
            allocation=main.PaymentAllocationCreate(invoice_id=invoice["id"], amount=Decimal("600.0000")),
        )
        check(
            "invoice becomes paid when fully allocated",
            invoice_status(invoice["id"]) == "paid",
            invoice_status(invoice["id"]),
        )

        listed = list_payments(user=user, q=f"VERIFY-RCP-{run_id}", limit=50, offset=0)
        check("payment appears in the register", listed.total == 1, str(listed.total))
        check("payment shows fully allocated", listed.items[0].unallocated_total == Decimal("0"))

        report = customer_balance_report(user=user)
        check("settled invoice is not reported as outstanding", not any(
            item.customer_id == customer for item in report.items
        ))

        second = create_invoice_for(booking, customer, f"VERIFY-INV-{run_id}-2", "250.0000")
        balance = customer_balance_report(user=user)
        entry = next((item for item in balance.items if item.customer_id == customer), None)
        check("unsettled invoice is reported as outstanding", entry is not None)
        if entry is not None:
            check(
                "outstanding total matches the unpaid invoice",
                entry.outstanding_total == Decimal("250.0000"),
                str(entry.outstanding_total),
            )
        csv_body = customer_balance_report_csv(user=user)
        check("csv export produces a header row", "Outstanding total" in csv_body.body.decode("utf-8"))

        print("Ticketing requests")
        request = create_ticketing_request(
            user=user,
            booking_id=booking,
            request=main.TicketingRequestCreate(
                supplier_id=supplier,
                ticketing_deadline=datetime.now(timezone.utc) + timedelta(days=2),
            ),
        )
        check("request starts as not_requested", request.status == "not_requested", request.status)

        updated = update_ticketing_request(
            user=user,
            request_id=request.id,
            update=main.TicketingRequestStatusUpdate(status="submitted"),
        )
        check("request moves to submitted", updated.status == "submitted", updated.status)
        check(
            "booking moves to ticketing_pending",
            booking_status(booking) == "ticketing_pending",
            booking_status(booking),
        )

        expect_http_error(
            "invalid transition is rejected",
            409,
            update_ticketing_request,
            user=user,
            request_id=request.id,
            update=main.TicketingRequestStatusUpdate(status="not_requested"),
        )

        expect_http_error(
            "request cannot complete without a ticket",
            409,
            update_ticketing_request,
            user=user,
            request_id=request.id,
            update=main.TicketingRequestStatusUpdate(status="completed"),
        )

        print("Dashboard")
        overview = dashboard_overview(user=user)
        check("dashboard reports bookings", overview.booking_count >= 1, str(overview.booking_count))
        check("dashboard reports a currency list", isinstance(overview.today_sales_by_currency, list))
        check("dashboard reports recent activity", isinstance(overview.recent_activity, list))

        print("Documents")
        run_document_checks(user=user, booking_id=booking, customer_id=customer, run_id=run_id)
    finally:
        cleanup([customer], [booking])

    print()
    print(f"{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for failure in FAILED:
            print(f"  - {failure}")
        raise SystemExit(1)


def run_document_checks(user, booking_id: int, customer_id: int, run_id: str) -> None:
    """Exercise the attachment upload, list, and download flow."""
    payload = b"%PDF-1.4 verification attachment"

    async def upload(name: str, content_type: str, body: bytes):
        return await main.upload_document(
            file=make_upload_file(name, content_type, body),
            document_type="itinerary",
            booking_id=booking_id,
            customer_id=None,
            user=user,
        )

    record = asyncio.run(upload(f"verify-{run_id}.pdf", "application/pdf", payload))
    check("document upload returns a record", record.id is not None)
    check("document keeps the original filename", record.original_filename == f"verify-{run_id}.pdf")
    check("document records the size", record.file_size_bytes == len(payload), str(record.file_size_bytes))
    check("document records a sha256", len(record.sha256_hex or "") == 64)

    listed = list_documents(booking_id=booking_id, customer_id=None, user=user)
    check("document appears in the list", any(item.id == record.id for item in listed.items))

    download = download_document(document_id=record.id, user=user)
    check("document downloads the original bytes", download.body == payload)

    expect_http_error(
        "disallowed content type is rejected",
        415,
        asyncio.run,
        upload("evil.exe", "application/x-msdownload", b"nope"),
    )
    expect_http_error(
        "empty upload is rejected",
        422,
        asyncio.run,
        upload("empty.pdf", "application/pdf", b""),
    )
    expect_http_error(
        "upload without a booking or customer is rejected",
        422,
        asyncio.run,
        _upload_without_target(user, "orphan.pdf", "application/pdf", payload),
    )

    with engine.begin() as connection:
        row = connection.execute(
            text("SELECT object_key FROM public.documents WHERE id = :id"),
            {"id": record.id},
        ).mappings().one_or_none()
        connection.execute(text("DELETE FROM public.documents WHERE id = :id"), {"id": record.id})
    if row is not None:
        stored = main.document_storage_dir() / row["object_key"]
        stored.unlink(missing_ok=True)
    print("Verification document removed.")


async def _upload_without_target(user, name: str, content_type: str, body: bytes):
    return await main.upload_document(
        file=make_upload_file(name, content_type, body),
        document_type="other",
        booking_id=None,
        customer_id=None,
        user=user,
    )


def make_upload_file(name: str, content_type: str, body: bytes):
    from io import BytesIO

    from starlette.datastructures import Headers, UploadFile

    return UploadFile(
        file=BytesIO(body),
        filename=name,
        headers=Headers({"content-type": content_type}),
    )


def create_invoice_for(
    booking_id: int, customer_id: int, number: str, total: str, status: str = "issued"
) -> dict:
    with engine.begin() as connection:
        return connection.execute(
            text(
                """
                INSERT INTO public.invoices (
                    invoice_number, customer_id, booking_id, currency, issue_date,
                    due_date, status, subtotal, tax_total, discount_total, grand_total
                )
                VALUES (
                    :number, :customer_id, :booking_id, 'ETB', CURRENT_DATE,
                    CURRENT_DATE + 7, :status, :total, 0, 0, :total
                )
                RETURNING id, status
                """
            ),
            {
                "number": number,
                "customer_id": customer_id,
                "booking_id": booking_id,
                "total": total,
                "status": status,
            },
        ).mappings().one()


def invoice_status(invoice_id: int) -> str:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT status FROM public.invoices WHERE id = :invoice_id"),
            {"invoice_id": invoice_id},
        ).scalar_one()


def booking_status(booking_id: int) -> str:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT status FROM public.bookings WHERE id = :booking_id"),
            {"booking_id": booking_id},
        ).scalar_one()


def remove_leftovers() -> None:
    """Delete rows left behind by an interrupted verification run."""
    with engine.begin() as connection:
        booking_ids = [
            row[0]
            for row in connection.execute(
                text("SELECT id FROM public.bookings WHERE booking_code LIKE 'VERIFY-TEST-%'")
            )
        ]
        customer_ids = [
            row[0]
            for row in connection.execute(
                text("SELECT id FROM public.customers WHERE email = 'verify@example.com'")
            )
        ]
        if not booking_ids and not customer_ids:
            return
        cleanup(customer_ids, booking_ids)


def cleanup(customer_ids: list[int], booking_ids: list[int]) -> None:
    with engine.begin() as connection:
        if customer_ids:
            connection.execute(
                text(
                    """
                    DELETE FROM public.payment_allocations
                    WHERE payment_id IN (
                        SELECT id FROM public.customer_payments WHERE customer_id = ANY(:customer_ids)
                    )
                    """
                ),
                {"customer_ids": customer_ids},
            )
            connection.execute(
                text("DELETE FROM public.customer_payments WHERE customer_id = ANY(:customer_ids)"),
                {"customer_ids": customer_ids},
            )
            connection.execute(
                text("DELETE FROM public.invoices WHERE customer_id = ANY(:customer_ids)"),
                {"customer_ids": customer_ids},
            )
        if customer_ids:
            extra_booking_ids = [
                row[0]
                for row in connection.execute(
                    text("SELECT id FROM public.bookings WHERE customer_id = ANY(:customer_ids)"),
                    {"customer_ids": customer_ids},
                )
            ]
            booking_ids = list({*booking_ids, *extra_booking_ids})
        if booking_ids:
            object_keys = [
                row[0]
                for row in connection.execute(
                    text("SELECT object_key FROM public.documents WHERE booking_id = ANY(:booking_ids)"),
                    {"booking_ids": booking_ids},
                )
            ]
            connection.execute(
                text("DELETE FROM public.documents WHERE booking_id = ANY(:booking_ids)"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.ticketing_requests WHERE booking_id = ANY(:booking_ids)"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.bookings WHERE id = ANY(:booking_ids)"),
                {"booking_ids": booking_ids},
            )
            for object_key in object_keys:
                (main.document_storage_dir() / object_key).unlink(missing_ok=True)
        if customer_ids:
            connection.execute(
                text("DELETE FROM public.customers WHERE id = ANY(:customer_ids)"),
                {"customer_ids": customer_ids},
            )
    print(f"Removed {len(customer_ids)} customer(s) and {len(booking_ids)} booking(s).")


if __name__ == "__main__":
    run()
