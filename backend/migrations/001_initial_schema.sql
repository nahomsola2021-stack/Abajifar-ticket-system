-- Non-IATA Travel Agency Ticket Management System
-- Starter schema for PostgreSQL 16+
-- Currency amounts use NUMERIC(18,4) to support currencies with different minor units.
-- Store timestamps as TIMESTAMPTZ (UTC in the application); convert for display.
-- Run using a migration tool in production rather than editing a live database manually.

BEGIN;

CREATE TABLE branches (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL,
    phone VARCHAR(40),
    email VARCHAR(254),
    address TEXT,
    base_currency CHAR(3) NOT NULL DEFAULT 'ETB',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE roles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT
);

CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_id BIGINT REFERENCES branches(id) ON DELETE RESTRICT,
    email VARCHAR(254) NOT NULL UNIQUE,
    full_name VARCHAR(160) NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_roles (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE customers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_type VARCHAR(20) NOT NULL CHECK (customer_type IN ('individual','corporate')),
    display_name VARCHAR(200) NOT NULL,
    phone VARCHAR(40),
    email VARCHAR(254),
    billing_address TEXT,
    tax_identifier VARCHAR(80),
    notes TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_customers_display_name ON customers (LOWER(display_name));
CREATE INDEX idx_customers_phone ON customers (phone);
CREATE INDEX idx_customers_email ON customers (LOWER(email));

CREATE TABLE passengers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    middle_name VARCHAR(100),
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE,
    gender VARCHAR(30),
    nationality CHAR(2), -- ISO 3166-1 alpha-2; validate in application
    email VARCHAR(254),
    phone VARCHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_passengers_name ON passengers (LOWER(last_name), LOWER(first_name));

-- Sensitive document numbers should be encrypted in the application before being stored.
-- Never use passport or identity-document numbers as ordinary search/log fields.
CREATE TABLE passenger_documents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    passenger_id BIGINT NOT NULL REFERENCES passengers(id) ON DELETE CASCADE,
    document_type VARCHAR(30) NOT NULL CHECK (document_type IN ('passport','national_id','residence_permit','other')),
    document_number_encrypted TEXT NOT NULL,
    issuing_country CHAR(2),
    issue_date DATE,
    expiry_date DATE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expiry_date IS NULL OR issue_date IS NULL OR expiry_date >= issue_date)
);
CREATE INDEX idx_passenger_documents_passenger ON passenger_documents(passenger_id);

CREATE TABLE suppliers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_type VARCHAR(30) NOT NULL CHECK (supplier_type IN ('airline','consolidator','host_agency','gds','hotel','other')),
    legal_name VARCHAR(200) NOT NULL,
    trading_name VARCHAR(200),
    contact_name VARCHAR(160),
    phone VARCHAR(40),
    email VARCHAR(254),
    account_reference VARCHAR(120),
    settlement_currency CHAR(3) NOT NULL DEFAULT 'ETB',
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_suppliers_name ON suppliers (LOWER(legal_name));

CREATE TABLE bookings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_code VARCHAR(30) NOT NULL UNIQUE,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    ticketing_partner_id BIGINT REFERENCES suppliers(id) ON DELETE RESTRICT,
    external_pnr VARCHAR(30),
    reservation_system VARCHAR(60), -- e.g. partner portal/GDS name; not an API credential
    status VARCHAR(30) NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested','quoted','confirmed','ticketing_pending','partially_ticketed','ticketed','cancelled','expired','closed')),
    booking_channel VARCHAR(30) NOT NULL DEFAULT 'office'
        CHECK (booking_channel IN ('office','phone','email','website','whatsapp','corporate','other')),
    assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    customer_notes TEXT,
    internal_notes TEXT,
    ticketing_deadline TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (external_pnr IS NULL OR LENGTH(TRIM(external_pnr)) > 0)
);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_deadline ON bookings(ticketing_deadline) WHERE ticketing_deadline IS NOT NULL;
CREATE INDEX idx_bookings_created_at ON bookings(created_at DESC);
CREATE UNIQUE INDEX uq_booking_partner_pnr ON bookings(ticketing_partner_id, UPPER(external_pnr))
    WHERE ticketing_partner_id IS NOT NULL AND external_pnr IS NOT NULL;

