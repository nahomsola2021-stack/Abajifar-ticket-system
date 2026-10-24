"""Verify the ticket sale workflow, including the gross margin rules.

Exercises the real handlers against the configured database, then removes
everything it created. Run from the backend directory:

    .\.venv\Scripts\python.exe scripts\verify_ticket_sales.py
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timezone
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
    booking_sale_summary,
    create_ticket_sale,
    list_ticket_sales,
    update_ticket_sale,
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
            FAILED.append(f"{label} (expected {status_code}, got {actual}: {error})")
            print(f"  FAIL  {label} (expected {status_code}, got {actual}: {error})")
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
                WHERE is_active = TRUE AND auth_user_id IS NOT NULL
                ORDER BY id LIMIT 1
                """
            )
        ).mappings().one()
        customer = connection.execute(
            text(
                """
                INSERT INTO public.customers (customer_type, display_name, email)
                VALUES ('individual', 'Sale Verification Customer', :email)
                RETURNING id
                """
            ),
            {"email": f"verify-sales-{run_id}@example.com"},
        ).scalar_one()
        booking = connection.execute(
            text(
                """
                INSERT INTO public.bookings (
                    booking_code, branch_id, customer_id, status, booking_channel
                )
                VALUES (:code, :branch_id, :customer_id, 'confirmed', 'office')
                RETURNING id
                """
            ),
            {
                "code": f"VERIFY-SALE-{run_id}",
                "branch_id": staff["branch_id"],
                "customer_id": customer,
            },
        ).scalar_one()
        passenger = connection.execute(
            text(
                """
                INSERT INTO public.booking_passengers (
                    booking_id, passenger_type, first_name, last_name
                )
                VALUES (:booking_id, 'ADT', 'Test', 'Traveller')
                RETURNING id
                """
            ),
            {"booking_id": booking},
        ).scalar_one()
        second_passenger = connection.execute(
            text(
                """
                INSERT INTO public.booking_passengers (
                    booking_id, passenger_type, first_name, last_name
                )
                VALUES (:booking_id, 'ADT', 'Second', 'Traveller')
                RETURNING id
                """
            ),
            {"booking_id": booking},
        ).scalar_one()
        connection.execute(
            text(
                """
                INSERT INTO public.flight_segments (
                    booking_id, segment_order, marketing_carrier, flight_number,
                    origin_airport, destination_airport, departure_at, arrival_at
                )
                VALUES (
                    :booking_id, 1, 'ET', 'ET100', 'ADD', 'JFK',
                    '2026-12-01T08:00:00+00:00', '2026-12-01T16:00:00+00:00'
                )
                """
            ),
            {"booking_id": booking},
        )
        supplier = connection.execute(
            text(
                """
                SELECT id FROM public.suppliers
                WHERE is_active = TRUE
                  AND supplier_type IN ('airline', 'consolidator', 'host_agency')
                ORDER BY id LIMIT 1
                """
            )
        ).scalar_one()

    user = AuthenticatedUser(id=str(staff["auth_user_id"]), email=staff["email"])
    try:
        print("Recording a pending sale")
        pending = create_ticket_sale(
            user=user,
            sale=main.TicketSaleCreate(
                booking_id=booking,
                booking_passenger_id=passenger,
                supplier_id=supplier,
                selling_price=Decimal("4500.0000"),
                selling_currency="ETB",
                supplier_cost=Decimal("3800.0000"),
                supplier_cost_currency="ETB",
                notes="Sold before the airline issued the ticket",
            ),
        )
        check("pending sale is recorded", pending.id is not None)
        check("pending sale has no ticket number", pending.ticket_number is None)
        check("pending sale is not marked issued", pending.ticket_status == "pending", pending.ticket_status)
        check(
            "pending sale does not count as ticketed",
            booking_status(booking) == "confirmed",
            booking_status(booking),
        )
        check(
            "same-currency margin is computed",
            pending.gross_margin == Decimal("700.0000"),
            str(pending.gross_margin),
        )
        check("margin is marked computable", pending.margin_computable is True)
        check("passenger name is shown", pending.passenger_name == "Test Traveller", pending.passenger_name)

        print("Issuing the pending sale")
        issued = update_ticket_sale(
            user=user,
            sale_id=pending.id,
            update=main.TicketSaleUpdate(
                ticket_number=f"VERIFY-{run_id}",
                verified=True,
                issue_date=date(2026, 12, 1),
            ),
        )
        check("sale becomes issued", issued.ticket_status == "issued", issued.ticket_status)
        check("ticket number is stored", issued.ticket_number == f"VERIFY-{run_id}")
        check("issue date is stored", issued.issue_date == date(2026, 12, 1), str(issued.issue_date))
        check(
            "booking advances to partially ticketed, not ticketed",
            booking_status(booking) == "partially_ticketed",
            booking_status(booking),
        )
        check("selling price survives issuing", issued.selling_price == Decimal("4500.0000"))
        check("supplier cost survives issuing", issued.supplier_cost == Decimal("3800.0000"))

        print("Cross-currency sales are never converted")
        cross = create_ticket_sale(
            user=user,
            sale=main.TicketSaleCreate(
                booking_id=booking,
                booking_passenger_id=second_passenger,
                supplier_id=supplier,
                selling_price=Decimal("500.0000"),
                selling_currency="USD",
                supplier_cost=Decimal("400.0000"),
                supplier_cost_currency="ETB",
            ),
        )
        check("cross-currency sale is recorded", cross.id is not None)
        check("cross-currency margin is not computed", cross.gross_margin is None, str(cross.gross_margin))
        check("cross-currency margin is flagged as not computable", cross.margin_computable is False)

        print("Guards")
        expect_http_error(
            "a second sale for the same traveler is rejected",
            409,
            create_ticket_sale,
            user=user,
            sale=main.TicketSaleCreate(
                booking_id=booking,
                booking_passenger_id=passenger,
                supplier_id=supplier,
                selling_price=Decimal("100.0000"),
                selling_currency="ETB",
            ),
        )
        expect_http_error(
            "a sale without an itinerary is rejected",
            409,
            create_ticket_sale,
            user=user,
            sale=main.TicketSaleCreate(
                booking_id=booking,
                booking_passenger_id=second_passenger,
                supplier_id=supplier,
                selling_price=Decimal("100.0000"),
                selling_currency="ETB",
            ),
        )

        print("Booking totals are derived from the tickets")
        summary = booking_sale_summary(user=user, booking_id=booking)
        check("sale count matches", summary.sale_count == 2, str(summary.sale_count))
        check("issued count matches", summary.issued_count == 1, str(summary.issued_count))
        check("pending count matches", summary.pending_count == 1, str(summary.pending_count))
        etb_selling = next(
            (row for row in summary.selling_total_by_currency if row.currency == "ETB"), None
        )
        check(
            "ETB selling total is derived",
            etb_selling is not None and etb_selling.amount == Decimal("4500.0000"),
            str(etb_selling),
        )
        usd_selling = next(
            (row for row in summary.selling_total_by_currency if row.currency == "USD"), None
        )
        check(
            "USD selling total is separate, not merged",
            usd_selling is not None and usd_selling.amount == Decimal("500.0000"),
            str(usd_selling),
        )
        margin_rows = {row.currency: row.amount for row in summary.gross_margin_by_currency}
        check(
            "margin only includes same-currency sales",
            margin_rows == {"ETB": Decimal("700.0000")},
            str(margin_rows),
        )

        print("Sale register")
        register = list_ticket_sales(user=user, q=f"VERIFY-SALE-{run_id}", limit=50, offset=0)
        check(
            "searching by booking code returns every sale on the booking",
            register.total == 2,
            str(register.total),
        )
        by_ticket_number = list_ticket_sales(
            user=user, q=f"VERIFY-{run_id}", limit=50, offset=0
        )
        check(
            "searching by ticket number finds the issued sale",
            by_ticket_number.total == 1,
            str(by_ticket_number.total),
        )
        filtered = list_ticket_sales(user=user, q="", status="pending", limit=50, offset=0)
        check("register filters by status", all(item.ticket_status == "pending" for item in filtered.items))
        check("register states the margin basis", "same currency" in register.margin_basis.lower())
    finally:
        cleanup([customer], [booking])

    print()
    print(f"{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for failure in FAILED:
            print(f"  - {failure}")
        raise SystemExit(1)


def booking_status(booking_id: int) -> str:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT status FROM public.bookings WHERE id = :booking_id"),
            {"booking_id": booking_id},
        ).scalar_one()


