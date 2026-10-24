
import logging
import json
import csv
import io
import inspect
import os
import re
import hashlib
import asyncio
import time
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from secrets import token_hex
from typing import Literal
from uuid import uuid4
from xml.sax.saxutils import escape

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from fastapi import params as fastapi_params
from sqlalchemy import text, bindparam, Integer, String
from sqlalchemy.exc import SQLAlchemyError
from pydantic import BaseModel, Field, field_validator, model_validator
from database import engine

# --- NEW: Load environment variables and initialize OpenAI ---
from dotenv import load_dotenv
load_dotenv()

try:
    from openai import OpenAI
    client = OpenAI() # Automatically reads OPENAI_API_KEY from the environment
except Exception as e:
    OpenAI = None
    client = None
    print(f"WARNING: OpenAI Client failed to initialize. Check your .env file. Error: {e}")
# -------------------------------------------------------------

logger = logging.getLogger(__name__)
bearer_scheme = HTTPBearer(auto_error=False)

app = FastAPI(
    title="Ticket Office Management System",
    description="Manual ticket office management API",
    version="0.1.0",
)

def backfill_tickets():
    """Idempotent backfill of missing invoices and supplier bills for existing tickets."""
    with engine.begin() as connection:
        tickets = connection.execute(
            text(
                """
                SELECT t.id, t.booking_passenger_id, t.issued_by_supplier_id AS supplier_id,
                       t.fare_amount, t.currency, t.selling_price, t.selling_currency,
                       t.ticket_number, bp.booking_id, b.customer_id, b.booking_code
                FROM public.tickets t
                JOIN public.booking_passengers bp ON bp.id = t.booking_passenger_id
                JOIN public.bookings b ON b.id = bp.booking_id
                WHERE t.selling_price IS NOT NULL
                """
            )
        ).mappings().all()

        for t in tickets:
            # Check supplier bill
            bill_exists = connection.execute(
                text("SELECT 1 FROM public.supplier_bills WHERE booking_id = :bid LIMIT 1"),
                {"bid": t["booking_id"]},
            ).scalar_one_or_none()
            if bill_exists is None and t["fare_amount"] is not None:
                bill_number = connection.execute(
                    text("SELECT public.next_supplier_bill_number(:branch_id)"),
                    {"branch_id": 1},
                ).scalar_one()
                connection.execute(
                    text(
                        """
                        INSERT INTO public.supplier_bills
                            (supplier_id, branch_id, booking_id, bill_number, currency, bill_date, amount, status, created_by)
                        VALUES
                            (:supplier_id, 1, :booking_id, :bill_number, :currency, CURRENT_DATE, :amount, 'unpaid', 1)
                        """
                    ),
                    {
                        "supplier_id": t["supplier_id"],
                        "booking_id": t["booking_id"],
                        "bill_number": bill_number,
                        "currency": t["currency"],
                        "amount": t["fare_amount"],
                    },
                )

            # Check invoice
            inv_exists = connection.execute(
                text("SELECT 1 FROM public.invoices WHERE booking_id = :bid LIMIT 1"),
                {"bid": t["booking_id"]},
            ).scalar_one_or_none()
            if inv_exists is None and t["selling_price"] is not None:
                invoice_number = f"INV-{t['booking_code'][-6:]}-{token_hex(2).upper()}"
                inv_row = connection.execute(
                    text(
                        """
                        INSERT INTO public.invoices
                            (invoice_number, customer_id, booking_id, currency, status, subtotal, tax_total, discount_total, grand_total, created_by)
                        VALUES
                            (:invoice_number, :customer_id, :booking_id, :currency, 'issued', :amount, 0, 0, :amount, 1)
                        ON CONFLICT (invoice_number) DO NOTHING
                        RETURNING id
                        """
                    ),
                    {
                        "invoice_number": invoice_number,
                        "customer_id": t["customer_id"],
                        "booking_id": t["booking_id"],
                        "currency": t["selling_currency"],
                        "amount": t["selling_price"],
                    },
                ).scalar_one_or_none()
                if inv_row:
                    passenger = connection.execute(
                        text("SELECT first_name, last_name FROM public.booking_passengers WHERE id = :pid"),
                        {"pid": t["booking_passenger_id"]},
                    ).mappings().one_or_none()
                    pax_name = f"{passenger['first_name']} {passenger['last_name']}" if passenger else "Traveler"
                    connection.execute(
                        text(
                            """
                            INSERT INTO public.invoice_items
                                (invoice_id, booking_id, item_type, description, quantity, unit_price, line_total)
                            VALUES
                                (:invoice_id, :booking_id, 'airfare', :description, 1, :unit_price, :line_total)
                            """
                        ),
                        {
                            "invoice_id": inv_row,
                            "booking_id": t["booking_id"],
                            "description": f"Airfare for {pax_name} (Ticket: {t['ticket_number']})",
                            "unit_price": t["selling_price"],
                            "line_total": t["selling_price"],
                        },
                    )

    # Auto-allocation sweep: allocate unallocated payments to open invoices (FIFO)
    payments = connection.execute(
        text(
            """
            SELECT cp.id, cp.customer_id, cp.currency, cp.amount,
                   COALESCE((SELECT SUM(pa.amount) FROM public.payment_allocations pa WHERE pa.payment_id = cp.id), 0) AS allocated
            FROM public.customer_payments cp
            """
        )
    ).mappings().all()

    for pay in payments:
        remaining = pay["amount"] - pay["allocated"]
        if remaining <= 0:
            continue
        outstanding = connection.execute(
            text(
                """
                SELECT i.id, i.grand_total,
                       COALESCE((SELECT SUM(pa.amount) FROM public.payment_allocations pa WHERE pa.invoice_id = i.id), 0) AS allocated
                FROM public.invoices i
                WHERE i.customer_id = :customer_id
                  AND i.currency = :currency
                  AND i.status IN ('draft', 'issued', 'partially_paid')
                ORDER BY i.issue_date ASC, i.id ASC
                """
            ),
            {"customer_id": pay["customer_id"], "currency": pay["currency"]},
        ).mappings().all()

        for inv in outstanding:
            if remaining <= 0:
                break
            balance = inv["grand_total"] - inv["allocated"]
            if balance <= 0:
                continue
            alloc_amount = min(balance, remaining)
            # Check if allocation already exists
            existing = connection.execute(
                text("SELECT 1 FROM public.payment_allocations WHERE payment_id = :pid AND invoice_id = :iid LIMIT 1"),
                {"pid": pay["id"], "iid": inv["id"]},
            ).scalar_one_or_none()
            if existing is None:
                connection.execute(
                    text("INSERT INTO public.payment_allocations (payment_id, invoice_id, amount) VALUES (:pid, :iid, :amt)"),
                    {"pid": pay["id"], "iid": inv["id"], "amt": alloc_amount},
                )
            new_allocated = inv["allocated"] + alloc_amount
            if new_allocated >= inv["grand_total"]:
                new_status = "paid"
            else:
                new_status = "partially_paid"
            connection.execute(
                text("UPDATE public.invoices SET status = :status WHERE id = :id"),
                {"status": new_status, "id": inv["id"]},
            )
            remaining -= alloc_amount

    print("Backfill complete.")


@app.on_event("startup")
def startup_backfill():
    try:
        backfill_tickets()
    except Exception as e:
        print(f"Backfill error: {e}")
# Allow the deployed frontend to talk to this backend. The local development
# origins are always allowed so the app works before any deployment settings
# are in place; extra origins come from CORS_ORIGINS.
LOCAL_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://[::1]:4173",
]

# The dev server may bind to the IPv6 loopback, and the browser then sends
# that address as the origin. Any loopback host on any port is allowed so the
# preflight is not rejected; deployed origins still have to be listed.
LOCAL_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"


def allowed_cors_origins() -> list[str]:
    """Collect the browser origins allowed to call this API.

    CORS_ORIGINS holds a comma-separated list of origins, one per entry. A
    wildcard is refused: the API authenticates with a bearer token, and
    wildcard origins would let any site make those requests.
    """
    origins = list(LOCAL_CORS_ORIGINS)
    configured = os.getenv("CORS_ORIGINS", "")
    for entry in configured.split(","):
        origin = entry.strip().rstrip("/")
        if not origin:
            continue
        if origin == "*":
            raise RuntimeError(
                "CORS_ORIGINS cannot be a wildcard. List the exact origins, "
                "for example: https://office.example.com"
            )
        if origin not in origins:
            origins.append(origin)
    return origins


app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_cors_origins(),
    allow_origin_regex=LOCAL_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    from fastapi.responses import JSONResponse
    origin = request.headers.get("origin", "")
    headers = {}
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers=headers,
    )


class AuthenticatedUser(BaseModel):
    id: str
    email: str | None = None


def optional_query(value, default=None):
    """Unwrap a FastAPI query default.

    The handlers are also called directly by the verification scripts, where an
    omitted query parameter arrives as the `Query` placeholder rather than the
    value FastAPI would inject.
    """
    if isinstance(value, fastapi_params.Query):
        if value.default is Ellipsis or value.default is inspect.Parameter.empty:
            return default
        return value.default
    return value


class StaffIdentity(BaseModel):
    auth_user_id: str
    staff_id: int
    email: str
    full_name: str
    branch_id: int | None
    roles: list[str]


class StaffRoleOption(BaseModel):
    id: int
    code: str
    name: str
    description: str | None


class StaffBranchOption(BaseModel):
    id: int
    code: str
    name: str


class StaffAdminOptions(BaseModel):
    roles: list[StaffRoleOption]
    branches: list[StaffBranchOption]


class DashboardCurrencyTotal(BaseModel):
    currency: str
    amount: Decimal
    count: int = 0


class DashboardRecentActivity(BaseModel):
    action: str
    entity_type: str
    entity_id: int | None
    detail: str | None
    actor_name: str | None
    created_at: datetime


class DashboardOverviewRecord(BaseModel):
    branch_count: int
    staff_count: int
    role_count: int
    booking_count: int
    open_booking_count: int
    tickets_issued_count: int
    tickets_voided_count: int
    tickets_exchanged_count: int
    tickets_refunded_count: int
    pending_ticketing_count: int
    upcoming_departures_count: int
    overdue_invoice_count: int
    today_sales_by_currency: list[DashboardCurrencyTotal]
    today_margin_by_currency: list[DashboardCurrencyTotal]
    today_payments_by_currency: list[DashboardCurrencyTotal]
    outstanding_balance_by_currency: list[DashboardCurrencyTotal]
    supplier_outstanding_by_currency: list[DashboardCurrencyTotal]
    month_expenses_by_currency: list[DashboardCurrencyTotal]
    recent_activity: list[DashboardRecentActivity]
    current_user: dict


class StaffAdminRecord(BaseModel):
    staff_id: int
    auth_user_id: str | None
    email: str
    full_name: str
    branch_id: int | None
    branch_code: str | None
    branch_name: str | None
    is_active: bool
    role_ids: list[int]
    roles: list[str]
    created_at: datetime
    # False when the staff profile exists with its roles but has no Supabase
    # sign-in joined to it yet. The person cannot sign in until it is.
    has_sign_in: bool = True


class StaffAccessFields(BaseModel):
    branch_id: int = Field(gt=0)
    role_ids: list[int] = Field(min_length=1, max_length=10)

    @field_validator("role_ids")
    @classmethod
    def validate_unique_role_ids(cls, value: list[int]) -> list[int]:
        if any(role_id <= 0 for role_id in value):
            raise ValueError("Role IDs must be positive")
        if len(set(value)) != len(value):
            raise ValueError("Duplicate roles are not allowed")
        return value


