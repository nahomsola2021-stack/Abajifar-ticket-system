import { getAppConfig } from './config';
import type { StaffIdentity, DashboardOverview, DashboardCurrencyTotal, AuthErrorState } from '../types/auth';
import type {
  StaffAdminOptions,
  StaffAdminRecord,
  StaffCreateInput,
  StaffLinkInput,
} from '../types/admin';
import type {
  BookingCreateInput,
  BookingDetails,
  BookingListResponse,
  BookingPassengerCreateInput,
  BookingPassengerRecord,
  BookingRecord,
  BookingStatusHistoryEntry,
  BookingStatus,
  CustomerCreateInput,
  CustomerListResponse,
  CustomerRecord,
  FlightSegmentCreateInput,
  FlightSegmentRecord,
  TicketCreateInput,
  TicketRecord,
  TicketSaleBookingSummary,
  TicketSaleCreateInput,
  TicketSaleRecord,
  TicketSupplierRecord,
  SupplierCreateInput,
  SupplierRecord,
  InvoiceCreateInput,
  InvoiceDetails,
  InvoiceListResponse,
  AllocatableInvoiceRecord,
  InvoiceSalesReport,
  InvoiceStatus,
  PaymentAllocationCreateInput,
  PaymentAllocationRecord,
  PaymentCreateInput,
  PaymentListResponse,
  PaymentRecord,
  CustomerBalanceReport,
  DocumentListResponse,
  DocumentRecord,
  TicketingRequestCreateInput,
  TicketingRequestRecord,
  TicketingRequestStatusUpdateInput,
} from '../types/customer';
import type {
  ExpenseCategory,
  ExpenseCategoryOption,
  ExpenseCreateInput,
  ExpenseListResponse,
  ExpenseRecord,
  ExpenseStatus,
  ExpenseSummaryReport,
  SupplierBalanceReport,
  SupplierBillCreateInput,
  SupplierBillListResponse,
  SupplierBillRecord,
  SupplierBillStatus,
  SupplierPaymentCreateInput,
  SupplierPaymentListResponse,
  SupplierPaymentRecord,
  SupplierPaymentStatus,
} from '../types/finance';

export class ApiError extends Error {
  status?: number;
  code?: string;
  details?: string;

  constructor(message: string, status?: number, code?: string, details?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Optional filters accepted by list endpoints and reporting screens. */
interface ListQueryOptions {
  query?: string;
  q?: string;
  status?: string;
  limit?: number;
  offset?: number;
  start_date?: string;
  end_date?: string;
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

async function getErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      const errorBody = body as Record<string, unknown>;
      const detail = errorBody.detail ?? errorBody.message ?? errorBody.error;
      if (typeof detail === 'string') return detail;
      if (detail !== undefined) return JSON.stringify(detail);
    }
  } catch {
    return response.statusText;
  }
  return response.statusText;
}

function addDateFilters(params: URLSearchParams, options: ListQueryOptions): void {
  if (options.start_date) params.set('start_date', options.start_date);
  if (options.end_date) params.set('end_date', options.end_date);
}

/**
 * Validates and normalizes StaffIdentity response from GET /api/auth/me
 */