-- Snapshot the passenger's name/details at booking time. A later profile edit must not rewrite history.
CREATE TABLE booking_passengers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    passenger_id BIGINT REFERENCES passengers(id) ON DELETE SET NULL,
    passenger_type VARCHAR(10) NOT NULL DEFAULT 'ADT' CHECK (passenger_type IN ('ADT','CHD','INF')),
    first_name VARCHAR(100) NOT NULL,
    middle_name VARCHAR(100),
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE,
    nationality CHAR(2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_booking_passengers_booking ON booking_passengers(booking_id);

CREATE TABLE flight_segments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    segment_order SMALLINT NOT NULL CHECK (segment_order > 0),
    marketing_carrier CHAR(2),
    operating_carrier CHAR(2),
    flight_number VARCHAR(10),
    origin_airport CHAR(3) NOT NULL,
    destination_airport CHAR(3) NOT NULL,
    departure_at TIMESTAMPTZ NOT NULL,
    arrival_at TIMESTAMPTZ NOT NULL,
    booking_class VARCHAR(10),
    cabin VARCHAR(30),
    fare_basis VARCHAR(30),
    baggage_allowance VARCHAR(120),
    segment_status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
        CHECK (segment_status IN ('scheduled','confirmed','flown','cancelled','changed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (booking_id, segment_order),
    CHECK (arrival_at > departure_at),
    CHECK (origin_airport <> destination_airport)
);
CREATE INDEX idx_flight_segments_departure ON flight_segments(departure_at);

-- Keep each quote version. Do not silently overwrite a quote after it has been sent to a customer.
CREATE TABLE booking_quotes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    version_no INTEGER NOT NULL CHECK (version_no > 0),
    customer_currency CHAR(3) NOT NULL,
    supplier_currency CHAR(3) NOT NULL,
    supplier_cost NUMERIC(18,4) NOT NULL CHECK (supplier_cost >= 0),
    supplier_fx_rate_to_customer NUMERIC(20,8) NOT NULL DEFAULT 1 CHECK (supplier_fx_rate_to_customer > 0),
    base_fare NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (base_fare >= 0),
    taxes NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (taxes >= 0),
    service_fee NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (service_fee >= 0),
    other_charges NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (other_charges >= 0),
    discount NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    customer_total NUMERIC(18,4) NOT NULL CHECK (customer_total >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','sent','accepted','rejected','expired','superseded')),
    valid_until TIMESTAMPTZ,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (booking_id, version_no)
);
CREATE UNIQUE INDEX uq_one_accepted_quote_per_booking ON booking_quotes(booking_id)
    WHERE status = 'accepted';
CREATE INDEX idx_booking_quotes_booking ON booking_quotes(booking_id, created_at DESC);

CREATE TABLE ticketing_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    partner_request_reference VARCHAR(120),
    status VARCHAR(30) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','partner_confirmed','ticketed','rejected','cancelled','expired')),
    ticketing_deadline TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    responded_at TIMESTAMPTZ,
    partner_cost NUMERIC(18,4) CHECK (partner_cost IS NULL OR partner_cost >= 0),
    partner_currency CHAR(3),
    response_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ticketing_requests_status_deadline ON ticketing_requests(status, ticketing_deadline);
CREATE INDEX idx_ticketing_requests_booking ON ticketing_requests(booking_id, created_at DESC);

CREATE TABLE tickets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_passenger_id BIGINT NOT NULL REFERENCES booking_passengers(id) ON DELETE RESTRICT,
    issued_by_supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    ticket_number VARCHAR(30) NOT NULL,
    ticket_status VARCHAR(20) NOT NULL DEFAULT 'issued'
        CHECK (ticket_status IN ('issued','voided','refunded','exchanged')),
    issued_at TIMESTAMPTZ,
    original_ticket_id BIGINT REFERENCES tickets(id) ON DELETE RESTRICT,
    fare_amount NUMERIC(18,4) CHECK (fare_amount IS NULL OR fare_amount >= 0),
    currency CHAR(3),
    eticket_document_key TEXT, -- private object-storage key, never a public URL
    verified_at TIMESTAMPTZ,
    verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issued_by_supplier_id, ticket_number)
);
CREATE INDEX idx_tickets_booking_passenger ON tickets(booking_passenger_id);
CREATE INDEX idx_tickets_status ON tickets(ticket_status);

