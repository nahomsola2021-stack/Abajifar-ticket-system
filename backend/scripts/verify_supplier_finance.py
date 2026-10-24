"""End-to-end check of the supplier bills, supplier payments, and expense flows.

Runs against the configured database using the real API handlers, then removes
everything it created. Run from the backend directory:

    .\.venv\Scripts\python.exe scripts\verify_supplier_finance.py
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import text

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from database import engine
from main import (
    AuthenticatedUser,
    create_expense,
    create_supplier_bill,
    create_supplier_payment,
    create_ticket_sale,
    dashboard_overview,
    expense_summary_report,
    list_expenses,
    list_supplier_bills,
    list_supplier_payments,
    supplier_balance_report,
    supplier_balance_report_csv,
    void_expense,
    void_supplier_bill,
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


def expect_validation_error(label: str, model, **kwargs) -> None:
    try:
        model(**kwargs)
    except ValidationError:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(f"{label} (no validation error raised)")
        print(f"  FAIL  {label} (no validation error raised)")


def run() -> None:
    remove_leftovers()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    today = date.today()

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
                VALUES ('individual', 'Finance Verification Customer', '+255900000001', 'verify-finance@example.com')
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
                "code": f"VERIFY-FIN-{run_id}",
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
                VALUES (:booking_id, 'ADT', 'Finance', 'Traveller')
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
                ORDER BY id
                LIMIT 1
                """
            )
        ).scalar_one()

    user = AuthenticatedUser(id=str(staff["auth_user_id"]), email=staff["email"])
    created_bill_ids: list[int] = []
    try:
        print("Issuing a ticket so the reconciliation has a ticket fare to compare")
        sale = create_ticket_sale(
            user=user,
            sale=main.TicketSaleCreate(
                booking_id=booking,
                booking_passenger_id=passenger,
                supplier_id=supplier,
                ticket_number=f"VERIFY-TKT-{run_id}",
                selling_price=Decimal("4500.0000"),
                selling_currency="ETB",
                supplier_cost=Decimal("3800.0000"),
                supplier_cost_currency="ETB",
                verified=True,
            ),
        )
        check("ticket is issued", sale.ticket_status == "issued", sale.ticket_status)
        check("ticket records the supplier cost", sale.supplier_cost == Decimal("3800.0000"))

        print("Supplier bills")
        bill = create_supplier_bill(
            user=user,
            bill=main.SupplierBillCreate(
                supplier_id=supplier,
                booking_id=booking,
                supplier_invoice_reference=f"VERIFY-REF-{run_id}",
                currency="ETB",
                bill_date=today,
                due_date=today + timedelta(days=14),
                amount=Decimal("4000.0000"),
                notes="Partner invoice for the verified ticket",
            ),
        )
        check("bill is recorded", bill.id is not None)
        created_bill_ids.append(bill.id)
        check("bill starts unpaid", bill.status == "unpaid", bill.status)
        check("bill gets an office number", bool(bill.bill_number), str(bill.bill_number))
        check(
            "bill number is branch scoped",
            (bill.bill_number or "").split("-")[1] != "",
            str(bill.bill_number),
        )
        check("bill starts with nothing paid", bill.paid_total == Decimal("0"))
        check(
            "bill outstanding equals the amount",
            bill.outstanding_total == Decimal("4000.0000"),
            str(bill.outstanding_total),
        )

        expect_http_error(
            "a repeated partner reference is rejected",
            409,
            create_supplier_bill,
            user=user,
            bill=main.SupplierBillCreate(
                supplier_id=supplier,
                supplier_invoice_reference=f"VERIFY-REF-{run_id}",
                currency="ETB",
                bill_date=today,
                amount=Decimal("100.0000"),
            ),
        )

        expect_validation_error(
            "a due date before the bill date is rejected",
            main.SupplierBillCreate,
            supplier_id=supplier,
            currency="ETB",
            bill_date=today,
            due_date=today - timedelta(days=1),
            amount=Decimal("100.0000"),
        )

        expect_validation_error(
            "a zero amount is rejected",
            main.SupplierBillCreate,
            supplier_id=supplier,
            currency="ETB",
            bill_date=today,
            amount=Decimal("0"),
        )

        print("Supplier payments")
        expect_http_error(
            "a payment in another currency is rejected",
            409,
            create_supplier_payment,
            bill_id=bill.id,
            payment=main.SupplierPaymentCreate(
                currency="USD",
                amount=Decimal("1000.0000"),
                payment_method="bank_transfer",
            ),
            user=user,
        )

        expect_http_error(
            "a payment larger than the outstanding amount is rejected",
            409,
            create_supplier_payment,
            bill_id=bill.id,
            payment=main.SupplierPaymentCreate(
                currency="ETB",
                amount=Decimal("5000.0000"),
                payment_method="bank_transfer",
            ),
            user=user,
        )

        first = create_supplier_payment(
            user=user,
            bill_id=bill.id,
            payment=main.SupplierPaymentCreate(
                currency="ETB",
                amount=Decimal("1500.0000"),
                payment_method="bank_transfer",
                external_reference=f"VERIFY-WIRE-{run_id}",
            ),
        )
        check("payment is recorded", first.id is not None)
        check("payment keeps the bill currency", first.currency == "ETB")
        check(
            "bill becomes partially paid",
            bill_status(bill.id) == "partially_paid",
            bill_status(bill.id),
        )

        listed_bills = list_supplier_bills(user=user, q=f"VERIFY-REF-{run_id}")
        check("bill appears in the register", listed_bills.total == 1, str(listed_bills.total))
        check(
            "bill shows the partial payment",
            listed_bills.items[0].paid_total == Decimal("1500.0000"),
            str(listed_bills.items[0].paid_total),
        )
        check(
            "bill shows the remaining outstanding",
            listed_bills.items[0].outstanding_total == Decimal("2500.0000"),
            str(listed_bills.items[0].outstanding_total),
        )

        second = create_supplier_payment(
            user=user,
            bill_id=bill.id,
            payment=main.SupplierPaymentCreate(
                currency="ETB",
                amount=Decimal("2500.0000"),
                payment_method="bank_transfer",
            ),
        )
        check("second payment is recorded", second.id is not None)
        check("bill becomes paid", bill_status(bill.id) == "paid", bill_status(bill.id))

        listed_payments = list_supplier_payments(user=user, q=f"VERIFY-WIRE-{run_id}")
        check("payment appears in the register", listed_payments.total == 1, str(listed_payments.total))
        check(
            "payment register totals by currency",
            any(
                entry.currency == "ETB" and entry.amount == Decimal("1500.0000")
                for entry in listed_payments.paid_by_currency
            ),
            str(listed_payments.paid_by_currency),
        )

        expect_http_error(
            "a settled bill cannot take another payment",
            409,
            create_supplier_payment,
            bill_id=bill.id,
            payment=main.SupplierPaymentCreate(
                currency="ETB",
                amount=Decimal("1.0000"),
            ),
            user=user,
        )

        print("Supplier balance report")
        report = supplier_balance_report(user=user)
        entry = next(
            (
                item
                for item in report.items
                if item.supplier_id == supplier and item.currency == "ETB"
            ),
            None,
        )
        check("settled bill is not reported as outstanding", entry is None, str(entry))

        open_bill = create_supplier_bill(
            user=user,
            bill=main.SupplierBillCreate(
                supplier_id=supplier,
                currency="ETB",
                bill_date=today - timedelta(days=20),
                due_date=today - timedelta(days=5),
                amount=Decimal("500.0000"),
            ),
        )
        created_bill_ids.append(open_bill.id)
        report = supplier_balance_report(user=user)
        entry = next(
            (
                item
                for item in report.items
                if item.supplier_id == supplier and item.currency == "ETB"
            ),
            None,
        )
        check("open bill is reported as outstanding", entry is not None)
        if entry is not None:
            check(
                "outstanding matches the open bill",
                entry.outstanding_total == Decimal("500.0000"),
                str(entry.outstanding_total),
            )
            check(
                "the overdue bill is counted as overdue",
                entry.overdue_bill_count == 1,
                str(entry.overdue_bill_count),
            )
            check(
                "the overdue amount is reported",
                entry.overdue_total == Decimal("500.0000"),
                str(entry.overdue_total),
            )

        usd_bill = create_supplier_bill(
            user=user,
            bill=main.SupplierBillCreate(
                supplier_id=supplier,
                currency="USD",
                bill_date=today,
                amount=Decimal("75.0000"),
            ),
        )
        created_bill_ids.append(usd_bill.id)
        report = supplier_balance_report(user=user)
        etb_total = next(
            (item for item in report.totals_by_currency if item.currency == "ETB"), None
        )
        usd_total = next(
            (item for item in report.totals_by_currency if item.currency == "USD"), None
        )
        check("the ETB total is kept separate", etb_total is not None)
        check("the USD total is kept separate", usd_total is not None)
        if etb_total is not None:
            check(
                "the ETB total holds only ETB bills",
                etb_total.outstanding_total == Decimal("500.0000"),
                str(etb_total.outstanding_total),
            )
        if usd_total is not None:
            check(
                "the USD total holds only USD bills",
                usd_total.outstanding_total == Decimal("75.0000"),
                str(usd_total.outstanding_total),
            )

        print("Cost reconciliation")
        reconciliation = next(
            (
                item
                for item in report.reconciliation
                if item.booking_id == booking and item.supplier_id == supplier
            ),
            None,
        )
        check("the booking appears in the reconciliation", reconciliation is not None)
        if reconciliation is not None:
            check(
                "the billed amount is shown",
                reconciliation.billed_total == Decimal("4000.0000"),
                str(reconciliation.billed_total),
            )
            check(
                "the ticket fare is shown next to it",
                reconciliation.ticket_fare_total == Decimal("3800.0000"),
                str(reconciliation.ticket_fare_total),
            )
            check(
                "the variance explains the difference",
                reconciliation.variance == Decimal("200.0000"),
                str(reconciliation.variance),
            )

        csv_body = supplier_balance_report_csv(user=user)
        check("csv export produces a header row", "Outstanding total" in csv_body.body.decode("utf-8"))

        print("Voiding a bill")
        expect_http_error(
            "a bill with payments cannot be voided",
            409,
            void_supplier_bill,
            bill_id=bill.id,
            payload=main.VoidRequest(reason="entered against the wrong ticket"),
            user=user,
        )

        voided = void_supplier_bill(
            user=user,
            bill_id=open_bill.id,
            payload=main.VoidRequest(reason="the partner withdrew the invoice"),
        )
        check("the bill is voided", voided.status == "void", voided.status)
        report = supplier_balance_report(user=user)
        entry = next(
            (
                item
                for item in report.items
                if item.supplier_id == supplier and item.currency == "ETB"
            ),
            None,
        )
        check("a voided bill leaves the balance report", entry is None, str(entry))

        print("Business expenses")
        before = list_expenses(user=user, limit=1)
        baseline = next(
            (
                item.amount
                for item in before.total_by_currency
                if item.currency == "ETB"
            ),
            Decimal("0"),
        )
        expense = create_expense(
            user=user,
            expense=main.ExpenseCreate(
                expense_date=today,
                category="utilities",
                description="Electricity bill for the verification run",
                currency="ETB",
                amount=Decimal("120.0000"),
                payment_method="bank_transfer",
            ),
        )
        check("expense is recorded", expense.id is not None)
        check("expense gets an office number", bool(expense.expense_number), str(expense.expense_number))
        check("expense starts as recorded", expense.status == "recorded", expense.status)

        listed = list_expenses(user=user, q=f"Electricity bill for the verification run")
        check("expense appears in the register", listed.total == 1, str(listed.total))
        after = next(
            (item.amount for item in listed.total_by_currency if item.currency == "ETB"),
            Decimal("0"),
        )
        check(
            "the expense total grew by the amount",
            after - baseline == Decimal("120.0000"),
            str(after - baseline),
        )

        summary = expense_summary_report(user=user)
        summary_etb = next(
            (item for item in summary.total_by_currency if item.currency == "ETB"), None
        )
        check("the summary totals expenses by currency", summary_etb is not None)

        expect_validation_error(
            "an unknown category is rejected",
            main.ExpenseCreate,
            expense_date=today,
            category="petrol",
            description="Fuel for the verification run",
            currency="ETB",
            amount=Decimal("10.0000"),
        )

        voided_expense = void_expense(
            user=user,
            expense_id=expense.id,
            payload=main.ExpenseVoidRequest(reason="recorded in the wrong branch"),
        )
        check("the expense is voided", voided_expense.status == "void", voided_expense.status)
        check("the void reason is kept", voided_expense.void_reason == "recorded in the wrong branch")

        listed = list_expenses(user=user, q="Electricity bill for the verification run")
        after = next(
            (item.amount for item in listed.total_by_currency if item.currency == "ETB"),
            Decimal("0"),
        )
        check(
            "a voided expense leaves the totals",
            after == baseline,
            str(after),
        )

        expect_http_error(
            "an expense cannot be voided twice",
            409,
            void_expense,
            expense_id=expense.id,
            payload=main.ExpenseVoidRequest(reason="again"),
            user=user,
        )

        print("Dashboard")
        overview = dashboard_overview(user=user)
        check(
            "dashboard reports supplier balances by currency",
            isinstance(overview.supplier_outstanding_by_currency, list),
        )
        check(
            "dashboard reports business expenses by currency",
            isinstance(overview.month_expenses_by_currency, list),
        )
        check(
            "a voided expense is not counted in the dashboard",
            not any(
                Number(item.amount) == Decimal("120.0000")
                for item in overview.month_expenses_by_currency
                if item.currency == "ETB"
            ),
        )
    finally:
        cleanup([customer], [booking], created_bill_ids)

    print()
    print(f"{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        for failure in FAILED:
            print(f"  - {failure}")
        raise SystemExit(1)


def bill_status(bill_id: int) -> str:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT status FROM public.supplier_bills WHERE id = :bill_id"),
            {"bill_id": bill_id},
        ).scalar_one()