function validateStaffIdentity(data: unknown): StaffIdentity {
  if (!data || typeof data !== 'object') {
    throw new ApiError('Invalid identity response: Expected an object', 500, 'INVALID_RESPONSE');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.auth_user_id !== 'string' || !obj.auth_user_id) {
    throw new ApiError('Missing or invalid auth_user_id in staff profile', 500, 'MALFORMED_DATA');
  }

  const staffId = normalizeIdentifier(obj.staff_id);
  if (staffId === null) {
    throw new ApiError('Missing or invalid staff_id in staff profile', 500, 'MALFORMED_DATA');
  }

  if (typeof obj.email !== 'string') {
    throw new ApiError('Missing email in staff profile', 500, 'MALFORMED_DATA');
  }

  if (typeof obj.full_name !== 'string') {
    throw new ApiError('Missing full_name in staff profile', 500, 'MALFORMED_DATA');
  }

  const branch_id = obj.branch_id === null || obj.branch_id === undefined
    ? null
    : normalizeIdentifier(obj.branch_id);
  if (obj.branch_id !== null && obj.branch_id !== undefined && branch_id === null) {
    throw new ApiError('Invalid branch_id in staff profile', 500, 'MALFORMED_DATA');
  }

  let roles: string[] = [];
  if (Array.isArray(obj.roles)) {
    roles = obj.roles.map((r: unknown) => {
      if (typeof r === 'string') return r;
      if (typeof r === 'object' && r !== null) {
        const rObj = r as Record<string, unknown>;
        return String(rObj.role_name || rObj.name || rObj.id || 'Staff');
      }
      return String(r);
    });
  } else if (typeof obj.roles === 'string') {
    roles = obj.roles.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const isActive = obj.is_active !== undefined ? Boolean(obj.is_active) : undefined;
  const status = typeof obj.status === 'string' ? obj.status : undefined;

  if (isActive === false || status?.toLowerCase() === 'inactive' || status?.toLowerCase() === 'suspended') {
    throw new ApiError(
      'Staff account is inactive or suspended. Please contact your Ticket Office branch administrator.',
      403,
      'INACTIVE_ACCOUNT'
    );
  }

  return {
    auth_user_id: obj.auth_user_id,
    staff_id: staffId,
    email: obj.email,
    full_name: obj.full_name,
    branch_id,
    roles,
    is_active: isActive ?? true,
    status: status ?? 'active',
  };
}

/**
 * Validates DashboardOverview response from GET /api/dashboard/overview
 */
function validateDashboardOverview(data: unknown): DashboardOverview {
  if (!data || typeof data !== 'object') {
    throw new ApiError('Invalid overview response: Expected an object', 500, 'INVALID_RESPONSE');
  }

  const obj = data as Record<string, unknown>;

  const COUNT_FIELDS = [
    'branch_count',
    'staff_count',
    'role_count',
    'booking_count',
    'open_booking_count',
    'tickets_issued_count',
    'tickets_voided_count',
    'tickets_exchanged_count',
    'tickets_refunded_count',
    'pending_ticketing_count',
    'upcoming_departures_count',
    'overdue_invoice_count',
  ] as const;

  const counts = {} as Record<(typeof COUNT_FIELDS)[number], number>;
  for (const field of COUNT_FIELDS) {
    const raw = obj[field];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (raw === undefined || raw === null || Number.isNaN(value)) {
      throw new ApiError(
        `Malformed dashboard overview metrics: expected numeric count for ${field}`,
        500,
        'MALFORMED_DATA'
      );
    }
    counts[field] = value;
  }

  const CURRENCY_LIST_FIELDS = [
    'today_sales_by_currency',
    'today_payments_by_currency',
    'outstanding_balance_by_currency',
    'supplier_outstanding_by_currency',
    'month_expenses_by_currency',
  ] as const;

  const currencyLists = {} as Record<(typeof CURRENCY_LIST_FIELDS)[number], DashboardCurrencyTotal[]>;
  for (const field of CURRENCY_LIST_FIELDS) {
    const raw = obj[field];
    if (!Array.isArray(raw)) {
      throw new ApiError(
        `Malformed dashboard overview metrics: expected an array for ${field}`,
        500,
        'MALFORMED_DATA'
      );
    }
    currencyLists[field] = raw.map((entry) => {
      const item = entry as Record<string, unknown>;
      const amount = typeof item.amount === 'number' ? item.amount : Number(item.amount);
      const count = typeof item.count === 'number' ? item.count : Number(item.count);
      if (typeof item.currency !== 'string' || Number.isNaN(amount) || Number.isNaN(count)) {
        throw new ApiError(
          `Malformed dashboard currency total in ${field}`,
          500,
          'MALFORMED_DATA'
        );
      }
      return { currency: item.currency, amount: String(amount), count };
    });
  }

  const rawActivity = obj.recent_activity;
  if (!Array.isArray(rawActivity)) {
    throw new ApiError(
      'Malformed dashboard overview metrics: expected an array for recent_activity',
      500,
      'MALFORMED_DATA'
    );
  }
  const recentActivity = rawActivity.map((entry) => {
    const item = entry as Record<string, unknown>;
    return {
      action: String(item.action ?? ''),
      entity_type: String(item.entity_type ?? ''),
      entity_id: typeof item.entity_id === 'number' ? item.entity_id : null,
      detail: typeof item.detail === 'string' ? item.detail : null,
      actor_name: typeof item.actor_name === 'string' ? item.actor_name : null,
      created_at: String(item.created_at ?? ''),
    };
  });

  return {
    ...counts,
    ...currencyLists,
    recent_activity: recentActivity,
    current_user: obj.current_user,
  };
}

/**
 * Fetch staff identity from GET {VITE_API_URL}/api/auth/me
 */
export async function fetchStaffIdentity(accessToken: string): Promise<StaffIdentity> {
  const { apiUrl } = getAppConfig();

  if (!apiUrl) {
    throw new ApiError(
      'Backend API URL (VITE_API_URL) is not configured.',
      0,
      'ENV_CONFIG_MISSING'
    );
  }

  const endpoint = `${apiUrl}/api/auth/me`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    console.error('Network error fetching staff identity:', err);
    throw new ApiError(
      `Unable to connect to Ticket Office API at ${apiUrl}. Verify server status and CORS configuration.`,
      0,
      'BACKEND_CONNECTION_ERROR',
      err instanceof Error ? err.message : String(err)
    );
  }

  if (response.status === 401) {
    throw new ApiError('Your session has expired. Please sign in again.', 401, 'SESSION_EXPIRED');
  }

  if (response.status === 403) {
    const errorDetail = await getErrorDetail(response);
    throw new ApiError(
      errorDetail || 'Access denied. Contact an administrator to verify your staff account.',
      403,
      'INACTIVE_ACCOUNT'
    );
  }

  if (response.status === 404) {
    const errorDetail = await getErrorDetail(response);
    throw new ApiError(
      errorDetail || 'No associated staff profile was found. An administrator must provision your staff record.',
      404,
      'MISSING_STAFF_PROFILE'
    );
  }

  if (!response.ok) {
    const errorDetail = await getErrorDetail(response);
    throw new ApiError(
      `Failed to load staff profile (${response.status}): ${errorDetail || 'Server error'}`,
      response.status,
      'API_ERROR',
      errorDetail
    );
  }

  const json = await response.json();
  return validateStaffIdentity(json);
}