def remove_leftovers() -> None:
    with engine.begin() as connection:
        customer_ids = [
            row[0]
            for row in connection.execute(
                text("SELECT id FROM public.customers WHERE display_name = 'Sale Verification Customer'")
            )
        ]
        booking_ids = [
            row[0]
            for row in connection.execute(
                text("SELECT id FROM public.bookings WHERE booking_code LIKE 'VERIFY-SALE-%'")
            )
        ]
        if not customer_ids and not booking_ids:
            return
        cleanup(customer_ids, booking_ids)


def cleanup(customer_ids: list[int], booking_ids: list[int]) -> None:
    with engine.begin() as connection:
        if booking_ids:
            connection.execute(
                text("DELETE FROM public.activity_logs WHERE entity_type = 'ticket_sale' AND entity_id IN (SELECT tickets.id FROM public.tickets AS tickets JOIN public.booking_passengers AS bp ON bp.id = tickets.booking_passenger_id WHERE bp.booking_id = ANY(:booking_ids))"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.ticket_coupons WHERE ticket_id IN (SELECT tickets.id FROM public.tickets AS tickets JOIN public.booking_passengers AS bp ON bp.id = tickets.booking_passenger_id WHERE bp.booking_id = ANY(:booking_ids))"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.tickets WHERE booking_passenger_id IN (SELECT id FROM public.booking_passengers WHERE booking_id = ANY(:booking_ids))"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.flight_segments WHERE booking_id = ANY(:booking_ids)"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.booking_passengers WHERE booking_id = ANY(:booking_ids)"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.bookings WHERE id = ANY(:booking_ids)"),
                {"booking_ids": booking_ids},
            )
        if customer_ids:
            connection.execute(
                text("DELETE FROM public.customers WHERE id = ANY(:customer_ids)"),
                {"customer_ids": customer_ids},
            )
    print(f"Removed {len(customer_ids)} customer(s) and {len(booking_ids)} booking(s).")


if __name__ == "__main__":
    run()
