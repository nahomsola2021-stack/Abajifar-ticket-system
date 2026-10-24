/**
 * Staff Identity returned by GET /api/auth/me
 */
export interface StaffIdentity {
  auth_user_id: string;
  staff_id: string;
  email: string;
  full_name: string;
  branch_id: string | null;
  roles: string[];
  is_active?: boolean;
  status?: string;
}

/**
 * Currency totals returned by the dashboard. Amounts are never summed across
 * currencies; each currency is reported separately.
 */
export interface DashboardCurrencyTotal {
  currency: string;
  amount: string;
  count: number;
}

/**
 * Recent audited activity entry from the dashboard feed.
 */
export interface DashboardRecentActivity {
  action: string;
  entity_type: string;
  entity_id: number | null;
  detail: string | null;
  actor_name: string | null;
  created_at: string;
}

/**
 * Dashboard Overview returned by GET /api/dashboard/overview
 */
export interface DashboardOverview {
  branch_count: number;
  staff_count: number;
  role_count: number;
  booking_count: number;
  open_booking_count: number;
  tickets_issued_count: number;
  tickets_voided_count: number;
  tickets_exchanged_count: number;
  tickets_refunded_count: number;
  pending_ticketing_count: number;
  upcoming_departures_count: number;
  overdue_invoice_count: number;
  today_sales_by_currency: DashboardCurrencyTotal[];
  today_payments_by_currency: DashboardCurrencyTotal[];
  outstanding_balance_by_currency: DashboardCurrencyTotal[];
  supplier_outstanding_by_currency: DashboardCurrencyTotal[];
  month_expenses_by_currency: DashboardCurrencyTotal[];
  recent_activity: DashboardRecentActivity[];
  current_user?: unknown;
}

/**
 * Auth state error categorization
 */
export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'SESSION_EXPIRED'
  | 'MISSING_STAFF_PROFILE'
  | 'INACTIVE_ACCOUNT'
  | 'BACKEND_CONNECTION_ERROR'
  | 'ENV_CONFIG_MISSING'
  | 'UNKNOWN';

export interface AuthErrorState {
  code: AuthErrorCode;
  message: string;
  details?: string;
}