/**
 * Fetch operations overview metrics from GET {VITE_API_URL}/api/dashboard/overview
 */
export async function fetchDashboardOverview(accessToken: string): Promise<DashboardOverview> {
  const { apiUrl } = getAppConfig();

  if (!apiUrl) {
    throw new ApiError(
      'Backend API URL (VITE_API_URL) is not configured.',
      0,
      'ENV_CONFIG_MISSING'
    );
  }

  const endpoint = `${apiUrl}/api/dashboard/overview`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    console.error('Network error fetching dashboard overview:', err);
    throw new ApiError(
      `Failed to connect to backend overview endpoint at ${apiUrl}. Check CORS headers and connectivity.`,
      0,
      'BACKEND_CONNECTION_ERROR',
      err instanceof Error ? err.message : String(err)
    );
  }

  if (response.status === 401) {
    throw new ApiError('Your session has expired while retrieving operations overview.', 401, 'SESSION_EXPIRED');
  }

  if (response.status === 403) {
    throw new ApiError(
      'Your staff permissions do not permit viewing operations overview metrics.',
      403,
      'INACTIVE_ACCOUNT'
    );
  }

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errBody = await response.json();
      errorDetail = errBody.message || errBody.error || response.statusText;
    } catch {
      errorDetail = response.statusText;
    }
    throw new ApiError(
      `Dashboard overview error (${response.status}): ${errorDetail}`,
      response.status,
      'OVERVIEW_ERROR',
      errorDetail
    );
  }

  const json = await response.json();
  return validateDashboardOverview(json);
}

async function customerRequest<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new ApiError('Backend API URL (VITE_API_URL) is not configured.', 0, 'ENV_CONFIG_MISSING');
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(
      `Could not reach the backend at ${apiUrl}. Check that it is running and that this frontend origin is allowed by CORS. (${reason})`,
      0,
      'BACKEND_CONNECTION_ERROR',
      reason,
    );
  }

  if (!response.ok) {
    const errorDetail = await getErrorDetail(response);
    throw new ApiError(errorDetail || `API request failed (${response.status}).`, response.status, 'API_ERROR', errorDetail);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function fetchCustomers(
  accessToken: string,
  query: string = '',
  limit: number = 50,
  offset: number = 0,
): Promise<CustomerListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  if (safeQuery) params.set('q', safeQuery);
  return customerRequest<CustomerListResponse>(accessToken, `/api/customers?${params.toString()}`);
}