class StaffLinkCreate(StaffAccessFields):
    email: str = Field(min_length=3, max_length=254)
    full_name: str = Field(min_length=1, max_length=160)
    # "none" records the office and the roles and leaves the sign-in to be
    # joined later. "existing" joins a Supabase account that already exists
    # for the address. Neither creates, invites, or emails an account.
    sign_in_method: Literal["none", "existing"] = "none"

    @field_validator("email", mode="before")
    @classmethod
    def normalize_staff_email(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value

    @field_validator("full_name", mode="before")
    @classmethod
    def normalize_staff_name(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("email")
    @classmethod
    def validate_staff_email(cls, value: str) -> str:
        if not value or "@" not in value or any(character.isspace() for character in value):
            raise ValueError("Enter a valid email address")
        return value


class StaffCreateWithPassword(StaffAccessFields):
    email: str = Field(min_length=3, max_length=254)
    full_name: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=8, max_length=128)
    confirm_password: str = Field(min_length=8, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_staff_email(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value

    @field_validator("full_name", mode="before")
    @classmethod
    def normalize_staff_name(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("email")
    @classmethod
    def validate_staff_email(cls, value: str) -> str:
        if not value or "@" not in value or any(character.isspace() for character in value):
            raise ValueError("Enter a valid email address")
        return value

    @model_validator(mode="after")
    def passwords_match(self):
        if self.password != self.confirm_password:
            raise ValueError("Passwords do not match")
        return self


class StaffAccessUpdate(StaffAccessFields):
    is_active: bool


class CustomerCreate(BaseModel):
    customer_type: Literal["individual", "corporate"]
    display_name: str = Field(min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=254)

    @field_validator("display_name")
    @classmethod
    def strip_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Display name cannot be blank")
        return value

    @field_validator("phone", "email", mode="before")
    @classmethod
    def normalize_optional_contact(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class CustomerRecord(BaseModel):
    id: int
    customer_type: Literal["individual", "corporate"]
    display_name: str
    phone: str | None
    email: str | None
    created_at: datetime


class CustomerListResponse(BaseModel):
    items: list[CustomerRecord]
    total: int
    limit: int
    offset: int


BookingChannel = Literal["office", "phone", "email", "website", "whatsapp", "corporate", "other"]
BookingStatus = Literal[
    "draft", "ticketed", "cancelled",
]

BOOKING_STATUS_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"ticketed", "cancelled"},
    "ticketed": set(),
    "cancelled": set(),
}


class BookingCreate(BaseModel):
    customer_id: int = Field(gt=0)
    booking_channel: BookingChannel = "office"
    external_pnr: str | None = Field(default=None, max_length=30)
    reservation_system: str | None = Field(default=None, max_length=60)
    customer_notes: str | None = Field(default=None, max_length=2000)

    @field_validator("external_pnr", "reservation_system", "customer_notes", mode="before")
    @classmethod
    def normalize_optional_booking_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class BookingStatusUpdate(BaseModel):
    status: BookingStatus


PassengerType = Literal["ADT", "CHD", "INF"]


class BookingPassengerCreate(BaseModel):
    passenger_type: PassengerType = "ADT"
    first_name: str = Field(min_length=1, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)

    @field_validator("first_name", "middle_name", "last_name", mode="before")
    @classmethod
    def normalize_passenger_names(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class BookingPassengerRecord(BaseModel):
    id: int
    passenger_type: PassengerType
    first_name: str
    middle_name: str | None
    last_name: str
    created_at: datetime


class FlightSegmentCreate(BaseModel):
    marketing_carrier: str | None = Field(default=None, min_length=2, max_length=2)
    flight_number: str | None = Field(default=None, max_length=10)
    origin_airport: str = Field(min_length=3, max_length=3)
    destination_airport: str = Field(min_length=3, max_length=3)
    departure_at: datetime
    arrival_at: datetime
    booking_class: str | None = Field(default=None, max_length=10)
    cabin: str | None = Field(default=None, max_length=30)

    @field_validator("marketing_carrier", "flight_number", "booking_class", "cabin", mode="before")
    @classmethod
    def normalize_optional_segment_fields(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper() or None
        return value

    @field_validator("origin_airport", "destination_airport")
    @classmethod
    def normalize_airport_code(cls, value: str) -> str:
        code = value.strip().upper()
        if len(code) != 3 or not code.isascii() or not code.isalpha():
            raise ValueError("Airport code must contain exactly three letters")
        return code

    @model_validator(mode="after")
    def validate_route_and_times(self):
        if self.origin_airport == self.destination_airport:
            raise ValueError("Origin and destination airports must differ")
        if self.departure_at.tzinfo is None or self.arrival_at.tzinfo is None:
            raise ValueError("Departure and arrival must include a timezone")
        if self.arrival_at <= self.departure_at:
            raise ValueError("Arrival must be after departure")
        return self


class FlightSegmentRecord(BaseModel):
    id: int
    segment_order: int
    marketing_carrier: str | None
    flight_number: str | None
    origin_airport: str
    destination_airport: str
    departure_at: datetime
    arrival_at: datetime
    booking_class: str | None
    cabin: str | None
    segment_status: str


class BookingDetails(BaseModel):
    passengers: list[BookingPassengerRecord]
    segments: list[FlightSegmentRecord]
    tickets: list["TicketRecord"] = []


SupplierType = Literal["airline", "consolidator", "host_agency", "gds", "hotel", "other"]


class SupplierCreate(BaseModel):
    supplier_type: SupplierType
    legal_name: str = Field(min_length=1, max_length=200)
    trading_name: str | None = Field(default=None, max_length=200)
    contact_name: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=254)
    account_reference: str | None = Field(default=None, max_length=120)
    settlement_currency: str = Field(default="ETB", min_length=3, max_length=3)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator(
        "legal_name", "trading_name", "contact_name", "phone", "email",
        "account_reference", "notes", mode="before",
    )
    @classmethod
    def normalize_supplier_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("settlement_currency", mode="before")
    @classmethod
    def normalize_settlement_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("legal_name")
    @classmethod
    def require_legal_name(cls, value: str) -> str:
        if not value:
            raise ValueError("Legal name cannot be blank")
        return value

    @field_validator("settlement_currency")
    @classmethod
    def validate_settlement_currency(cls, value: str) -> str:
        if not value.isascii() or not value.isalpha():
            raise ValueError("Settlement currency must be a three-letter code")
        return value


class SupplierStatusUpdate(BaseModel):
    is_active: bool


class SupplierRecord(BaseModel):
    id: int
    supplier_type: SupplierType
    legal_name: str
    trading_name: str | None
    contact_name: str | None
    phone: str | None
    email: str | None
    account_reference: str | None
    settlement_currency: str
    notes: str | None
    is_active: bool
    created_at: datetime


InvoiceStatus = Literal["draft", "issued", "partially_paid", "paid", "overdue", "void", "cancelled"]
InvoiceItemType = Literal["airfare", "tax", "agency_fee", "change_fee", "cancellation_fee", "other"]


class InvoiceItemCreate(BaseModel):
    item_type: InvoiceItemType
    description: str = Field(min_length=1, max_length=1000)
    quantity: Decimal = Field(default=Decimal("1"), gt=0, max_digits=12, decimal_places=3)
    unit_price: Decimal = Field(ge=0, max_digits=18, decimal_places=4)

    @field_validator("description", mode="before")
    @classmethod
    def normalize_invoice_description(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class InvoiceCreate(BaseModel):
    invoice_number: str = Field(min_length=1, max_length=40)
    booking_id: int = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)
    due_date: date | None = None
    tax_total: Decimal = Field(default=Decimal("0"), ge=0, max_digits=18, decimal_places=4)
    discount_total: Decimal = Field(default=Decimal("0"), ge=0, max_digits=18, decimal_places=4)
    notes: str | None = Field(default=None, max_length=2000)
    items: list[InvoiceItemCreate] = Field(min_length=1, max_length=100)

    @field_validator("invoice_number", mode="before")
    @classmethod
    def normalize_invoice_number(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper() or None
        return value

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_invoice_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("currency")
    @classmethod
    def validate_invoice_currency(cls, value: str) -> str:
        if not value.isascii() or not value.isalpha():
            raise ValueError("Currency must be a three-letter code")
        return value

    @field_validator("notes", mode="before")
    @classmethod
    def normalize_invoice_notes(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class InvoiceItemRecord(BaseModel):
    id: int
    item_type: InvoiceItemType
    description: str
    quantity: Decimal
    unit_price: Decimal
    line_total: Decimal


class InvoiceRecord(BaseModel):
    id: int
    invoice_number: str
    customer_id: int
    customer_name: str
    booking_id: int
    booking_code: str
    currency: str
    issue_date: date
    due_date: date | None
    status: InvoiceStatus
    subtotal: Decimal
    tax_total: Decimal
    discount_total: Decimal
    grand_total: Decimal
    item_count: int
    created_at: datetime


class InvoiceDetails(InvoiceRecord):
    notes: str | None
    items: list[InvoiceItemRecord]


class InvoiceListResponse(BaseModel):
    items: list[InvoiceRecord]
    total: int
    limit: int
    offset: int


class InvoiceReportCurrencyTotal(BaseModel):
    currency: str
    invoice_count: int
    subtotal: Decimal
    tax_total: Decimal
    discount_total: Decimal
    grand_total: Decimal
    total_margin: Decimal = Decimal("0")


class InvoiceSalesReport(BaseModel):
    start_date: date
    end_date: date
    invoice_count: int
    by_currency: list[InvoiceReportCurrencyTotal]


class CustomerBalanceRecord(BaseModel):
    customer_id: int
    customer_name: str
    currency: str
    invoice_count: int
    invoiced_total: Decimal
    paid_total: Decimal
    outstanding_total: Decimal
    oldest_due_date: date | None


class CustomerBalanceReport(BaseModel):
    as_of_date: date
    items: list[CustomerBalanceRecord]
    totals_by_currency: list[InvoiceReportCurrencyTotal]


class TicketCreate(BaseModel):
    booking_passenger_id: int = Field(gt=0)
    supplier_id: int = Field(gt=0)
    ticket_number: str = Field(min_length=1, max_length=30)
    fare_amount: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=4)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    selling_price: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=4)
    selling_currency: str | None = Field(default=None, min_length=3, max_length=3)
    issue_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    verified: Literal[True]

    @field_validator("ticket_number", mode="before")
    @classmethod
    def normalize_ticket_number(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper() or None
        return value

    @field_validator("currency", "selling_currency", mode="before")
    @classmethod
    def normalize_ticket_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper() or None
        return value

    @model_validator(mode="after")
    def check_sale_amounts(self) -> "TicketCreate":
        if (self.selling_price is None) != (self.selling_currency is None):
            raise ValueError("Selling price and selling currency must be entered together.")
        return self
    def validate_fare_currency(self):
        if (self.fare_amount is None) != (self.currency is None):
            raise ValueError("Fare amount and currency must be provided together")
        if self.currency is not None and (not self.currency.isascii() or not self.currency.isalpha()):
            raise ValueError("Currency must be a three-letter code")
        return self


class TicketRecord(BaseModel):
    id: int
    booking_passenger_id: int
    supplier_id: int
    supplier_name: str
    ticket_number: str | None
    ticket_status: Literal["issued", "pending", "voided", "refunded", "exchanged"]
    issued_at: datetime | None
    issue_date: date | None
    fare_amount: Decimal | None
    currency: str | None
    selling_price: Decimal | None
    selling_currency: str | None
    notes: str | None
    verified_at: datetime | None


TicketingRequestStatus = Literal[
    "not_requested", "pending", "submitted", "failed", "completed", "cancelled", "expired",
]

TICKETING_REQUEST_STATUS_TRANSITIONS: dict[str, set[str]] = {
    "not_requested": {"pending", "submitted", "cancelled", "expired"},
    "pending": {"submitted", "cancelled", "expired"},
    "submitted": {"failed", "completed", "cancelled", "expired"},
    "failed": {"pending", "submitted", "cancelled"},
    "completed": set(),
    "cancelled": {"pending", "submitted"},
    "expired": {"pending", "submitted"},
}


class TicketingRequestCreate(BaseModel):
    supplier_id: int = Field(gt=0)
    ticketing_deadline: datetime | None = None
    partner_request_reference: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("partner_request_reference", "notes", mode="before")
    @classmethod
    def normalize_optional_request_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class TicketingRequestStatusUpdate(BaseModel):
    status: TicketingRequestStatus
    partner_request_reference: str | None = Field(default=None, max_length=120)
    partner_cost: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=4)
    partner_currency: str | None = Field(default=None, min_length=3, max_length=3)
    response_notes: str | None = Field(default=None, max_length=2000)

    @field_validator("partner_request_reference", "response_notes", mode="before")
    @classmethod
    def normalize_optional_update_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("partner_currency", mode="before")
    @classmethod
    def normalize_partner_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @model_validator(mode="after")
    def validate_partner_cost_currency(self):
        if (self.partner_cost is None) != (self.partner_currency is None):
            raise ValueError("Partner cost and currency must be provided together")
        if self.partner_currency is not None and (
            not self.partner_currency.isascii() or not self.partner_currency.isalpha()
        ):
            raise ValueError("Currency must be a three-letter code")
        return self


class TicketingRequestRecord(BaseModel):
    id: int
    booking_id: int
    booking_code: str
    supplier_id: int
    supplier_name: str
    status: TicketingRequestStatus
    ticketing_deadline: datetime | None
    partner_request_reference: str | None
    partner_cost: Decimal | None
    partner_currency: str | None
    response_notes: str | None
    requested_by: int | None
    requested_by_name: str | None
    submitted_at: datetime | None
    responded_at: datetime | None
    created_at: datetime


class BookingRecord(BaseModel):
    id: int
    booking_code: str
    branch_id: int
    customer_id: int
    customer_name: str
    status: BookingStatus
    booking_channel: BookingChannel
    external_pnr: str | None
    reservation_system: str | None
    customer_notes: str | None
    created_at: datetime


class BookingListResponse(BaseModel):
    items: list[BookingRecord]
    total: int
    limit: int
    offset: int


class BookingStatusHistoryEntry(BaseModel):
    from_status: str | None
    to_status: str
    changed_by: str | None
    changed_at: datetime


_supabase_client: httpx.AsyncClient | None = None

# The browser fires a burst of parallel calls with the same bearer token, and
# each one would otherwise ask Supabase Auth to identify the session. A short
# cache of the verified session keeps that to one call per token per window,
# which stops the burst from overwhelming the verification endpoint and
# removes the intermittent "could not verify the session" failures.
SESSION_CACHE_TTL_SECONDS = 30.0
_session_cache: dict[str, tuple[float, "AuthenticatedUser"]] = {}
_session_cache_lock = asyncio.Lock()


def get_supabase_client() -> httpx.AsyncClient:
    """One shared client for Supabase Auth verification.

    A client per request meant a new TLS connection for every API call. The
    browser fires several calls at once, so those connections competed and
    some timed out, which surfaced as a session verification failure. A single
    pooled client keeps connections alive and handles the parallel calls.
    """
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _supabase_client


def _session_cache_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def verify_supabase_session(token: str) -> httpx.Response:
    """Ask Supabase Auth who the token belongs to, with a short retry.

    A single dropped connection should not sign the user out, so a transport
    failure is retried before it is reported.
    """
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    client = get_supabase_client()
    headers = {
        "apikey": supabase_anon_key,
        "Authorization": f"Bearer {token}",
    }
    last_error: httpx.RequestError | None = None
    for attempt in range(3):
        try:
            return await client.get(
                f"{supabase_url}/auth/v1/user",
                headers=headers,
            )
        except httpx.RequestError as error:
            last_error = error
            logger.warning(
                "Supabase Auth verification request failed (attempt %s): %s: %s",
                attempt + 1,
                type(error).__name__,
                error,
            )
    raise last_error  # type: ignore[misc]


async def get_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> AuthenticatedUser:
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    if not supabase_url or not supabase_anon_key:
        raise HTTPException(
            status_code=503,
            detail="Supabase Auth is not configured on the backend",
        )

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Bearer token required")

    token = credentials.credentials
    cache_key = _session_cache_key(token)
    now = time.monotonic()
    async with _session_cache_lock:
        cached = _session_cache.get(cache_key)
        if cached is not None and cached[0] > now:
            return cached[1]
        if cached is not None:
            _session_cache.pop(cache_key, None)

    try:
        response = await verify_supabase_session(token)
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=503,
            detail="Could not verify the session with Supabase Auth",
        ) from error

    if response.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    if response.status_code != 200:
        logger.error(
            "Supabase Auth verification returned HTTP %s",
            response.status_code,
        )
        raise HTTPException(
            status_code=503,
            detail="Supabase Auth could not verify the session",
        )

    try:
        user = AuthenticatedUser.model_validate(response.json())
    except (ValueError, TypeError) as error:
        logger.error("Supabase Auth returned an invalid user response")
        raise HTTPException(
            status_code=502,
            detail="Supabase Auth returned an invalid user response",
        ) from error

    async with _session_cache_lock:
        _session_cache[cache_key] = (time.monotonic() + SESSION_CACHE_TTL_SECONDS, user)
        if len(_session_cache) > 500:
            now = time.monotonic()
            expired = [key for key, (expiry, _) in _session_cache.items() if expiry <= now]
            for key in expired:
                _session_cache.pop(key, None)

    return user




def require_active_staff(connection, auth_user_id: str) -> int:
    profile = connection.execute(
        text(
            """
            SELECT
                staff.id,
                staff.is_active,
                EXISTS (
                    SELECT 1
                    FROM public.user_roles AS user_roles
                    WHERE user_roles.user_id = staff.id
                ) AS has_role
            FROM public.users AS staff
            WHERE staff.auth_user_id = :auth_user_id
            """
        ),
        {"auth_user_id": auth_user_id},
    ).mappings().one_or_none()

    if profile is None:
        raise HTTPException(
            status_code=404,
            detail="Your staff profile has not been provisioned. Contact an administrator.",
        )
    if not profile["is_active"]:
        raise HTTPException(
            status_code=403,
            detail="Your staff account is inactive. Contact an administrator.",
        )
    if not profile["has_role"]:
        raise HTTPException(
            status_code=403,
            detail="Your staff account has no assigned role. Contact an administrator.",
        )

    return profile["id"]


@app.get("/")
def home():
    return {
        "message": "Ticket Office Management System API",
        "status": "running",
        "mode": "manual",
    }


@app.get("/api/health")
def health_check():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError as error:
        logger.exception("Database health check failed")
        raise HTTPException(
            status_code=503,
            detail="Database connection unavailable",
        ) from error

    return {
        "status": "ok",
        "message": "Backend and database are working correctly",
    }




@app.get("/api/auth/me", response_model=StaffIdentity)
def current_user(
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        profile = connection.execute(
            text(
                """
                SELECT
                    staff.id AS staff_id,
                    staff.email,
                    staff.full_name,
                    staff.branch_id,
                    staff.is_active,
                    COALESCE(
                        ARRAY_AGG(roles.code ORDER BY roles.code)
                            FILTER (WHERE roles.code IS NOT NULL),
                        ARRAY[]::VARCHAR[]
                    ) AS roles
                FROM public.users AS staff
                LEFT JOIN public.user_roles AS user_roles
                    ON user_roles.user_id = staff.id
                LEFT JOIN public.roles AS roles
                    ON roles.id = user_roles.role_id
                WHERE staff.auth_user_id = :auth_user_id
                GROUP BY staff.id
                """
            ),
            {"auth_user_id": user.id},
        ).mappings().one_or_none()

    if profile is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "Your staff profile has not been provisioned, or it is not joined to a "
                "sign-in yet. Contact an administrator."
            ),
        )
    if not profile["is_active"]:
        raise HTTPException(
            status_code=403,
            detail="Your staff account is inactive. Contact an administrator.",
        )
    if not profile["roles"]:
        raise HTTPException(
            status_code=403,
            detail="Your staff account has no assigned role. Contact an administrator.",
        )

    return StaffIdentity(
        auth_user_id=user.id,
        staff_id=profile["staff_id"],
        email=profile["email"],
        full_name=profile["full_name"],
        branch_id=profile["branch_id"],
        roles=profile["roles"],
    )


@app.get("/api/dashboard/overview", response_model=DashboardOverviewRecord)
def dashboard_overview(
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        profile = connection.execute(
            text(
                """
                SELECT
                    staff.id AS staff_id,
                    staff.email,
                    staff.full_name,
                    staff.branch_id,
                    COALESCE(
                        ARRAY_AGG(roles.code ORDER BY roles.code)
                            FILTER (WHERE roles.code IS NOT NULL),
                        ARRAY[]::VARCHAR[]
                    ) AS roles
                FROM public.users AS staff
                LEFT JOIN public.user_roles AS user_roles
                    ON user_roles.user_id = staff.id
                LEFT JOIN public.roles AS roles
                    ON roles.id = user_roles.role_id
                WHERE staff.auth_user_id = :auth_user_id
                GROUP BY staff.id
                """
            ),
            {"auth_user_id": user.id},
        ).mappings().one_or_none()

    if profile is None:
        raise HTTPException(
            status_code=403,
            detail="Your staff profile has not been provisioned.",
        )

    branch_id = profile["branch_id"]

    with engine.connect() as connection:
        stats = connection.execute(
            text(
                """
                SELECT
                    (SELECT COUNT(*) FROM public.branches WHERE is_active = TRUE) AS branch_count,
                    (SELECT COUNT(*) FROM public.users WHERE is_active = TRUE) AS staff_count,
                    (SELECT COUNT(*) FROM public.roles) AS role_count
                """
            )
        ).mappings().one()

        booking_stats = connection.execute(
            text(
                """
                SELECT
                    COUNT(*) AS booking_count,
                    COUNT(*) FILTER (
                        WHERE status NOT IN ('cancelled', 'expired', 'closed')
                    ) AS open_booking_count,
                    COUNT(*) FILTER (
                        WHERE status IN ('confirmed', 'ticketing_pending')
                    ) AS pending_ticketing_count
                FROM public.bookings
                WHERE branch_id = :branch_id
                """
            ),
            {"branch_id": branch_id},
        ).mappings().one()

        ticket_stats = connection.execute(
            text(
                """
                SELECT
                    COUNT(*) FILTER (WHERE tickets.ticket_status = 'issued') AS issued_count,
                    COUNT(*) FILTER (WHERE tickets.ticket_status = 'voided') AS voided_count,
                    COUNT(*) FILTER (WHERE tickets.ticket_status = 'exchanged') AS exchanged_count,
                    COUNT(*) FILTER (WHERE tickets.ticket_status = 'refunded') AS refunded_count
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                JOIN public.bookings AS bookings
                    ON bookings.id = booking_passengers.booking_id
                WHERE bookings.branch_id = :branch_id
                """
            ),
            {"branch_id": branch_id},
        ).mappings().one()

        departure_stats = connection.execute(
            text(
                """
                SELECT COUNT(*) AS departure_count
                FROM public.flight_segments AS flight_segments
                JOIN public.bookings AS bookings
                    ON bookings.id = flight_segments.booking_id
                WHERE bookings.branch_id = :branch_id
                    AND bookings.status NOT IN ('cancelled', 'expired')
                    AND flight_segments.departure_at >= NOW()
                    AND flight_segments.departure_at <= NOW() + INTERVAL '7 days'
                """
            ),
            {"branch_id": branch_id},
        ).mappings().one()

        today_sales = connection.execute(
            text(
                """
                SELECT invoices.currency, COUNT(*) AS entry_count,
                    COALESCE(SUM(invoices.grand_total), 0) AS amount
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                WHERE bookings.branch_id = :branch_id
                    AND invoices.issue_date = CURRENT_DATE
                    AND invoices.status IN ('issued', 'partially_paid', 'paid')
                GROUP BY invoices.currency
                ORDER BY invoices.currency
                """
            ),
            {"branch_id": branch_id},
        ).mappings().all()

        today_margin = connection.execute(
            text(
                """
                SELECT COALESCE(t.currency, 'ETB') AS currency, COUNT(*) AS entry_count,
                    COALESCE(SUM(t.selling_price - COALESCE(t.fare_amount, 0)), 0) AS amount
                FROM public.tickets AS t
                JOIN public.booking_passengers AS bp ON bp.id = t.booking_passenger_id
                JOIN public.bookings AS b ON b.id = bp.booking_id
                WHERE b.branch_id = :branch_id
                    AND DATE(COALESCE(t.issue_date, t.created_at)) = CURRENT_DATE
                GROUP BY COALESCE(t.currency, 'ETB')
                ORDER BY COALESCE(t.currency, 'ETB')
                """
            ),
            {"branch_id": branch_id},
        ).mappings().all()

        today_payments = connection.execute(
            text(
                """
                SELECT customer_payments.currency, COUNT(*) AS entry_count,
                    COALESCE(SUM(customer_payments.amount), 0) AS amount
                FROM public.customer_payments AS customer_payments
                WHERE customer_payments.branch_id = :branch_id
                    AND customer_payments.status = 'confirmed'
                    AND customer_payments.received_at >= CURRENT_DATE
                    AND customer_payments.received_at < CURRENT_DATE + INTERVAL '1 day'
                GROUP BY customer_payments.currency
                ORDER BY customer_payments.currency
                """
            ),
            {"branch_id": branch_id},
        ).mappings().all()

        outstanding = connection.execute(
            text(
                """
                SELECT invoices.currency, COUNT(*) AS entry_count,
                    COALESCE(SUM(
                        invoices.grand_total - COALESCE((
                            SELECT SUM(allocations.amount)
                            FROM public.payment_allocations AS allocations
                            WHERE allocations.invoice_id = invoices.id
                        ), 0)
                    ), 0) AS amount
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                WHERE bookings.branch_id = :branch_id
                    AND invoices.status IN ('issued', 'partially_paid')
                GROUP BY invoices.currency
                ORDER BY invoices.currency
                """
            ),
            {"branch_id": branch_id},
        ).mappings().all()

        supplier_outstanding = connection.execute(
            text(
                """
                SELECT supplier_bills.currency, COUNT(*) AS entry_count,
                    COALESCE(SUM(
                        supplier_bills.amount - COALESCE((
                            SELECT SUM(supplier_payments.amount)
                            FROM public.supplier_payments AS supplier_payments
                            WHERE supplier_payments.supplier_bill_id = supplier_bills.id
                                AND supplier_payments.status = 'confirmed'
                        ), 0)
                    ), 0) AS amount
                FROM public.supplier_bills AS supplier_bills
                WHERE supplier_bills.branch_id = :branch_id
                    AND supplier_bills.status IN ('unpaid', 'partially_paid')
                GROUP BY supplier_bills.currency
                ORDER BY supplier_bills.currency
                """
            ),
            {"branch_id": branch_id},
        ).mappings().all()

        month_expenses = connection.execute(
            text(
                """
                SELECT business_expenses.currency, COUNT(*) AS entry_count,
                    COALESCE(SUM(business_expenses.amount), 0) AS amount
                FROM public.business_expenses AS business_expenses
                WHERE business_expenses.branch_id = :branch_id
                    AND business_expenses.status = 'recorded'
                    AND business_expenses.expense_date >= date_trunc('month', CURRENT_DATE)
                GROUP BY business_expenses.currency
                ORDER BY business_expenses.currency
                """
            ),
            {"branch_id": branch_id},
        ).mappings().all()

        overdue_count = connection.execute(
            text(
                """
                SELECT COUNT(*) AS overdue_count
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                WHERE bookings.branch_id = :branch_id
                    AND invoices.status IN ('issued', 'partially_paid')
                    AND invoices.due_date IS NOT NULL
                    AND invoices.due_date < CURRENT_DATE
                """
            ),
            {"branch_id": branch_id},
        ).mappings().one()

        recent_activity = connection.execute(
            text(
                """
                SELECT
                    activity_logs.action,
                    activity_logs.entity_type,
                    activity_logs.entity_id,
                    activity_logs.details_json,
                    users.full_name AS actor_name,
                    activity_logs.created_at
                FROM public.activity_logs AS activity_logs
                LEFT JOIN public.users AS users ON users.id = activity_logs.user_id
                WHERE activity_logs.branch_id = :branch_id
                ORDER BY activity_logs.created_at DESC, activity_logs.id DESC
                LIMIT 8
                """
            ),
            {"branch_id": branch_id},
        ).mappings().all()

    def to_currency_totals(rows) -> list[DashboardCurrencyTotal]:
        return [
            DashboardCurrencyTotal(
                currency=row["currency"],
                amount=row["amount"],
                count=int(row["entry_count"]),
            )
            for row in rows
        ]

    activity_entries = []
    for row in recent_activity:
        details = row["details_json"] or {}
        detail = None
        if isinstance(details, dict):
            for key in ("invoice_number", "booking_code", "ticket_number", "legal_name", "to_status"):
                value = details.get(key)
                if isinstance(value, str) and value:
                    detail = value
                    break
        activity_entries.append(
            DashboardRecentActivity(
                action=row["action"],
                entity_type=row["entity_type"],
                entity_id=row["entity_id"],
                detail=detail,
                actor_name=row["actor_name"],
                created_at=row["created_at"],
            )
        )

    return DashboardOverviewRecord(
        branch_count=int(stats["branch_count"]),
        staff_count=int(stats["staff_count"]),
        role_count=int(stats["role_count"]),
        booking_count=int(booking_stats["booking_count"]),
        open_booking_count=int(booking_stats["open_booking_count"]),
        tickets_issued_count=int(ticket_stats["issued_count"]),
        tickets_voided_count=int(ticket_stats["voided_count"]),
        tickets_exchanged_count=int(ticket_stats["exchanged_count"]),
        tickets_refunded_count=int(ticket_stats["refunded_count"]),
        pending_ticketing_count=int(booking_stats["pending_ticketing_count"]),
        upcoming_departures_count=int(departure_stats["departure_count"]),
        overdue_invoice_count=int(overdue_count["overdue_count"]),
        today_sales_by_currency=to_currency_totals(today_sales),
        today_margin_by_currency=to_currency_totals(today_margin),
        today_payments_by_currency=to_currency_totals(today_payments),
        outstanding_balance_by_currency=to_currency_totals(outstanding),
        supplier_outstanding_by_currency=to_currency_totals(supplier_outstanding),
        month_expenses_by_currency=to_currency_totals(month_expenses),
        recent_activity=activity_entries,
        current_user={
            "staff_id": int(profile["staff_id"]),
            "email": profile["email"],
            "full_name": profile["full_name"],
            "branch_id": profile["branch_id"],
            "roles": profile["roles"],
        },
    )


@app.get("/api/customers", response_model=CustomerListResponse)
def list_customers(
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    search = q.strip()
    search_pattern = f"%{search}%"

    with engine.connect() as connection:
        require_active_staff(connection, user.id)
        total = connection.execute(
            text(
                """
                SELECT COUNT(*)
                FROM public.customers
                WHERE :search = ''
                    OR display_name ILIKE :search_pattern
                    OR email ILIKE :search_pattern
                    OR phone ILIKE :search_pattern
                """
            ),
            {"search": search, "search_pattern": search_pattern},
        ).scalar_one()
        rows = connection.execute(
            text(
                """
                SELECT id, customer_type, display_name, phone, email, created_at
                FROM public.customers
                WHERE :search = ''
                    OR display_name ILIKE :search_pattern
                    OR email ILIKE :search_pattern
                    OR phone ILIKE :search_pattern
                ORDER BY LOWER(display_name), id
                LIMIT :limit OFFSET :offset
                """
            ),
            {
                "search": search,
                "search_pattern": search_pattern,
                "limit": limit,
                "offset": offset,
            },
        ).mappings().all()

    return CustomerListResponse(
        items=[CustomerRecord.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@app.post("/api/customers", response_model=CustomerRecord, status_code=201)
def create_customer(
    customer: CustomerCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id = require_active_staff(connection, user.id)
        row = connection.execute(
            text(
                """
                INSERT INTO public.customers
                    (customer_type, display_name, phone, email, created_by)
                VALUES
                    (:customer_type, :display_name, :phone, :email, :created_by)
                RETURNING id, customer_type, display_name, phone, email, created_at
                """
            ),
            {
                **customer.model_dump(),
                "created_by": staff_id,
            },
        ).mappings().one()

    return CustomerRecord.model_validate(row)


@app.delete("/api/customers/{customer_id}", status_code=204)
def delete_customer(
    customer_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id = require_active_staff(connection, user.id)
        row = connection.execute(
            text("SELECT id FROM public.customers WHERE id = :id FOR UPDATE"),
            {"id": customer_id},
        ).mappings().one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Customer not found.")
        counts = connection.execute(
            text(
                """
                SELECT
                    (SELECT COUNT(*) FROM public.bookings WHERE customer_id = :id) AS bookings,
                    (SELECT COUNT(*) FROM public.invoices WHERE customer_id = :id) AS invoices,
                    (SELECT COUNT(*) FROM public.customer_payments WHERE customer_id = :id) AS payments
                """
            ),
            {"id": customer_id},
        ).mappings().one()
        if any(counts[k] for k in counts):
            raise HTTPException(status_code=409, detail="Customer has transactions; deactivate instead of deleting.")
        connection.execute(text("DELETE FROM public.customers WHERE id = :id"), {"id": customer_id})
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (:user_id, NULL, 'customer.deleted', 'customer', :customer_id, jsonb_build_object('customer_id', :customer_id))
                """
            ),
            {"user_id": staff_id, "customer_id": customer_id},
        )


@app.get("/api/suppliers", response_model=list[SupplierRecord])
def list_suppliers(
    ticketing_only: bool = False,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        get_booking_staff(connection, user.id)
        rows = connection.execute(
            text(
                """
                SELECT
                    id,
                    supplier_type,
                    legal_name,
                    trading_name,
                    contact_name,
                    phone,
                    email,
                    account_reference,
                    settlement_currency,
                    notes,
                    is_active,
                    created_at
                FROM public.suppliers
                WHERE :ticketing_only = FALSE
                    OR (is_active = TRUE AND supplier_type IN ('airline', 'consolidator', 'host_agency'))
                ORDER BY is_active DESC, LOWER(COALESCE(NULLIF(BTRIM(trading_name), ''), legal_name)), id
                """
            ),
            {"ticketing_only": ticketing_only},
        ).mappings().all()

    return [SupplierRecord.model_validate(row) for row in rows]


@app.post("/api/suppliers", response_model=SupplierRecord, status_code=201)
def create_supplier(
    supplier: SupplierCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_supplier_manager(connection, user.id)
        row = connection.execute(
            text(
                """
                INSERT INTO public.suppliers (
                    supplier_type, legal_name, trading_name, contact_name, phone,
                    email, account_reference, settlement_currency, notes
                )
                VALUES (
                    :supplier_type, :legal_name, :trading_name, :contact_name, :phone,
                    :email, :account_reference, :settlement_currency, :notes
                )
                RETURNING
                    id, supplier_type, legal_name, trading_name, contact_name, phone,
                    email, account_reference, settlement_currency, notes, is_active, created_at
                """
            ),
            supplier.model_dump(),
        ).mappings().one()
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'supplier.created', 'supplier', :supplier_id,
                    jsonb_build_object(
                        'supplier_type', CAST(:supplier_type AS text),
                        'legal_name', CAST(:legal_name AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "supplier_id": row["id"],
                "supplier_type": row["supplier_type"],
                "legal_name": row["legal_name"],
            },
        )

    return SupplierRecord.model_validate(row)


@app.patch("/api/suppliers/{supplier_id}/status", response_model=SupplierRecord)
def update_supplier_status(
    supplier_id: int,
    update: SupplierStatusUpdate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_supplier_manager(connection, user.id)
        supplier = connection.execute(
            text("SELECT id, is_active FROM public.suppliers WHERE id = :supplier_id FOR UPDATE"),
            {"supplier_id": supplier_id},
        ).mappings().one_or_none()
        if supplier is None:
            raise HTTPException(status_code=404, detail="Supplier not found.")

        row = connection.execute(
            text(
                """
                UPDATE public.suppliers
                SET is_active = :is_active
                WHERE id = :supplier_id
                RETURNING
                    id, supplier_type, legal_name, trading_name, contact_name, phone,
                    email, account_reference, settlement_currency, notes, is_active, created_at
                """
            ),
            {"supplier_id": supplier_id, "is_active": update.is_active},
        ).mappings().one()
        if supplier["is_active"] != update.is_active:
            connection.execute(
                text(
                    """
                    INSERT INTO public.activity_logs
                        (user_id, branch_id, action, entity_type, entity_id, details_json)
                    VALUES (
                        :user_id, :branch_id, :action, 'supplier', :supplier_id,
                        jsonb_build_object('is_active', CAST(:is_active AS boolean))
                    )
                    """
                ),
                {
                    "user_id": staff_id,
                    "branch_id": branch_id,
                    "action": "supplier.activated" if update.is_active else "supplier.deactivated",
                    "supplier_id": supplier_id,
                    "is_active": update.is_active,
                },
            )

    return SupplierRecord.model_validate(row)


def get_booking_staff(connection, auth_user_id: str) -> tuple[int, int]:
    profile = connection.execute(
        text(
            """
            SELECT staff.id, staff.branch_id, staff.is_active, branches.is_active AS branch_is_active,
                EXISTS (
                    SELECT 1 FROM public.user_roles
                    WHERE user_roles.user_id = staff.id
                ) AS has_role
            FROM public.users AS staff
            LEFT JOIN public.branches AS branches ON branches.id = staff.branch_id
            WHERE staff.auth_user_id = :auth_user_id
            """
        ),
        {"auth_user_id": auth_user_id},
    ).mappings().one_or_none()

    if profile is None:
        raise HTTPException(status_code=404, detail="Your staff profile has not been provisioned.")
    if not profile["is_active"]:
        raise HTTPException(status_code=403, detail="Your staff account is inactive.")
    if not profile["has_role"]:
        raise HTTPException(status_code=403, detail="Your staff account has no assigned role.")
    if profile["branch_id"] is None or not profile["branch_is_active"]:
        raise HTTPException(status_code=403, detail="An active branch assignment is required for bookings.")

    return profile["id"], profile["branch_id"]


def require_supplier_manager(connection, auth_user_id: str) -> tuple[int, int]:
    staff_id, branch_id = get_booking_staff(connection, auth_user_id)
    can_manage_suppliers = connection.execute(
        text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM public.user_roles AS user_roles
                JOIN public.roles AS roles ON roles.id = user_roles.role_id
                WHERE user_roles.user_id = :staff_id
                    AND roles.code IN ('ADMIN', 'MANAGER')
            )
            """
        ),
        {"staff_id": staff_id},
    ).scalar_one()
    if not can_manage_suppliers:
        raise HTTPException(status_code=403, detail="Administrator or manager access is required to manage suppliers.")
    return staff_id, branch_id


def require_finance_staff(
    connection,
    auth_user_id: str,
    *,
    write_access: bool = False,
) -> tuple[int, int]:
    staff_id, branch_id = get_booking_staff(connection, auth_user_id)
    allowed_roles = ("ADMIN", "MANAGER", "ACCOUNTANT") if write_access else (
        "ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER",
    )
    has_access = connection.execute(
        text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM public.user_roles AS user_roles
                JOIN public.roles AS roles ON roles.id = user_roles.role_id
                WHERE user_roles.user_id = :staff_id
                    AND roles.code = ANY(:allowed_roles)
            )
            """
        ),
        {"staff_id": staff_id, "allowed_roles": list(allowed_roles)},
    ).scalar_one()
    if not has_access:
        raise HTTPException(status_code=403, detail="Finance access is required for this operation.")
    return staff_id, branch_id


def require_cash_staff(connection, auth_user_id: str) -> tuple[int, int]:
    """Allow staff who handle the cash desk to record and apply receipts.

    A cashier takes money and applies it to an invoice, but does not raise or
    issue invoices. That stays with `require_finance_staff(write_access=True)`.
    """
    staff_id, branch_id = get_booking_staff(connection, auth_user_id)
    allowed_roles = ("ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER")
    has_access = connection.execute(
        text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM public.user_roles AS user_roles
                JOIN public.roles AS roles ON roles.id = user_roles.role_id
                WHERE user_roles.user_id = :staff_id
                    AND roles.code = ANY(:allowed_roles)
            )
            """
        ),
        {"staff_id": staff_id, "allowed_roles": list(allowed_roles)},
    ).scalar_one()
    if not has_access:
        raise HTTPException(status_code=403, detail="Cash desk access is required for this operation.")
    return staff_id, branch_id


def require_staff_administrator(connection, auth_user_id: str) -> tuple[int, int]:
    staff_id, branch_id = get_booking_staff(connection, auth_user_id)
    is_administrator = connection.execute(
        text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM public.user_roles AS user_roles
                JOIN public.roles AS roles ON roles.id = user_roles.role_id
                WHERE user_roles.user_id = :staff_id AND roles.code = 'ADMIN'
            )
            """
        ),
        {"staff_id": staff_id},
    ).scalar_one()
    if not is_administrator:
        raise HTTPException(status_code=403, detail="Administrator access is required to manage staff.")
    return staff_id, branch_id


def validate_staff_branch(connection, branch_id: int) -> None:
    is_active = connection.execute(
        text("SELECT is_active FROM public.branches WHERE id = :branch_id"),
        {"branch_id": branch_id},
    ).scalar_one_or_none()
    if is_active is None or not is_active:
        raise HTTPException(status_code=422, detail="Select an active branch.")


def resolve_staff_roles(connection, role_ids: list[int]) -> list[dict[str, object]]:
    roles = connection.execute(
        text(
            """
            SELECT id, code, name
            FROM public.roles
            WHERE id = ANY(:role_ids)
            ORDER BY code
            """
        ),
        {"role_ids": role_ids},
    ).mappings().all()
    if len(roles) != len(role_ids):
        raise HTTPException(status_code=422, detail="One or more selected roles do not exist.")
    return [dict(role) for role in roles]


def load_staff_admin_record(connection, staff_id: int):
    return connection.execute(
        text(
            """
            SELECT
                staff.id AS staff_id,
                staff.auth_user_id::text AS auth_user_id,
                staff.email,
                staff.full_name,
                staff.branch_id,
                branches.code AS branch_code,
                branches.name AS branch_name,
                staff.is_active,
                (staff.auth_user_id IS NOT NULL) AS has_sign_in,
                COALESCE(
                    ARRAY_AGG(DISTINCT roles.id ORDER BY roles.id)
                        FILTER (WHERE roles.id IS NOT NULL),
                    ARRAY[]::BIGINT[]
                ) AS role_ids,
                COALESCE(
                    ARRAY_AGG(DISTINCT roles.code ORDER BY roles.code)
                        FILTER (WHERE roles.code IS NOT NULL),
                    ARRAY[]::VARCHAR[]
                ) AS roles,
                staff.created_at
            FROM public.users AS staff
            LEFT JOIN public.branches AS branches ON branches.id = staff.branch_id
            LEFT JOIN public.user_roles AS user_roles ON user_roles.user_id = staff.id
            LEFT JOIN public.roles AS roles ON roles.id = user_roles.role_id
            WHERE staff.id = :staff_id
            GROUP BY staff.id, branches.code, branches.name
            """
        ),
        {"staff_id": staff_id},
    ).mappings().one()


@app.get("/api/admin/staff/options", response_model=StaffAdminOptions)
def staff_admin_options(
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        require_staff_administrator(connection, user.id)
        roles = connection.execute(
            text("SELECT id, code, name, description FROM public.roles ORDER BY code")
        ).mappings().all()
        branches = connection.execute(
            text("SELECT id, code, name FROM public.branches WHERE is_active = TRUE ORDER BY code")
        ).mappings().all()

    return StaffAdminOptions(roles=roles, branches=branches)


@app.get("/api/admin/staff", response_model=list[StaffAdminRecord])
def list_managed_staff(
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        require_staff_administrator(connection, user.id)
        staff_ids = connection.execute(
            text("SELECT id FROM public.users ORDER BY is_active DESC, LOWER(full_name), id")
        ).scalars().all()
        records = [load_staff_admin_record(connection, staff_id) for staff_id in staff_ids]

    return [StaffAdminRecord.model_validate(record) for record in records]


@app.post("/api/admin/staff", response_model=StaffAdminRecord, status_code=201)
def link_invited_staff(
    request: StaffLinkCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        admin_id, branch_id = require_staff_administrator(connection, user.id)
        validate_staff_branch(connection, request.branch_id)
        roles = resolve_staff_roles(connection, request.role_ids)

        # A staff profile is recorded by the office, not by Supabase. The
        # duplicate check comes first so the person gets a clear message
        # rather than a database constraint.
        existing_profile = connection.execute(
            text(
                """
                SELECT staff.id, staff.full_name
                FROM public.users AS staff
                WHERE lower(staff.email) = lower(:email)
                """
            ),
            {"email": request.email},
        ).mappings().one_or_none()
        if existing_profile is not None:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"A staff profile already exists for {request.email} "
                    f"({existing_profile['full_name']}). Edit that profile's roles instead of "
                    "adding a second one."
                ),
            )

        # The sign-in is joined only when a Supabase account already exists
        # for the address. Nothing is created, invited, or emailed here.
        auth_user_id: str | None = None
        auth_user_email: str | None = None
        if request.sign_in_method == "existing":
            auth_user = connection.execute(
                text(
                    """
                    SELECT id, email
                    FROM auth.users
                    WHERE lower(email) = :email
                    """
                ),
                {"email": request.email},
            ).mappings().one_or_none()
            if auth_user is None:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        "No Supabase sign-in exists for that email. Record the profile without a "
                        "sign-in instead, and link it later."
                    ),
                )
            linked_elsewhere = connection.execute(
                text(
                    """
                    SELECT id FROM public.users
                    WHERE auth_user_id = :auth_user_id
                    """
                ),
                {"auth_user_id": auth_user["id"]},
            ).scalars().first()
            if linked_elsewhere is not None:
                raise HTTPException(
                    status_code=422,
                    detail="That Supabase sign-in is already joined to another staff profile.",
                )
            auth_user_id = str(auth_user["id"])
            auth_user_email = auth_user["email"]

        created = connection.execute(
            text(
                """
                INSERT INTO public.users (auth_user_id, branch_id, email, full_name)
                VALUES (:auth_user_id, :branch_id, :email, :full_name)
                ON CONFLICT DO NOTHING
                RETURNING id
                """
            ),
            {
                "auth_user_id": auth_user_id,
                "branch_id": request.branch_id,
                "email": auth_user_email or request.email,
                "full_name": request.full_name,
            },
        ).mappings().one_or_none()
        if created is None:
            raise HTTPException(
                status_code=422,
                detail=f"A staff profile already exists for {request.email}.",
            )

        for role in roles:
            connection.execute(
                text("INSERT INTO public.user_roles (user_id, role_id) VALUES (:user_id, :role_id)"),
                {"user_id": created["id"], "role_id": role["id"]},
            )
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'staff.provisioned', 'staff', :staff_id,
                    CAST(:details_json AS jsonb)
                )
                """
            ),
            {
                "user_id": admin_id,
                "branch_id": branch_id,
                "staff_id": created["id"],
                "details_json": json.dumps({
                    "branch_id": request.branch_id,
                    "role_codes": [role["code"] for role in roles],
                    "sign_in_method": request.sign_in_method,
                }),
            },
        )
        record = load_staff_admin_record(connection, created["id"])

    return StaffAdminRecord.model_validate(record)


@app.post("/api/admin/staff/{target_staff_id}/link-sign-in", response_model=StaffAdminRecord)
def link_staff_sign_in(
    target_staff_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    """Join a Supabase sign-in to a staff profile that was created without one.

    The sign-in is matched on the email already on the profile. It has to
    exist in Supabase already, so a person invited in the Supabase dashboard
    can be connected to a profile the office recorded earlier.
    """
    with engine.begin() as connection:
        admin_id, branch_id = require_staff_administrator(connection, user.id)
        connection.execute(text("SELECT pg_advisory_xact_lock(90422, 1)"))
        target = connection.execute(
            text(
                """
                SELECT id, email, auth_user_id
                FROM public.users
                WHERE id = :staff_id
                FOR UPDATE
                """
            ),
            {"staff_id": target_staff_id},
        ).mappings().one_or_none()
        if target is None:
            raise HTTPException(status_code=404, detail="Staff profile not found.")
        if target["auth_user_id"] is not None:
            raise HTTPException(
                status_code=409,
                detail="That staff member already has a sign-in.",
            )

        auth_user = connection.execute(
            text(
                """
                SELECT id, email
                FROM auth.users
                WHERE lower(email) = lower(:email)
                """
            ),
            {"email": target["email"]},
        ).mappings().one_or_none()
        if auth_user is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    "No Supabase sign-in exists for that email yet. Invite the person in "
                    "Supabase first, then link them here."
                ),
            )

        connection.execute(
            text(
                """
                UPDATE public.users
                SET auth_user_id = :auth_user_id, updated_at = NOW()
                WHERE id = :staff_id
                """
            ),
            {"auth_user_id": auth_user["id"], "staff_id": target_staff_id},
        )
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'staff.sign_in_linked', 'staff', :staff_id,
                    CAST(:details_json AS jsonb)
                )
                """
            ),
            {
                "user_id": admin_id,
                "branch_id": branch_id,
                "staff_id": target_staff_id,
                "details_json": json.dumps({"email": target["email"]}),
            },
        )
        record = load_staff_admin_record(connection, target_staff_id)

    return StaffAdminRecord.model_validate(record)


@app.post("/api/admin/staff/create-with-password", response_model=StaffAdminRecord, status_code=201)
def create_staff_with_password(
    request: StaffCreateWithPassword,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    secret_key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not secret_key:
        raise HTTPException(status_code=500, detail="Supabase admin credentials are not configured.")

    with engine.begin() as connection:
        admin_id, branch_id = require_staff_administrator(connection, user.id)
        validate_staff_branch(connection, request.branch_id)
        roles = resolve_staff_roles(connection, request.role_ids)

        existing_profile = connection.execute(
            text("SELECT id FROM public.users WHERE lower(email) = lower(:email)"),
            {"email": request.email},
        ).scalar_one_or_none()
        if existing_profile is not None:
            raise HTTPException(status_code=422, detail="A staff profile already exists for that email.")

        auth_user_id = None
        try:
            response = httpx.post(
                f"{supabase_url}/auth/v1/admin/users",
                headers={
                    "apikey": secret_key,
                    "Authorization": f"Bearer {secret_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "email": request.email,
                    "password": request.password,
                    "email_confirm": True,
                    "user_metadata": {"must_change_password": True},
                },
                timeout=30.0,
            )
            response.raise_for_status()
            auth_user_id = response.json()["id"]
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not create Supabase auth account: {exc}")

        try:
            created = connection.execute(
                text(
                    """
                    INSERT INTO public.users (auth_user_id, branch_id, email, full_name)
                    VALUES (:auth_user_id, :branch_id, :email, :full_name)
                    RETURNING id
                    """
                ),
                {
                    "auth_user_id": auth_user_id,
                    "branch_id": request.branch_id,
                    "email": request.email,
                    "full_name": request.full_name,
                },
            ).mappings().one()
            for role in roles:
                connection.execute(
                    text("INSERT INTO public.user_roles (user_id, role_id) VALUES (:user_id, :role_id)"),
                    {"user_id": created["id"], "role_id": role["id"]},
                )
            record = load_staff_admin_record(connection, created["id"])
        except Exception as exc:
            httpx.delete(
                f"{supabase_url}/auth/v1/admin/users/{auth_user_id}",
                headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
                timeout=30.0,
            )
            raise HTTPException(status_code=422, detail=f"Staff profile creation failed: {exc}")

    return StaffAdminRecord.model_validate(record)


@app.delete("/api/admin/staff/{target_staff_id}", status_code=204)
def delete_managed_staff(
    target_staff_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    secret_key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    with engine.begin() as connection:
        admin_id, branch_id = require_staff_administrator(connection, user.id)
        connection.execute(text("SELECT pg_advisory_xact_lock(90423, 1)"))
        target = connection.execute(
            text("SELECT id, auth_user_id, is_active FROM public.users WHERE id = :staff_id FOR UPDATE"),
            {"staff_id": target_staff_id},
        ).mappings().one_or_none()
        if target is None:
            raise HTTPException(status_code=404, detail="Staff profile not found.")
        if target_staff_id == admin_id:
            raise HTTPException(status_code=409, detail="You cannot delete your own account.")
        auth_user_id = target["auth_user_id"]
        connection.execute(text("DELETE FROM public.user_roles WHERE user_id = :staff_id"), {"staff_id": target_staff_id})
        connection.execute(text("DELETE FROM public.users WHERE id = :staff_id"), {"staff_id": target_staff_id})
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (:user_id, :branch_id, 'staff.deleted', 'staff', :staff_id, CAST(:details_json AS jsonb))
                """
            ),
            {"user_id": admin_id, "branch_id": branch_id, "staff_id": target_staff_id, "details_json": json.dumps({"auth_user_id": str(auth_user_id) if auth_user_id else None})},
        )

    if auth_user_id and supabase_url and secret_key:
        try:
            httpx.delete(
                f"{supabase_url}/auth/v1/admin/users/{auth_user_id}",
                headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
                timeout=30.0,
            )
        except Exception:
            pass

    return Response(status_code=204)