CREATE TABLE ticket_coupons (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
    flight_segment_id BIGINT NOT NULL REFERENCES flight_segments(id) ON DELETE RESTRICT,
    coupon_number SMALLINT NOT NULL CHECK (coupon_number > 0),
    coupon_status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (coupon_status IN ('open','flown','void','refunded','exchanged')),
    UNIQUE (ticket_id, coupon_number),
    UNIQUE (ticket_id, flight_segment_id)
);

CREATE TABLE ticket_actions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
    action_type VARCHAR(20) NOT NULL CHECK (action_type IN ('void','refund','exchange','reissue')),
    status VARCHAR(30) NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested','submitted_to_partner','approved','rejected','completed')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    amount_requested NUMERIC(18,4) CHECK (amount_requested IS NULL OR amount_requested >= 0),
    amount_approved NUMERIC(18,4) CHECK (amount_approved IS NULL OR amount_approved >= 0),
    currency CHAR(3),
    partner_reference VARCHAR(120),
    new_ticket_id BIGINT REFERENCES tickets(id) ON DELETE RESTRICT,
    reason TEXT,
    notes TEXT,
    requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_ticket_actions_status ON ticket_actions(status, requested_at DESC);

CREATE TABLE invoices (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_number VARCHAR(40) NOT NULL UNIQUE,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    booking_id BIGINT REFERENCES bookings(id) ON DELETE RESTRICT,
    currency CHAR(3) NOT NULL,
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','issued','partially_paid','paid','void')),
    subtotal NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    tax_total NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
    discount_total NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
    grand_total NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
    notes TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (due_date IS NULL OR due_date >= issue_date)
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, issue_date DESC);
CREATE INDEX idx_invoices_status ON invoices(status, due_date);

CREATE TABLE invoice_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    booking_id BIGINT REFERENCES bookings(id) ON DELETE RESTRICT,
    ticket_id BIGINT REFERENCES tickets(id) ON DELETE RESTRICT,
    item_type VARCHAR(30) NOT NULL
        CHECK (item_type IN ('airfare','tax','agency_fee','change_fee','cancellation_fee','other')),
    description TEXT NOT NULL,
    quantity NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
    line_total NUMERIC(18,4) NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE customer_payments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    currency CHAR(3) NOT NULL,
    amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(30) NOT NULL
        CHECK (payment_method IN ('cash','bank_transfer','mobile_money','card_gateway','cheque','other')),
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('pending','confirmed','voided')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    external_reference VARCHAR(120),
    receipt_number VARCHAR(40) UNIQUE,
    notes TEXT,
    received_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_customer_payments_customer ON customer_payments(customer_id, received_at DESC);

-- A single receipt may be split across multiple invoices. Application logic must enforce currency match
-- and that total confirmed allocations do not exceed the payment amount, inside a database transaction.
CREATE TABLE payment_allocations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payment_id BIGINT NOT NULL REFERENCES customer_payments(id) ON DELETE RESTRICT,
    invoice_id BIGINT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (payment_id, invoice_id)
);
CREATE INDEX idx_payment_allocations_invoice ON payment_allocations(invoice_id);