export function createCustomer(
  accessToken: string,
  customer: CustomerCreateInput,
): Promise<CustomerRecord> {
  return customerRequest<CustomerRecord>(accessToken, '/api/customers', {
    method: 'POST',
    body: JSON.stringify(customer),
  });
}

export function deleteCustomer(accessToken: string, customerId: number): Promise<void> {
  return customerRequest<void>(accessToken, `/api/customers/${customerId}`, { method: 'DELETE' });
}

export function deleteBooking(accessToken: string, bookingId: number): Promise<void> {
  return customerRequest<void>(accessToken, `/api/bookings/${bookingId}`, { method: 'DELETE' });
}

export function deleteTicketSale(accessToken: string, saleId: number): Promise<void> {
  return customerRequest<void>(accessToken, `/api/ticket-sales/${saleId}`, { method: 'DELETE' });
}

export function fetchSuppliers(accessToken: string): Promise<SupplierRecord[]> {
  return customerRequest<SupplierRecord[]>(accessToken, '/api/suppliers');
}

export function createSupplier(accessToken: string, supplier: SupplierCreateInput): Promise<SupplierRecord> {
  return customerRequest<SupplierRecord>(accessToken, '/api/suppliers', {
    method: 'POST',
    body: JSON.stringify(supplier),
  });
}

export function updateSupplierStatus(
  accessToken: string,
  supplierId: number,
  isActive: boolean,
): Promise<SupplierRecord> {
  return customerRequest<SupplierRecord>(accessToken, `/api/suppliers/${supplierId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: isActive }),
  });
}

export function fetchInvoices(
  accessToken: string,
  query: string = '',
  status: InvoiceStatus | '' = '',
  limit: number = 50,
  offset: number = 0,
  bookingId?: number,
): Promise<InvoiceListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  if (safeQuery) params.set('q', safeQuery);
  if (status) params.set('status', status);
  if (bookingId) params.set('booking_id', String(bookingId));
  return customerRequest<InvoiceListResponse>(accessToken, `/api/invoices?${params.toString()}`);
}

export function fetchAllocatableInvoices(
  accessToken: string,
  limit: number = 100,
): Promise<AllocatableInvoiceRecord[]> {
  return customerRequest<AllocatableInvoiceRecord[]>(accessToken, `/api/invoices/allocatable?limit=${limit}`);
}

export function fetchInvoiceDetails(accessToken: string, invoiceId: number): Promise<InvoiceDetails> {
  return customerRequest<InvoiceDetails>(accessToken, `/api/invoices/${invoiceId}`);
}

export function createInvoice(accessToken: string, invoice: InvoiceCreateInput): Promise<InvoiceDetails> {
  return customerRequest<InvoiceDetails>(accessToken, '/api/invoices', {
    method: 'POST',
    body: JSON.stringify(invoice),
  });
}

export function issueInvoice(accessToken: string, invoiceId: number): Promise<InvoiceDetails> {
  return customerRequest<InvoiceDetails>(accessToken, `/api/invoices/${invoiceId}/issue`, {
    method: 'POST',
  });
}

export function fetchInvoiceSalesReport(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<InvoiceSalesReport> {
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  return customerRequest<InvoiceSalesReport>(accessToken, `/api/financial-reports/invoices?${params.toString()}`);
}

export function fetchCustomerBalanceReport(
  accessToken: string,
): Promise<CustomerBalanceReport> {
  return customerRequest<CustomerBalanceReport>(accessToken, '/api/financial-reports/customer-balances');
}

export async function downloadCustomerBalancesCsv(accessToken: string): Promise<void> {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new ApiError('Backend API URL (VITE_API_URL) is not configured.', 0, 'ENV_CONFIG_MISSING');
  }

  const response = await fetch(`${apiUrl}/api/financial-reports/customer-balances.csv`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/csv' },
  });
  if (!response.ok) {
    const detail = await getErrorDetail(response);
    throw new ApiError(detail || `Export failed (${response.status}).`, response.status, 'API_ERROR');
  }

  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = 'customer-balances.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

export async function downloadInvoicePdf(accessToken: string, invoiceId: number): Promise<Blob> {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new ApiError('Backend API URL (VITE_API_URL) is not configured.', 0, 'ENV_CONFIG_MISSING');
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/invoices/${invoiceId}/pdf`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/pdf' },
    });
  } catch (error) {
    throw new ApiError(
      `Could not reach the backend at ${apiUrl}. Check that it is running and that this frontend origin is allowed by CORS.`,
      0,
      'BACKEND_CONNECTION_ERROR',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    const detail = await getErrorDetail(response);
    throw new ApiError(detail || `PDF download failed (${response.status}).`, response.status, 'API_ERROR');
  }
  return response.blob();
}