@app.patch("/api/admin/staff/{target_staff_id}", response_model=StaffAdminRecord)
def update_managed_staff(
    target_staff_id: int,
    update: StaffAccessUpdate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        admin_id, branch_id = require_staff_administrator(connection, user.id)
        connection.execute(text("SELECT pg_advisory_xact_lock(90421, 1)"))
        target = connection.execute(
            text("SELECT id, is_active FROM public.users WHERE id = :staff_id FOR UPDATE"),
            {"staff_id": target_staff_id},
        ).mappings().one_or_none()
        if target is None:
            raise HTTPException(status_code=404, detail="Staff profile not found.")

        validate_staff_branch(connection, update.branch_id)
        roles = resolve_staff_roles(connection, update.role_ids)
        role_codes = {role["code"] for role in roles}
        if target_staff_id == admin_id and (not update.is_active or "ADMIN" not in role_codes):
            raise HTTPException(status_code=409, detail="You cannot deactivate yourself or remove your own administrator role.")

        current_roles = connection.execute(
            text(
                """
                SELECT roles.code
                FROM public.user_roles AS user_roles
                JOIN public.roles AS roles ON roles.id = user_roles.role_id
                WHERE user_roles.user_id = :staff_id
                """
            ),
            {"staff_id": target_staff_id},
        ).scalars().all()
        if target["is_active"] and "ADMIN" in current_roles and (
            not update.is_active or "ADMIN" not in role_codes
        ):
            active_admin_count = connection.execute(
                text(
                    """
                    SELECT COUNT(DISTINCT staff.id)
                    FROM public.users AS staff
                    JOIN public.user_roles AS user_roles ON user_roles.user_id = staff.id
                    JOIN public.roles AS roles ON roles.id = user_roles.role_id
                    WHERE staff.is_active = TRUE AND roles.code = 'ADMIN'
                    """
                )
            ).scalar_one()
            if active_admin_count <= 1:
                raise HTTPException(status_code=409, detail="The last active administrator cannot be deactivated or demoted.")

        connection.execute(
            text(
                """
                UPDATE public.users
                SET branch_id = :branch_id, is_active = :is_active, updated_at = NOW()
                WHERE id = :staff_id
                """
            ),
            {"branch_id": update.branch_id, "is_active": update.is_active, "staff_id": target_staff_id},
        )
        connection.execute(
            text("DELETE FROM public.user_roles WHERE user_id = :staff_id"),
            {"staff_id": target_staff_id},
        )
        for role in roles:
            connection.execute(
                text("INSERT INTO public.user_roles (user_id, role_id) VALUES (:user_id, :role_id)"),
                {"user_id": target_staff_id, "role_id": role["id"]},
            )
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'staff.access_updated', 'staff', :staff_id,
                    CAST(:details_json AS jsonb)
                )
                """
            ),
            {
                "user_id": admin_id,
                "branch_id": branch_id,
                "staff_id": target_staff_id,
                "details_json": json.dumps({
                    "branch_id": update.branch_id,
                    "is_active": update.is_active,
                    "role_codes": sorted(role_codes),
                }),
            },
        )
        record = load_staff_admin_record(connection, target_staff_id)

    return StaffAdminRecord.model_validate(record)


def invoice_query_filters(
    search: str,
    status: InvoiceStatus | None,
    branch_id: int,
    booking_id: int | None = None,
) -> tuple[str, dict[str, object]]:
    filters = """
        bookings.branch_id = :branch_id
        AND (
            :search = ''
            OR invoices.invoice_number ILIKE :search_pattern
            OR bookings.booking_code ILIKE :search_pattern
            OR customers.display_name ILIKE :search_pattern
        )
    """
    params: dict[str, object] = {
        "branch_id": branch_id,
        "search": search,
        "search_pattern": f"%{search}%",
    }
    if booking_id is not None:
        filters += " AND invoices.booking_id = :booking_id"
        params["booking_id"] = booking_id
    if status is not None:
        filters += """
            AND (
                invoices.status = :status
                OR (
                    :status = 'overdue'
                    AND invoices.status IN ('issued', 'partially_paid')
                    AND invoices.due_date IS NOT NULL
                    AND invoices.due_date < CURRENT_DATE
                )
            )
        """
        params["status"] = status
    return filters, params


def render_invoice_pdf(invoice, items) -> bytes:
    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"Invoice {invoice['invoice_number']}",
        author=invoice["branch_name"],
    )
    styles = getSampleStyleSheet()
    right_style = ParagraphStyle("InvoiceRight", parent=styles["Normal"], alignment=TA_RIGHT)
    small_style = ParagraphStyle("InvoiceSmall", parent=styles["Normal"], fontSize=8, leading=11)
    safe = lambda value: escape(str(value)) if value is not None else ""
    branch_lines = [safe(invoice["branch_name"]), safe(invoice["branch_code"])]
    branch_lines.extend(safe(invoice[field]) for field in ("branch_address", "branch_phone", "branch_email") if invoice.get(field))
    customer_lines = [safe(invoice["customer_name"])]
    customer_lines.extend(safe(invoice[field]) for field in ("customer_billing_address", "customer_email", "customer_phone") if invoice.get(field))
    metadata = [
        f"Invoice: {safe(invoice['invoice_number'])}",
        f"Booking: {safe(invoice['booking_code'])}",
        f"Issued: {invoice['issue_date'].isoformat()}",
        f"Due: {invoice['due_date'].isoformat() if invoice['due_date'] else 'Not specified'}",
        f"Status: {safe(invoice['status']).upper()}",
    ]
    story = [
        Table(
            [[Paragraph("<br/>".join(branch_lines), styles["Normal"]),
              Paragraph("CUSTOMER INVOICE", styles["Title"])]],
            colWidths=[90 * mm, 85 * mm],
            style=TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]),
        ),
        Spacer(1, 8 * mm),
        Table(
            [[Paragraph("<b>Bill to</b><br/>" + "<br/>".join(customer_lines), styles["Normal"]),
              Paragraph("<br/>".join(metadata), small_style)]],
            colWidths=[92 * mm, 83 * mm],
            style=TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]),
        ),
        Spacer(1, 8 * mm),
    ]
    currency = safe(invoice["currency"].strip())
    line_rows = [["Type", "Description", "Qty", "Unit price", "Line total"]]
    for item in items:
        line_rows.append([
            Paragraph(safe(item["item_type"].replace("_", " ").title()), small_style),
            Paragraph(safe(item["description"]), small_style),
            str(item["quantity"]),
            f"{currency} {item['unit_price']}",
            f"{currency} {item['line_total']}",
        ])
    line_table = Table(line_rows, colWidths=[25 * mm, 68 * mm, 16 * mm, 31 * mm, 35 * mm], repeatRows=1)
    line_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#cbd5e1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(line_table)
    story.append(Spacer(1, 6 * mm))
    totals = Table([
        ["Subtotal", f"{currency} {invoice['subtotal']}", ""],
        ["Tax", f"{currency} {invoice['tax_total']}", ""],
        ["Discount", f"- {currency} {invoice['discount_total']}", ""],
        ["Total due", "", f"{currency} {invoice['grand_total']}"],
    ], colWidths=[90 * mm, 43 * mm, 42 * mm], hAlign="RIGHT")
    totals.setStyle(TableStyle([
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("FONTNAME", (0, 3), (-1, 3), "Helvetica-Bold"),
        ("LINEABOVE", (0, 3), (-1, 3), 0.8, colors.HexColor("#0f766e")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(totals)
    if invoice.get("notes"):
        story.extend([Spacer(1, 8 * mm), Paragraph("<b>Notes</b>", styles["Normal"]),
                      Paragraph(safe(invoice["notes"]).replace("\n", "<br/>"), small_style)])
    document.build(story)
    return buffer.getvalue()


@app.get("/api/financial-reports/invoices", response_model=InvoiceSalesReport)
def invoice_sales_report(
    start_date: date | None = None,
    end_date: date | None = None,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        today = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()
        resolved_end = end_date or today
        resolved_start = start_date or resolved_end.replace(day=1)
        if resolved_start > resolved_end:
            raise HTTPException(status_code=422, detail="Start date must be on or before end date.")

        rows = connection.execute(
            text(
                """
                SELECT
                    invoices.currency,
                    COUNT(*) AS invoice_count,
                    COALESCE(SUM(invoices.subtotal), 0) AS subtotal,
                    COALESCE(SUM(invoices.tax_total), 0) AS tax_total,
                    COALESCE(SUM(invoices.discount_total), 0) AS discount_total,
                    COALESCE(SUM(invoices.grand_total), 0) AS grand_total,
                    COALESCE(SUM(
                        (SELECT COALESCE(SUM(t.selling_price - t.fare_amount), 0)
                         FROM public.tickets t
                         JOIN public.booking_passengers bp ON bp.id = t.booking_passenger_id
                         WHERE bp.booking_id = invoices.booking_id)
                    ), 0) AS total_margin
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                WHERE bookings.branch_id = :branch_id
                    AND invoices.status IN ('issued', 'partially_paid', 'paid')
                    AND DATE(invoices.issue_date) >= :start_date
                    AND DATE(invoices.issue_date) <= :end_date
                GROUP BY invoices.currency
                ORDER BY invoices.currency
                """
            ),
            {
                "branch_id": branch_id,
                "start_date": resolved_start,
                "end_date": resolved_end,
            },
        ).mappings().all()

    totals = [InvoiceReportCurrencyTotal.model_validate(row) for row in rows]
    return InvoiceSalesReport(
        start_date=resolved_start,
        end_date=resolved_end,
        invoice_count=sum(row.invoice_count for row in totals),
        by_currency=totals,
    )


class TicketMarginRecord(BaseModel):
    ticket_id: int
    ticket_number: str | None = None
    issue_date: date | None = None
    selling_price: Decimal | None = None
    fare_amount: Decimal | None = None
    margin: Decimal | None = None
    currency: str | None = None
    booking_code: str | None = None
    passenger_name: str | None = None
    supplier_name: str | None = None

class TicketMarginReport(BaseModel):
    start_date: date
    end_date: date
    items: list[TicketMarginRecord]

@app.get("/api/reports/margin-summary")
def get_margin_summary(user: AuthenticatedUser = Depends(get_authenticated_user)):
    with engine.begin() as conn:
        base_query = """
            SELECT COALESCE(SUM(selling_price - COALESCE(fare_amount, 0)), 0) as margin, COUNT(id) as count
            FROM public.tickets
        """

        today = conn.execute(text(base_query + " WHERE DATE(COALESCE(issue_date, created_at)) = CURRENT_DATE")).mappings().one()
        weekly = conn.execute(text(base_query + " WHERE DATE(COALESCE(issue_date, created_at)) >= CURRENT_DATE - INTERVAL '6 days'")).mappings().one()
        monthly = conn.execute(text(base_query + " WHERE DATE(COALESCE(issue_date, created_at)) >= date_trunc('month', CURRENT_DATE)")).mappings().one()

        return {
            "today": {"margin": today["margin"], "count": today["count"]},
            "last_7_days": {"margin": weekly["margin"], "count": weekly["count"]},
            "this_month": {"margin": monthly["margin"], "count": monthly["count"]}
        }


@app.get("/api/financial-reports/ticket-margins", response_model=TicketMarginReport)
def ticket_margin_report(
    start_date: date | None = None,
    end_date: date | None = None,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        today = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()
        resolved_end = end_date or today
        resolved_start = start_date or resolved_end.replace(day=1)
        if resolved_start > resolved_end:
            raise HTTPException(status_code=422, detail="Start date must be on or before end date.")

        rows = connection.execute(
            text(
                """
                SELECT
                    t.id AS ticket_id,
                    t.ticket_number,
                    t.issue_date,
                    t.selling_price,
                    t.fare_amount,
                    (t.selling_price - t.fare_amount) AS margin,
                    t.currency,
                    b.booking_code,
                    bp.first_name || ' ' || bp.last_name AS passenger_name,
                    COALESCE(s.trading_name, s.legal_name) AS supplier_name
                FROM public.tickets t
                JOIN public.booking_passengers bp ON bp.id = t.booking_passenger_id
                JOIN public.bookings b ON b.id = bp.booking_id
                LEFT JOIN public.suppliers s ON s.id = t.issued_by_supplier_id
                WHERE b.branch_id = :branch_id
                    AND DATE(t.issue_date) >= :start_date
                    AND DATE(t.issue_date) <= :end_date
                ORDER BY t.issue_date DESC, t.id DESC
                """
            ),
            {
                "branch_id": branch_id,
                "start_date": resolved_start,
                "end_date": resolved_end,
            },
        ).mappings().all()

    items = [TicketMarginRecord.model_validate(row) for row in rows]
    return TicketMarginReport(
        start_date=resolved_start,
        end_date=resolved_end,
        items=items,
    )


@app.get("/api/invoices", response_model=InvoiceListResponse)
def list_invoices(
    q: str = Query(default="", max_length=200),
    status: InvoiceStatus | None = None,
    booking_id: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    search = q.strip()
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        filters, params = invoice_query_filters(search, status, branch_id, booking_id)
        total = connection.execute(
            text(
                f"""
                SELECT COUNT(*)
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                JOIN public.customers AS customers ON customers.id = invoices.customer_id
                WHERE {filters}
                """
            ),
            params,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"""
                SELECT
                    invoices.id,
                    invoices.invoice_number,
                    invoices.customer_id,
                    customers.display_name AS customer_name,
                    invoices.booking_id,
                    bookings.booking_code,
                    invoices.currency,
                    invoices.issue_date,
                    invoices.due_date,
                    CASE
                        WHEN invoices.status IN ('issued', 'partially_paid')
                            AND invoices.due_date IS NOT NULL
                            AND invoices.due_date < CURRENT_DATE
                        THEN 'overdue'
                        ELSE invoices.status
                    END AS status,
                    invoices.subtotal,
                    invoices.tax_total,
                    invoices.discount_total,
                    invoices.grand_total,
                    invoices.created_at,
                    (
                        SELECT COUNT(*)
                        FROM public.invoice_items AS invoice_items
                        WHERE invoice_items.invoice_id = invoices.id
                    ) AS item_count
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                JOIN public.customers AS customers ON customers.id = invoices.customer_id
                WHERE {filters}
                ORDER BY invoices.issue_date DESC, invoices.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()

    return InvoiceListResponse(
        items=[InvoiceRecord.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


class AllocatableInvoiceRecord(BaseModel):
    """An invoice that can still take a payment, with what is left owing."""

    id: int
    invoice_number: str
    customer_id: int
    customer_name: str
    currency: str
    status: InvoiceStatus
    due_date: date | None
    grand_total: Decimal
    allocated_total: Decimal
    balance_due: Decimal


@app.get("/api/invoices/allocatable", response_model=list[AllocatableInvoiceRecord])
def list_allocatable_invoices(
    limit: int = Query(default=100, ge=1, le=500),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    """List the invoices that can still receive money.

    An invoice is eligible when it is issued or partly paid and money is still
    outstanding on it. The remaining balance is returned with it, so the
    caller cannot offer an amount the invoice cannot take. Cancelled, void,
    draft and paid invoices are never eligible, and neither is one that has
    been settled in full.
    """
    with engine.connect() as connection:
        _, branch_id = require_cash_staff(connection, user.id)
        rows = connection.execute(
            text(
                """
                SELECT
                    invoices.id,
                    invoices.invoice_number,
                    invoices.customer_id,
                    customers.display_name AS customer_name,
                    invoices.currency,
                    invoices.status,
                    invoices.due_date,
                    invoices.grand_total,
                    COALESCE(SUM(payment_allocations.amount), 0) AS allocated_total,
                    invoices.grand_total - COALESCE(SUM(payment_allocations.amount), 0) AS balance_due
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                JOIN public.customers AS customers ON customers.id = invoices.customer_id
                LEFT JOIN public.payment_allocations AS payment_allocations
                    ON payment_allocations.invoice_id = invoices.id
                WHERE bookings.branch_id = :branch_id
                    AND invoices.status IN ('issued', 'partially_paid')
                GROUP BY
                    invoices.id,
                    customers.display_name
                HAVING invoices.grand_total - COALESCE(SUM(payment_allocations.amount), 0) > 0
                ORDER BY invoices.due_date ASC NULLS LAST, invoices.id DESC
                LIMIT :limit
                """
            ),
            {"branch_id": branch_id, "limit": limit},
        ).mappings().all()

    return [AllocatableInvoiceRecord.model_validate(row) for row in rows]


@app.get("/api/invoices/{invoice_id}", response_model=InvoiceDetails)
def invoice_details(
    invoice_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        invoice = connection.execute(
            text(
                """
                SELECT
                    invoices.id,
                    invoices.invoice_number,
                    invoices.customer_id,
                    customers.display_name AS customer_name,
                    invoices.booking_id,
                    bookings.booking_code,
                    invoices.currency,
                    invoices.issue_date,
                    invoices.due_date,
                    CASE
                        WHEN invoices.status IN ('issued', 'partially_paid')
                            AND invoices.due_date IS NOT NULL
                            AND invoices.due_date < CURRENT_DATE
                        THEN 'overdue'
                        ELSE invoices.status
                    END AS status,
                    invoices.subtotal,
                    invoices.tax_total,
                    invoices.discount_total,
                    invoices.grand_total,
                    invoices.notes,
                    invoices.created_at
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                JOIN public.customers AS customers ON customers.id = invoices.customer_id
                WHERE invoices.id = :invoice_id AND bookings.branch_id = :branch_id
                """
            ),
            {"invoice_id": invoice_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Invoice not found.")
        items = connection.execute(
            text(
                """
                SELECT id, item_type, description, quantity, unit_price, line_total
                FROM public.invoice_items
                WHERE invoice_id = :invoice_id
                ORDER BY id
                """
            ),
            {"invoice_id": invoice_id},
        ).mappings().all()

    return InvoiceDetails.model_validate({**invoice, "item_count": len(items), "items": items})


@app.get("/api/invoices/{invoice_id}/pdf")
def download_invoice_pdf(
    invoice_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        invoice = connection.execute(
            text(
                """
                SELECT
                    invoices.id,
                    invoices.invoice_number,
                    invoices.currency,
                    invoices.issue_date,
                    invoices.due_date,
                    CASE
                        WHEN invoices.status IN ('issued', 'partially_paid')
                            AND invoices.due_date IS NOT NULL
                            AND invoices.due_date < CURRENT_DATE
                        THEN 'overdue'
                        ELSE invoices.status
                    END AS status,
                    invoices.subtotal,
                    invoices.tax_total,
                    invoices.discount_total,
                    invoices.grand_total,
                    invoices.notes,
                    customers.display_name AS customer_name,
                    customers.billing_address AS customer_billing_address,
                    customers.email AS customer_email,
                    customers.phone AS customer_phone,
                    bookings.booking_code,
                    branches.name AS branch_name,
                    branches.code AS branch_code,
                    branches.address AS branch_address,
                    branches.phone AS branch_phone,
                    branches.email AS branch_email
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                JOIN public.customers AS customers ON customers.id = invoices.customer_id
                JOIN public.branches AS branches ON branches.id = bookings.branch_id
                WHERE invoices.id = :invoice_id AND bookings.branch_id = :branch_id
                """
            ),
            {"invoice_id": invoice_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Invoice not found.")
        if invoice["status"] == "draft":
            raise HTTPException(status_code=409, detail="Draft invoices cannot be downloaded as customer invoices.")
        items = connection.execute(
            text(
                """
                SELECT item_type, description, quantity, unit_price, line_total
                FROM public.invoice_items
                WHERE invoice_id = :invoice_id
                ORDER BY id
                """
            ),
            {"invoice_id": invoice_id},
        ).mappings().all()

    pdf = render_invoice_pdf(invoice, items)
    filename = re.sub(r"[^A-Za-z0-9._-]+", "_", invoice["invoice_number"]) or f"invoice-{invoice_id}"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}.pdf"'},
    )


@app.post("/api/invoices", response_model=InvoiceDetails, status_code=201)
def create_invoice(
    invoice: InvoiceCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_finance_staff(connection, user.id, write_access=True)
        booking = connection.execute(
            text(
                """
                SELECT bookings.id, bookings.customer_id, customers.display_name AS customer_name,
                    bookings.booking_code
                FROM public.bookings AS bookings
                JOIN public.customers AS customers ON customers.id = bookings.customer_id
                WHERE bookings.id = :booking_id AND bookings.branch_id = :branch_id
                FOR UPDATE OF bookings
                """
            ),
            {"booking_id": invoice.booking_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found in your branch.")

        line_items = []
        subtotal = Decimal("0")
        for item in invoice.items:
            line_total = (item.quantity * item.unit_price).quantize(
                Decimal("0.0001"), rounding=ROUND_HALF_UP,
            )
            subtotal += line_total
            line_items.append({
                **item.model_dump(),
                "line_total": line_total,
                "booking_id": invoice.booking_id,
            })

        grand_total = subtotal + invoice.tax_total - invoice.discount_total
        if grand_total < 0:
            raise HTTPException(status_code=422, detail="Discount cannot exceed the subtotal plus tax.")

        created = connection.execute(
            text(
                """
                INSERT INTO public.invoices (
                    invoice_number, customer_id, booking_id, currency, due_date,
                    status, subtotal, tax_total, discount_total, grand_total, notes, created_by
                )
                VALUES (
                    :invoice_number, :customer_id, :booking_id, :currency, :due_date,
                    'draft', :subtotal, :tax_total, :discount_total, :grand_total, :notes, :created_by
                )
                ON CONFLICT (invoice_number) DO NOTHING
                RETURNING
                    id, invoice_number, customer_id, booking_id, currency, issue_date,
                    due_date, status, subtotal, tax_total, discount_total, grand_total,
                    notes, created_at
                """
            ),
            {
                "invoice_number": invoice.invoice_number,
                "customer_id": booking["customer_id"],
                "booking_id": invoice.booking_id,
                "currency": invoice.currency,
                "due_date": invoice.due_date,
                "subtotal": subtotal,
                "tax_total": invoice.tax_total,
                "discount_total": invoice.discount_total,
                "grand_total": grand_total,
                "notes": invoice.notes,
                "created_by": staff_id,
            },
        ).mappings().one_or_none()
        if created is None:
            raise HTTPException(status_code=409, detail="That invoice number is already in use.")

        created_items = []
        for item in line_items:
            created_item = connection.execute(
                text(
                    """
                    INSERT INTO public.invoice_items (
                        invoice_id, booking_id, item_type, description, quantity, unit_price, line_total
                    )
                    VALUES (
                        :invoice_id, :booking_id, :item_type, :description, :quantity, :unit_price, :line_total
                    )
                    RETURNING id, item_type, description, quantity, unit_price, line_total
                    """
                ),
                {**item, "invoice_id": created["id"]},
            ).mappings().one()
            created_items.append(created_item)

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'invoice.draft_created', 'invoice', :invoice_id,
                    jsonb_build_object(
                        'invoice_number', CAST(:invoice_number AS text),
                        'booking_id', CAST(:booking_id AS bigint),
                        'currency', CAST(:currency AS text),
                        'grand_total', CAST(:grand_total AS text),
                        'item_count', CAST(:item_count AS integer)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "invoice_id": created["id"],
                "invoice_number": invoice.invoice_number,
                "booking_id": invoice.booking_id,
                "currency": invoice.currency,
                "grand_total": grand_total,
                "item_count": len(created_items),
            },
        )

    return InvoiceDetails.model_validate({
        **created,
        "customer_name": booking["customer_name"],
        "booking_code": booking["booking_code"],
        "item_count": len(created_items),
        "items": created_items,
    })


@app.post("/api/invoices/{invoice_id}/issue", response_model=InvoiceDetails)
def issue_invoice(
    invoice_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_finance_staff(connection, user.id, write_access=True)
        invoice = connection.execute(
            text(
                """
                SELECT
                    invoices.id,
                    invoices.invoice_number,
                    invoices.customer_id,
                    customers.display_name AS customer_name,
                    invoices.booking_id,
                    bookings.booking_code,
                    invoices.currency,
                    invoices.issue_date,
                    invoices.due_date,
                    CASE
                        WHEN invoices.status IN ('issued', 'partially_paid')
                            AND invoices.due_date IS NOT NULL
                            AND invoices.due_date < CURRENT_DATE
                        THEN 'overdue'
                        ELSE invoices.status
                    END AS status,
                    invoices.subtotal,
                    invoices.tax_total,
                    invoices.discount_total,
                    invoices.grand_total,
                    invoices.notes,
                    invoices.created_at
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                JOIN public.customers AS customers ON customers.id = invoices.customer_id
                WHERE invoices.id = :invoice_id AND bookings.branch_id = :branch_id
                FOR UPDATE OF invoices
                """
            ),
            {"invoice_id": invoice_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Invoice not found.")
        if invoice["status"] != "draft":
            raise HTTPException(status_code=409, detail="Only draft invoices can be issued.")

        items = connection.execute(
            text(
                """
                SELECT id, item_type, description, quantity, unit_price, line_total
                FROM public.invoice_items
                WHERE invoice_id = :invoice_id
                ORDER BY id
                """
            ),
            {"invoice_id": invoice_id},
        ).mappings().all()
        if not items:
            raise HTTPException(status_code=409, detail="An invoice must contain at least one line item before it can be issued.")

        current_date = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()
        if invoice["due_date"] is not None and invoice["due_date"] < current_date:
            raise HTTPException(
                status_code=409,
                detail="The due date has passed. Create a new draft with a valid due date before issuing.",
            )

        updated = connection.execute(
            text(
                """
                UPDATE public.invoices
                SET status = 'issued', issue_date = CURRENT_DATE
                WHERE id = :invoice_id AND status = 'draft'
                RETURNING issue_date, status
                """
            ),
            {"invoice_id": invoice_id},
        ).mappings().one()
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'invoice.issued', 'invoice', :invoice_id,
                    jsonb_build_object(
                        'invoice_number', CAST(:invoice_number AS text),
                        'from_status', 'draft',
                        'to_status', 'issued',
                        'issue_date', CAST(:issue_date AS text),
                        'grand_total', CAST(:grand_total AS text),
                        'currency', CAST(:currency AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "invoice_id": invoice_id,
                "invoice_number": invoice["invoice_number"],
                "issue_date": updated["issue_date"],
                "grand_total": invoice["grand_total"],
                "currency": invoice["currency"],
            },
        )

    return InvoiceDetails.model_validate({
        **invoice,
        "issue_date": updated["issue_date"],
        "status": updated["status"],
        "item_count": len(items),
        "items": items,
    })


@app.get("/api/bookings", response_model=BookingListResponse)
def list_bookings(
    q: str = Query(default="", max_length=200),
    status: BookingStatus | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    search = q.strip()
    search_pattern = f"%{search}%"
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        filters = """
            bookings.branch_id = :branch_id
            AND (
                :search = ''
                OR bookings.booking_code ILIKE :search_pattern
                OR bookings.external_pnr ILIKE :search_pattern
                OR customers.display_name ILIKE :search_pattern
            )
        """
        params = {
            "branch_id": branch_id,
            "search": search,
            "search_pattern": search_pattern,
        }
        if status is not None:
            filters += " AND bookings.status = :status"
            params["status"] = status
        total = connection.execute(
            text(
                f"""
                SELECT COUNT(*)
                FROM public.bookings AS bookings
                JOIN public.customers AS customers ON customers.id = bookings.customer_id
                WHERE {filters}
                """
            ),
            params,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"""
                SELECT
                    bookings.id,
                    bookings.booking_code,
                    bookings.branch_id,
                    bookings.customer_id,
                    customers.display_name AS customer_name,
                    bookings.status,
                    bookings.booking_channel,
                    bookings.external_pnr,
                    bookings.reservation_system,
                    bookings.customer_notes,
                    bookings.created_at
                FROM public.bookings AS bookings
                JOIN public.customers AS customers ON customers.id = bookings.customer_id
                WHERE {filters}
                ORDER BY bookings.created_at DESC, bookings.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()

    return BookingListResponse(
        items=[BookingRecord.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@app.post("/api/bookings", response_model=BookingRecord, status_code=201)
def create_booking(
    booking: BookingCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        customer = connection.execute(
            text("SELECT id, display_name FROM public.customers WHERE id = :customer_id"),
            {"customer_id": booking.customer_id},
        ).mappings().one_or_none()
        if customer is None:
            raise HTTPException(status_code=404, detail="The selected customer was not found.")

        booking_code = f"TO{datetime.now(timezone.utc).strftime('%y%m%d')}{token_hex(8).upper()}"
        row = connection.execute(
            text(
                """
                INSERT INTO public.bookings (
                    booking_code, branch_id, customer_id, external_pnr,
                    reservation_system, booking_channel, assigned_to, created_by,
                    customer_notes
                )
                VALUES (
                    :booking_code, :branch_id, :customer_id, :external_pnr,
                    :reservation_system, :booking_channel, :staff_id, :staff_id,
                    :customer_notes
                )
                RETURNING id, booking_code, branch_id, customer_id, status,
                    booking_channel, external_pnr, reservation_system,
                    customer_notes, created_at
                """
            ),
            {
                **booking.model_dump(),
                "booking_code": booking_code,
                "branch_id": branch_id,
                "staff_id": staff_id,
            },
        ).mappings().one()

        connection.execute(
        text(
            """
            INSERT INTO public.activity_logs
                (user_id, branch_id, action, entity_type, entity_id, details_json)
            VALUES
                (
                    :user_id,
                    :branch_id,
                    'booking.created',
                    'booking',
                    :booking_id,
                    jsonb_build_object('to_status', 'requested')
                )
            """
        ),
        {
            "user_id": staff_id,
            "branch_id": branch_id,
            "booking_id": row["id"],
        },
        )

    return BookingRecord.model_validate({**row, "customer_name": customer["display_name"]})


@app.delete("/api/bookings/{booking_id}", status_code=204)
def delete_booking(
    booking_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        booking = connection.execute(
            text("SELECT id, status FROM public.bookings WHERE id = :booking_id AND branch_id = :branch_id FOR UPDATE"),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found.")
        # Block if dependents exist
        counts = connection.execute(
            text(
                """
                SELECT
                    (SELECT COUNT(*) FROM public.booking_passengers WHERE booking_id = :bid) AS passengers,
                    (SELECT COUNT(*) FROM public.flight_segments WHERE booking_id = :bid) AS segments,
                    (SELECT COUNT(*) FROM public.tickets t JOIN public.booking_passengers bp ON bp.id = t.booking_passenger_id WHERE bp.booking_id = :bid) AS tickets,
                    (SELECT COUNT(*) FROM public.invoices WHERE booking_id = :bid) AS invoices,
                    (SELECT COUNT(*) FROM public.ticketing_requests WHERE booking_id = :bid) AS ticketing_requests,
                    (SELECT COUNT(*) FROM public.documents WHERE booking_id = :bid) AS documents
                """
            ),
            {"bid": booking_id},
        ).mappings().one()
        if any(counts[k] for k in counts):
            raise HTTPException(status_code=409, detail="Booking has dependent records; cancel it instead of deleting.")
        if booking["status"] not in {"requested", "quoted"}:
            raise HTTPException(status_code=409, detail="Only unused draft bookings can be deleted.")
        connection.execute(text("DELETE FROM public.bookings WHERE id = :booking_id"), {"booking_id": booking_id})
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (:user_id, :branch_id, 'booking.deleted', 'booking', :booking_id, '{}'::jsonb)
                """
            ),
            {"user_id": staff_id, "branch_id": branch_id, "booking_id": booking_id},
        )


def lock_editable_booking(connection, booking_id: int, branch_id: int):
    booking = connection.execute(
        text(
            """
            SELECT id, status
            FROM public.bookings
            WHERE id = :booking_id AND branch_id = :branch_id
            FOR UPDATE
            """
        ),
        {"booking_id": booking_id, "branch_id": branch_id},
    ).mappings().one_or_none()
    if booking is None:
        raise HTTPException(status_code=404, detail="Booking not found.")
    if booking["status"] in {"partially_ticketed", "ticketed", "cancelled", "expired", "closed"}:
        raise HTTPException(
            status_code=409,
            detail=f"Passengers and itinerary cannot be changed while booking is {booking['status']}.",
        )
    return booking


@app.get("/api/bookings/{booking_id}/details", response_model=BookingDetails)
def booking_details(
    booking_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        exists = connection.execute(
            text(
                """
                SELECT 1 FROM public.bookings
                WHERE id = :booking_id AND branch_id = :branch_id
                """
            ),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="Booking not found.")

        passengers = connection.execute(
            text(
                """
                SELECT id, passenger_type, first_name, middle_name, last_name, created_at
                FROM public.booking_passengers
                WHERE booking_id = :booking_id
                ORDER BY id
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()
        segments = connection.execute(
            text(
                """
                SELECT
                    id, segment_order, marketing_carrier, flight_number,
                    origin_airport, destination_airport, departure_at, arrival_at,
                    booking_class, cabin, segment_status
                FROM public.flight_segments
                WHERE booking_id = :booking_id
                ORDER BY segment_order
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()
        tickets = connection.execute(
            text(
                """
                SELECT
                    tickets.id,
                    tickets.booking_passenger_id,
                    tickets.issued_by_supplier_id AS supplier_id,
                    COALESCE(NULLIF(BTRIM(suppliers.trading_name), ''), suppliers.legal_name) AS supplier_name,
                    tickets.ticket_number,
                    tickets.ticket_status,
                    tickets.issued_at,
                    tickets.issue_date,
                    tickets.fare_amount,
                    tickets.currency,
                    tickets.selling_price,
                    tickets.selling_currency,
                    tickets.notes,
                    tickets.verified_at
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                JOIN public.suppliers AS suppliers
                    ON suppliers.id = tickets.issued_by_supplier_id
                WHERE booking_passengers.booking_id = :booking_id
                ORDER BY tickets.created_at DESC, tickets.id DESC
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()

    return BookingDetails(
        passengers=[BookingPassengerRecord.model_validate(row) for row in passengers],
        segments=[FlightSegmentRecord.model_validate(row) for row in segments],
        tickets=[TicketRecord.model_validate(row) for row in tickets],
    )


@app.delete("/api/bookings/{booking_id}/passengers/{passenger_id}", status_code=204)
def delete_booking_passenger(
    booking_id: int,
    passenger_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        exists = connection.execute(
            text(
                """
                SELECT 1 FROM public.booking_passengers AS bp
                JOIN public.bookings AS b ON b.id = bp.booking_id
                WHERE bp.id = :passenger_id AND bp.booking_id = :booking_id AND b.branch_id = :branch_id
                """
            ),
            {"passenger_id": passenger_id, "booking_id": booking_id, "branch_id": branch_id},
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="Passenger not found.")
        ticketed = connection.execute(
            text(
                """
                SELECT 1 FROM public.tickets
                WHERE booking_passenger_id = :passenger_id
                LIMIT 1
                """
            ),
            {"passenger_id": passenger_id},
        ).scalar_one_or_none()
        if ticketed is not None:
            raise HTTPException(status_code=409, detail="Cannot delete a passenger with issued tickets.")
        connection.execute(
            text("DELETE FROM public.booking_passengers WHERE id = :passenger_id"),
            {"passenger_id": passenger_id},
        )
    return None


@app.delete("/api/bookings/{booking_id}/segments/{segment_id}", status_code=204)
def delete_flight_segment(
    booking_id: int,
    segment_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        exists = connection.execute(
            text(
                """
                SELECT 1 FROM public.flight_segments AS fs
                JOIN public.bookings AS b ON b.id = fs.booking_id
                WHERE fs.id = :segment_id AND fs.booking_id = :booking_id AND b.branch_id = :branch_id
                """
            ),
            {"segment_id": segment_id, "booking_id": booking_id, "branch_id": branch_id},
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="Segment not found.")
        couponed = connection.execute(
            text(
                """
                SELECT 1 FROM public.coupon_usages
                WHERE flight_segment_id = :segment_id
                LIMIT 1
                """
            ),
            {"segment_id": segment_id},
        ).scalar_one_or_none()
        if couponed is not None:
            raise HTTPException(status_code=409, detail="Cannot delete a segment linked to a coupon.")
        connection.execute(
            text("DELETE FROM public.flight_segments WHERE id = :segment_id"),
            {"segment_id": segment_id},
        )
    return None


@app.post(
    "/api/bookings/{booking_id}/tickets",
    response_model=TicketRecord,
    status_code=201,
)
def record_booking_ticket(
    booking_id: int,
    ticket: TicketCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        booking = connection.execute(
            text(
                """
                SELECT id, status, customer_id, booking_code
                FROM public.bookings
                WHERE id = :booking_id AND branch_id = :branch_id
                FOR UPDATE
                """
            ),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found.")

        passenger_exists = connection.execute(
            text(
                """
                SELECT 1 FROM public.booking_passengers
                WHERE id = :passenger_id AND booking_id = :booking_id
                """
            ),
            {"passenger_id": ticket.booking_passenger_id, "booking_id": booking_id},
        ).scalar_one_or_none()
        if passenger_exists is None:
            raise HTTPException(status_code=404, detail="Traveler not found on this booking.")

        supplier = connection.execute(
            text(
                """
                SELECT
                    id,
                    COALESCE(NULLIF(BTRIM(trading_name), ''), legal_name) AS display_name
                FROM public.suppliers
                WHERE id = :supplier_id
                    AND is_active = TRUE
                    AND supplier_type IN ('airline', 'consolidator', 'host_agency')
                """
            ),
            {"supplier_id": ticket.supplier_id},
        ).mappings().one_or_none()
        if supplier is None:
            raise HTTPException(status_code=422, detail="Select an active airline, consolidator, or host agency.")

        segment_ids = connection.execute(
            text(
                """
                SELECT id
                FROM public.flight_segments
                WHERE booking_id = :booking_id
                ORDER BY segment_order
                """
            ),
            {"booking_id": booking_id},
        ).scalars().all()
        if not segment_ids:
            raise HTTPException(status_code=409, detail="Add the flight itinerary before recording a ticket.")

        active_ticket_exists = connection.execute(
            text(
                """
                SELECT 1 FROM public.tickets
                WHERE booking_passenger_id = :passenger_id
                    AND ticket_status IN ('issued', 'exchanged')
                LIMIT 1
                """
            ),
            {"passenger_id": ticket.booking_passenger_id},
        ).scalar_one_or_none()
        if active_ticket_exists is not None:
            raise HTTPException(status_code=409, detail="This traveler already has an active ticket.")

        # 1. Insert the E-Ticket
        created = connection.execute(
            text(
                """
                INSERT INTO public.tickets (
                    booking_passenger_id,
                    issued_by_supplier_id,
                    ticket_number,
                    ticket_status,
                    issued_at,
                    issue_date,
                    fare_amount,
                    currency,
                    selling_price,
                    selling_currency,
                    notes,
                    verified_at,
                    verified_by
                )
                VALUES (
                    :passenger_id,
                    :supplier_id,
                    :ticket_number,
                    'issued',
                    NOW(),
                    :issue_date,
                    :fare_amount,
                    :currency,
                    :selling_price,
                    :selling_currency,
                    :notes,
                    NOW(),
                    :verified_by
                )
                ON CONFLICT (issued_by_supplier_id, ticket_number) DO NOTHING
                RETURNING
                    id,
                    booking_passenger_id,
                    issued_by_supplier_id AS supplier_id,
                    ticket_number,
                    ticket_status,
                    issued_at,
                    fare_amount,
                    currency,
                    selling_price,
                    selling_currency,
                    issue_date,
                    notes,
                    verified_at
                """
            ),
            {
                "passenger_id": ticket.booking_passenger_id,
                "supplier_id": ticket.supplier_id,
                "ticket_number": ticket.ticket_number,
                "fare_amount": ticket.fare_amount,
                "currency": ticket.currency,
                "selling_price": ticket.selling_price,
                "selling_currency": ticket.selling_currency,
                "issue_date": ticket.issue_date or date.today(),
                "notes": ticket.notes,
                "verified_by": staff_id,
            },
        ).mappings().one_or_none()
        if created is None:
            raise HTTPException(
                status_code=409,
                detail="That ticket number is already recorded for this supplier.",
            )

        _create_ticket_coupons(connection, created["id"], list(segment_ids))

        # 2. Automatically Create Supplier Bill (Accounts Payable)
        if ticket.fare_amount is not None and ticket.currency is not None:
            bill_number = connection.execute(
                text("SELECT public.next_supplier_bill_number(:branch_id)"),
                {"branch_id": branch_id},
            ).scalar_one()
            connection.execute(
                text(
                    """
                    INSERT INTO public.supplier_bills (
                        supplier_id, branch_id, booking_id, bill_number,
                        currency, bill_date, amount, status, created_by
                    )
                    VALUES (
                        :supplier_id, :branch_id, :booking_id, :bill_number,
                        :currency, CURRENT_DATE, :amount, 'unpaid', :created_by
                    )
                    """
                ),
                {
                    "supplier_id": ticket.supplier_id,
                    "branch_id": branch_id,
                    "booking_id": booking_id,
                    "bill_number": bill_number,
                    "currency": ticket.currency,
                    "amount": ticket.fare_amount,
                    "created_by": staff_id,
                },
            )

        # 3. Automatically Create Draft Invoice (Customer Billing)
        if ticket.selling_price is not None and ticket.selling_currency is not None:
            passenger = connection.execute(
                text("SELECT first_name, last_name FROM public.booking_passengers WHERE id = :pid"),
                {"pid": ticket.booking_passenger_id},
            ).mappings().one_or_none()
            pax_name = f"{passenger['first_name']} {passenger['last_name']}" if passenger else "Traveler"
            invoice_number = f"INV-{booking['booking_code'][-6:]}-{token_hex(2).upper()}"

            inv_row = connection.execute(
                text(
                    """
                    INSERT INTO public.invoices (
                        invoice_number, customer_id, booking_id, currency,
                        status, subtotal, tax_total, discount_total, grand_total, created_by
                    )
                    VALUES (
                        :invoice_number, :customer_id, :booking_id, :currency,
                        'draft', :amount, 0, 0, :amount, :created_by
                    )
                    ON CONFLICT (invoice_number) DO NOTHING
                    RETURNING id
                    """
                ),
                {
                    "invoice_number": invoice_number,
                    "customer_id": booking["customer_id"],
                    "booking_id": booking_id,
                    "currency": ticket.selling_currency,
                    "amount": ticket.selling_price,
                    "created_by": staff_id,
                },
            ).mappings().one_or_none()

            if inv_row:
                connection.execute(
                    text(
                        """
                        INSERT INTO public.invoice_items (
                            invoice_id, booking_id, item_type, description, quantity, unit_price, line_total
                        )
                        VALUES (
                            :invoice_id, :booking_id, 'airfare', :description, 1, :unit_price, :line_total
                        )
                        """
                    ),
                    {
                        "invoice_id": inv_row["id"],
                        "booking_id": booking_id,
                        "description": f"Airfare for {pax_name} (Ticket: {ticket.ticket_number})",
                        "unit_price": ticket.selling_price,
                        "line_total": ticket.selling_price,
                    },
                )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id,
                    :branch_id,
                    'ticket.issued_recorded',
                    'ticket',
                    :ticket_id,
                    jsonb_build_object(
                        'booking_id', CAST(:booking_id AS bigint),
                        'booking_passenger_id', CAST(:passenger_id AS bigint),
                        'supplier_id', CAST(:supplier_id AS bigint),
                        'ticket_number', CAST(:ticket_number AS text),
                        'fare_amount', CAST(:fare_amount AS text),
                        'currency', CAST(:currency AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "ticket_id": created["id"],
                "booking_id": booking_id,
                "passenger_id": ticket.booking_passenger_id,
                "supplier_id": ticket.supplier_id,
                "ticket_number": ticket.ticket_number,
                "fare_amount": ticket.fare_amount,
                "currency": ticket.currency,
            },
        )

        # Cascade booking status to ticketed
        connection.execute(
            text(
                """
                UPDATE public.bookings
                SET status = 'ticketed', updated_at = NOW()
                WHERE id = :booking_id
                """
            ),
            {"booking_id": booking_id},
        )

    return TicketRecord.model_validate({**created, "supplier_name": supplier["display_name"]})
# ============================================================================
# Ticket Sales
#
# A sale is one ticket sold to one traveller. The selling price sits on the
# ticket next to the supplier cost, so gross margin is a per-ticket figure.
# Booking totals are derived from the associated tickets and are never entered
# separately. A sale can be recorded before the airline issues the ticket; it
# is then 'pending' and is never counted as ticketed.
# ============================================================================

TicketSaleStatus = Literal["pending", "issued", "voided", "refunded", "exchanged"]

# A booking that is already ticketed, cancelled, expired, or closed is out of
# scope for recording new sales. Corrections to a ticketed booking go through
# the ticket change workflow, not through a new sale.
SALE_RECORDABLE_BOOKING_STATUSES = {
    "requested",
    "quoted",
    "confirmed",
    "ticketing_pending",
    "partially_ticketed",
}

MARGIN_BASIS_NOTE = (
    "Gross margin is the selling price less the supplier cost. It is only "
    "reported when both amounts are in the same currency and cover the same "
    "charges. Amounts in different currencies are never converted."
)


class CurrencyTotal(BaseModel):
    currency: str
    amount: Decimal


class TicketSaleCreate(BaseModel):
    booking_id: int = Field(gt=0)
    booking_passenger_id: int = Field(gt=0)
    supplier_id: int = Field(gt=0)
    ticket_number: str | None = Field(default=None, max_length=30)
    selling_price: Decimal | None = Field(
        default=None, ge=0, max_digits=18, decimal_places=4
    )
    selling_currency: str | None = Field(default=None, min_length=3, max_length=3)
    supplier_cost: Decimal | None = Field(
        default=None, ge=0, max_digits=18, decimal_places=4
    )
    supplier_cost_currency: str | None = Field(default=None, min_length=3, max_length=3)
    issue_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    verified: bool = False

    @field_validator(
        "ticket_number", "selling_currency", "supplier_cost_currency", mode="before"
    )
    @classmethod
    def normalize_optional_code(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper() or None
        return value

    @model_validator(mode="after")
    def check_sale_amounts(self) -> "TicketSaleCreate":
        if (self.selling_price is None) != (self.selling_currency is None):
            raise ValueError("Selling price and selling currency must be entered together.")
        if (self.supplier_cost is None) != (self.supplier_cost_currency is None):
            raise ValueError("Supplier cost and its currency must be entered together.")
        if self.ticket_number is not None and not self.verified:
            raise ValueError("A ticket number must be verified before it is recorded.")
        return self


class TicketSaleUpdate(BaseModel):
    ticket_number: str | None = Field(default=None, max_length=30)
    selling_price: Decimal | None = Field(
        default=None, ge=0, max_digits=18, decimal_places=4
    )
    selling_currency: str | None = Field(default=None, min_length=3, max_length=3)
    supplier_cost: Decimal | None = Field(
        default=None, ge=0, max_digits=18, decimal_places=4
    )
    supplier_cost_currency: str | None = Field(default=None, min_length=3, max_length=3)
    issue_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    verified: bool = False

    @field_validator(
        "ticket_number", "selling_currency", "supplier_cost_currency", mode="before"
    )
    @classmethod
    def normalize_optional_code(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper() or None
        return value

    @model_validator(mode="after")
    def check_sale_amounts(self) -> "TicketSaleUpdate":
        provided = self.model_fields_set
        if ("selling_price" in provided) != ("selling_currency" in provided):
            raise ValueError("Selling price and selling currency must be updated together.")
        if ("supplier_cost" in provided) != ("supplier_cost_currency" in provided):
            raise ValueError("Supplier cost and its currency must be updated together.")
        if (
            "ticket_number" in provided
            and self.ticket_number is not None
            and not self.verified
        ):
            raise ValueError("A ticket number must be verified before it is recorded.")
        return self


class TicketSaleRecord(BaseModel):
    id: int
    booking_id: int
    booking_code: str
    customer_id: int
    customer_name: str
    booking_passenger_id: int
    passenger_name: str
    supplier_id: int
    supplier_name: str
    ticket_number: str | None
    ticket_status: TicketSaleStatus
    issue_date: date | None
    selling_price: Decimal | None
    selling_currency: str | None
    supplier_cost: Decimal | None
    supplier_cost_currency: str | None
    gross_margin: Decimal | None
    margin_computable: bool
    notes: str | None
    created_at: datetime


class TicketSaleListResponse(BaseModel):
    items: list[TicketSaleRecord]
    total: int
    limit: int
    offset: int
    selling_total_by_currency: list[CurrencyTotal]
    supplier_cost_total_by_currency: list[CurrencyTotal]
    gross_margin_by_currency: list[CurrencyTotal]
    margin_basis: str = MARGIN_BASIS_NOTE


class TicketSaleBookingSummary(BaseModel):
    booking_id: int
    booking_code: str
    sale_count: int
    pending_count: int
    issued_count: int
    selling_total_by_currency: list[CurrencyTotal]
    supplier_cost_total_by_currency: list[CurrencyTotal]
    gross_margin_by_currency: list[CurrencyTotal]
    margin_basis: str = MARGIN_BASIS_NOTE


def sale_gross_margin(
    selling_price: Decimal | None,
    selling_currency: str | None,
    supplier_cost: Decimal | None,
    supplier_cost_currency: str | None,
) -> tuple[Decimal | None, bool]:
    """Gross margin for one sale, and whether it can be computed at all.

    Margin is only reported when both amounts are in the same currency.
    Different currencies are never converted implicitly, so a cross-currency
    sale reports no margin rather than a misleading one.
    """
    if selling_price is None or supplier_cost is None:
        return None, False
    if not selling_currency or not supplier_cost_currency:
        return None, False
    if selling_currency != supplier_cost_currency:
        return None, False
    return selling_price - supplier_cost, True


def _create_ticket_coupons(
    connection,
    ticket_id: int,
    segment_ids: list[int],
) -> None:
    for coupon_number, segment_id in enumerate(segment_ids, start=1):
        connection.execute(
            text(
                """
                INSERT INTO public.ticket_coupons (ticket_id, flight_segment_id, coupon_number)
                VALUES (:ticket_id, :flight_segment_id, :coupon_number)
                """
            ),
            {
                "ticket_id": ticket_id,
                "flight_segment_id": segment_id,
                "coupon_number": coupon_number,
            },
        )


def _advance_booking_after_issue(
    connection,
    booking_id: int,
    current_status: str,
    staff_id: int,
    branch_id: int,
) -> None:
    """Move a booking to partially ticketed or ticketed once a ticket exists."""
    passenger_counts = connection.execute(
        text(
            """
            SELECT
                COUNT(DISTINCT booking_passengers.id) AS passenger_count,
                COUNT(DISTINCT booking_passengers.id) FILTER (
                    WHERE tickets.ticket_status IN ('issued', 'exchanged')
                ) AS ticketed_passenger_count
            FROM public.booking_passengers AS booking_passengers
            LEFT JOIN public.tickets AS tickets
                ON tickets.booking_passenger_id = booking_passengers.id
            WHERE booking_passengers.booking_id = :booking_id
            """
        ),
        {"booking_id": booking_id},
    ).mappings().one()
    if passenger_counts["passenger_count"] == passenger_counts["ticketed_passenger_count"]:
        next_status = "ticketed"
    else:
        return
    if next_status == current_status:
        return
    connection.execute(
        text(
            """
            UPDATE public.bookings
            SET status = :status, updated_at = NOW()
            WHERE id = :booking_id
            """
        ),
        {"status": next_status, "booking_id": booking_id},
    )
    connection.execute(
        text(
            """
            INSERT INTO public.activity_logs
                (user_id, branch_id, action, entity_type, entity_id, details_json)
            VALUES (
                :user_id,
                :branch_id,
                'booking.status_changed',
                'booking',
                :booking_id,
                jsonb_build_object(
                    'from_status', CAST(:from_status AS text),
                    'to_status', CAST(:to_status AS text)
                )
            )
            """
        ),
        {
            "user_id": staff_id,
            "branch_id": branch_id,
            "booking_id": booking_id,
            "from_status": current_status,
            "to_status": next_status,
        },
    )


TICKET_SALE_SELECT = """
    SELECT
        tickets.id,
        tickets.booking_passenger_id,
        tickets.issued_by_supplier_id AS supplier_id,
        tickets.ticket_number,
        tickets.ticket_status,
        tickets.issue_date,
        tickets.selling_price,
        tickets.selling_currency,
        tickets.fare_amount AS supplier_cost,
        tickets.currency AS supplier_cost_currency,
        tickets.notes,
        tickets.created_at,
        bookings.id AS booking_id,
        bookings.booking_code,
        bookings.customer_id,
        customers.display_name AS customer_name,
        booking_passengers.first_name,
        booking_passengers.middle_name,
        booking_passengers.last_name,
        COALESCE(NULLIF(BTRIM(suppliers.trading_name), ''), suppliers.legal_name) AS supplier_name
    FROM public.tickets AS tickets
    JOIN public.booking_passengers AS booking_passengers
        ON booking_passengers.id = tickets.booking_passenger_id
    JOIN public.bookings AS bookings
        ON bookings.id = booking_passengers.booking_id
    JOIN public.customers AS customers
        ON customers.id = bookings.customer_id
    LEFT JOIN public.suppliers AS suppliers
        ON suppliers.id = tickets.issued_by_supplier_id
"""


def _ticket_sale_record(row) -> TicketSaleRecord:
    passenger_name = " ".join(
        part for part in (row["first_name"], row["middle_name"], row["last_name"]) if part
    )
    margin, computable = sale_gross_margin(
        row["selling_price"],
        row["selling_currency"],
        row["supplier_cost"],
        row["supplier_cost_currency"],
    )
    return TicketSaleRecord.model_validate(
        {
            **dict(row),
            "passenger_name": passenger_name,
            "gross_margin": margin,
            "margin_computable": computable,
        }
    )


@app.get("/api/ticket-sales", response_model=TicketSaleListResponse)
def list_ticket_sales(
    q: str = Query(default="", max_length=200),
    status: TicketSaleStatus | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    limit: int = Query(default=50, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    if start_date is not None:
        date_from = start_date
    if end_date is not None:
        date_to = end_date
    search = q.strip()
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status_code=422, detail="The start date must not be after the end date.")
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        params: dict[str, object] = {
            "branch_id": branch_id,
            "search": search,
            "search_pattern": f"%{search}%",
            "status": status,
            "date_from": date_from,
            "date_to": date_to,
            "limit": limit,
            "offset": offset,
        }
        filters = """
            bookings.branch_id = :branch_id
            AND (
                :search = ''
                OR customers.display_name ILIKE :search_pattern
                OR bookings.booking_code ILIKE :search_pattern
                OR bookings.external_pnr ILIKE :search_pattern
                OR tickets.ticket_number ILIKE :search_pattern
            )
            AND (
                CAST(:status AS text) IS NULL
                OR tickets.ticket_status = CAST(:status AS text)
            )
            AND (
                CAST(:date_from AS date) IS NULL
                OR DATE(COALESCE(tickets.issue_date, tickets.created_at)) >= CAST(:date_from AS date)
            )
            AND (
                CAST(:date_to AS date) IS NULL
                OR DATE(COALESCE(tickets.issue_date, tickets.created_at)) <= CAST(:date_to AS date)
            )
        """
        total = connection.execute(
            text(f"SELECT COUNT(*) FROM ({TICKET_SALE_SELECT} WHERE {filters}) AS sales"),
            params,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"""
                {TICKET_SALE_SELECT}
                WHERE {filters}
                ORDER BY tickets.created_at DESC, tickets.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        ).mappings().all()

        # Totals cover the whole filtered set, not just the page on screen.
        # Voided and refunded sales are excluded: they are not sales.
        active_filters = f"{filters}\n            AND tickets.ticket_status NOT IN ('voided', 'refunded')"
        selling_rows = connection.execute(
            text(
                f"""
                SELECT tickets.selling_currency AS currency, SUM(tickets.selling_price) AS amount
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                JOIN public.bookings AS bookings
                    ON bookings.id = booking_passengers.booking_id
                JOIN public.customers AS customers
                    ON customers.id = bookings.customer_id
                WHERE {active_filters}
                    AND tickets.selling_price IS NOT NULL
                GROUP BY tickets.selling_currency
                ORDER BY tickets.selling_currency
                """
            ),
            params,
        ).mappings().all()
        cost_rows = connection.execute(
            text(
                f"""
                SELECT tickets.currency AS currency, SUM(tickets.fare_amount) AS amount
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                JOIN public.bookings AS bookings
                    ON bookings.id = booking_passengers.booking_id
                JOIN public.customers AS customers
                    ON customers.id = bookings.customer_id
                WHERE {active_filters}
                    AND tickets.fare_amount IS NOT NULL
                GROUP BY tickets.currency
                ORDER BY tickets.currency
                """
            ),
            params,
        ).mappings().all()
        margin_rows = connection.execute(
            text(
                f"""
                SELECT tickets.selling_currency AS currency,
                       SUM(tickets.selling_price - tickets.fare_amount) AS amount
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                JOIN public.bookings AS bookings
                    ON bookings.id = booking_passengers.booking_id
                JOIN public.customers AS customers
                    ON customers.id = bookings.customer_id
                WHERE {active_filters}
                    AND tickets.selling_price IS NOT NULL
                    AND tickets.fare_amount IS NOT NULL
                    AND tickets.selling_currency = tickets.currency
                GROUP BY tickets.selling_currency
                ORDER BY tickets.selling_currency
                """
            ),
            params,
        ).mappings().all()
    return TicketSaleListResponse(
        items=[_ticket_sale_record(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
        selling_total_by_currency=[
            CurrencyTotal(currency=row["currency"], amount=row["amount"])
            for row in selling_rows
        ],
        supplier_cost_total_by_currency=[
            CurrencyTotal(currency=row["currency"], amount=row["amount"])
            for row in cost_rows
        ],
        gross_margin_by_currency=[
            CurrencyTotal(currency=row["currency"], amount=row["amount"])
            for row in margin_rows
        ],
    )


@app.post("/api/ticket-sales", response_model=TicketSaleRecord, status_code=201)
def create_ticket_sale(
    sale: TicketSaleCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        booking = connection.execute(
            text(
                """
                SELECT id, status
                FROM public.bookings
                WHERE id = :booking_id AND branch_id = :branch_id
                FOR UPDATE
                """
            ),
            {"booking_id": sale.booking_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found.")
        if booking["status"] not in SALE_RECORDABLE_BOOKING_STATUSES:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"A sale cannot be recorded while the booking is {booking['status']}."
                ),
            )

        passenger = connection.execute(
            text(
                """
                SELECT id, first_name, middle_name, last_name
                FROM public.booking_passengers
                WHERE id = :passenger_id AND booking_id = :booking_id
                """
            ),
            {"passenger_id": sale.booking_passenger_id, "booking_id": sale.booking_id},
        ).mappings().one_or_none()
        if passenger is None:
            raise HTTPException(status_code=404, detail="Traveler not found on this booking.")

        supplier = connection.execute(
            text(
                """
                SELECT id, COALESCE(NULLIF(BTRIM(trading_name), ''), legal_name) AS display_name
                FROM public.suppliers
                WHERE id = :supplier_id
                    AND is_active = TRUE
                    AND supplier_type IN ('airline', 'consolidator', 'host_agency')
                """
            ),
            {"supplier_id": sale.supplier_id},
        ).mappings().one_or_none()
        if supplier is None:
            raise HTTPException(
                status_code=422,
                detail="Select an active airline, consolidator, or host agency.",
            )

        segment_ids = connection.execute(
            text(
                """
                SELECT id
                FROM public.flight_segments
                WHERE booking_id = :booking_id
                ORDER BY segment_order
                """
            ),
            {"booking_id": sale.booking_id},
        ).scalars().all()
        if not segment_ids:
            raise HTTPException(
                status_code=409, detail="Add the flight itinerary before recording a sale."
            )

        existing_ticket = connection.execute(
            text(
                """
                SELECT id, ticket_status
                FROM public.tickets
                WHERE booking_passenger_id = :passenger_id
                    AND ticket_status IN ('issued', 'exchanged', 'pending')
                LIMIT 1
                """
            ),
            {"passenger_id": sale.booking_passenger_id},
        ).mappings().one_or_none()
        if existing_ticket is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This traveler already has a sale recorded. Update the existing sale "
                    "instead of recording a second one."
                ),
            )

        is_issued = sale.ticket_number is not None
        issue_date = sale.issue_date
        if is_issued and issue_date is None:
            issue_date = date.today()

        created = connection.execute(
            text(
                """
                INSERT INTO public.tickets (
                    booking_passenger_id,
                    issued_by_supplier_id,
                    ticket_number,
                    ticket_status,
                    issued_at,
                    issue_date,
                    fare_amount,
                    currency,
                    selling_price,
                    selling_currency,
                    notes,
                    verified_at,
                    verified_by
                )
                VALUES (
                    :passenger_id,
                    :supplier_id,
                    :ticket_number,
                    :ticket_status,
                    CASE WHEN :is_issued THEN NOW() ELSE NULL END,
                    :issue_date,
                    :supplier_cost,
                    :supplier_cost_currency,
                    :selling_price,
                    :selling_currency,
                    :notes,
                    CASE WHEN :is_issued THEN NOW() ELSE NULL END,
                    CASE WHEN :is_issued THEN :verified_by ELSE NULL END
                )
                RETURNING id
                """
            ),
            {
                "passenger_id": sale.booking_passenger_id,
                "supplier_id": sale.supplier_id,
                "ticket_number": sale.ticket_number,
                "ticket_status": "issued" if is_issued else "pending",
                "is_issued": is_issued,
                "issue_date": issue_date,
                "supplier_cost": sale.supplier_cost,
                "supplier_cost_currency": sale.supplier_cost_currency,
                "selling_price": sale.selling_price,
                "selling_currency": sale.selling_currency,
                "notes": sale.notes,
                "verified_by": staff_id,
            },
        ).mappings().one()

        if is_issued:
            _create_ticket_coupons(connection, created["id"], list(segment_ids))
            _advance_booking_after_issue(
                connection, sale.booking_id, booking["status"], staff_id, branch_id
            )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id,
                    :branch_id,
                    'ticket_sale.recorded',
                    'ticket_sale',
                    :sale_id,
                    jsonb_build_object(
                        'booking_id', CAST(:booking_id AS bigint),
                        'booking_passenger_id', CAST(:passenger_id AS bigint),
                        'supplier_id', CAST(:supplier_id AS bigint),
                        'ticket_status', CAST(:ticket_status AS text),
                        'selling_price', CAST(:selling_price AS text),
                        'selling_currency', CAST(:selling_currency AS text),
                        'supplier_cost', CAST(:supplier_cost AS text),
                        'supplier_cost_currency', CAST(:supplier_cost_currency AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "sale_id": created["id"],
                "booking_id": sale.booking_id,
                "passenger_id": sale.booking_passenger_id,
                "supplier_id": sale.supplier_id,
                "ticket_status": "issued" if is_issued else "pending",
                "selling_price": sale.selling_price,
                "selling_currency": sale.selling_currency,
                "supplier_cost": sale.supplier_cost,
                "supplier_cost_currency": sale.supplier_cost_currency,
            },
        )

        row = connection.execute(
            text(f"{TICKET_SALE_SELECT} WHERE tickets.id = :sale_id"),
            {"sale_id": created["id"]},
        ).mappings().one()
    return _ticket_sale_record(row)


@app.patch("/api/ticket-sales/{sale_id}", response_model=TicketSaleRecord)
def update_ticket_sale(
    sale_id: int,
    update: TicketSaleUpdate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    provided = update.model_fields_set
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        sale = connection.execute(
            text(
                """
                SELECT
                    tickets.id,
                    tickets.ticket_status,
                    tickets.ticket_number,
                    tickets.booking_passenger_id,
                    bookings.id AS booking_id,
                    bookings.status AS booking_status
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                JOIN public.bookings AS bookings
                    ON bookings.id = booking_passengers.booking_id
                WHERE tickets.id = :sale_id AND bookings.branch_id = :branch_id
                FOR UPDATE OF tickets
                """
            ),
            {"sale_id": sale_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if sale is None:
            raise HTTPException(status_code=404, detail="Sale not found in your branch.")

        if sale["ticket_status"] in {"voided", "refunded"}:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"A {sale['ticket_status']} sale cannot be edited. Record a refund or "
                    "an adjustment instead."
                ),
            )

        is_issuing = "ticket_number" in provided and update.ticket_number is not None
        if is_issuing and sale["ticket_status"] == "issued":
            raise HTTPException(
                status_code=409, detail="This sale has already been issued."
            )

        selling_price = update.selling_price if "selling_price" in provided else None
        selling_currency = update.selling_currency if "selling_currency" in provided else None
        supplier_cost = update.supplier_cost if "supplier_cost" in provided else None
        supplier_cost_currency = (
            update.supplier_cost_currency if "supplier_cost_currency" in provided else None
        )
        if "selling_price" not in provided:
            existing = connection.execute(
                text("SELECT selling_price, selling_currency FROM public.tickets WHERE id = :id"),
                {"id": sale_id},
            ).mappings().one()
            selling_price = existing["selling_price"]
            selling_currency = existing["selling_currency"]
        if "supplier_cost" not in provided:
            existing = connection.execute(
                text("SELECT fare_amount, currency FROM public.tickets WHERE id = :id"),
                {"id": sale_id},
            ).mappings().one()
            supplier_cost = existing["fare_amount"]
            supplier_cost_currency = existing["currency"]
        if (selling_price is None) != (selling_currency is None):
            raise HTTPException(
                status_code=409,
                detail="Selling price and selling currency must be entered together.",
            )
        if (supplier_cost is None) != (supplier_cost_currency is None):
            raise HTTPException(
                status_code=409,
                detail="Supplier cost and its currency must be entered together.",
            )

        issue_date = update.issue_date if "issue_date" in provided else None
        if is_issuing:
            if issue_date is None:
                issue_date = date.today()
        elif "issue_date" not in provided:
            existing = connection.execute(
                text("SELECT issue_date FROM public.tickets WHERE id = :id"),
                {"id": sale_id},
            ).mappings().one()
            issue_date = existing["issue_date"]

        if is_issuing:
            segment_ids = connection.execute(
                text(
                    """
                    SELECT id FROM public.flight_segments
                    WHERE booking_id = :booking_id ORDER BY segment_order
                    """
                ),
                {"booking_id": sale["booking_id"]},
            ).scalars().all()
            if not segment_ids:
                raise HTTPException(
                    status_code=409,
                    detail="Add the flight itinerary before issuing this sale.",
                )
            duplicate = connection.execute(
                text(
                    """
                    SELECT id FROM public.tickets
                    WHERE issued_by_supplier_id = (
                            SELECT issued_by_supplier_id FROM public.tickets WHERE id = :id
                        )
                        AND ticket_number = :ticket_number
                        AND id <> :id
                    """
                ),
                {"id": sale_id, "ticket_number": update.ticket_number},
            ).scalar_one_or_none()
            if duplicate is not None:
                raise HTTPException(
                    status_code=409,
                    detail="That ticket number is already recorded for this supplier.",
                )

        connection.execute(
            text(
                """
                UPDATE public.tickets
                SET
                    ticket_number = COALESCE(:ticket_number, ticket_number),
                    ticket_status = CASE WHEN :is_issuing THEN 'issued' ELSE ticket_status END,
                    issued_at = CASE WHEN :is_issuing THEN NOW() ELSE issued_at END,
                    verified_at = CASE WHEN :is_issuing THEN NOW() ELSE verified_at END,
                    verified_by = CASE WHEN :is_issuing THEN :verified_by ELSE verified_by END,
                    issue_date = COALESCE(:issue_date, issue_date),
                    selling_price = :selling_price,
                    selling_currency = :selling_currency,
                    fare_amount = :supplier_cost,
                    currency = :supplier_cost_currency,
                    notes = COALESCE(:notes, notes)
                WHERE id = :sale_id
                """
            ),
            {
                "sale_id": sale_id,
                "ticket_number": update.ticket_number if is_issuing else None,
                "is_issuing": is_issuing,
                "verified_by": staff_id,
                "issue_date": issue_date,
                "selling_price": selling_price,
                "selling_currency": selling_currency,
                "supplier_cost": supplier_cost,
                "supplier_cost_currency": supplier_cost_currency,
                "notes": update.notes if "notes" in provided else None,
            },
        )

        if is_issuing:
            _create_ticket_coupons(connection, sale_id, list(segment_ids))
            _advance_booking_after_issue(
                connection, sale["booking_id"], sale["booking_status"], staff_id, branch_id
            )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id,
                    :branch_id,
                    :action,
                    'ticket_sale',
                    :sale_id,
                    jsonb_build_object(
                        'booking_id', CAST(:booking_id AS bigint),
                        'ticket_status', CAST(:ticket_status AS text),
                        'selling_price', CAST(:selling_price AS text),
                        'selling_currency', CAST(:selling_currency AS text),
                        'supplier_cost', CAST(:supplier_cost AS text),
                        'supplier_cost_currency', CAST(:supplier_cost_currency AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "action": "ticket_sale.issued" if is_issuing else "ticket_sale.updated",
                "sale_id": sale_id,
                "booking_id": sale["booking_id"],
                "ticket_status": "issued" if is_issuing else sale["ticket_status"],
                "selling_price": selling_price,
                "selling_currency": selling_currency,
                "supplier_cost": supplier_cost,
                "supplier_cost_currency": supplier_cost_currency,
            },
        )

        row = connection.execute(
            text(f"{TICKET_SALE_SELECT} WHERE tickets.id = :sale_id"),
            {"sale_id": sale_id},
        ).mappings().one()
    return _ticket_sale_record(row)


@app.delete("/api/ticket-sales/{sale_id}", status_code=204)
def delete_ticket_sale(
    sale_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        row = connection.execute(
            text(
                """
                SELECT t.id, t.ticket_status, b.branch_id
                FROM public.tickets AS t
                JOIN public.booking_passengers AS bp ON bp.id = t.booking_passenger_id
                JOIN public.bookings AS b ON b.id = bp.booking_id
                WHERE t.id = :sale_id AND b.branch_id = :branch_id
                FOR UPDATE
                """
            ),
            {"sale_id": sale_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="Ticket sale not found.")
        if row["ticket_status"] != "pending":
            raise HTTPException(status_code=409, detail="Only unissued pending sales can be deleted.")
        connection.execute(text("DELETE FROM public.ticket_coupons WHERE ticket_id = :id"), {"id": sale_id})
        connection.execute(text("DELETE FROM public.tickets WHERE id = :id"), {"id": sale_id})
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (:user_id, :branch_id, 'ticket_sale.deleted', 'ticket_sale', :sale_id, jsonb_build_object('ticket_status', 'pending'))
                """
            ),
            {"user_id": staff_id, "branch_id": branch_id, "sale_id": sale_id},
        )


@app.get(
    "/api/bookings/{booking_id}/sale-summary",
    response_model=TicketSaleBookingSummary,
)
def booking_sale_summary(
    booking_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        booking = connection.execute(
            text(
                """
                SELECT id, booking_code
                FROM public.bookings
                WHERE id = :booking_id AND branch_id = :branch_id
                """
            ),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found.")

        counts = connection.execute(
            text(
                """
                SELECT
                    COUNT(*) AS sale_count,
                    COUNT(*) FILTER (WHERE tickets.ticket_status = 'pending') AS pending_count,
                    COUNT(*) FILTER (
                        WHERE tickets.ticket_status IN ('issued', 'exchanged')
                    ) AS issued_count
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                WHERE booking_passengers.booking_id = :booking_id
                """
            ),
            {"booking_id": booking_id},
        ).mappings().one()

        selling_rows = connection.execute(
            text(
                """
                SELECT tickets.selling_currency AS currency, SUM(tickets.selling_price) AS amount
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                WHERE booking_passengers.booking_id = :booking_id
                    AND tickets.selling_price IS NOT NULL
                    AND tickets.ticket_status NOT IN ('voided', 'refunded')
                GROUP BY tickets.selling_currency
                ORDER BY tickets.selling_currency
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()

        cost_rows = connection.execute(
            text(
                """
                SELECT tickets.currency AS currency, SUM(tickets.fare_amount) AS amount
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                WHERE booking_passengers.booking_id = :booking_id
                    AND tickets.fare_amount IS NOT NULL
                    AND tickets.ticket_status NOT IN ('voided', 'refunded')
                GROUP BY tickets.currency
                ORDER BY tickets.currency
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()

        margin_rows = connection.execute(
            text(
                """
                SELECT tickets.selling_currency AS currency,
                       SUM(tickets.selling_price - tickets.fare_amount) AS amount
                FROM public.tickets AS tickets
                JOIN public.booking_passengers AS booking_passengers
                    ON booking_passengers.id = tickets.booking_passenger_id
                WHERE booking_passengers.booking_id = :booking_id
                    AND tickets.selling_price IS NOT NULL
                    AND tickets.fare_amount IS NOT NULL
                    AND tickets.selling_currency = tickets.currency
                    AND tickets.ticket_status NOT IN ('voided', 'refunded')
                GROUP BY tickets.selling_currency
                ORDER BY tickets.selling_currency
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()

    return TicketSaleBookingSummary(
        booking_id=booking["id"],
        booking_code=booking["booking_code"],
        sale_count=counts["sale_count"],
        pending_count=counts["pending_count"],
        issued_count=counts["issued_count"],
        selling_total_by_currency=[
            CurrencyTotal(currency=row["currency"], amount=row["amount"])
            for row in selling_rows
        ],
        supplier_cost_total_by_currency=[
            CurrencyTotal(currency=row["currency"], amount=row["amount"])
            for row in cost_rows
        ],
        gross_margin_by_currency=[
            CurrencyTotal(currency=row["currency"], amount=row["amount"])
            for row in margin_rows
        ],
    )


@app.post(
    "/api/bookings/{booking_id}/passengers",
    response_model=BookingPassengerRecord,
    status_code=201,
)
def add_booking_passenger(
    booking_id: int,
    passenger: BookingPassengerCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        lock_editable_booking(connection, booking_id, branch_id)
        row = connection.execute(
            text(
                """
                INSERT INTO public.booking_passengers
                    (booking_id, passenger_type, first_name, middle_name, last_name)
                VALUES
                    (:booking_id, :passenger_type, :first_name, :middle_name, :last_name)
                RETURNING id, passenger_type, first_name, middle_name, last_name, created_at
                """
            ),
            {**passenger.model_dump(), "booking_id": booking_id},
        ).mappings().one()
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES
                    (:user_id, :branch_id, 'booking.passenger_added', 'booking', :booking_id,
                     jsonb_build_object(
                         'passenger_id', CAST(:passenger_id AS bigint),
                         'passenger_type', CAST(:passenger_type AS text)
                     ))
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "booking_id": booking_id,
                "passenger_id": row["id"],
                "passenger_type": row["passenger_type"],
            },
        )

    return BookingPassengerRecord.model_validate(row)


@app.post(
    "/api/bookings/{booking_id}/segments",
    response_model=FlightSegmentRecord,
    status_code=201,
)
def add_flight_segment(
    booking_id: int,
    segment: FlightSegmentCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        lock_editable_booking(connection, booking_id, branch_id)
        last_order = connection.execute(
            text(
                """
                SELECT COALESCE(MAX(segment_order), 0)
                FROM public.flight_segments
                WHERE booking_id = :booking_id
                """
            ),
            {"booking_id": booking_id},
        ).scalar_one()
        if last_order >= 32767:
            raise HTTPException(status_code=409, detail="This booking already has the maximum number of flight segments.")
        segment_order = last_order + 1
        row = connection.execute(
            text(
                """
                INSERT INTO public.flight_segments (
                    booking_id, segment_order, marketing_carrier, flight_number,
                    origin_airport, destination_airport, departure_at, arrival_at,
                    booking_class, cabin
                )
                VALUES (
                    :booking_id, :segment_order, :marketing_carrier, :flight_number,
                    :origin_airport, :destination_airport, :departure_at, :arrival_at,
                    :booking_class, :cabin
                )
                RETURNING id, segment_order, marketing_carrier, flight_number,
                    origin_airport, destination_airport, departure_at, arrival_at,
                    booking_class, cabin, segment_status
                """
            ),
            {
                **segment.model_dump(),
                "booking_id": booking_id,
                "segment_order": segment_order,
            },
        ).mappings().one()
        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES
                    (:user_id, :branch_id, 'booking.segment_added', 'booking', :booking_id,
                     jsonb_build_object(
                        'segment_id', CAST(:segment_id AS bigint),
                        'segment_order', CAST(:segment_order AS integer),
                        'origin_airport', CAST(:origin_airport AS text),
                        'destination_airport', CAST(:destination_airport AS text)
                     ))
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "booking_id": booking_id,
                "segment_id": row["id"],
                "segment_order": segment_order,
                "origin_airport": row["origin_airport"],
                "destination_airport": row["destination_airport"],
            },
        )

    return FlightSegmentRecord.model_validate(row)


@app.get(
    "/api/bookings/{booking_id}/history",
    response_model=list[BookingStatusHistoryEntry],
)
def booking_status_history(
    booking_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        booking = connection.execute(
            text(
                """
                SELECT id
                FROM public.bookings
                WHERE id = :booking_id AND branch_id = :branch_id
                """
            ),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).scalar_one_or_none()
        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found.")

        rows = connection.execute(
            text(
                """
                SELECT
                    activity_logs.details_json ->> 'from_status' AS from_status,
                    activity_logs.details_json ->> 'to_status' AS to_status,
                    users.full_name AS changed_by,
                    activity_logs.created_at AS changed_at
                FROM public.activity_logs AS activity_logs
                LEFT JOIN public.users AS users ON users.id = activity_logs.user_id
                WHERE activity_logs.entity_type = 'booking'
                    AND activity_logs.entity_id = :booking_id
                    AND activity_logs.action IN ('booking.created', 'booking.status_changed')
                ORDER BY activity_logs.created_at DESC, activity_logs.id DESC
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()

    return [BookingStatusHistoryEntry.model_validate(row) for row in rows]


@app.patch("/api/bookings/{booking_id}/status", response_model=BookingRecord)
def update_booking_status(
    booking_id: int,
    update: BookingStatusUpdate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        booking = connection.execute(
            text(
                """
                SELECT
                    bookings.id,
                    bookings.booking_code,
                    bookings.branch_id,
                    bookings.customer_id,
                    customers.display_name AS customer_name,
                    bookings.status,
                    bookings.booking_channel,
                    bookings.external_pnr,
                    bookings.reservation_system,
                    bookings.customer_notes,
                    bookings.created_at
                FROM public.bookings AS bookings
                JOIN public.customers AS customers ON customers.id = bookings.customer_id
                WHERE bookings.id = :booking_id AND bookings.branch_id = :branch_id
                FOR UPDATE OF bookings
                """
            ),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).mappings().one_or_none()

        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found.")

        previous_status = booking["status"]
        next_status = update.status
        if next_status not in BOOKING_STATUS_TRANSITIONS[previous_status]:
            allowed = sorted(BOOKING_STATUS_TRANSITIONS[previous_status])
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Booking status cannot change from {previous_status} to {next_status}."
                    if not allowed
                    else f"Booking status cannot change from {previous_status} to {next_status}. "
                    f"Allowed next statuses: {', '.join(allowed)}."
                ),
            )

        if next_status in {"partially_ticketed", "ticketed"}:
            passenger_counts = connection.execute(
                text(
                    """
                    SELECT
                        COUNT(DISTINCT booking_passengers.id) AS passenger_count,
                        COUNT(DISTINCT booking_passengers.id) FILTER (
                            WHERE tickets.ticket_status IN ('issued', 'exchanged')
                        ) AS ticketed_passenger_count
                    FROM public.booking_passengers AS booking_passengers
                    LEFT JOIN public.tickets AS tickets
                        ON tickets.booking_passenger_id = booking_passengers.id
                    WHERE booking_passengers.booking_id = :booking_id
                    """
                ),
                {"booking_id": booking_id},
            ).mappings().one()
            passenger_count = passenger_counts["passenger_count"]
            ticketed_count = passenger_counts["ticketed_passenger_count"]

            if next_status == "partially_ticketed" and not 0 < ticketed_count < passenger_count:
                raise HTTPException(
                    status_code=409,
                    detail="Partial ticketing requires issued tickets for some, but not all, booking passengers.",
                )
            if next_status == "ticketed" and not 0 < passenger_count == ticketed_count:
                raise HTTPException(
                    status_code=409,
                    detail="Ticketed status requires an issued or exchanged ticket for every booking passenger.",
                )

        updated = connection.execute(
            text(
                """
                UPDATE public.bookings
                SET status = :status, updated_at = NOW()
                WHERE id = :booking_id AND branch_id = :branch_id
                RETURNING status
                """
            ),
            {
                "status": next_status,
                "booking_id": booking_id,
                "branch_id": branch_id,
            },
        ).mappings().one()

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES
                    (
                        :user_id,
                        :branch_id,
                        'booking.status_changed',
                        'booking',
                        :booking_id,
                        jsonb_build_object(
                            'from_status', CAST(:from_status AS text),
                            'to_status', CAST(:to_status AS text)
                        )
                    )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "booking_id": booking_id,
                "from_status": previous_status,
                "to_status": next_status,
            },
        )

    return BookingRecord.model_validate({**booking, "status": updated["status"]})


# ============================================================================
# Customer Payments & Allocations
# ============================================================================

PaymentMethod = Literal["cash", "bank_transfer", "mobile_money", "card_gateway", "cheque", "other"]
PaymentStatus = Literal["pending", "confirmed", "voided"]


class PaymentCreate(BaseModel):
    customer_id: int = Field(gt=0)
    booking_id: int | None = Field(default=None, gt=0)
    currency: str = Field(min_length=3, max_length=3)
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    payment_method: PaymentMethod = "cash"
    status: PaymentStatus = "confirmed"
    received_at: datetime | None = None
    external_reference: str | None = Field(default=None, max_length=120)
    receipt_number: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_payment_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("currency")
    @classmethod
    def validate_payment_currency(cls, value: str) -> str:
        if not value.isascii() or not value.isalpha():
            raise ValueError("Currency must be a three-letter code")
        return value

    @field_validator("external_reference", "receipt_number", "notes", mode="before")
    @classmethod
    def normalize_optional_payment_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class PaymentRecord(BaseModel):
    id: int
    customer_id: int
    customer_name: str
    currency: str
    amount: Decimal
    payment_method: PaymentMethod
    status: PaymentStatus
    received_at: datetime | None
    external_reference: str | None
    receipt_number: str | None
    notes: str | None
    received_by: int | None
    created_at: datetime
    allocated_total: Decimal
    unallocated_total: Decimal


class PaymentAllocationCreate(BaseModel):
    invoice_id: int = Field(gt=0)
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=4)


class PaymentAllocationRecord(BaseModel):
    id: int
    payment_id: int
    invoice_id: int
    invoice_number: str
    amount: Decimal
    allocated_at: datetime


class PaymentListResponse(BaseModel):
    items: list[PaymentRecord]
    total: int
    limit: int
    offset: int


def recalc_invoice_status(connection, invoice_id: int) -> str:
    invoice = connection.execute(
        text("SELECT grand_total, status FROM public.invoices WHERE id = :invoice_id"),
        {"invoice_id": invoice_id},
    ).mappings().one()
    total_allocated = connection.execute(
        text("SELECT COALESCE(SUM(amount), 0) FROM public.payment_allocations WHERE invoice_id = :invoice_id"),
        {"invoice_id": invoice_id},
    ).scalar_one() or Decimal("0")
    grand_total = invoice["grand_total"] or Decimal("0")
    current_status = invoice["status"]
    if current_status not in ("issued", "partially_paid"):
        return current_status
    if grand_total > 0 and total_allocated >= grand_total:
        return "paid"
    if total_allocated > 0:
        return "partially_paid"
    return "issued"


def payment_query_filters(search: str, branch_id: int) -> tuple[str, dict[str, object]]:
    filters = """
        customer_payments.branch_id = :branch_id
    """
    params: dict[str, object] = {
        "branch_id": branch_id,
        "search": search,
        "search_pattern": f"%{search}%",
    }
    if search:
        filters += """
            AND (
                customers.display_name ILIKE :search_pattern
                OR customer_payments.receipt_number ILIKE :search_pattern
                OR customer_payments.external_reference ILIKE :search_pattern
            )
        """
    return filters, params


@app.get("/api/payments", response_model=PaymentListResponse)
def list_payments(
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    search = q.strip()
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        filters, params = payment_query_filters(search, branch_id)
        total = connection.execute(
            text(
                f"""
                SELECT COUNT(*)
                FROM public.customer_payments AS customer_payments
                JOIN public.customers AS customers ON customers.id = customer_payments.customer_id
                WHERE {filters}
                """
            ),
            params,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"""
                SELECT
                    customer_payments.id,
                    customer_payments.customer_id,
                    customers.display_name AS customer_name,
                    customer_payments.currency,
                    customer_payments.amount,
                    customer_payments.payment_method,
                    customer_payments.status,
                    customer_payments.received_at,
                    customer_payments.external_reference,
                    customer_payments.receipt_number,
                    customer_payments.notes,
                    customer_payments.received_by,
                    customer_payments.created_at,
                    COALESCE((
                        SELECT SUM(allocations.amount)
                        FROM public.payment_allocations AS allocations
                        WHERE allocations.payment_id = customer_payments.id
                    ), 0) AS allocated_total
                FROM public.customer_payments AS customer_payments
                JOIN public.customers AS customers ON customers.id = customer_payments.customer_id
                WHERE {filters}
                ORDER BY customer_payments.received_at DESC NULLS LAST, customer_payments.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {**params, "limit": limit, "offset": offset},
        ).mappings().all()

    items = []
    for row in rows:
        allocated = row["allocated_total"] or Decimal("0")
        items.append(PaymentRecord(
            **{k: row[k] for k in [
                "id", "customer_id", "customer_name", "currency", "amount",
                "payment_method", "status", "received_at", "external_reference",
                "receipt_number", "notes", "received_by", "created_at",
            ]},
            allocated_total=allocated,
            unallocated_total=(row["amount"] - allocated),
        ))

    return PaymentListResponse(items=items, total=total, limit=limit, offset=offset)


@app.post("/api/payments", response_model=PaymentRecord, status_code=201)
def create_payment(
    payment: PaymentCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_cash_staff(connection, user.id)
        customer = connection.execute(
            text("SELECT id, display_name FROM public.customers WHERE id = :customer_id"),
            {"customer_id": payment.customer_id},
        ).mappings().one_or_none()
        if customer is None:
            raise HTTPException(status_code=404, detail="The selected customer was not found.")

        received_at = payment.received_at
        if received_at is None:
            received_at = connection.execute(text("SELECT NOW()")).scalar_one()

        row = connection.execute(
            text(
                """
                INSERT INTO public.customer_payments (
                    customer_id, branch_id, currency, amount, payment_method, status,
                    received_at, external_reference, receipt_number, notes, received_by
                )
                VALUES (
                    :customer_id, :branch_id, :currency, :amount, :payment_method, :status,
                    :received_at, :external_reference, :receipt_number, :notes, :received_by
                )
                RETURNING
                    id, customer_id, currency, amount, payment_method, status,
                    received_at, external_reference, receipt_number, notes,
                    received_by, created_at
                """
            ),
            {
                "customer_id": payment.customer_id,
                "branch_id": branch_id,
                "currency": payment.currency,
                "amount": payment.amount,
                "payment_method": payment.payment_method,
                "status": payment.status,
                "received_at": received_at,
                "external_reference": payment.external_reference,
                "receipt_number": payment.receipt_number,
                "notes": payment.notes,
                "received_by": staff_id,
            },
        ).mappings().one()

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'payment.recorded', 'payment', :payment_id,
                    jsonb_build_object(
                        'customer_id', CAST(:customer_id AS bigint),
                        'currency', CAST(:currency AS text),
                        'amount', CAST(:amount AS text),
                        'payment_method', CAST(:payment_method AS text),
                        'receipt_number', CAST(:receipt_number AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "payment_id": row["id"],
                "customer_id": payment.customer_id,
                "currency": payment.currency,
                "amount": payment.amount,
                "payment_method": payment.payment_method,
                "receipt_number": payment.receipt_number,
            },
        )

        # Unified Outstanding Query: Prioritizes booking_id invoices first, then FIFO
        outstanding = connection.execute(
            text(
                """
                SELECT i.id, i.grand_total, i.status,
                       COALESCE((SELECT SUM(pa.amount) FROM public.payment_allocations pa WHERE pa.invoice_id = i.id), 0) AS allocated
                FROM public.invoices i
                WHERE i.customer_id = :customer_id
                  AND i.currency = :currency
                  AND i.status IN ('draft', 'issued', 'partially_paid')
                ORDER BY 
                    CASE WHEN CAST(:booking_id AS INTEGER) IS NOT NULL AND i.booking_id = CAST(:booking_id AS INTEGER) THEN 0 ELSE 1 END ASC,
                    i.issue_date ASC, i.id ASC
                """
            ).bindparams(
                bindparam("customer_id", type_=Integer),
                bindparam("currency", type_=String),
                bindparam("booking_id", type_=Integer),
            ),
            {
                "customer_id": payment.customer_id,
                "currency": payment.currency,
                "booking_id": payment.booking_id,
            },
        ).mappings().all()

        remaining = payment.amount
        total_allocated = Decimal("0")

        for inv in outstanding:
            if remaining <= 0:
                break
            
            balance = inv["grand_total"] - inv["allocated"]
            if balance <= 0:
                continue
            
            alloc_amount = min(balance, remaining)

            # Ensure draft invoices transition to issued when paid/allocated
            if inv["status"] == 'draft':
                connection.execute(
                    text("UPDATE public.invoices SET status = 'issued' WHERE id = :id"),
                    {"id": inv["id"]},
                )

            connection.execute(
                text(
                    """
                    INSERT INTO public.payment_allocations (payment_id, invoice_id, amount)
                    VALUES (:payment_id, :invoice_id, :amount)
                    """
                ),
                {"payment_id": row["id"], "invoice_id": inv["id"], "amount": alloc_amount},
            )

            new_allocated = inv["allocated"] + alloc_amount
            new_status = "paid" if new_allocated >= inv["grand_total"] else "partially_paid"
            
            connection.execute(
                text("UPDATE public.invoices SET status = :status WHERE id = :id"),
                {"status": new_status, "id": inv["id"]},
            )
            
            total_allocated += alloc_amount
            remaining -= alloc_amount

        unallocated_total = payment.amount - total_allocated

    return PaymentRecord(
        **{k: row[k] for k in [
            "id", "customer_id", "currency", "amount", "payment_method", "status",
            "received_at", "external_reference", "receipt_number", "notes",
            "received_by", "created_at",
        ]},
        customer_name=customer["display_name"],
        allocated_total=total_allocated,
        unallocated_total=unallocated_total,
    )

@app.post("/api/payments/{payment_id}/allocations", response_model=PaymentAllocationRecord, status_code=201)
def allocate_payment_to_invoice(
    payment_id: int,
    allocation: PaymentAllocationCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_cash_staff(connection, user.id)
        payment = connection.execute(
            text(
                """
                SELECT id, customer_id, branch_id, currency, amount, status
                FROM public.customer_payments
                WHERE id = :payment_id
                FOR UPDATE
                """
            ),
            {"payment_id": payment_id},
        ).mappings().one_or_none()
        if payment is None:
            raise HTTPException(status_code=404, detail="Payment not found.")
        if payment["branch_id"] is not None and payment["branch_id"] != branch_id:
            raise HTTPException(status_code=404, detail="Payment not found in your branch.")
        if payment["status"] == "voided":
            raise HTTPException(status_code=409, detail="Cannot allocate a voided payment.")

        invoice = connection.execute(
            text(
                """
                SELECT
                    invoices.id, invoices.invoice_number, invoices.currency, invoices.grand_total,
                    invoices.status, bookings.branch_id
                FROM public.invoices AS invoices
                JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
                WHERE invoices.id = :invoice_id AND bookings.branch_id = :branch_id
                FOR UPDATE OF invoices
                """
            ),
            {"invoice_id": allocation.invoice_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Invoice not found in your branch.")
        if invoice["currency"] != payment["currency"]:
            raise HTTPException(
                status_code=409,
                detail="Payment and invoice currencies must match.",
            )
        if invoice["status"] not in ("issued", "partially_paid"):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Only issued invoices can receive a payment. This invoice is {invoice['status']}."
                ),
            )

        allocated_total = connection.execute(
            text("SELECT COALESCE(SUM(amount), 0) FROM public.payment_allocations WHERE invoice_id = :invoice_id"),
            {"invoice_id": allocation.invoice_id},
        ).scalar_one() or Decimal("0")
        invoice_balance = invoice["grand_total"] - allocated_total
        payment_allocated = connection.execute(
            text("SELECT COALESCE(SUM(amount), 0) FROM public.payment_allocations WHERE payment_id = :payment_id"),
            {"payment_id": payment_id},
        ).scalar_one() or Decimal("0")
        payment_balance = payment["amount"] - payment_allocated

        if allocation.amount > payment_balance:
            raise HTTPException(
                status_code=409,
                detail="Allocation exceeds the payment's unallocated balance.",
            )
        if allocation.amount > invoice_balance:
            raise HTTPException(
                status_code=409,
                detail="Allocation exceeds the invoice's unpaid balance.",
            )

        created = connection.execute(
            text(
                """
                INSERT INTO public.payment_allocations (
                    payment_id, invoice_id, amount
                )
                VALUES (
                    :payment_id, :invoice_id, :amount
                )
                ON CONFLICT (payment_id, invoice_id)
                DO UPDATE
                SET amount = public.payment_allocations.amount + EXCLUDED.amount
                RETURNING id, payment_id, invoice_id, amount, allocated_at
                """
            ),
            {
                "payment_id": payment_id,
                "invoice_id": allocation.invoice_id,
                "amount": allocation.amount,
            },
        ).mappings().one()

        new_status = recalc_invoice_status(connection, allocation.invoice_id)
        if new_status != invoice["status"]:
            connection.execute(
                text(
                    """
                    UPDATE public.invoices
                    SET status = :status
                    WHERE id = :invoice_id
                    """
                ),
                {"status": new_status, "invoice_id": allocation.invoice_id},
            )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'payment.allocated', 'payment_allocation', :allocation_id,
                    jsonb_build_object(
                        'payment_id', CAST(:payment_id AS bigint),
                        'invoice_id', CAST(:invoice_id AS bigint),
                        'amount', CAST(:amount AS text),
                        'currency', CAST(:currency AS text),
                        'to_invoice_status', CAST(:to_invoice_status AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "allocation_id": created["id"],
                "payment_id": payment_id,
                "invoice_id": allocation.invoice_id,
                "amount": allocation.amount,
                "currency": payment["currency"],
                "to_invoice_status": new_status,
            },
        )

    return PaymentAllocationRecord(
        id=created["id"],
        payment_id=payment_id,
        invoice_id=allocation.invoice_id,
        invoice_number=invoice["invoice_number"],
        amount=created["amount"],
        allocated_at=created["allocated_at"],
    )


# ============================================================================
# Documents (Private Attachment Storage)
# ============================================================================

DocumentType = Literal[
    "booking_confirmation", "itinerary", "e_ticket", "passport", "receipt", "other",
]

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
ALLOWED_DOCUMENT_CONTENT_TYPES = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "text/plain": ".txt",
}


def document_storage_dir() -> Path:
    configured = os.getenv("DOCUMENT_STORAGE_DIR", "").strip()
    if configured:
        directory = Path(configured).expanduser().resolve()
    else:
        directory = (Path(__file__).resolve().parent / "storage" / "documents").resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def safe_download_filename(original_filename: str, fallback: str) -> str:
    cleaned = os.path.basename(original_filename or "").strip()
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", cleaned)
    cleaned = cleaned.lstrip(".")
    return cleaned[:200] or fallback


class DocumentRecord(BaseModel):
    id: int
    document_type: str
    booking_id: int | None
    customer_id: int | None
    passenger_id: int | None
    original_filename: str
    content_type: str | None
    file_size_bytes: int | None
    sha256_hex: str | None
    uploaded_by: int | None
    uploaded_by_name: str | None
    created_at: datetime


class DocumentListResponse(BaseModel):
    items: list[DocumentRecord]
    total: int


def resolve_document_branch(connection, document) -> int | None:
    """Return the branch that owns a document, or None for shared customer documents."""
    if document["booking_id"] is not None:
        branch = connection.execute(
            text("SELECT branch_id FROM public.bookings WHERE id = :booking_id"),
            {"booking_id": document["booking_id"]},
        ).scalar_one_or_none()
        return branch
    if document["passenger_id"] is not None:
        return connection.execute(
            text(
                """
                SELECT bookings.branch_id
                FROM public.booking_passengers AS booking_passengers
                JOIN public.bookings AS bookings ON bookings.id = booking_passengers.booking_id
                WHERE booking_passengers.passenger_id = :passenger_id
                ORDER BY booking_passengers.id
                LIMIT 1
                """
            ),
            {"passenger_id": document["passenger_id"]},
        ).scalar_one_or_none()
    return None


def document_is_accessible(connection, document, branch_id: int) -> bool:
    owning_branch = resolve_document_branch(connection, document)
    if owning_branch is None:
        return True
    return owning_branch == branch_id


def load_document_row(connection, document_id: int):
    return connection.execute(
        text(
            """
            SELECT
                documents.id,
                documents.document_type,
                documents.booking_id,
                documents.customer_id,
                documents.passenger_id,
                documents.object_key,
                documents.original_filename,
                documents.content_type,
                documents.file_size_bytes,
                documents.sha256_hex,
                documents.uploaded_by,
                documents.created_at,
                users.full_name AS uploaded_by_name
            FROM public.documents AS documents
            LEFT JOIN public.users AS users ON users.id = documents.uploaded_by
            WHERE documents.id = :document_id
            """
        ),
        {"document_id": document_id},
    ).mappings().one_or_none()


@app.get("/api/documents", response_model=DocumentListResponse)
def list_documents(
    booking_id: int | None = Query(default=None, gt=0),
    customer_id: int | None = Query(default=None, gt=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        filters = ["TRUE"]
        params: dict[str, object] = {"branch_id": branch_id}
        if booking_id is not None:
            filters.append("documents.booking_id = :booking_id")
            params["booking_id"] = booking_id
        if customer_id is not None:
            filters.append("documents.customer_id = :customer_id")
            params["customer_id"] = customer_id

        rows = connection.execute(
            text(
                f"""
                SELECT
                    documents.id,
                    documents.document_type,
                    documents.booking_id,
                    documents.customer_id,
                    documents.passenger_id,
                    documents.original_filename,
                    documents.content_type,
                    documents.file_size_bytes,
                    documents.sha256_hex,
                    documents.uploaded_by,
                    documents.created_at,
                    users.full_name AS uploaded_by_name
                FROM public.documents AS documents
                LEFT JOIN public.users AS users ON users.id = documents.uploaded_by
                WHERE {" AND ".join(filters)}
                ORDER BY documents.created_at DESC, documents.id DESC
                """
            ),
            params,
        ).mappings().all()

        accessible = []
        for row in rows:
            if document_is_accessible(connection, row, branch_id):
                accessible.append(row)

    return DocumentListResponse(
        items=[DocumentRecord.model_validate(row) for row in accessible],
        total=len(accessible),
    )


@app.post("/api/documents", response_model=DocumentRecord, status_code=201)
async def upload_document(
    file: UploadFile = File(...),
    document_type: DocumentType = Form(default="other"),
    booking_id: int | None = Form(default=None),
    customer_id: int | None = Form(default=None),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    if booking_id is None and customer_id is None:
        raise HTTPException(
            status_code=422,
            detail="Attach the document to a booking or a customer.",
        )

    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_DOCUMENT_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Only PDF, JPEG, PNG, WebP, and plain-text attachments are accepted.",
        )

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")
    if len(payload) > MAX_DOCUMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="The attachment exceeds the 10 MB limit.",
        )

    original_filename = safe_download_filename(
        file.filename or "", f"document-{uuid4().hex[:8]}"
    )
    extension = ALLOWED_DOCUMENT_CONTENT_TYPES[content_type]
    object_key = f"{uuid4().hex}{extension}"
    sha256_hex = hashlib.sha256(payload).hexdigest()

    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        if booking_id is not None:
            booking = connection.execute(
                text("SELECT id FROM public.bookings WHERE id = :booking_id AND branch_id = :branch_id"),
                {"booking_id": booking_id, "branch_id": branch_id},
            ).mappings().one_or_none()
            if booking is None:
                raise HTTPException(status_code=404, detail="Booking not found in your branch.")
        if customer_id is not None:
            customer = connection.execute(
                text("SELECT id FROM public.customers WHERE id = :customer_id"),
                {"customer_id": customer_id},
            ).mappings().one_or_none()
            if customer is None:
                raise HTTPException(status_code=404, detail="Customer not found.")

        storage_directory = document_storage_dir()
        target_path = (storage_directory / object_key).resolve()
        if target_path.parent != storage_directory:
            raise HTTPException(status_code=400, detail="Invalid attachment path.")
        target_path.write_bytes(payload)

        try:
            row = connection.execute(
                text(
                    """
                    INSERT INTO public.documents (
                        booking_id, customer_id, document_type, object_key,
                        original_filename, content_type, file_size_bytes,
                        sha256_hex, uploaded_by
                    )
                    VALUES (
                        :booking_id, :customer_id, :document_type, :object_key,
                        :original_filename, :content_type, :file_size_bytes,
                        :sha256_hex, :uploaded_by
                    )
                    RETURNING
                        id, document_type, booking_id, customer_id, passenger_id,
                        original_filename, content_type, file_size_bytes,
                        sha256_hex, uploaded_by, created_at
                    """
                ),
                {
                    "booking_id": booking_id,
                    "customer_id": customer_id,
                    "document_type": document_type,
                    "object_key": object_key,
                    "original_filename": original_filename,
                    "content_type": content_type,
                    "file_size_bytes": len(payload),
                    "sha256_hex": sha256_hex,
                    "uploaded_by": staff_id,
                },
            ).mappings().one()
        except Exception:
            target_path.unlink(missing_ok=True)
            raise

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'document.uploaded', 'document', :document_id,
                    jsonb_build_object(
                        'document_type', CAST(:document_type AS text),
                        'booking_id', CAST(:booking_id AS bigint),
                        'customer_id', CAST(:customer_id AS bigint),
                        'original_filename', CAST(:original_filename AS text),
                        'file_size_bytes', CAST(:file_size_bytes AS bigint)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "document_id": row["id"],
                "document_type": document_type,
                "booking_id": booking_id,
                "customer_id": customer_id,
                "original_filename": original_filename,
                "file_size_bytes": len(payload),
            },
        )

    return DocumentRecord.model_validate({**row, "uploaded_by_name": None})


@app.get("/api/documents/{document_id}/download")
def download_document(
    document_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        document = load_document_row(connection, document_id)
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found.")
        if not document_is_accessible(connection, document, branch_id):
            raise HTTPException(status_code=403, detail="You do not have access to this document.")
        object_key = document["object_key"]
        filename = document["original_filename"]
        content_type = document["content_type"] or "application/octet-stream"

    storage_directory = document_storage_dir()
    file_path = (storage_directory / object_key).resolve()
    if file_path.parent != storage_directory or not file_path.is_file():
        raise HTTPException(status_code=404, detail="The stored attachment is no longer available.")

    return Response(
        content=file_path.read_bytes(),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ============================================================================
# Ticketing Requests (Partner Issuance Workflow)
# ============================================================================

TICKETING_REQUEST_SELECT = """
    SELECT
        ticketing_requests.id,
        ticketing_requests.booking_id,
        bookings.booking_code,
        ticketing_requests.supplier_id,
        COALESCE(NULLIF(BTRIM(suppliers.trading_name), ''), suppliers.legal_name) AS supplier_name,
        ticketing_requests.status,
        ticketing_requests.ticketing_deadline,
        ticketing_requests.partner_request_reference,
        ticketing_requests.partner_cost,
        ticketing_requests.partner_currency,
        ticketing_requests.response_notes,
        ticketing_requests.requested_by,
        ticketing_requests.submitted_at,
        ticketing_requests.responded_at,
        ticketing_requests.created_at,
        users.full_name AS requested_by_name
    FROM public.ticketing_requests AS ticketing_requests
    JOIN public.bookings AS bookings ON bookings.id = ticketing_requests.booking_id
    JOIN public.suppliers AS suppliers ON suppliers.id = ticketing_requests.supplier_id
    LEFT JOIN public.users AS users ON users.id = ticketing_requests.requested_by
"""


@app.get("/api/bookings/{booking_id}/ticketing-requests", response_model=list[TicketingRequestRecord])
def list_ticketing_requests(
    booking_id: int,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = get_booking_staff(connection, user.id)
        exists = connection.execute(
            text("SELECT 1 FROM public.bookings WHERE id = :booking_id AND branch_id = :branch_id"),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="Booking not found.")

        rows = connection.execute(
            text(
                f"""
                {TICKETING_REQUEST_SELECT}
                WHERE ticketing_requests.booking_id = :booking_id
                ORDER BY ticketing_requests.created_at DESC, ticketing_requests.id DESC
                """
            ),
            {"booking_id": booking_id},
        ).mappings().all()

    return [TicketingRequestRecord.model_validate(row) for row in rows]


@app.post(
    "/api/bookings/{booking_id}/ticketing-requests",
    response_model=TicketingRequestRecord,
    status_code=201,
)
def create_ticketing_request(
    booking_id: int,
    request: TicketingRequestCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        booking = connection.execute(
            text(
                """
                SELECT id, status, ticketing_deadline, booking_code
                FROM public.bookings
                WHERE id = :booking_id AND branch_id = :branch_id
                FOR UPDATE
                """
            ),
            {"booking_id": booking_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if booking is None:
            raise HTTPException(status_code=404, detail="Booking not found.")
        if booking["status"] in ("cancelled", "expired", "closed"):
            raise HTTPException(
                status_code=409,
                detail=f"A ticketing request cannot be raised while a booking is {booking['status']}.",
            )

        supplier = connection.execute(
            text(
                """
                SELECT id,
                    COALESCE(NULLIF(BTRIM(trading_name), ''), legal_name) AS display_name
                FROM public.suppliers
                WHERE id = :supplier_id
                    AND is_active = TRUE
                    AND supplier_type IN ('airline', 'consolidator', 'host_agency')
                """
            ),
            {"supplier_id": request.supplier_id},
        ).mappings().one_or_none()
        if supplier is None:
            raise HTTPException(
                status_code=422,
                detail="Select an active airline, consolidator, or host agency as the ticketing partner.",
            )

        deadline = request.ticketing_deadline or booking["ticketing_deadline"]
        created = connection.execute(
            text(
                """
                INSERT INTO public.ticketing_requests (
                    booking_id, supplier_id, requested_by, partner_request_reference,
                    status, ticketing_deadline, response_notes
                )
                VALUES (
                    :booking_id, :supplier_id, :requested_by, :partner_request_reference,
                    'not_requested', :ticketing_deadline, :response_notes
                )
                RETURNING
                    id, booking_id, supplier_id, status, ticketing_deadline,
                    partner_request_reference, partner_cost, partner_currency,
                    response_notes, requested_by, submitted_at, responded_at, created_at
                """
            ),
            {
                "booking_id": booking_id,
                "supplier_id": request.supplier_id,
                "requested_by": staff_id,
                "partner_request_reference": request.partner_request_reference,
                "ticketing_deadline": deadline,
                "response_notes": request.notes,
            },
        ).mappings().one()

        connection.execute(
            text(
                """
                UPDATE public.bookings
                SET ticketing_partner_id = :supplier_id,
                    ticketing_deadline = COALESCE(:ticketing_deadline, ticketing_deadline),
                    updated_at = NOW()
                WHERE id = :booking_id
                """
            ),
            {
                "supplier_id": request.supplier_id,
                "ticketing_deadline": deadline,
                "booking_id": booking_id,
            },
        )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'ticketing_request.created', 'ticketing_request', :request_id,
                    jsonb_build_object(
                        'booking_id', CAST(:booking_id AS bigint),
                        'supplier_id', CAST(:supplier_id AS bigint),
                        'to_status', 'not_requested',
                        'ticketing_deadline', CAST(:ticketing_deadline AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "request_id": created["id"],
                "booking_id": booking_id,
                "supplier_id": request.supplier_id,
                "ticketing_deadline": deadline.isoformat() if deadline else None,
            },
        )

    return TicketingRequestRecord.model_validate({
        **created,
        "booking_code": booking["booking_code"],
        "supplier_name": supplier["display_name"],
        "requested_by_name": None,
    })


@app.patch("/api/ticketing-requests/{request_id}", response_model=TicketingRequestRecord)
def update_ticketing_request(
    request_id: int,
    update: TicketingRequestStatusUpdate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = get_booking_staff(connection, user.id)
        existing = connection.execute(
            text(
                """
                SELECT
                    ticketing_requests.id,
                    ticketing_requests.booking_id,
                    ticketing_requests.supplier_id,
                    ticketing_requests.status,
                    bookings.booking_code,
                    bookings.status AS booking_status
                FROM public.ticketing_requests AS ticketing_requests
                JOIN public.bookings AS bookings ON bookings.id = ticketing_requests.booking_id
                WHERE ticketing_requests.id = :request_id
                    AND bookings.branch_id = :branch_id
                FOR UPDATE OF ticketing_requests
                """
            ),
            {"request_id": request_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if existing is None:
            raise HTTPException(status_code=404, detail="Ticketing request not found.")

        previous_status = existing["status"]
        next_status = update.status
        if next_status == previous_status:
            raise HTTPException(status_code=409, detail="The request already has that status.")
        allowed = TICKETING_REQUEST_STATUS_TRANSITIONS[previous_status]
        if next_status not in allowed:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"A ticketing request cannot change from {previous_status} to {next_status}. "
                    f"Allowed next statuses: {', '.join(sorted(allowed)) or 'none'}."
                ),
            )

        if next_status == "completed":
            issued_count = connection.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM public.tickets AS tickets
                    JOIN public.booking_passengers AS booking_passengers
                        ON booking_passengers.id = tickets.booking_passenger_id
                    WHERE booking_passengers.booking_id = :booking_id
                        AND tickets.ticket_status IN ('issued', 'exchanged')
                    """
                ),
                {"booking_id": existing["booking_id"]},
            ).scalar_one()
            if not issued_count:
                raise HTTPException(
                    status_code=409,
                    detail="Record the issued ticket before completing the ticketing request.",
                )

        submitted_at = connection.execute(
            text("SELECT NOW()")
        ).scalar_one() if next_status == "submitted" else None
        responded_at = connection.execute(
            text("SELECT NOW()")
        ).scalar_one() if next_status in ("failed", "completed") else None

        connection.execute(
            text(
                """
                UPDATE public.ticketing_requests
                SET status = :status,
                    partner_request_reference = COALESCE(:partner_request_reference, partner_request_reference),
                    partner_cost = COALESCE(:partner_cost, partner_cost),
                    partner_currency = COALESCE(:partner_currency, partner_currency),
                    response_notes = COALESCE(:response_notes, response_notes),
                    submitted_at = COALESCE(:submitted_at, submitted_at),
                    responded_at = COALESCE(:responded_at, responded_at),
                    updated_at = NOW()
                WHERE id = :request_id
                """
            ),
            {
                "status": next_status,
                "partner_request_reference": update.partner_request_reference,
                "partner_cost": update.partner_cost,
                "partner_currency": update.partner_currency,
                "response_notes": update.response_notes,
                "submitted_at": submitted_at,
                "responded_at": responded_at,
                "request_id": request_id,
            },
        )

        if next_status == "submitted" and existing["booking_status"] == "confirmed":
            connection.execute(
                text(
                    """
                    UPDATE public.bookings
                    SET status = 'ticketing_pending', updated_at = NOW()
                    WHERE id = :booking_id AND status = 'confirmed'
                    """
                ),
                {"booking_id": existing["booking_id"]},
            )
            connection.execute(
                text(
                    """
                    INSERT INTO public.activity_logs
                        (user_id, branch_id, action, entity_type, entity_id, details_json)
                    VALUES (
                        :user_id, :branch_id, 'booking.status_changed', 'booking', :booking_id,
                        jsonb_build_object('from_status', 'confirmed', 'to_status', 'ticketing_pending')
                    )
                    """
                ),
                {
                    "user_id": staff_id,
                    "branch_id": branch_id,
                    "booking_id": existing["booking_id"],
                },
            )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'ticketing_request.status_changed', 'ticketing_request', :request_id,
                    jsonb_build_object(
                        'booking_id', CAST(:booking_id AS bigint),
                        'supplier_id', CAST(:supplier_id AS bigint),
                        'from_status', CAST(:from_status AS text),
                        'to_status', CAST(:to_status AS text),
                        'partner_cost', CAST(:partner_cost AS text),
                        'partner_currency', CAST(:partner_currency AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "request_id": request_id,
                "booking_id": existing["booking_id"],
                "supplier_id": existing["supplier_id"],
                "from_status": previous_status,
                "to_status": next_status,
                "partner_cost": update.partner_cost,
                "partner_currency": update.partner_currency,
            },
        )

        row = connection.execute(
            text(
                f"""
                {TICKETING_REQUEST_SELECT}
                WHERE ticketing_requests.id = :request_id
                """
            ),
            {"request_id": request_id},
        ).mappings().one()

    return TicketingRequestRecord.model_validate(row)


# ============================================================================
# Supplier Bills & Payments
# ============================================================================

SupplierBillStatus = Literal["unpaid", "partially_paid", "paid", "void"]
SupplierPaymentStatus = Literal["pending", "confirmed", "voided"]

SUPPLIER_COST_BASIS_NOTE = (
    "Owed to suppliers is taken from the bills recorded against each partner. "
    "The ticket fare is what the partner's price list said at the time of "
    "issue. Where a booking has both a bill and issued tickets, the two are "
    "shown side by side in the reconciliation rather than added together, so "
    "the same cost is never counted twice. Amounts in different currencies are "
    "never converted or combined."
)


class SupplierBillCreate(BaseModel):
    supplier_id: int = Field(gt=0)
    booking_id: int | None = Field(default=None, gt=0)
    supplier_invoice_reference: str | None = Field(default=None, max_length=120)
    currency: str = Field(min_length=3, max_length=3)
    bill_date: date
    due_date: date | None = None
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_bill_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("currency")
    @classmethod
    def validate_bill_currency(cls, value: str) -> str:
        if not value.isascii() or not value.isalpha():
            raise ValueError("Currency must be a three-letter code")
        return value

    @field_validator("supplier_invoice_reference", "notes", mode="before")
    @classmethod
    def normalize_optional_bill_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @model_validator(mode="after")
    def check_bill_dates(self) -> "SupplierBillCreate":
        if self.due_date is not None and self.due_date < self.bill_date:
            raise ValueError("The due date cannot be before the bill date.")
        return self


class SupplierBillRecord(BaseModel):
    id: int
    bill_number: str | None
    supplier_id: int
    supplier_name: str
    booking_id: int | None
    booking_code: str | None
    supplier_invoice_reference: str | None
    currency: str
    bill_date: date
    due_date: date | None
    amount: Decimal
    paid_total: Decimal
    outstanding_total: Decimal
    status: SupplierBillStatus
    notes: str | None
    created_by: int | None
    created_at: datetime


class SupplierBillListResponse(BaseModel):
    items: list[SupplierBillRecord]
    total: int
    limit: int
    offset: int
    outstanding_by_currency: list[CurrencyTotal]


class SupplierPaymentCreate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    currency: str = Field(min_length=3, max_length=3)
    payment_method: PaymentMethod = "bank_transfer"
    status: SupplierPaymentStatus = "confirmed"
    paid_at: datetime | None = None
    external_reference: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_payment_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("currency")
    @classmethod
    def validate_payment_currency(cls, value: str) -> str:
        if not value.isascii() or not value.isalpha():
            raise ValueError("Currency must be a three-letter code")
        return value

    @field_validator("external_reference", "notes", mode="before")
    @classmethod
    def normalize_optional_payment_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class SupplierPaymentRecord(BaseModel):
    id: int
    supplier_bill_id: int
    bill_number: str | None
    supplier_id: int
    supplier_name: str
    booking_code: str | None
    currency: str
    amount: Decimal
    payment_method: PaymentMethod
    status: SupplierPaymentStatus
    paid_at: datetime
    external_reference: str | None
    notes: str | None
    paid_by: int | None
    created_at: datetime


class SupplierPaymentListResponse(BaseModel):
    items: list[SupplierPaymentRecord]
    total: int
    limit: int
    offset: int
    paid_by_currency: list[CurrencyTotal]


class VoidRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason", mode="before")
    @classmethod
    def normalize_reason(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value


def supplier_display_name(row) -> str:
    return row["trading_name"] or row["legal_name"]


def supplier_bill_row_sql() -> str:
    return """
        SELECT
            bills.id,
            bills.bill_number,
            bills.supplier_id,
            COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name) AS supplier_name,
            bills.booking_id,
            bookings.booking_code,
            bills.supplier_invoice_reference,
            bills.currency,
            bills.bill_date,
            bills.due_date,
            bills.amount,
            bills.status,
            bills.notes,
            bills.created_by,
            bills.created_at,
            COALESCE((
                SELECT SUM(payments.amount)
                FROM public.supplier_payments AS payments
                WHERE payments.supplier_bill_id = bills.id
                    AND payments.status = 'confirmed'
            ), 0) AS paid_total
        FROM public.supplier_bills AS bills
        JOIN public.suppliers AS suppliers ON suppliers.id = bills.supplier_id
        LEFT JOIN public.bookings AS bookings ON bookings.id = bills.booking_id
    """


def recalc_supplier_bill_status(connection, bill_id: int) -> str:
    """Recompute a bill's status from the payments recorded against it.

    The bill amount is the obligation. Payments settle it. A void bill keeps
    its status: voiding is an explicit statement that the record was wrong,
    not a statement that it was settled.
    """
    row = connection.execute(
        text(
            """
            SELECT
                bills.amount,
                bills.status,
                COALESCE((
                    SELECT SUM(payments.amount)
                    FROM public.supplier_payments AS payments
                    WHERE payments.supplier_bill_id = bills.id
                        AND payments.status = 'confirmed'
                ), 0) AS paid_total
            FROM public.supplier_bills AS bills
            WHERE bills.id = :bill_id
            """
        ),
        {"bill_id": bill_id},
    ).mappings().one()
    if row["status"] == "void":
        return "void"
    paid_total = row["paid_total"] or Decimal("0")
    amount = row["amount"] or Decimal("0")
    if paid_total <= 0:
        return "unpaid"
    if paid_total >= amount:
        return "paid"
    return "partially_paid"


def supplier_bill_query_filters(
    *,
    branch_id: int,
    search: str,
    supplier_id: int | None,
    status: str | None,
    currency: str | None,
    booking_id: int | None,
) -> tuple[str, dict[str, object]]:
    filters = "bills.branch_id = :branch_id"
    params: dict[str, object] = {
        "branch_id": branch_id,
        "search": search,
        "search_pattern": f"%{search}%",
    }
    if search:
        filters += """
            AND (
                COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name) ILIKE :search_pattern
                OR bills.bill_number ILIKE :search_pattern
                OR bills.supplier_invoice_reference ILIKE :search_pattern
                OR bookings.booking_code ILIKE :search_pattern
            )
        """
    if supplier_id is not None:
        filters += " AND bills.supplier_id = :supplier_id"
        params["supplier_id"] = supplier_id
    if status:
        filters += " AND bills.status = :status"
        params["status"] = status
    if currency:
        filters += " AND bills.currency = :currency"
        params["currency"] = currency
    if booking_id is not None:
        filters += " AND bills.booking_id = :booking_id"
        params["booking_id"] = booking_id
    return filters, params


@app.get("/api/supplier-bills", response_model=SupplierBillListResponse)
def list_supplier_bills(
    q: str = Query(default="", max_length=200),
    supplier_id: int | None = Query(default=None, gt=0),
    status: SupplierBillStatus | None = Query(default=None),
    currency: str | None = Query(default=None, min_length=3, max_length=3),
    booking_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    search = optional_query(q, '').strip()
    limit = optional_query(limit, 50)
    offset = optional_query(offset, 0)
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        filters, params = supplier_bill_query_filters(
            branch_id=branch_id,
            search=search,
            supplier_id=optional_query(supplier_id),
            status=optional_query(status),
            currency=(optional_query(currency) or "").strip().upper() or None,
            booking_id=optional_query(booking_id),
        )
        total = connection.execute(
            text(
                f"""
                SELECT COUNT(*)
                FROM public.supplier_bills AS bills
                JOIN public.suppliers AS suppliers ON suppliers.id = bills.supplier_id
                LEFT JOIN public.bookings AS bookings ON bookings.id = bills.booking_id
                WHERE {filters}
                """
            ),
            params,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"""
                {supplier_bill_row_sql()}
                WHERE {filters}
                ORDER BY bills.bill_date DESC, bills.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {**params, "limit": optional_query(limit, 50), "offset": optional_query(offset, 0)},
        ).mappings().all()

    items = []
    outstanding: dict[str, Decimal] = {}
    for row in rows:
        paid_total = row["paid_total"] or Decimal("0")
        outstanding_total = (row["amount"] or Decimal("0")) - paid_total
        items.append(
            SupplierBillRecord(
                id=row["id"],
                bill_number=row["bill_number"],
                supplier_id=row["supplier_id"],
                supplier_name=row["supplier_name"],
                booking_id=row["booking_id"],
                booking_code=row["booking_code"],
                supplier_invoice_reference=row["supplier_invoice_reference"],
                currency=row["currency"],
                bill_date=row["bill_date"],
                due_date=row["due_date"],
                amount=row["amount"],
                paid_total=paid_total,
                outstanding_total=outstanding_total,
                status=row["status"],
                notes=row["notes"],
                created_by=row["created_by"],
                created_at=row["created_at"],
            )
        )
        if row["status"] != "void":
            outstanding[row["currency"]] = (
                outstanding.get(row["currency"], Decimal("0")) + outstanding_total
            )

    return SupplierBillListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        outstanding_by_currency=[
            CurrencyTotal(currency=code, amount=outstanding[code])
            for code in sorted(outstanding)
        ],
    )


@app.post("/api/supplier-bills", response_model=SupplierBillRecord, status_code=201)
def create_supplier_bill(
    bill: SupplierBillCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_finance_staff(connection, user.id, write_access=True)
        supplier = connection.execute(
            text(
                """
                SELECT id, legal_name, trading_name, is_active
                FROM public.suppliers
                WHERE id = :supplier_id
                """
            ),
            {"supplier_id": bill.supplier_id},
        ).mappings().one_or_none()
        if supplier is None:
            raise HTTPException(status_code=404, detail="The selected supplier was not found.")
        if not supplier["is_active"]:
            raise HTTPException(
                status_code=409,
                detail="This supplier is inactive. Reactivate it before recording bills.",
            )

        booking_code = None
        if bill.booking_id is not None:
            booking = connection.execute(
                text(
                    """
                    SELECT id, booking_code FROM public.bookings
                    WHERE id = :booking_id AND branch_id = :branch_id
                    """
                ),
                {"booking_id": bill.booking_id, "branch_id": branch_id},
            ).mappings().one_or_none()
            if booking is None:
                raise HTTPException(
                    status_code=404, detail="The selected booking was not found in your branch."
                )
            booking_code = booking["booking_code"]

        if bill.supplier_invoice_reference:
            existing = connection.execute(
                text(
                    """
                    SELECT id FROM public.supplier_bills
                    WHERE supplier_id = :supplier_id
                        AND supplier_invoice_reference = :reference
                    """
                ),
                {
                    "supplier_id": bill.supplier_id,
                    "reference": bill.supplier_invoice_reference,
                },
            ).scalar_one_or_none()
            if existing is not None:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This partner invoice reference has already been recorded for "
                        "the supplier."
                    ),
                )

        bill_number = connection.execute(
            text("SELECT public.next_supplier_bill_number(:branch_id)"),
            {"branch_id": branch_id},
        ).scalar_one()

        row = connection.execute(
            text(
                """
                INSERT INTO public.supplier_bills (
                    supplier_id, branch_id, booking_id, bill_number,
                    supplier_invoice_reference, currency, bill_date, due_date,
                    amount, status, notes, created_by
                )
                VALUES (
                    :supplier_id, :branch_id, :booking_id, :bill_number,
                    :supplier_invoice_reference, :currency, :bill_date, :due_date,
                    :amount, 'unpaid', :notes, :created_by
                )
                RETURNING
                    id, bill_number, supplier_id, booking_id, supplier_invoice_reference,
                    currency, bill_date, due_date, amount, status, notes, created_by, created_at
                """
            ),
            {
                "supplier_id": bill.supplier_id,
                "branch_id": branch_id,
                "booking_id": bill.booking_id,
                "bill_number": bill_number,
                "supplier_invoice_reference": bill.supplier_invoice_reference,
                "currency": bill.currency,
                "bill_date": bill.bill_date,
                "due_date": bill.due_date,
                "amount": bill.amount,
                "notes": bill.notes,
                "created_by": staff_id,
            },
        ).mappings().one()

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'supplier_bill.recorded', 'supplier_bill', :bill_id,
                    jsonb_build_object(
                        'supplier_id', CAST(:supplier_id AS bigint),
                        'bill_number', CAST(:bill_number AS text),
                        'currency', CAST(:currency AS text),
                        'amount', CAST(:amount AS text),
                        'booking_id', CAST(:booking_id AS bigint)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "bill_id": row["id"],
                "supplier_id": bill.supplier_id,
                "bill_number": bill_number,
                "currency": bill.currency,
                "amount": str(bill.amount),
                "booking_id": bill.booking_id,
            },
        )

    return SupplierBillRecord(
        id=row["id"],
        bill_number=row["bill_number"],
        supplier_id=row["supplier_id"],
        supplier_name=supplier_display_name(supplier),
        booking_id=row["booking_id"],
        booking_code=booking_code,
        supplier_invoice_reference=row["supplier_invoice_reference"],
        currency=row["currency"],
        bill_date=row["bill_date"],
        due_date=row["due_date"],
        amount=row["amount"],
        paid_total=Decimal("0"),
        outstanding_total=row["amount"],
        status=row["status"],
        notes=row["notes"],
        created_by=row["created_by"],
        created_at=row["created_at"],
    )


@app.post("/api/supplier-bills/{bill_id}/void", response_model=SupplierBillRecord)
def void_supplier_bill(
    bill_id: int,
    payload: VoidRequest,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_finance_staff(connection, user.id, write_access=True)
        bill = connection.execute(
            text(
                """
                SELECT
                    bills.id, bills.bill_number, bills.supplier_id, bills.booking_id,
                    bills.supplier_invoice_reference, bills.currency, bills.bill_date,
                    bills.due_date, bills.amount, bills.status, bills.notes,
                    bills.created_by, bills.created_at,
                    COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name) AS supplier_name,
                    bookings.booking_code
                FROM public.supplier_bills AS bills
                JOIN public.suppliers AS suppliers ON suppliers.id = bills.supplier_id
                LEFT JOIN public.bookings AS bookings ON bookings.id = bills.booking_id
                WHERE bills.id = :bill_id AND bills.branch_id = :branch_id
                FOR UPDATE OF bills
                """
            ),
            {"bill_id": bill_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if bill is None:
            raise HTTPException(status_code=404, detail="Supplier bill not found in your branch.")
        if bill["status"] == "void":
            raise HTTPException(status_code=409, detail="This bill has already been voided.")

        payment_count = connection.execute(
            text(
                """
                SELECT COUNT(*) FROM public.supplier_payments
                WHERE supplier_bill_id = :bill_id AND status <> 'voided'
                """
            ),
            {"bill_id": bill_id},
        ).scalar_one()
        if payment_count:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Payments have been recorded against this bill. Void the "
                    "payments first, then void the bill."
                ),
            )

        connection.execute(
            text(
                """
                UPDATE public.supplier_bills
                SET status = 'void',
                    notes = CONCAT(COALESCE(notes, ''), CHR(10), '[Voided] ', CAST(:reason AS text))
                WHERE id = :bill_id
                """
            ),
            {"bill_id": bill_id, "reason": payload.reason},
        )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'supplier_bill.voided', 'supplier_bill', :bill_id,
                    jsonb_build_object('reason', CAST(:reason AS text))
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "bill_id": bill_id,
                "reason": payload.reason,
            },
        )

    paid_total = Decimal("0")
    return SupplierBillRecord(
        id=bill["id"],
        bill_number=bill["bill_number"],
        supplier_id=bill["supplier_id"],
        supplier_name=bill["supplier_name"],
        booking_id=bill["booking_id"],
        booking_code=bill["booking_code"],
        supplier_invoice_reference=bill["supplier_invoice_reference"],
        currency=bill["currency"],
        bill_date=bill["bill_date"],
        due_date=bill["due_date"],
        amount=bill["amount"],
        paid_total=paid_total,
        outstanding_total=Decimal("0"),
        status="void",
        notes=bill["notes"],
        created_by=bill["created_by"],
        created_at=bill["created_at"],
    )


@app.post(
    "/api/supplier-bills/{bill_id}/payments",
    response_model=SupplierPaymentRecord,
    status_code=201,
)
def create_supplier_payment(
    bill_id: int,
    payment: SupplierPaymentCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_finance_staff(connection, user.id, write_access=True)
        bill = connection.execute(
            text(
                """
                SELECT
                    bills.id, bills.bill_number, bills.supplier_id, bills.booking_id,
                    bills.currency, bills.amount, bills.status,
                    COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name) AS supplier_name,
                    bookings.booking_code
                FROM public.supplier_bills AS bills
                JOIN public.suppliers AS suppliers ON suppliers.id = bills.supplier_id
                LEFT JOIN public.bookings AS bookings ON bookings.id = bills.booking_id
                WHERE bills.id = :bill_id AND bills.branch_id = :branch_id
                FOR UPDATE OF bills
                """
            ),
            {"bill_id": bill_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if bill is None:
            raise HTTPException(status_code=404, detail="Supplier bill not found in your branch.")
        if bill["status"] == "void":
            raise HTTPException(status_code=409, detail="This bill has been voided.")
        if bill["status"] == "paid":
            raise HTTPException(
                status_code=409, detail="This bill is already settled in full."
            )
        if bill["currency"] != payment.currency:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This bill is in {bill['currency']}. Payments must be in the "
                    f"same currency; amounts are never converted."
                ),
            )

        paid_total = connection.execute(
            text(
                """
                SELECT COALESCE(SUM(amount), 0) FROM public.supplier_payments
                WHERE supplier_bill_id = :bill_id AND status = 'confirmed'
                """
            ),
            {"bill_id": bill_id},
        ).scalar_one() or Decimal("0")
        outstanding = (bill["amount"] or Decimal("0")) - paid_total
        if payment.amount > outstanding:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"The payment of {payment.amount} {payment.currency} is more than "
                    f"the {outstanding} {bill['currency']} still owed on this bill."
                ),
            )

        paid_at = payment.paid_at
        if paid_at is None:
            paid_at = connection.execute(text("SELECT NOW()")).scalar_one()

        row = connection.execute(
            text(
                """
                INSERT INTO public.supplier_payments (
                    supplier_bill_id, currency, amount, payment_method, status,
                    paid_at, external_reference, notes, paid_by
                )
                VALUES (
                    :supplier_bill_id, :currency, :amount, :payment_method, :status,
                    :paid_at, :external_reference, :notes, :paid_by
                )
                RETURNING
                    id, supplier_bill_id, currency, amount, payment_method, status,
                    paid_at, external_reference, notes, paid_by, created_at
                """
            ),
            {
                "supplier_bill_id": bill_id,
                "currency": payment.currency,
                "amount": payment.amount,
                "payment_method": payment.payment_method,
                "status": payment.status,
                "paid_at": paid_at,
                "external_reference": payment.external_reference,
                "notes": payment.notes,
                "paid_by": staff_id,
            },
        ).mappings().one()

        new_status = recalc_supplier_bill_status(connection, bill_id)
        connection.execute(
            text(
                """
                UPDATE public.supplier_bills
                SET status = :status
                WHERE id = :bill_id
                """
            ),
            {"status": new_status, "bill_id": bill_id},
        )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'supplier_payment.recorded', 'supplier_payment',
                    :payment_id,
                    jsonb_build_object(
                        'supplier_bill_id', CAST(:supplier_bill_id AS bigint),
                        'bill_number', CAST(:bill_number AS text),
                        'currency', CAST(:currency AS text),
                        'amount', CAST(:amount AS text),
                        'payment_method', CAST(:payment_method AS text),
                        'bill_status', CAST(:bill_status AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "payment_id": row["id"],
                "supplier_bill_id": bill_id,
                "bill_number": bill["bill_number"],
                "currency": payment.currency,
                "amount": str(payment.amount),
                "payment_method": payment.payment_method,
                "bill_status": new_status,
            },
        )

    return SupplierPaymentRecord(
        id=row["id"],
        supplier_bill_id=row["supplier_bill_id"],
        bill_number=bill["bill_number"],
        supplier_id=bill["supplier_id"],
        supplier_name=bill["supplier_name"],
        booking_code=bill["booking_code"],
        currency=row["currency"],
        amount=row["amount"],
        payment_method=row["payment_method"],
        status=row["status"],
        paid_at=row["paid_at"],
        external_reference=row["external_reference"],
        notes=row["notes"],
        paid_by=row["paid_by"],
        created_at=row["created_at"],
    )


@app.get("/api/supplier-payments", response_model=SupplierPaymentListResponse)
def list_supplier_payments(
    q: str = Query(default="", max_length=200),
    supplier_id: int | None = Query(default=None, gt=0),
    bill_id: int | None = Query(default=None, gt=0),
    status: SupplierPaymentStatus | None = Query(default=None),
    currency: str | None = Query(default=None, min_length=3, max_length=3),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    search = optional_query(q, '').strip()
    limit = optional_query(limit, 50)
    offset = optional_query(offset, 0)
    supplier_id = optional_query(supplier_id)
    bill_id = optional_query(bill_id)
    status = optional_query(status)
    currency = optional_query(currency)
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        filters = "bills.branch_id = :branch_id"
        params: dict[str, object] = {
            "branch_id": branch_id,
            "search": search,
            "search_pattern": f"%{search}%",
        }
        if search:
            filters += """
                AND (
                    COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name) ILIKE :search_pattern
                    OR payments.external_reference ILIKE :search_pattern
                    OR bills.bill_number ILIKE :search_pattern
                    OR bookings.booking_code ILIKE :search_pattern
                )
            """
        if supplier_id is not None:
            filters += " AND bills.supplier_id = :supplier_id"
            params["supplier_id"] = supplier_id
        if bill_id is not None:
            filters += " AND payments.supplier_bill_id = :bill_id"
            params["bill_id"] = bill_id
        if status:
            filters += " AND payments.status = :status"
            params["status"] = status
        if currency:
            filters += " AND payments.currency = :currency"
            params["currency"] = currency.strip().upper()
        base_from = """
            FROM public.supplier_payments AS payments
            JOIN public.supplier_bills AS bills ON bills.id = payments.supplier_bill_id
            JOIN public.suppliers AS suppliers ON suppliers.id = bills.supplier_id
            LEFT JOIN public.bookings AS bookings ON bookings.id = bills.booking_id
        """
        total = connection.execute(
            text(f"SELECT COUNT(*) {base_from} WHERE {filters}"),
            params,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"""
                SELECT
                    payments.id,
                    payments.supplier_bill_id,
                    bills.bill_number,
                    bills.supplier_id,
                    COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name) AS supplier_name,
                    bookings.booking_code,
                    payments.currency,
                    payments.amount,
                    payments.payment_method,
                    payments.status,
                    payments.paid_at,
                    payments.external_reference,
                    payments.notes,
                    payments.paid_by,
                    payments.created_at
                {base_from}
                WHERE {filters}
                ORDER BY payments.paid_at DESC, payments.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {**params, "limit": optional_query(limit, 50), "offset": optional_query(offset, 0)},
        ).mappings().all()

    items = []
    paid: dict[str, Decimal] = {}
    for row in rows:
        items.append(
            SupplierPaymentRecord(
                id=row["id"],
                supplier_bill_id=row["supplier_bill_id"],
                bill_number=row["bill_number"],
                supplier_id=row["supplier_id"],
                supplier_name=row["supplier_name"],
                booking_code=row["booking_code"],
                currency=row["currency"],
                amount=row["amount"],
                payment_method=row["payment_method"],
                status=row["status"],
                paid_at=row["paid_at"],
                external_reference=row["external_reference"],
                notes=row["notes"],
                paid_by=row["paid_by"],
                created_at=row["created_at"],
            )
        )
        if row["status"] == "confirmed":
            paid[row["currency"]] = paid.get(row["currency"], Decimal("0")) + row["amount"]

    return SupplierPaymentListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        paid_by_currency=[
            CurrencyTotal(currency=code, amount=paid[code]) for code in sorted(paid)
        ],
    )


# ============================================================================
# Business Expenses
# ============================================================================

ExpenseCategory = Literal[
    "rent",
    "utilities",
    "internet",
    "phone",
    "transport",
    "salary",
    "supplies",
    "marketing",
    "licensing",
    "insurance",
    "bank_charges",
    "maintenance",
    "other",
]
ExpenseStatus = Literal["recorded", "void"]

EXPENSE_CATEGORY_LABELS: dict[str, str] = {
    "rent": "Rent",
    "utilities": "Electricity and water",
    "internet": "Internet",
    "phone": "Phone and airtime",
    "transport": "Transport and fuel",
    "salary": "Salaries",
    "supplies": "Office supplies",
    "marketing": "Marketing",
    "licensing": "Licences and fees",
    "insurance": "Insurance",
    "bank_charges": "Bank charges",
    "maintenance": "Repairs and maintenance",
    "other": "Other",
}


class ExpenseCategoryOption(BaseModel):
    code: str
    label: str


class ExpenseCreate(BaseModel):
    expense_date: date
    category: ExpenseCategory
    description: str = Field(min_length=3, max_length=500)
    supplier_name: str | None = Field(default=None, max_length=200)
    currency: str = Field(min_length=3, max_length=3)
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    payment_method: PaymentMethod = "cash"
    receipt_document_key: str | None = Field(default=None, max_length=500)

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_expense_currency(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @field_validator("currency")
    @classmethod
    def validate_expense_currency(cls, value: str) -> str:
        if not value.isascii() or not value.isalpha():
            raise ValueError("Currency must be a three-letter code")
        return value

    @field_validator(
        "description", "supplier_name", "receipt_document_key", mode="before"
    )
    @classmethod
    def normalize_expense_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class ExpenseRecord(BaseModel):
    id: int
    expense_number: str | None
    branch_id: int
    expense_date: date
    category: ExpenseCategory
    category_label: str
    description: str
    supplier_name: str | None
    currency: str
    amount: Decimal
    payment_method: PaymentMethod
    receipt_document_key: str | None
    status: ExpenseStatus
    recorded_by: int | None
    created_at: datetime
    voided_at: datetime | None
    voided_by: int | None
    void_reason: str | None


class ExpenseListResponse(BaseModel):
    items: list[ExpenseRecord]
    total: int
    limit: int
    offset: int
    total_by_currency: list[CurrencyTotal]


class ExpenseVoidRequest(VoidRequest):
    pass


@app.get("/api/expense-categories", response_model=list[ExpenseCategoryOption])
def list_expense_categories(
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        require_finance_staff(connection, user.id)
    return [
        ExpenseCategoryOption(code=code, label=EXPENSE_CATEGORY_LABELS[code])
        for code in EXPENSE_CATEGORY_LABELS
    ]


def expense_query_filters(
    *,
    branch_id: int,
    search: str,
    category: str | None,
    status: str | None,
    currency: str | None,
    date_from: date | None,
    date_to: date | None,
) -> tuple[str, dict[str, object]]:
    filters = "expenses.branch_id = :branch_id"
    params: dict[str, object] = {
        "branch_id": branch_id,
        "search": search,
        "search_pattern": f"%{search}%",
    }
    if search:
        filters += """
            AND (
                expenses.description ILIKE :search_pattern
                OR expenses.expense_number ILIKE :search_pattern
                OR expenses.supplier_name ILIKE :search_pattern
            )
        """
    if category:
        filters += " AND expenses.category = :category"
        params["category"] = category
    if status:
        filters += " AND expenses.status = :status"
        params["status"] = status
    if currency:
        filters += " AND expenses.currency = :currency"
        params["currency"] = currency
    if date_from is not None:
        filters += " AND expenses.expense_date >= :date_from"
        params["date_from"] = date_from
    if date_to is not None:
        filters += " AND expenses.expense_date <= :date_to"
        params["date_to"] = date_to
    return filters, params


@app.get("/api/expenses", response_model=ExpenseListResponse)
def list_expenses(
    q: str = Query(default="", max_length=200),
    category: ExpenseCategory | None = Query(default=None),
    status: ExpenseStatus | None = Query(default=None),
    currency: str | None = Query(default=None, min_length=3, max_length=3),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    search = optional_query(q, '').strip()
    limit = optional_query(limit, 50)
    offset = optional_query(offset, 0)
    category = optional_query(category)
    status = optional_query(status)
    currency = optional_query(currency)
    date_from = optional_query(date_from)
    date_to = optional_query(date_to)
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        filters, params = expense_query_filters(
            branch_id=branch_id,
            search=search,
            category=category,
            status=status,
            currency=currency.strip().upper() if currency else None,
            date_from=date_from,
            date_to=date_to,
        )
        total = connection.execute(
            text(f"SELECT COUNT(*) FROM public.business_expenses AS expenses WHERE {filters}"),
            params,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"""
                SELECT
                    expenses.id, expenses.expense_number, expenses.branch_id,
                    expenses.expense_date, expenses.category, expenses.description,
                    expenses.supplier_name, expenses.currency, expenses.amount,
                    expenses.payment_method, expenses.receipt_document_key,
                    expenses.status, expenses.recorded_by, expenses.created_at,
                    expenses.voided_at, expenses.voided_by, expenses.void_reason
                FROM public.business_expenses AS expenses
                WHERE {filters}
                ORDER BY expenses.expense_date DESC, expenses.id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {**params, "limit": optional_query(limit, 50), "offset": optional_query(offset, 0)},
        ).mappings().all()

    items = []
    totals: dict[str, Decimal] = {}
    for row in rows:
        items.append(
            ExpenseRecord(
                id=row["id"],
                expense_number=row["expense_number"],
                branch_id=row["branch_id"],
                expense_date=row["expense_date"],
                category=row["category"],
                category_label=EXPENSE_CATEGORY_LABELS.get(row["category"], row["category"]),
                description=row["description"],
                supplier_name=row["supplier_name"],
                currency=row["currency"],
                amount=row["amount"],
                payment_method=row["payment_method"],
                receipt_document_key=row["receipt_document_key"],
                status=row["status"],
                recorded_by=row["recorded_by"],
                created_at=row["created_at"],
                voided_at=row["voided_at"],
                voided_by=row["voided_by"],
                void_reason=row["void_reason"],
            )
        )
        if row["status"] == "recorded":
            totals[row["currency"]] = totals.get(row["currency"], Decimal("0")) + row["amount"]

    return ExpenseListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        total_by_currency=[
            CurrencyTotal(currency=code, amount=totals[code]) for code in sorted(totals)
        ],
    )


@app.post("/api/expenses", response_model=ExpenseRecord, status_code=201)
def create_expense(
    expense: ExpenseCreate,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_finance_staff(connection, user.id, write_access=True)
        expense_number = connection.execute(
            text("SELECT public.next_expense_number(:branch_id)"),
            {"branch_id": branch_id},
        ).scalar_one()

        row = connection.execute(
            text(
                """
                INSERT INTO public.business_expenses (
                    branch_id, expense_date, category, description, supplier_name,
                    currency, amount, payment_method, receipt_document_key,
                    recorded_by, expense_number, status
                )
                VALUES (
                    :branch_id, :expense_date, :category, :description, :supplier_name,
                    :currency, :amount, :payment_method, :receipt_document_key,
                    :recorded_by, :expense_number, 'recorded'
                )
                RETURNING
                    id, expense_number, branch_id, expense_date, category, description,
                    supplier_name, currency, amount, payment_method, receipt_document_key,
                    status, recorded_by, created_at, voided_at, voided_by, void_reason
                """
            ),
            {
                "branch_id": branch_id,
                "expense_date": expense.expense_date,
                "category": expense.category,
                "description": expense.description,
                "supplier_name": expense.supplier_name,
                "currency": expense.currency,
                "amount": expense.amount,
                "payment_method": expense.payment_method,
                "receipt_document_key": expense.receipt_document_key,
                "recorded_by": staff_id,
                "expense_number": expense_number,
            },
        ).mappings().one()

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'expense.recorded', 'expense', :expense_id,
                    jsonb_build_object(
                        'expense_number', CAST(:expense_number AS text),
                        'category', CAST(:category AS text),
                        'currency', CAST(:currency AS text),
                        'amount', CAST(:amount AS text),
                        'payment_method', CAST(:payment_method AS text)
                    )
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "expense_id": row["id"],
                "expense_number": expense_number,
                "category": expense.category,
                "currency": expense.currency,
                "amount": str(expense.amount),
                "payment_method": expense.payment_method,
            },
        )

    return ExpenseRecord(
        id=row["id"],
        expense_number=row["expense_number"],
        branch_id=row["branch_id"],
        expense_date=row["expense_date"],
        category=row["category"],
        category_label=EXPENSE_CATEGORY_LABELS.get(row["category"], row["category"]),
        description=row["description"],
        supplier_name=row["supplier_name"],
        currency=row["currency"],
        amount=row["amount"],
        payment_method=row["payment_method"],
        receipt_document_key=row["receipt_document_key"],
        status=row["status"],
        recorded_by=row["recorded_by"],
        created_at=row["created_at"],
        voided_at=row["voided_at"],
        voided_by=row["voided_by"],
        void_reason=row["void_reason"],
    )


@app.post("/api/expenses/{expense_id}/void", response_model=ExpenseRecord)
def void_expense(
    expense_id: int,
    payload: ExpenseVoidRequest,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.begin() as connection:
        staff_id, branch_id = require_finance_staff(connection, user.id, write_access=True)
        expense = connection.execute(
            text(
                """
                SELECT
                    expenses.id, expenses.expense_number, expenses.branch_id,
                    expenses.expense_date, expenses.category, expenses.description,
                    expenses.supplier_name, expenses.currency, expenses.amount,
                    expenses.payment_method, expenses.receipt_document_key,
                    expenses.status, expenses.recorded_by, expenses.created_at,
                    expenses.voided_at, expenses.voided_by, expenses.void_reason
                FROM public.business_expenses AS expenses
                WHERE expenses.id = :expense_id AND expenses.branch_id = :branch_id
                FOR UPDATE OF expenses
                """
            ),
            {"expense_id": expense_id, "branch_id": branch_id},
        ).mappings().one_or_none()
        if expense is None:
            raise HTTPException(status_code=404, detail="Expense not found in your branch.")
        if expense["status"] == "void":
            raise HTTPException(status_code=409, detail="This expense has already been voided.")

        voided_at = connection.execute(text("SELECT NOW()")).scalar_one()
        connection.execute(
            text(
                """
                UPDATE public.business_expenses
                SET status = 'void',
                    voided_at = :voided_at,
                    voided_by = :voided_by,
                    void_reason = :void_reason
                WHERE id = :expense_id
                """
            ),
            {
                "voided_at": voided_at,
                "voided_by": staff_id,
                "void_reason": payload.reason,
                "expense_id": expense_id,
            },
        )

        connection.execute(
            text(
                """
                INSERT INTO public.activity_logs
                    (user_id, branch_id, action, entity_type, entity_id, details_json)
                VALUES (
                    :user_id, :branch_id, 'expense.voided', 'expense', :expense_id,
                    jsonb_build_object('reason', CAST(:reason AS text))
                )
                """
            ),
            {
                "user_id": staff_id,
                "branch_id": branch_id,
                "expense_id": expense_id,
                "reason": payload.reason,
            },
        )

    return ExpenseRecord(
        id=expense["id"],
        expense_number=expense["expense_number"],
        branch_id=expense["branch_id"],
        expense_date=expense["expense_date"],
        category=expense["category"],
        category_label=EXPENSE_CATEGORY_LABELS.get(expense["category"], expense["category"]),
        description=expense["description"],
        supplier_name=expense["supplier_name"],
        currency=expense["currency"],
        amount=expense["amount"],
        payment_method=expense["payment_method"],
        receipt_document_key=expense["receipt_document_key"],
        status="void",
        recorded_by=expense["recorded_by"],
        created_at=expense["created_at"],
        voided_at=voided_at,
        voided_by=staff_id,
        void_reason=payload.reason,
    )


# ============================================================================
# Financial Reports
# ============================================================================
@app.get("/api/financial-reports/payment-methods")
def payment_methods_report(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        rows = connection.execute(
            text(
                """
                SELECT payment_method, currency, COUNT(*) AS count, SUM(amount) AS total_amount
                FROM public.customer_payments
                WHERE branch_id = :branch_id AND status = 'confirmed'
                  AND (CAST(:start_date AS date) IS NULL OR DATE(received_at) >= CAST(:start_date AS date))
                  AND (CAST(:end_date AS date) IS NULL OR DATE(received_at) <= CAST(:end_date AS date))
                GROUP BY payment_method, currency
                """
            ),
            {"branch_id": branch_id, "start_date": start_date, "end_date": end_date},
        ).mappings().all()
        return {"items": [dict(row) for row in rows]}
CUSTOMER_BALANCE_SQL = """
    SELECT
        invoices.customer_id,
        customers.display_name AS customer_name,
        invoices.currency,
        COUNT(*) AS invoice_count,
        COALESCE(SUM(invoices.grand_total), 0) AS invoiced_total,
        COALESCE(SUM(COALESCE((
            SELECT SUM(allocations.amount)
            FROM public.payment_allocations AS allocations
            WHERE allocations.invoice_id = invoices.id
        ), 0)), 0) AS paid_total,
        MIN(invoices.due_date) AS oldest_due_date
    FROM public.invoices AS invoices
    JOIN public.bookings AS bookings ON bookings.id = invoices.booking_id
    JOIN public.customers AS customers ON customers.id = invoices.customer_id
    WHERE invoices.status IN ('draft', 'issued', 'partially_paid')
        AND (
            CAST(:start_date AS date) IS NULL 
            OR DATE(COALESCE(invoices.issue_date, invoices.created_at)) >= CAST(:start_date AS date)
        )
        AND (
            CAST(:end_date AS date) IS NULL 
            OR DATE(COALESCE(invoices.issue_date, invoices.created_at)) <= CAST(:end_date AS date)
        )
    GROUP BY invoices.customer_id, customers.display_name, invoices.currency
"""



def load_customer_balances(
    connection, branch_id: int, start_date: date | None, end_date: date | None
) -> list[CustomerBalanceRecord]:
    rows = connection.execute(
        text(CUSTOMER_BALANCE_SQL),
        {"branch_id": branch_id, "start_date": start_date, "end_date": end_date},
    ).mappings().all()

    records = []
    for row in rows:
        invoiced = row["invoiced_total"] or Decimal("0")
        paid = row["paid_total"] or Decimal("0")
        outstanding = invoiced - paid
        if outstanding <= 0:
            continue
        records.append(
            CustomerBalanceRecord(
                customer_id=row["customer_id"],
                customer_name=row["customer_name"],
                currency=row["currency"],
                invoice_count=int(row["invoice_count"]),
                invoiced_total=invoiced,
                paid_total=paid,
                outstanding_total=outstanding,
                oldest_due_date=row["oldest_due_date"],
            )
        )
    records.sort(key=lambda item: item.outstanding_total, reverse=True)
    return records


@app.get("/api/financial-reports/customer-balances", response_model=CustomerBalanceReport)
def customer_balance_report(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        as_of_date = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()
        items = load_customer_balances(connection, branch_id, start_date, end_date)
    # ... rest of totals mapping ...

    totals: dict[str, InvoiceReportCurrencyTotal] = {}
    for item in items:
        entry = totals.get(item.currency)
        if entry is None:
            totals[item.currency] = InvoiceReportCurrencyTotal(
                currency=item.currency,
                invoice_count=item.invoice_count,
                subtotal=Decimal("0"),
                tax_total=Decimal("0"),
                discount_total=Decimal("0"),
                grand_total=item.outstanding_total,
            )
        else:
            entry.invoice_count += item.invoice_count
            entry.grand_total += item.outstanding_total

    return CustomerBalanceReport(
        as_of_date=as_of_date,
        items=items,
        totals_by_currency=[totals[key] for key in sorted(totals)],
    )


@app.get("/api/financial-reports/customer-balances.csv")
def customer_balance_report_csv(
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        as_of_date = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()
        items = load_customer_balances(connection, branch_id)

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([
        "Customer ID",
        "Customer",
        "Currency",
        "Open invoices",
        "Invoiced total",
        "Paid to date",
        "Outstanding total",
        "Oldest due date",
    ])
    for item in items:
        writer.writerow([
            item.customer_id,
            item.customer_name,
            item.currency.strip(),
            item.invoice_count,
            f"{item.invoiced_total:.4f}",
            f"{item.paid_total:.4f}",
            f"{item.outstanding_total:.4f}",
            item.oldest_due_date.isoformat() if item.oldest_due_date else "",
        ])

    filename = f"customer-balances-{as_of_date.isoformat()}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class SupplierBalanceRecord(BaseModel):
    supplier_id: int
    supplier_name: str
    currency: str
    bill_count: int
    billed_total: Decimal
    paid_total: Decimal
    outstanding_total: Decimal
    overdue_total: Decimal
    overdue_bill_count: int
    oldest_due_date: date | None


class SupplierBalanceCurrencyTotal(BaseModel):
    currency: str
    bill_count: int
    billed_total: Decimal
    paid_total: Decimal
    outstanding_total: Decimal
    overdue_total: Decimal


class SupplierCostReconciliationRecord(BaseModel):
    booking_id: int
    booking_code: str
    supplier_id: int
    supplier_name: str
    currency: str
    billed_total: Decimal
    ticket_fare_total: Decimal
    variance: Decimal


class SupplierBalanceReport(BaseModel):
    as_of_date: date
    items: list[SupplierBalanceRecord]
    totals_by_currency: list[SupplierBalanceCurrencyTotal]
    reconciliation: list[SupplierCostReconciliationRecord]
    basis_note: str


SUPPLIER_BALANCE_SQL = """
    SELECT
        bills.supplier_id,
        COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name) AS supplier_name,
        bills.currency,
        COUNT(*) AS bill_count,
        COALESCE(SUM(bills.amount), 0) AS billed_total,
        COALESCE(SUM(COALESCE((
            SELECT SUM(payments.amount)
            FROM public.supplier_payments AS payments
            WHERE payments.supplier_bill_id = bills.id
                AND payments.status = 'confirmed'
        ), 0)), 0) AS paid_total,
        COUNT(*) FILTER (
            WHERE bills.due_date IS NOT NULL
                AND bills.due_date < :as_of_date
                AND bills.status IN ('unpaid', 'partially_paid')
        ) AS overdue_bill_count,
        COALESCE(SUM(
            CASE
                WHEN bills.due_date IS NOT NULL
                    AND bills.due_date < :as_of_date
                    AND bills.status IN ('unpaid', 'partially_paid')
                THEN bills.amount - COALESCE((
                    SELECT SUM(payments.amount)
                    FROM public.supplier_payments AS payments
                    WHERE payments.supplier_bill_id = bills.id
                        AND payments.status = 'confirmed'
                ), 0)
                ELSE 0
            END
        ), 0) AS overdue_total,
        MIN(bills.due_date) FILTER (
            WHERE bills.due_date IS NOT NULL
                AND bills.status IN ('unpaid', 'partially_paid')
        ) AS oldest_due_date
    FROM public.supplier_bills AS bills
    JOIN public.suppliers AS suppliers ON suppliers.id = bills.supplier_id
    WHERE bills.branch_id = :branch_id
        AND bills.status <> 'void'
        AND (CAST(:start_date AS date) IS NULL OR DATE(bills.bill_date) >= CAST(:start_date AS date))
        AND (CAST(:end_date AS date) IS NULL OR DATE(bills.bill_date) <= CAST(:end_date AS date))
    GROUP BY
        bills.supplier_id,
        COALESCE(NULLIF(suppliers.trading_name, ''), suppliers.legal_name),
        bills.currency
"""


def load_supplier_balances(
    connection, branch_id: int, as_of_date: date, start_date: date | None, end_date: date | None
) -> list[SupplierBalanceRecord]:
    rows = connection.execute(
        text(SUPPLIER_BALANCE_SQL),
        {"branch_id": branch_id, "as_of_date": as_of_date, "start_date": start_date, "end_date": end_date},
    ).mappings().all()
    # ...
    records = []
    for row in rows:
        billed = row["billed_total"] or Decimal("0")
        paid = row["paid_total"] or Decimal("0")
        outstanding = billed - paid
        if outstanding <= 0:
            continue
        records.append(
            SupplierBalanceRecord(
                supplier_id=row["supplier_id"],
                supplier_name=row["supplier_name"],
                currency=row["currency"],
                bill_count=int(row["bill_count"]),
                billed_total=billed,
                paid_total=paid,
                outstanding_total=outstanding,
                overdue_total=row["overdue_total"] or Decimal("0"),
                overdue_bill_count=int(row["overdue_bill_count"]),
                oldest_due_date=row["oldest_due_date"],
            )
        )
    records.sort(key=lambda item: item.outstanding_total, reverse=True)
    return records


def load_supplier_reconciliation(
    connection, branch_id: int
) -> list[SupplierCostReconciliationRecord]:
    rows = connection.execute(
        text(SUPPLIER_RECONCILIATION_SQL),
        {"branch_id": branch_id},
    ).mappings().all()

    records = []
    for row in rows:
        billed = row["billed_total"] or Decimal("0")
        ticket_fares = row["ticket_fare_total"] or Decimal("0")
        if billed <= 0 or ticket_fares <= 0:
            continue
        records.append(
            SupplierCostReconciliationRecord(
                booking_id=row["booking_id"],
                booking_code=row["booking_code"],
                supplier_id=row["supplier_id"],
                supplier_name=row["supplier_name"],
                currency=row["currency"],
                billed_total=billed,
                ticket_fare_total=ticket_fares,
                variance=billed - ticket_fares,
            )
        )
    records.sort(key=lambda item: item.booking_code)
    return records


@app.get("/api/financial-reports/supplier-balances", response_model=SupplierBalanceReport)
def supplier_balance_report(
    user: AuthenticatedUser = Depends(get_authenticated_user),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        as_of_date = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()
        items = load_supplier_balances(connection, branch_id, as_of_date)
        reconciliation = load_supplier_reconciliation(connection, branch_id)

    totals: dict[str, SupplierBalanceCurrencyTotal] = {}
    for item in items:
        entry = totals.get(item.currency)
        if entry is None:
            totals[item.currency] = SupplierBalanceCurrencyTotal(
                currency=item.currency,
                bill_count=item.bill_count,
                billed_total=item.billed_total,
                paid_total=item.paid_total,
                outstanding_total=item.outstanding_total,
                overdue_total=item.overdue_total,
            )
        else:
            entry.bill_count += item.bill_count
            entry.billed_total += item.billed_total
            entry.paid_total += item.paid_total
            entry.outstanding_total += item.outstanding_total
            entry.overdue_total += item.overdue_total

    return SupplierBalanceReport(
        as_of_date=as_of_date,
        items=items,
        totals_by_currency=[totals[key] for key in sorted(totals)],
        reconciliation=reconciliation,
        basis_note=SUPPLIER_COST_BASIS_NOTE,
    )


@app.get("/api/financial-reports/supplier-balances.csv")
def supplier_balance_report_csv(
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        as_of_date = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()
        items = load_supplier_balances(connection, branch_id, as_of_date)

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([
        "Supplier ID",
        "Supplier",
        "Currency",
        "Bills",
        "Billed total",
        "Paid to date",
        "Outstanding total",
        "Overdue total",
        "Overdue bills",
        "Oldest due date",
    ])
    for item in items:
        writer.writerow([
            item.supplier_id,
            item.supplier_name,
            item.currency.strip(),
            item.bill_count,
            f"{item.billed_total:.4f}",
            f"{item.paid_total:.4f}",
            f"{item.outstanding_total:.4f}",
            f"{item.overdue_total:.4f}",
            item.overdue_bill_count,
            item.oldest_due_date.isoformat() if item.oldest_due_date else "",
        ])

    filename = f"supplier-balances-{as_of_date.isoformat()}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class ExpenseCategoryTotal(BaseModel):
    category: ExpenseCategory
    category_label: str
    currency: str
    amount: Decimal


class ExpenseSummaryReport(BaseModel):
    as_of_date: date
    date_from: date | None
    date_to: date | None
    total_by_currency: list[CurrencyTotal]
    by_category: list[ExpenseCategoryTotal]
    voided_count: int


@app.get("/api/financial-reports/expense-summary", response_model=ExpenseSummaryReport)
def expense_summary_report(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    date_from = optional_query(date_from)
    date_to = optional_query(date_to)
    with engine.connect() as connection:
        _, branch_id = require_finance_staff(connection, user.id)
        as_of_date = connection.execute(text("SELECT CURRENT_DATE")).scalar_one()

        filters = "expenses.branch_id = :branch_id AND expenses.status = 'recorded'"
        params: dict[str, object] = {"branch_id": branch_id}
        if date_from is not None:
            filters += " AND expenses.expense_date >= :date_from"
            params["date_from"] = date_from
        if date_to is not None:
            filters += " AND expenses.expense_date <= :date_to"
            params["date_to"] = date_to

        rows = connection.execute(
            text(
                f"""
                SELECT
                    expenses.category,
                    expenses.currency,
                    COALESCE(SUM(expenses.amount), 0) AS amount
                FROM public.business_expenses AS expenses
                WHERE {filters}
                GROUP BY expenses.category, expenses.currency
                ORDER BY expenses.category, expenses.currency
                """
            ),
            params,
        ).mappings().all()

        voided_count = connection.execute(
            text(
                """
                SELECT COUNT(*)
                FROM public.business_expenses AS expenses
                WHERE expenses.branch_id = :branch_id AND expenses.status = 'void'
                """
            ),
            {"branch_id": branch_id},
        ).scalar_one()

    totals: dict[str, Decimal] = {}
    by_category = []
    for row in rows:
        totals[row["currency"]] = totals.get(row["currency"], Decimal("0")) + row["amount"]
        by_category.append(
            ExpenseCategoryTotal(
                category=row["category"],
                category_label=EXPENSE_CATEGORY_LABELS.get(row["category"], row["category"]),
                currency=row["currency"],
                amount=row["amount"],
            )
        )

    return ExpenseSummaryReport(
        as_of_date=as_of_date,
        date_from=date_from,
        date_to=date_to,
        total_by_currency=[
            CurrencyTotal(currency=code, amount=totals[code]) for code in sorted(totals)
        ],
        by_category=by_category,
        voided_count=int(voided_count),
    )


class ParsedPassenger(BaseModel):
    first_name: str
    middle_name: str
    last_name: str
    passenger_type: str

class ParsedSegment(BaseModel):
    origin_airport: str
    destination_airport: str
    marketing_carrier: str
    flight_number: str
    departure_at: str
    arrival_at: str
    booking_class: str
    cabin: str

class ItineraryExtraction(BaseModel):
    passengers: list[ParsedPassenger]
    segments: list[ParsedSegment]

class ParseRequest(BaseModel):
    raw_text: str

@app.post("/api/parse-itinerary", response_model=ItineraryExtraction)
def parse_itinerary(
    payload: ParseRequest,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    if client is None:
        raise HTTPException(
            status_code=503, 
            detail="OpenAI API key is missing or invalid in the .env file."
        )
    
    if not payload.raw_text or not payload.raw_text.strip():
        raise HTTPException(status_code=400, detail="No itinerary text provided.")

    system_prompt = (
        "You are an expert travel data extractor. Read the provided raw GDS or airline portal text. "
        "Extract all passengers and flight segments into the requested format. "
        "If the year is missing from a flight date, assume the current year. "
        "Ensure all airport codes are 3-letter IATA codes. "
        "Ensure marketing_carrier is a 2-letter IATA code. "
        "Map cabins strictly to: 'Economy', 'Premium Economy', 'Business', or 'First'."
    )
    
    try:
        response = client.beta.chat.completions.parse(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": payload.raw_text},
            ],
            response_format=ItineraryExtraction,
        )
        return response.choices[0].message.parsed
        
    except Exception as e:
        logger.error(f"AI Parsing Error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to parse itinerary: {str(e)}")
    