def remove_leftovers() -> None:
    """Delete rows left behind by an interrupted verification run."""
    with engine.begin() as connection:
        booking_ids = [
            row[0]
            for row in connection.execute(
                text("SELECT id FROM public.bookings WHERE booking_code LIKE 'VERIFY-FIN-%'")
            )
        ]
        customer_ids = [
            row[0]
            for row in connection.execute(
                text("SELECT id FROM public.customers WHERE email = 'verify-finance@example.com'")
            )
        ]
        bill_ids = [
            row[0]
            for row in connection.execute(
                text(
                    """
                    SELECT id FROM public.supplier_bills
                    WHERE supplier_invoice_reference LIKE 'VERIFY-REF-%'
                       OR bill_number IN (
                            SELECT bill_number FROM public.supplier_bills
                            WHERE notes ILIKE '%verification run%'
                       )
                    """
                )
            )
        ]
        if not booking_ids and not customer_ids and not bill_ids:
            return
        cleanup(customer_ids, booking_ids, bill_ids)


def cleanup(
    customer_ids: list[int], booking_ids: list[int], bill_ids: list[int]
) -> None:
    with engine.begin() as connection:
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
            connection.execute(
                text(
                    """
                    DELETE FROM public.supplier_payments
                    WHERE supplier_bill_id IN (
                        SELECT id FROM public.supplier_bills WHERE booking_id = ANY(:booking_ids)
                    )
                    """
                ),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text("DELETE FROM public.supplier_bills WHERE booking_id = ANY(:booking_ids)"),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text(
                    """
                    DELETE FROM public.ticket_coupons
                    WHERE ticket_id IN (
                        SELECT tickets.id FROM public.tickets AS tickets
                        JOIN public.booking_passengers AS passengers
                            ON passengers.id = tickets.booking_passenger_id
                        WHERE passengers.booking_id = ANY(:booking_ids)
                    )
                    """
                ),
                {"booking_ids": booking_ids},
            )
            connection.execute(
                text(
                    """
                    DELETE FROM public.ticket_actions
                    WHERE ticket_id IN (
                        SELECT tickets.id FROM public.tickets AS tickets
                        JOIN public.booking_passengers AS passengers
                            ON passengers.id = tickets.booking_passenger_id
                        WHERE passengers.booking_id = ANY(:booking_ids)
                    )
                    """
                ),
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
        if bill_ids:
            connection.execute(
                text(
                    """
                    DELETE FROM public.supplier_payments
                    WHERE supplier_bill_id = ANY(:bill_ids)
                    """
                ),
                {"bill_ids": bill_ids},
            )
            connection.execute(
                text("DELETE FROM public.supplier_bills WHERE id = ANY(:bill_ids)"),
                {"bill_ids": bill_ids},
            )
        connection.execute(
            text(
                """
                DELETE FROM public.business_expenses
                WHERE description ILIKE '%verification run%'
                """
            )
        )
        if customer_ids:
            connection.execute(
                text("DELETE FROM public.bookings WHERE customer_id = ANY(:customer_ids)"),
                {"customer_ids": customer_ids},
            )
            connection.execute(
                text("DELETE FROM public.customers WHERE id = ANY(:customer_ids)"),
                {"customer_ids": customer_ids},
            )
    print(f"Removed {len(customer_ids)} customer(s) and {len(booking_ids)} booking(s).")


if __name__ == "__main__":
    run()