export function fetchBookings(
  accessToken: string,
  query: string = '',
  status: BookingStatus | '' = '',
  limit: number = 50,
  offset: number = 0,
): Promise<BookingListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  if (safeQuery) params.set('q', safeQuery);
  if (status) params.set('status', status);
  return customerRequest<BookingListResponse>(accessToken, `/api/bookings?${params.toString()}`);
}

export function createBooking(accessToken: string, booking: BookingCreateInput): Promise<BookingRecord> {
  return customerRequest<BookingRecord>(accessToken, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify(booking),
  });
}

export function updateBookingStatus(
  accessToken: string,
  bookingId: number,
  status: BookingStatus,
): Promise<BookingRecord> {
  return customerRequest<BookingRecord>(accessToken, `/api/bookings/${bookingId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function fetchBookingStatusHistory(
  accessToken: string,
  bookingId: number,
): Promise<BookingStatusHistoryEntry[]> {
  return customerRequest<BookingStatusHistoryEntry[]>(accessToken, `/api/bookings/${bookingId}/history`);
}

export function fetchBookingDetails(accessToken: string, bookingId: number): Promise<BookingDetails> {
  return customerRequest<BookingDetails>(accessToken, `/api/bookings/${bookingId}/details`);
}

export function fetchTicketSuppliers(accessToken: string): Promise<TicketSupplierRecord[]> {
  return customerRequest<SupplierRecord[]>(accessToken, '/api/suppliers?ticketing_only=true')
    .then((suppliers) => suppliers.map((supplier) => ({
      id: supplier.id,
      supplier_type: supplier.supplier_type as TicketSupplierRecord['supplier_type'],
      display_name: supplier.trading_name || supplier.legal_name,
      settlement_currency: supplier.settlement_currency,
    })));
}

export function recordBookingTicket(
  accessToken: string,
  bookingId: number,
  ticket: TicketCreateInput,
): Promise<TicketRecord> {
  return customerRequest<TicketRecord>(accessToken, `/api/bookings/${bookingId}/tickets`, {
    method: 'POST',
    body: JSON.stringify(ticket),
  });
}

export function addBookingPassenger(
  accessToken: string,
  bookingId: number,
  passenger: BookingPassengerCreateInput,
): Promise<BookingPassengerRecord> {
  return customerRequest<BookingPassengerRecord>(accessToken, `/api/bookings/${bookingId}/passengers`, {
    method: 'POST',
    body: JSON.stringify(passenger),
  });
}

export function addFlightSegment(
  accessToken: string,
  bookingId: number,
  segment: FlightSegmentCreateInput,
): Promise<FlightSegmentRecord> {
  return customerRequest<FlightSegmentRecord>(accessToken, `/api/bookings/${bookingId}/segments`, {
    method: 'POST',
    body: JSON.stringify(segment),
  });
}

/**
 * Fetch ticket sales.
 *
 * Supports both existing page calls:
 *   fetchTicketSales(token, query, status, limit, offset)
 * and report-style calls:
 *   fetchTicketSales(token, { start_date, end_date, limit })
 *   fetchTicketSales(token, '')
 *
 * Defaults prevent limit=undefined/offset=undefined from being sent when
 * a reporting component only supplies the access token and an empty query.
 */
export async function fetchTicketSales(token: string, search: string = '', startDate?: string, endDate?: string) {
  const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000';
  let url = `${API_URL}/api/ticket-sales?limit=1000&offset=0`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  if (startDate) url += `&start_date=${startDate}`;
  if (endDate) url += `&end_date=${endDate}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Failed to fetch tickets');
  return res.json();
}

export function createTicketSale(
  accessToken: string,
  sale: TicketSaleCreateInput,
): Promise<TicketSaleRecord> {
  return customerRequest<TicketSaleRecord>(accessToken, '/api/ticket-sales', {
    method: 'POST',
    body: JSON.stringify(sale),
  });
}

export function updateTicketSale(
  accessToken: string,
  saleId: number,
  update: TicketSaleCreateInput,
): Promise<TicketSaleRecord> {
  return customerRequest<TicketSaleRecord>(accessToken, `/api/ticket-sales/${saleId}`, {
    method: 'PATCH',
    body: JSON.stringify(update),
  });
}

export function fetchBookingSaleSummary(
  accessToken: string,
  bookingId: number,
): Promise<TicketSaleBookingSummary> {
  return customerRequest<TicketSaleBookingSummary>(accessToken, `/api/bookings/${bookingId}/sale-summary`);
}

/** Maps raw error into structured AuthErrorState */
export function formatAuthError(error: unknown): AuthErrorState {
  if (error instanceof ApiError) {
    return {
      code: (error.code as AuthErrorState['code']) || 'UNKNOWN',
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('invalid login credentials') || msg.includes('invalid credentials')) {
      return {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password. Please verify your credentials and try again.',
      };
    }
    if (msg.includes('email not confirmed')) {
      return {
        code: 'INVALID_CREDENTIALS',
        message: 'Email address has not been confirmed. Please check your invitation email.',
      };
    }
    if (msg.includes('jwt expired') || msg.includes('token expired') || msg.includes('session expired')) {
      return {
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please sign in again.',
      };
    }
    if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('cors')) {
      return {
        code: 'BACKEND_CONNECTION_ERROR',
        message: 'Connection failed. Could not reach the authentication or backend server.',
        details: error.message,
      };
    }

    return {
      code: 'UNKNOWN',
      message: error.message,
    };
  }

  return {
    code: 'UNKNOWN',
    message: 'An unexpected error occurred. Please contact support.',
  };
}

