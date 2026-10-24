export type CustomerType = 'individual' | 'corporate';

export interface CustomerRecord {
  id: number;
  customer_type: CustomerType;
  display_name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
}

export interface CustomerListResponse {
  items: CustomerRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface CustomerCreateInput {
  customer_type: CustomerType;
  display_name: string;
  phone: string;
  email: string;
}

export type BookingStatus =
  | 'requested'
  | 'quoted'
  | 'confirmed'
  | 'ticketing_pending'
  | 'partially_ticketed'
  | 'ticketed'
  | 'cancelled'
  | 'expired'
  | 'closed';

export type BookingChannel = 'office' | 'phone' | 'email' | 'website' | 'whatsapp' | 'corporate' | 'other';

export interface BookingRecord {
  id: number;
  booking_code: string;
  branch_id: number;
  customer_id: number;
  customer_name: string;
  status: BookingStatus;
  booking_channel: BookingChannel;
  external_pnr: string | null;
  reservation_system: string | null;
  customer_notes: string | null;
  created_at: string;
}

export interface BookingListResponse {
  items: BookingRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface BookingCreateInput {
  customer_id: number;
  booking_channel: BookingChannel;
  external_pnr: string;
  reservation_system: string;
  customer_notes: string;
}

export interface BookingStatusHistoryEntry {
  from_status: BookingStatus | null;
  to_status: BookingStatus;
  changed_by: string | null;
  changed_at: string;
}

export type PassengerType = 'ADT' | 'CHD' | 'INF';

export interface BookingPassengerRecord {
  id: number;
  passenger_type: PassengerType;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  created_at: string;
}

export interface BookingPassengerCreateInput {
  passenger_type: PassengerType;
  first_name: string;
  middle_name: string;
  last_name: string;
}

export interface FlightSegmentRecord {
  id: number;
  segment_order: number;
  marketing_carrier: string | null;
  flight_number: string | null;
  origin_airport: string;
  destination_airport: string;
  departure_at: string;
  arrival_at: string;
  booking_class: string | null;
  cabin: string | null;
  segment_status: string;
}

export interface FlightSegmentCreateInput {
  marketing_carrier: string;
  flight_number: string;
  origin_airport: string;
  destination_airport: string;
  departure_at: string;
  arrival_at: string;
  booking_class: string;
  cabin: string;
}

// ---------------------------------------------------------------------------
// Ticket sales (Unified Non-IATA Ticketing Lifecycle)
//
// A TicketSaleRecord acts as the single source of truth for a ticket. 
// It starts as 'pending' (locking in margins/supplier costs) and becomes 
// 'issued' when the final 13-digit ticket_number is provided by the consolidator.
// ---------------------------------------------------------------------------

export type TicketSaleStatus = 'pending' | 'issued' | 'voided' | 'refunded' | 'exchanged';

export interface TicketSaleRecord {
  id: number;
  booking_id: number;
  booking_code: string;
  customer_id: number;
  customer_name: string;
  booking_passenger_id: number;
  passenger_name: string;
  supplier_id: number;
  supplier_name: string;
  ticket_number: string | null;
  ticket_status: TicketSaleStatus;
  issue_date: string | null;
  selling_price: string | null;
  selling_currency: string | null;
  supplier_cost: string | null;
  supplier_cost_currency: string | null;
  fare_amount?: string | null; // Mapped alias for legacy support if needed
  currency?: string | null;    // Mapped alias for legacy support if needed
  gross_margin: string | null;
  margin_computable: boolean;
  notes: string | null;
  created_at: string;
  verified_at?: string | null;
}

// Legacy strictly-issued ticket format (kept for DB backward compatibility)
export interface TicketRecord extends Omit<TicketSaleRecord, 'gross_margin' | 'margin_computable'> {
  issued_at: string | null;
}

export interface TicketSaleListResponse {
  items: TicketSaleRecord[];
  total: number;
  limit: number;
  offset: number;
  selling_total_by_currency: CurrencyTotal[];
  supplier_cost_total_by_currency: CurrencyTotal[];
  gross_margin_by_currency: CurrencyTotal[];
  margin_basis: string;
}

export interface CurrencyTotal {
  currency: string;
  amount: string;
}

export interface TicketSaleBookingSummary {
  booking_id: number;
  booking_code: string;
  sale_count: number;
  pending_count: number;
  issued_count: number;
  selling_total_by_currency: CurrencyTotal[];
  supplier_cost_total_by_currency: CurrencyTotal[];
  gross_margin_by_currency: CurrencyTotal[];
  margin_basis: string;
}

export interface TicketSaleCreateInput {
  booking_id: number;
  booking_passenger_id: number;
  supplier_id: number;
  ticket_number?: string | null;
  selling_price?: number | null;
  selling_currency?: string | null;
  supplier_cost?: number | null;
  supplier_cost_currency?: string | null;
  issue_date?: string | null;
  notes?: string | null;
  verified?: boolean;
}

export interface TicketCreateInput extends TicketSaleCreateInput {
  fare_amount?: number | null;
  currency?: string | null;
}

// ---------------------------------------------------------------------------
// Invoices & Billing
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'overdue' | 'void' | 'cancelled';
export type InvoiceItemType = 'airfare' | 'tax' | 'agency_fee' | 'change_fee' | 'cancellation_fee' | 'other';

export interface InvoiceItemRecord {
  id: number;
  item_type: InvoiceItemType;
  description: string;
  quantity: string;
  unit_price: string;
  line_total: string;
}

export interface InvoiceRecord {
  id: number;
  invoice_number: string;
  customer_id: number;
  customer_name: string;
  booking_id: number;
  booking_code: string;
  currency: string;
  issue_date: string;
  due_date: string | null;
  status: InvoiceStatus;
  subtotal: string;
  tax_total: string;
  discount_total: string;
  grand_total: string;
  item_count: number;
  created_at: string;
}

export interface AllocatableInvoiceRecord {
  id: number;
  invoice_number: string;
  customer_id: number;
  customer_name: string;
  currency: string;
  status: InvoiceStatus;
  due_date: string | null;
  grand_total: string;
  allocated_total: string;
  balance_due: string;
}

export interface InvoiceDetails extends InvoiceRecord {
  notes: string | null;
  items: InvoiceItemRecord[];
}

export interface InvoiceListResponse {
  items: InvoiceRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface InvoiceReportCurrencyTotal {
  currency: string;
  invoice_count: number;
  subtotal: string;
  tax_total: string;
  discount_total: string;
  grand_total: string;
}

export interface InvoiceSalesReport {
  start_date: string;
  end_date: string;
  invoice_count: number;
  by_currency: InvoiceReportCurrencyTotal[];
}

export interface InvoiceCreateItemInput {
  item_type: InvoiceItemType;
  description: string;
  quantity: number;
  unit_price: number;
}

export interface InvoiceCreateInput {
  invoice_number: string;
  booking_id: number;
  currency: string;
  due_date: string | null;
  tax_total: number;
  discount_total: number;
  notes: string;
  items: InvoiceCreateItemInput[];
}

export interface CustomerBalanceRecord {
  customer_id: number;
  customer_name: string;
  currency: string;
  invoice_count: number;
  invoiced_total: string;
  paid_total: string;
  outstanding_total: string;
  oldest_due_date: string | null;
}

export interface CustomerBalanceReport {
  as_of_date: string;
  items: CustomerBalanceRecord[];
  totals_by_currency: InvoiceReportCurrencyTotal[];
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentMethod =
  | 'cash'
  | 'bank_transfer'
  | 'mobile_money'
  | 'card_gateway'
  | 'cheque'
  | 'other';

export type PaymentStatus = 'pending' | 'confirmed' | 'voided';

export interface PaymentRecord {
  id: number;
  customer_id: number;
  customer_name: string;
  currency: string;
  amount: string;
  payment_method: PaymentMethod;
  status: PaymentStatus;
  received_at: string | null;
  external_reference: string | null;
  receipt_number: string | null;
  notes: string | null;
  received_by: number | null;
  created_at: string;
  allocated_total: string;
  unallocated_total: string;
}

export interface PaymentCreateInput {
  customer_id: number;
  currency: string;
  amount: number;
  payment_method?: PaymentMethod;
  status?: PaymentStatus;
  received_at?: string | null;
  external_reference?: string | null;
  receipt_number?: string | null;
  notes?: string | null;
}

export interface PaymentAllocationCreateInput {
  invoice_id: number;
  amount: number;
}

export interface PaymentAllocationRecord {
  id: number;
  payment_id: number;
  invoice_id: number;
  invoice_number: string;
  amount: string;
  allocated_at: string;
}

export interface PaymentListResponse {
  items: PaymentRecord[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Suppliers & Requests
// ---------------------------------------------------------------------------

export type SupplierType = 'airline' | 'consolidator' | 'host_agency' | 'gds' | 'hotel' | 'other';

export interface SupplierRecord {
  id: number;
  supplier_type: SupplierType;
  legal_name: string;
  trading_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  account_reference: string | null;
  settlement_currency: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export interface SupplierCreateInput {
  supplier_type: SupplierType;
  legal_name: string;
  trading_name: string;
  contact_name: string;
  phone: string;
  email: string;
  account_reference: string;
  settlement_currency: string;
  notes: string;
}

export interface TicketSupplierRecord {
  id: number;
  supplier_type: 'airline' | 'consolidator' | 'host_agency';
  display_name: string;
  settlement_currency: string;
}

export type TicketingRequestStatus =
  | 'not_requested'
  | 'pending'
  | 'submitted'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'expired';

export interface TicketingRequestRecord {
  id: number;
  booking_id: number;
  booking_code: string;
  supplier_id: number;
  supplier_name: string;
  status: TicketingRequestStatus;
  ticketing_deadline: string | null;
  partner_request_reference: string | null;
  partner_cost: string | null;
  partner_currency: string | null;
  response_notes: string | null;
  requested_by: number | null;
  requested_by_name: string | null;
  submitted_at: string | null;
  responded_at: string | null;
  created_at: string;
}

export interface TicketingRequestCreateInput {
  supplier_id: number;
  ticketing_deadline?: string | null;
  partner_request_reference?: string | null;
  notes?: string | null;
}

export interface TicketingRequestStatusUpdateInput {
  status: TicketingRequestStatus;
  partner_request_reference?: string | null;
  partner_cost?: number | null;
  partner_currency?: string | null;
  response_notes?: string | null;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentType =
  | 'booking_confirmation'
  | 'itinerary'
  | 'e_ticket'
  | 'passport'
  | 'receipt'
  | 'other';

export interface DocumentRecord {
  id: number;
  document_type: string;
  booking_id: number | null;
  customer_id: number | null;
  passenger_id: number | null;
  original_filename: string;
  content_type: string | null;
  file_size_bytes: number | null;
  sha256_hex: string | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  created_at: string;
}

export interface DocumentListResponse {
  items: DocumentRecord[];
  total: number;
}

// ---------------------------------------------------------------------------
// Master Booking Details (Command Center Payload)
// ---------------------------------------------------------------------------

export interface BookingDetails {
  passengers: BookingPassengerRecord[];
  segments: FlightSegmentRecord[];
  // Upgraded to TicketRecord to match the booking details endpoint payload.
  tickets: TicketRecord[];
  // Optional aggregated data to load the entire Command Center in one API call
  invoices?: InvoiceRecord[];
  ticketing_requests?: TicketingRequestRecord[];
  documents?: DocumentRecord[];
}

// ---------------------------------------------------------------------------
// Financial Dashboard & Management Reports
// ---------------------------------------------------------------------------

export type ExpenseCategoryType =
  | 'salaries_and_wages'
  | 'rent_and_utilities'
  | 'gds_and_software'
  | 'marketing'
  | 'bank_and_gateway_fees'
  | 'office_supplies'
  | 'other_operating';

export interface FinancialSummaryByCurrency {
  currency: string;
  ticket_sales_recorded: string;       // Sales Recorded (Accrual from TicketSaleRecord)
  customer_payments_received: string;  // Cash Received (Confirmed PaymentRecord)
  outstanding_customer_balance: string;// Accounts Receivable (CustomerBalanceRecord)
  outstanding_supplier_balance: string;// Accounts Payable (Supplier liability)
  recorded_operating_expenses: string; // Operating Expenses logged
  ticket_gross_margin: string;         // Selling price minus supplier cost
  refunds_and_adjustments_net: string; // Void/Refund/Exchange net adjustments
  estimated_net_profit: string;        // Gross Margin - Operating Expenses - Adjustments
}

export interface PeriodSalesReportRow {
  period: string; // YYYY-MM-DD (daily) or YYYY-MM (monthly)
  currency: string;
  issued_count: number;
  pending_count: number;
  selling_total: string;
  supplier_cost_total: string;
  gross_margin: string;
}

export interface EmployeeSalesReportRow {
  employee_id: number | null;
  employee_name: string;
  currency: string;
  issued_count: number;
  pending_count: number;
  selling_total: string;
  gross_margin: string;
}

export interface SupplierSalesReportRow {
  supplier_id: number;
  supplier_name: string;
  supplier_type: SupplierType;
  currency: string;
  ticket_count: number;
  supplier_cost_total: string;
  selling_total: string;
  gross_margin: string;
}

export interface SupplierBalanceRecord {
  supplier_id: number;
  supplier_name: string;
  supplier_type: SupplierType;
  currency: string;
  ticket_count: number;
  billed_cost_total: string;
  remitted_total: string;
  outstanding_total: string;
}

export interface ExpenseCategoryReportRow {
  category: ExpenseCategoryType | string;
  currency: string;
  entry_count: number;
  total_amount: string;
}

export interface PaymentMethodReportRow {
  payment_method: PaymentMethod;
  currency: string;
  payment_count: number;
  confirmed_cash_received: string;
  pending_amount: string;
}

export interface RefundAdjustmentReportRow {
  ticket_id: number;
  booking_code: string;
  ticket_number: string | null;
  customer_name: string;
  supplier_name: string;
  ticket_status: Extract<TicketSaleStatus, 'voided' | 'refunded' | 'exchanged'>;
  date: string;
  currency: string;
  selling_price_impact: string;
  supplier_cost_impact: string;
  net_margin_impact: string;
}

export interface FinancialManagementReport {
  start_date: string;
  end_date: string;
  as_of_date: string;
  tickets_issued_count: number;
  tickets_pending_count: number;
  summary_by_currency: FinancialSummaryByCurrency[];
  daily_sales: PeriodSalesReportRow[];
  monthly_sales: PeriodSalesReportRow[];
  sales_by_employee: EmployeeSalesReportRow[];
  sales_by_supplier: SupplierSalesReportRow[];
  supplier_balances: SupplierBalanceRecord[];
  expense_categories: ExpenseCategoryReportRow[];
  payment_methods: PaymentMethodReportRow[];
  refunds_and_adjustments: RefundAdjustmentReportRow[];
}