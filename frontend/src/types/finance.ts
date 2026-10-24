import type { CurrencyTotal, PaymentMethod } from './customer';

export type SupplierBillStatus = 'unpaid' | 'partially_paid' | 'paid' | 'void';

export interface SupplierBillRecord {
  id: number;
  bill_number: string | null;
  supplier_id: number;
  supplier_name: string;
  booking_id: number | null;
  booking_code: string | null;
  supplier_invoice_reference: string | null;
  currency: string;
  bill_date: string;
  due_date: string | null;
  amount: string;
  paid_total: string;
  outstanding_total: string;
  status: SupplierBillStatus;
  notes: string | null;
  created_by: number | null;
  created_at: string;
}

export interface SupplierBillListResponse {
  items: SupplierBillRecord[];
  total: number;
  limit: number;
  offset: number;
  outstanding_by_currency: CurrencyTotal[];
}

export interface SupplierBillCreateInput {
  supplier_id: number;
  booking_id?: number | null;
  supplier_invoice_reference?: string | null;
  currency: string;
  bill_date: string;
  due_date?: string | null;
  amount: number;
  notes?: string | null;
}

export type SupplierPaymentStatus = 'pending' | 'confirmed' | 'voided';

export interface SupplierPaymentRecord {
  id: number;
  supplier_bill_id: number;
  bill_number: string | null;
  supplier_id: number;
  supplier_name: string;
  booking_code: string | null;
  currency: string;
  amount: string;
  payment_method: PaymentMethod;
  status: SupplierPaymentStatus;
  paid_at: string;
  external_reference: string | null;
  notes: string | null;
  paid_by: number | null;
  created_at: string;
}

export interface SupplierPaymentListResponse {
  items: SupplierPaymentRecord[];
  total: number;
  limit: number;
  offset: number;
  paid_by_currency: CurrencyTotal[];
}

export interface SupplierPaymentCreateInput {
  amount: number;
  currency: string;
  payment_method?: PaymentMethod;
  status?: SupplierPaymentStatus;
  paid_at?: string | null;
  external_reference?: string | null;
  notes?: string | null;
}

export type ExpenseCategory =
  | 'rent'
  | 'utilities'
  | 'internet'
  | 'phone'
  | 'transport'
  | 'salary'
  | 'supplies'
  | 'marketing'
  | 'licensing'
  | 'insurance'
  | 'bank_charges'
  | 'maintenance'
  | 'other';

export type ExpenseStatus = 'recorded' | 'void';

export interface ExpenseCategoryOption {
  code: ExpenseCategory;
  label: string;
}

export interface ExpenseRecord {
  id: number;
  expense_number: string | null;
  branch_id: number;
  expense_date: string;
  category: ExpenseCategory;
  category_label: string;
  description: string;
  supplier_name: string | null;
  currency: string;
  amount: string;
  payment_method: PaymentMethod;
  receipt_document_key: string | null;
  status: ExpenseStatus;
  recorded_by: number | null;
  created_at: string;
  voided_at: string | null;
  voided_by: number | null;
  void_reason: string | null;
}

export interface ExpenseListResponse {
  items: ExpenseRecord[];
  total: number;
  limit: number;
  offset: number;
  total_by_currency: CurrencyTotal[];
}

export interface ExpenseCreateInput {
  expense_date: string;
  category: ExpenseCategory;
  description: string;
  supplier_name?: string | null;
  currency: string;
  amount: number;
  payment_method?: PaymentMethod;
  receipt_document_key?: string | null;
}

export interface SupplierBalanceRecord {
  supplier_id: number;
  supplier_name: string;
  currency: string;
  bill_count: number;
  billed_total: string;
  paid_total: string;
  outstanding_total: string;
  overdue_total: string;
  overdue_bill_count: number;
  oldest_due_date: string | null;
}

export interface SupplierBalanceCurrencyTotal {
  currency: string;
  bill_count: number;
  billed_total: string;
  paid_total: string;
  outstanding_total: string;
  overdue_total: string;
}

export interface SupplierCostReconciliationRecord {
  booking_id: number;
  booking_code: string;
  supplier_id: number;
  supplier_name: string;
  currency: string;
  billed_total: string;
  ticket_fare_total: string;
  variance: string;
}

export interface SupplierBalanceReport {
  as_of_date: string;
  items: SupplierBalanceRecord[];
  totals_by_currency: SupplierBalanceCurrencyTotal[];
  reconciliation: SupplierCostReconciliationRecord[];
  basis_note: string;
}

export interface ExpenseCategoryTotal {
  category: ExpenseCategory;
  category_label: string;
  currency: string;
  amount: string;
}

export interface ExpenseSummaryReport {
  as_of_date: string;
  date_from: string | null;
  date_to: string | null;
  total_by_currency: CurrencyTotal[];
  by_category: ExpenseCategoryTotal[];
  voided_count: number;
}