/**
 * Fetch customer payments.
 * Supports ordinary search calls and report-style filter objects.
 */
export function fetchPayments(
  accessToken: string,
  queryOrOptions: string | ListQueryOptions = '',
  limit: number = 500,
  offset: number = 0,
): Promise<PaymentListResponse> {
  const params = new URLSearchParams();
  let query = '';

  if (typeof queryOrOptions === 'string') {
    query = queryOrOptions.trim();
  } else if (queryOrOptions && typeof queryOrOptions === 'object') {
    query = String(queryOrOptions.query ?? queryOrOptions.q ?? '').trim();
    if (Number.isFinite(queryOrOptions.limit) && queryOrOptions.limit! > 0) {
      limit = Math.floor(queryOrOptions.limit!);
    }
    if (Number.isFinite(queryOrOptions.offset) && queryOrOptions.offset! >= 0) {
      offset = Math.floor(queryOrOptions.offset!);
    }
    addDateFilters(params, queryOrOptions);
  }

  params.set('limit', String(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500));
  params.set('offset', String(Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0));
  if (query) params.set('q', query);

  return customerRequest<PaymentListResponse>(accessToken, `/api/payments?${params.toString()}`);
}

export function createPayment(
  accessToken: string,
  payment: PaymentCreateInput,
): Promise<PaymentRecord> {
  return customerRequest<PaymentRecord>(accessToken, '/api/payments', {
    method: 'POST',
    body: JSON.stringify(payment),
  });
}

export function allocatePaymentToInvoice(
  accessToken: string,
  paymentId: number,
  allocation: PaymentAllocationCreateInput,
): Promise<PaymentAllocationRecord> {
  return customerRequest<PaymentAllocationRecord>(
    accessToken,
    `/api/payments/${paymentId}/allocations`,
    {
      method: 'POST',
      body: JSON.stringify(allocation),
    },
  );
}

export function removeBookingPassenger(accessToken: string, bookingId: number, passengerId: number): Promise<void> {
  return customerRequest<void>(accessToken, `/api/bookings/${bookingId}/passengers/${passengerId}`, {
    method: 'DELETE',
  });
}

export function removeFlightSegment(accessToken: string, bookingId: number, segmentId: number): Promise<void> {
  return customerRequest<void>(accessToken, `/api/bookings/${bookingId}/segments/${segmentId}`, {
    method: 'DELETE',
  });
}