CREATE TABLE customer_refunds (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    booking_id BIGINT REFERENCES bookings(id) ON DELETE RESTRICT,
    invoice_id BIGINT REFERENCES invoices(id) ON DELETE RESTRICT,
    original_payment_id BIGINT REFERENCES customer_payments(id) ON DELETE RESTRICT,
    currency CHAR(3) NOT NULL,
    amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(30) NOT NULL
        CHECK (payment_method IN ('cash','bank_transfer','mobile_money','card_gateway','cheque','other')),
    status VARCHAR(20) NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested','approved','paid','rejected')),
    reason TEXT,
    external_reference VARCHAR(120),
    requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_customer_refunds_status ON customer_refunds(status, created_at DESC);

CREATE TABLE supplier_bills (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    booking_id BIGINT REFERENCES bookings(id) ON DELETE RESTRICT,
    supplier_invoice_reference VARCHAR(120),
    currency CHAR(3) NOT NULL,
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    amount NUMERIC(18,4) NOT NULL CHECK (amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
        CHECK (status IN ('unpaid','partially_paid','paid','void')),
    notes TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (due_date IS NULL OR due_date >= bill_date)
);
CREATE INDEX idx_supplier_bills_supplier ON supplier_bills(supplier_id, bill_date DESC);
CREATE INDEX idx_supplier_bills_status ON supplier_bills(status, due_date);

CREATE TABLE supplier_payments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_bill_id BIGINT NOT NULL REFERENCES supplier_bills(id) ON DELETE RESTRICT,
    currency CHAR(3) NOT NULL,
    amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(30) NOT NULL
        CHECK (payment_method IN ('cash','bank_transfer','mobile_money','card_gateway','cheque','other')),
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('pending','confirmed','voided')),
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    external_reference VARCHAR(120),
    notes TEXT,
    paid_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_supplier_payments_bill ON supplier_payments(supplier_bill_id, paid_at DESC);

CREATE TABLE business_expenses (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    category VARCHAR(60) NOT NULL,
    description TEXT NOT NULL,
    supplier_name VARCHAR(200),
    currency CHAR(3) NOT NULL,
    amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(30) NOT NULL
        CHECK (payment_method IN ('cash','bank_transfer','mobile_money','card_gateway','cheque','other')),
    receipt_document_key TEXT,
    recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_business_expenses_branch_date ON business_expenses(branch_id, expense_date DESC);

CREATE TABLE documents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id BIGINT REFERENCES bookings(id) ON DELETE RESTRICT,
    customer_id BIGINT REFERENCES customers(id) ON DELETE RESTRICT,
    passenger_id BIGINT REFERENCES passengers(id) ON DELETE RESTRICT,
    document_type VARCHAR(40) NOT NULL,
    object_key TEXT NOT NULL UNIQUE, -- private object-storage key; do not store public permanent URLs
    original_filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(120),
    file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    sha256_hex CHAR(64),
    uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (booking_id IS NOT NULL OR customer_id IS NOT NULL OR passenger_id IS NOT NULL)
);
CREATE INDEX idx_documents_booking ON documents(booking_id);
CREATE INDEX idx_documents_customer ON documents(customer_id);
CREATE INDEX idx_documents_passenger ON documents(passenger_id);

CREATE TABLE exchange_rates (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    base_currency CHAR(3) NOT NULL,
    quote_currency CHAR(3) NOT NULL,
    rate NUMERIC(20,8) NOT NULL CHECK (rate > 0),
    effective_at TIMESTAMPTZ NOT NULL,
    source VARCHAR(100) NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (base_currency <> quote_currency),
    UNIQUE (base_currency, quote_currency, effective_at, source)
);
CREATE INDEX idx_exchange_rates_lookup ON exchange_rates(base_currency, quote_currency, effective_at DESC);

-- Business and security audit trail. Do not store passwords, tokens, full passport numbers,
-- payment-card data, or unnecessary passenger PII in details_json.
CREATE TABLE activity_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL,
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id BIGINT,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_activity_logs_entity ON activity_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_activity_logs_user ON activity_logs(user_id, created_at DESC);
CREATE INDEX idx_activity_logs_created_at ON activity_logs(created_at DESC);

-- Starter role names. Assign privileges in application code / permission tables as the system grows.
INSERT INTO roles (code, name, description) VALUES
    ('ADMIN', 'Administrator', 'Configure the office and manage users'),
    ('MANAGER', 'Manager', 'Approve financial adjustments, refunds, and sensitive changes'),
    ('AGENT', 'Ticketing Agent', 'Create customers, bookings, quotes, and ticketing requests'),
    ('CASHIER', 'Cashier', 'Record receipts and approved supplier/customer payments'),
    ('ACCOUNTANT', 'Accountant', 'Review invoices, supplier bills, reconciliation, and reports');

COMMIT;

-- IMPORTANT APPLICATION-LEVEL RULES (not fully enforceable using simple row constraints):
-- 1. Use database transactions for booking status changes, quote acceptance, payment allocations,
--    invoice totals, supplier balances, refunds, and ticket issue recording.
-- 2. Reject payment allocation if payment and invoice currencies differ or allocation total exceeds
--    either the payment's unallocated amount or invoice's unpaid balance.
-- 3. Verify a partner-issued ticket before setting a booking to 'ticketed'.
-- 4. Only authorized users may approve refunds, voids, exchanges, write-offs, or backdated payments.
-- 5. Do not delete completed bookings, invoices, payments, tickets, or audit logs; use reversal/void
--    workflows so historical records remain explainable.
-- 6. Store uploaded files in private object storage, scan them, validate file type/size, and require
--    authenticated, authorized downloads using short-lived signed links.