export function fetchDocuments(
  accessToken: string,
  bookingId: number,
): Promise<DocumentListResponse> {
  const params = new URLSearchParams({ booking_id: String(bookingId) });
  return customerRequest<DocumentListResponse>(accessToken, `/api/documents?${params.toString()}`);
}

export function uploadDocument(
  accessToken: string,
  file: File,
  documentType: string,
  bookingId: number,
): Promise<DocumentRecord> {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new ApiError('Backend API URL (VITE_API_URL) is not configured.', 0, 'ENV_CONFIG_MISSING');
  }

  const form = new FormData();
  form.append('file', file);
  form.append('document_type', documentType);
  form.append('booking_id', String(bookingId));

  return fetch(`${apiUrl}/api/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    body: form,
  }).then(async (response) => {
    if (!response.ok) {
      const detail = await getErrorDetail(response);
      throw new ApiError(detail || `Upload failed (${response.status}).`, response.status, 'API_ERROR');
    }
    return response.json() as Promise<DocumentRecord>;
  });
}

export async function downloadDocument(
  accessToken: string,
  documentId: number,
  filename: string,
): Promise<void> {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new ApiError('Backend API URL (VITE_API_URL) is not configured.', 0, 'ENV_CONFIG_MISSING');
  }

  const response = await fetch(`${apiUrl}/api/documents/${documentId}/download`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: '*/*' },
  });
  if (!response.ok) {
    const detail = await getErrorDetail(response);
    throw new ApiError(detail || `Download failed (${response.status}).`, response.status, 'API_ERROR');
  }

  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

export function fetchTicketingRequests(
  accessToken: string,
  bookingId: number,
): Promise<TicketingRequestRecord[]> {
  return customerRequest<TicketingRequestRecord[]>(
    accessToken,
    `/api/bookings/${bookingId}/ticketing-requests`,
  );
}

export function createTicketingRequest(
  accessToken: string,
  bookingId: number,
  request: TicketingRequestCreateInput,
): Promise<TicketingRequestRecord> {
  return customerRequest<TicketingRequestRecord>(
    accessToken,
    `/api/bookings/${bookingId}/ticketing-requests`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  );
}

export function updateTicketingRequestStatus(
  accessToken: string,
  requestId: number,
  update: TicketingRequestStatusUpdateInput,
): Promise<TicketingRequestRecord> {
  return customerRequest<TicketingRequestRecord>(
    accessToken,
    `/api/ticketing-requests/${requestId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(update),
    },
  );
}

export function fetchSupplierBills(
  accessToken: string,
  query: string = '',
  status: SupplierBillStatus | '' = '',
  limit: number = 50,
  offset: number = 0,
): Promise<SupplierBillListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  if (safeQuery) params.set('q', safeQuery);
  if (status) params.set('status', status);
  return customerRequest<SupplierBillListResponse>(
    accessToken,
    `/api/supplier-bills?${params.toString()}`,
  );
}

export function createSupplierBill(
  accessToken: string,
  bill: SupplierBillCreateInput,
): Promise<SupplierBillRecord> {
  return customerRequest<SupplierBillRecord>(accessToken, '/api/supplier-bills', {
    method: 'POST',
    body: JSON.stringify(bill),
  });
}

export function voidSupplierBill(
  accessToken: string,
  billId: number,
  reason: string,
): Promise<SupplierBillRecord> {
  return customerRequest<SupplierBillRecord>(accessToken, `/api/supplier-bills/${billId}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function fetchSupplierPayments(
  accessToken: string,
  query: string = '',
  status: SupplierPaymentStatus | '' = '',
  limit: number = 50,
  offset: number = 0,
): Promise<SupplierPaymentListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  if (safeQuery) params.set('q', safeQuery);
  if (status) params.set('status', status);
  return customerRequest<SupplierPaymentListResponse>(
    accessToken,
    `/api/supplier-payments?${params.toString()}`,
  );
}

export function createSupplierPayment(
  accessToken: string,
  billId: number,
  payment: SupplierPaymentCreateInput,
): Promise<SupplierPaymentRecord> {
  return customerRequest<SupplierPaymentRecord>(
    accessToken,
    `/api/supplier-bills/${billId}/payments`,
    {
      method: 'POST',
      body: JSON.stringify(payment),
    },
  );
}

export function fetchExpenses(
  accessToken: string,
  query: string = '',
  category: ExpenseCategory | '' = '',
  status: ExpenseStatus | '' = '',
  limit: number = 50,
  offset: number = 0,
): Promise<ExpenseListResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  if (safeQuery) params.set('q', safeQuery);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  return customerRequest<ExpenseListResponse>(accessToken, `/api/expenses?${params.toString()}`);
}

export function fetchExpenseCategories(
  accessToken: string,
): Promise<ExpenseCategoryOption[]> {
  return customerRequest<ExpenseCategoryOption[]>(accessToken, '/api/expense-categories');
}

export function createExpense(
  accessToken: string,
  expense: ExpenseCreateInput,
): Promise<ExpenseRecord> {
  return customerRequest<ExpenseRecord>(accessToken, '/api/expenses', {
    method: 'POST',
    body: JSON.stringify(expense),
  });
}

export function voidExpense(
  accessToken: string,
  expenseId: number,
  reason: string,
): Promise<ExpenseRecord> {
  return customerRequest<ExpenseRecord>(accessToken, `/api/expenses/${expenseId}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function fetchSupplierBalanceReport(
  accessToken: string,
): Promise<SupplierBalanceReport> {
  return customerRequest<SupplierBalanceReport>(
    accessToken,
    '/api/financial-reports/supplier-balances',
  );
}

export function fetchExpenseSummaryReport(
  accessToken: string,
): Promise<ExpenseSummaryReport> {
  return customerRequest<ExpenseSummaryReport>(
    accessToken,
    '/api/financial-reports/expense-summary',
  );
}

export async function downloadSupplierBalancesCsv(accessToken: string): Promise<void> {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new ApiError('Backend API URL (VITE_API_URL) is not configured.', 0, 'ENV_CONFIG_MISSING');
  }

  const response = await fetch(`${apiUrl}/api/financial-reports/supplier-balances.csv`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/csv' },
  });
  if (!response.ok) {
    const detail = await getErrorDetail(response);
    throw new ApiError(detail || `Export failed (${response.status}).`, response.status, 'API_ERROR');
  }

  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = 'supplier-balances.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

export function fetchStaffAdminOptions(accessToken: string): Promise<StaffAdminOptions> {
  return customerRequest<StaffAdminOptions>(accessToken, '/api/admin/staff/options');
}

export function fetchManagedStaff(accessToken: string): Promise<StaffAdminRecord[]> {
  return customerRequest<StaffAdminRecord[]>(accessToken, '/api/admin/staff');
}

export function linkInvitedStaff(
  accessToken: string,
  input: StaffLinkInput,
): Promise<StaffAdminRecord> {
  return customerRequest<StaffAdminRecord>(accessToken, '/api/admin/staff', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createStaffWithPassword(
  accessToken: string,
  input: StaffCreateInput,
): Promise<StaffAdminRecord> {
  return customerRequest<StaffAdminRecord>(accessToken, '/api/admin/staff/create-with-password', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteStaff(accessToken: string, staffId: number): Promise<void> {
  return customerRequest<void>(accessToken, `/api/admin/staff/${staffId}`, { method: 'DELETE' });
}

export function updateManagedStaff(
  accessToken: string,
  staffId: number,
  input: { branch_id: number; role_ids: number[]; is_active: boolean },
): Promise<StaffAdminRecord> {
  return customerRequest<StaffAdminRecord>(accessToken, `/api/admin/staff/${staffId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function linkStaffSignIn(
  accessToken: string,
  staffId: number,
): Promise<StaffAdminRecord> {
  return customerRequest<StaffAdminRecord>(
    accessToken,
    `/api/admin/staff/${staffId}/link-sign-in`,
    { method: 'POST' },
  );
}

export async function parseItineraryWithAI(token: string, rawText: string) {
  const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000';
  const response = await fetch(`${API_URL}/api/parse-itinerary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ raw_text: rawText }),
  });
  if (!response.ok) {
    throw new Error('Failed to parse itinerary via AI.');
  }
  return response.json();
}

export async function fetchMarginSummary(token: string) {
  const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000';
  const res = await fetch(`${API_URL}/api/reports/margin-summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to load summary');
  return res.json();
}
