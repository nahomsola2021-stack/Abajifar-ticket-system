import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../lib/api';

type ReportTab =
  | 'sales_margins'
  | 'customer_balances'
  | 'supplier_balances'
  | 'expenses_payments'
  | 'all_balances';

interface ReportsViewProps {
  onBackToDashboard: () => void;
  currentTab?: string;
  onTabChange?: (tab: string) => void;
}

const NAV_TO_REPORT_TAB: Record<string, ReportTab> = {
  reports: 'sales_margins',
  'reports-sales': 'sales_margins',
  'reports-customer-balances': 'customer_balances',
  'reports-supplier-balances': 'supplier_balances',
  'reports-expenses': 'expenses_payments',
};

const REPORT_TO_NAV_TAB: Record<ReportTab, string> = {
  sales_margins: 'reports-sales',
  customer_balances: 'reports-customer-balances',
  supplier_balances: 'reports-supplier-balances',
  expenses_payments: 'reports-expenses',
  all_balances: 'reports-customer-balances',
};

const REPORT_TABS: { id: ReportTab; label: string; badge?: string }[] = [
  { id: 'sales_margins', label: 'Sales & Margins' },
  { id: 'customer_balances', label: 'Customer Balances' },
  { id: 'supplier_balances', label: 'Supplier Balances' },
  { id: 'expenses_payments', label: 'Expenses & Payments' },
  { id: 'all_balances', label: 'Full Financial Sheet' },
];

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getToday(): string {
  return localDateString(new Date());
}

function getDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateString(date);
}

function getFirstDayOfMonth(): string {
  const date = new Date();
  date.setDate(1);
  return localDateString(date);
}

function getLastMonthRange(): { start: string; end: string } {
  const now = new Date();
  const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  return {
    start: localDateString(firstDayLastMonth),
    end: localDateString(lastDayLastMonth),
  };
}

function getFirstDayOfYear(): string {
  const date = new Date();
  date.setMonth(0, 1);
  return localDateString(date);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  onBackToDashboard,
  currentTab,
  onTabChange,
}) => {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? '';

  const [startDate, setStartDate] = useState(getFirstDayOfMonth);
  const [endDate, setEndDate] = useState(getToday);
  const [activePreset, setActivePreset] = useState<string>('this_month');

  const [activeTab, setActiveTab] = useState<ReportTab>(
    () => NAV_TO_REPORT_TAB[currentTab ?? 'reports-sales'] ?? 'sales_margins'
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const skipNextRouteSync = useRef(false);

  const [marginSummary, setMarginSummary] = useState({
    today: { margin: 0, count: 0 },
    last_7_days: { margin: 0, count: 0 },
    this_month: { margin: 0, count: 0 },
  });

  const [balanceReport, setBalanceReport] = useState<any>(null);
  const [ticketSales, setTicketSales] = useState<any[]>([]);
  const [mgmtReport, setMgmtReport] = useState<any>(null);
  const [extraData, setExtraData] = useState<{
    supplierBills: any[];
    supplierPayments: any[];
    customerPayments: any[];
    expensesList: any[];
  }>({
    supplierBills: [],
    supplierPayments: [],
    customerPayments: [],
    expensesList: [],
  });

  useEffect(() => {
    if (!currentTab) return;
    if (skipNextRouteSync.current) {
      skipNextRouteSync.current = false;
      return;
    }
    const mappedTab = NAV_TO_REPORT_TAB[currentTab];
    if (mappedTab) {
      setActiveTab(mappedTab);
      setSearchQuery('');
    }
  }, [currentTab]);

  const selectReportTab = (tab: ReportTab) => {
    setActiveTab(tab);
    setSearchQuery('');
    const parentTab = REPORT_TO_NAV_TAB[tab];
    if (onTabChange && parentTab && parentTab !== currentTab) {
      skipNextRouteSync.current = true;
      onTabChange(parentTab);
    }
  };

  const applyDatePreset = (preset: string) => {
    setActivePreset(preset);
    const today = getToday();
    if (preset === 'today') {
      setStartDate(today);
      setEndDate(today);
    } else if (preset === 'last_7_days') {
      setStartDate(getDaysAgo(6));
      setEndDate(today);
    } else if (preset === 'this_month') {
      setStartDate(getFirstDayOfMonth());
      setEndDate(today);
    } else if (preset === 'last_month') {
      const { start, end } = getLastMonthRange();
      setStartDate(start);
      setEndDate(end);
    } else if (preset === 'this_year') {
      setStartDate(getFirstDayOfYear());
      setEndDate(today);
    } else if (preset === 'all_time') {
      setStartDate('2020-01-01');
      setEndDate(today);
    }
  };

  useEffect(() => {
    if (!accessToken) {
      setLoadError('Please sign in to view reports.');
      return;
    }

    let isMounted = true;

    const loadData = async () => {
      setLoading(true);
      setLoadError('');
      const extendedApi = api as any;

      try {
        const balanceResult = await api.fetchCustomerBalanceReport(accessToken);
        if (isMounted) setBalanceReport(balanceResult);
      } catch (error) {
        console.error('Failed to load customer balances:', error);
      }

      try {
        if (typeof extendedApi.fetchMarginSummary === 'function') {
          const summaryResult = await extendedApi.fetchMarginSummary(accessToken);
          if (isMounted && summaryResult) setMarginSummary(summaryResult);
        }
      } catch (error) {
        console.error('Failed to load backend margin summary:', error);
      }

      try {
        if (typeof extendedApi.fetchTicketSales === 'function') {
          const result = await extendedApi.fetchTicketSales(accessToken, '', startDate, endDate);
          if (isMounted) {
            const items = Array.isArray(result?.items)
              ? result.items
              : Array.isArray(result)
              ? result
              : [];
            setTicketSales(items);
          }
        }
      } catch (error) {
        console.error('Failed to load ticket sales report:', error);
        if (isMounted) setLoadError('Ticket margin data could not be loaded.');
      }

      try {
        if (typeof extendedApi.fetchFinancialManagementReport === 'function') {
          const result = await extendedApi.fetchFinancialManagementReport(
            accessToken,
            startDate,
            endDate
          );
          if (isMounted && result) setMgmtReport(result);
        }
      } catch (error) {
        console.error('Failed to load financial management report:', error);
      }

      // Optional fallback fetchers if available in api.ts to guarantee rich fallback data
      try {
        const [suppBills, suppPayments, custPayments, expList] = await Promise.all([
          typeof extendedApi.fetchSupplierBills === 'function'
            ? extendedApi.fetchSupplierBills(accessToken).catch(() => null)
            : Promise.resolve(null),
          typeof extendedApi.fetchSupplierPayments === 'function'
            ? extendedApi.fetchSupplierPayments(accessToken).catch(() => null)
            : Promise.resolve(null),
          typeof extendedApi.fetchCustomerPayments === 'function'
            ? extendedApi.fetchCustomerPayments(accessToken).catch(() => null)
            : Promise.resolve(null),
          typeof extendedApi.fetchExpenses === 'function'
            ? extendedApi.fetchExpenses(accessToken).catch(() => null)
            : Promise.resolve(null),
        ]);

        if (isMounted) {
          const unwrap = (val: any) =>
            Array.isArray(val?.items) ? val.items : Array.isArray(val) ? val : [];
          setExtraData({
            supplierBills: unwrap(suppBills),
            supplierPayments: unwrap(suppPayments),
            customerPayments: unwrap(custPayments),
            expensesList: unwrap(expList),
          });
        }
      } catch {
        // Ignore optional fallback errors
      }

      if (isMounted) setLoading(false);
    };

    void loadData();

    return () => {
      isMounted = false;
    };
  }, [accessToken, startDate, endDate]);

  const formatETB = (value: unknown): string => {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 'ETB 0.00';
    return `ETB ${new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)}`;
  };

  // Smart Data Normalization & Cross-Aggregation
  const normalizedData = useMemo(() => {
    const filterEtb = (items?: any[]) =>
      (items ?? []).filter((item) => {
        const curr = item?.currency ?? item?.selling_currency;
        return !curr || curr === 'ETB';
      });

    // 1. Tickets
    const rawTickets = filterEtb(ticketSales).map((row: any) => {
      const sellingPrice = toNumber(row.selling_price);
      const supplierCost = toNumber(row.supplier_cost ?? row.fare_amount);
      const grossMargin =
        row.gross_margin !== undefined && row.gross_margin !== null
          ? toNumber(row.gross_margin)
          : sellingPrice - supplierCost;
      const marginPct = sellingPrice > 0 ? (grossMargin / sellingPrice) * 100 : 0;

      return {
        ...row,
        booking_code: row.booking_code ?? row.pnr ?? '',
        ticket_number: row.ticket_number ?? 'Pending',
        customer_name: row.customer_name || 'Walk-in Customer',
        supplier_name: row.supplier_name || 'Unassigned Supplier',
        selling_price: sellingPrice,
        supplier_cost: supplierCost,
        gross_margin: grossMargin,
        margin_pct: marginPct,
      };
    });

    // 2. Customer Balances
    const rawCustBalances = filterEtb(
      balanceReport?.items ?? balanceReport?.customer_balances ?? (Array.isArray(balanceReport) ? balanceReport : [])
    ).map((row: any) => {
      const invoiced = toNumber(row.invoiced_total ?? row.total_invoiced ?? row.selling_price);
      const paid = toNumber(row.paid_total ?? row.total_paid);
      const outstanding =
        row.outstanding_total !== undefined && row.outstanding_total !== null
          ? toNumber(row.outstanding_total)
          : Math.max(0, invoiced - paid);
      return {
        customer_name: row.customer_name || 'Unknown Customer',
        invoice_count: toNumber(row.invoice_count ?? row.tickets_count ?? 1),
        invoiced_total: invoiced,
        paid_total: paid,
        outstanding_total: outstanding,
      };
    });

    // 3. Supplier Balances (Merge backend mgmtReport + Fallback from Ticket Sales & Supplier Bills)
    const rawSuppFromMgmt = filterEtb(
      mgmtReport?.supplier_balances ?? mgmtReport?.suppliers ?? []
    );

    const supplierMap = new Map<
      string,
      {
        supplier_name: string;
        ticket_count: number;
        billed_cost_total: number;
        remitted_total: number;
        outstanding_total: number;
      }
    >();

    // First populate from mgmtReport if available
    for (const row of rawSuppFromMgmt) {
      const name = String(row.supplier_name || 'Unknown Supplier').trim();
      const billed = toNumber(row.billed_cost_total ?? row.total_billed ?? row.supplier_cost);
      const paid = toNumber(row.remitted_total ?? row.paid_total ?? row.total_paid);
      const outstanding =
        row.outstanding_total !== undefined && row.outstanding_total !== null
          ? toNumber(row.outstanding_total)
          : Math.max(0, billed - paid);

      supplierMap.set(name.toLowerCase(), {
        supplier_name: name,
        ticket_count: toNumber(row.ticket_count ?? row.bills_count ?? 0),
        billed_cost_total: billed,
        remitted_total: paid,
        outstanding_total: outstanding,
      });
    }

    // Fallback: If mgmtReport didn't include suppliers present in Ticket Sales (e.g. Nahom IATA), synthesize from tickets!
    const ticketsBySupplier = new Map<string, { name: string; count: number; cost: number }>();
    for (const t of rawTickets) {
      const name = String(t.supplier_name || 'Unassigned Supplier').trim();
      const key = name.toLowerCase();
      const existing = ticketsBySupplier.get(key) ?? { name, count: 0, cost: 0 };
      existing.count += 1;
      existing.cost += t.supplier_cost;
      ticketsBySupplier.set(key, existing);
    }

    // Also check extraData.supplierPayments if present
    const paidBySupplier = new Map<string, number>();
    for (const p of extraData.supplierPayments) {
      const name = String(p.supplier_name ?? '').trim().toLowerCase();
      if (name) {
        paidBySupplier.set(name, (paidBySupplier.get(name) ?? 0) + toNumber(p.amount ?? p.paid_amount));
      }
    }

    for (const [key, ticketAgg] of ticketsBySupplier.entries()) {
      const existing = supplierMap.get(key);
      const extraPaid = paidBySupplier.get(key) ?? 0;
      if (!existing) {
        supplierMap.set(key, {
          supplier_name: ticketAgg.name,
          ticket_count: ticketAgg.count,
          billed_cost_total: ticketAgg.cost,
          remitted_total: extraPaid,
          outstanding_total: Math.max(0, ticketAgg.cost - extraPaid),
        });
      } else if (existing.billed_cost_total === 0 && ticketAgg.cost > 0) {
        existing.ticket_count = Math.max(existing.ticket_count, ticketAgg.count);
        existing.billed_cost_total = ticketAgg.cost;
        if (existing.remitted_total === 0 && extraPaid > 0) {
          existing.remitted_total = extraPaid;
        }
        existing.outstanding_total = Math.max(
          0,
          existing.billed_cost_total - existing.remitted_total
        );
      }
    }

    const finalSupplierBalances = Array.from(supplierMap.values());

    // 4. Expenses
    let finalExpenses = filterEtb(
      mgmtReport?.expense_categories ?? mgmtReport?.expenses ?? []
    ).map((row: any) => ({
      category: row.category || row.expense_category || 'General Expense',
      entry_count: toNumber(row.entry_count ?? row.count ?? 1),
      total_amount: toNumber(row.total_amount ?? row.amount),
    }));

    if (finalExpenses.length === 0 && extraData.expensesList.length > 0) {
      const expMap = new Map<string, { category: string; entry_count: number; total_amount: number }>();
      for (const exp of extraData.expensesList) {
        const cat = String(exp.category || exp.expense_category || 'Operating Expense');
        const cur = expMap.get(cat) ?? { category: cat, entry_count: 0, total_amount: 0 };
        cur.entry_count += 1;
        cur.total_amount += toNumber(exp.amount ?? exp.total_amount);
        expMap.set(cat, cur);
      }
      finalExpenses = Array.from(expMap.values());
    }

    // 5. Payment Methods (Merge mgmtReport + Fallback from customerpayments / customerBalances)
    let finalPayments = filterEtb(
      mgmtReport?.payment_methods ?? mgmtReport?.payments ?? []
    ).map((row: any) => ({
      payment_method: row.payment_method || row.method || 'Bank / Cash',
      payment_count: toNumber(row.payment_count ?? row.count ?? 1),
      confirmed_cash_received: toNumber(
        row.confirmed_cash_received ?? row.confirmed_amount ?? row.total_amount
      ),
      pending_amount: toNumber(row.pending_amount ?? 0),
    }));

    if (finalPayments.length === 0) {
      if (extraData.customerPayments.length > 0) {
        const payMap = new Map<
          string,
          {
            payment_method: string;
            payment_count: number;
            confirmed_cash_received: number;
            pending_amount: number;
          }
        >();
        for (const p of extraData.customerPayments) {
          const method = String(p.payment_method || p.method || 'Standard Payment');
          const cur = payMap.get(method) ?? {
            payment_method: method,
            payment_count: 0,
            confirmed_cash_received: 0,
            pending_amount: 0,
          };
          cur.payment_count += 1;
          const amt = toNumber(p.amount ?? p.paid_amount);
          if (String(p.status ?? '').toLowerCase() === 'pending') {
            cur.pending_amount += amt;
          } else {
            cur.confirmed_cash_received += amt;
          }
          payMap.set(method, cur);
        }
        finalPayments = Array.from(payMap.values());
      } else {
        // Synthesize from Customer Balances if payments were recorded there (e.g. ETB 50,000.00 Paid)
        const totalCustomerPaid = rawCustBalances.reduce((acc, c) => acc + c.paid_total, 0);
        const totalCustomerPending = rawCustBalances.reduce(
          (acc, c) => acc + c.outstanding_total,
          0
        );
        const paidAccountsCount = rawCustBalances.filter((c) => c.paid_total > 0).length;

        if (totalCustomerPaid > 0 || totalCustomerPending > 0) {
          finalPayments = [
            {
              payment_method: 'Customer Collections (All Channels)',
              payment_count: paidAccountsCount || rawCustBalances.length,
              confirmed_cash_received: totalCustomerPaid,
              pending_amount: totalCustomerPending,
            },
          ];
        }
      }
    }

    return {
      ticketMargins: rawTickets,
      customerBalances: rawCustBalances,
      supplierBalances: finalSupplierBalances,
      expenses: finalExpenses,
      payments: finalPayments,
    };
  }, [ticketSales, balanceReport, mgmtReport, extraData]);

  // Apply Search Filtering
  const filteredTables = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const search = (items: any[], fields: string[]) =>
      items.filter(
        (item) =>
          !query ||
          fields.some((field) =>
            String(item[field] ?? '')
              .toLowerCase()
              .includes(query)
          )
      );

    return {
      ticketMargins: search(normalizedData.ticketMargins, [
        'ticket_number',
        'customer_name',
        'supplier_name',
        'booking_code',
      ]),
      customerBalances: search(normalizedData.customerBalances, ['customer_name']),
      supplierBalances: search(normalizedData.supplierBalances, ['supplier_name']),
      expenses: search(normalizedData.expenses, ['category']),
      payments: search(normalizedData.payments, ['payment_method']),
    };
  }, [normalizedData, searchQuery]);

  // Computed Period Totals for Executive KPI Cards & Table Footers
  const kpis = useMemo(() => {
    const totalSales = filteredTables.ticketMargins.reduce((s, r) => s + r.selling_price, 0);
    const totalSupplierCost = filteredTables.ticketMargins.reduce((s, r) => s + r.supplier_cost, 0);
    const totalGrossMargin = filteredTables.ticketMargins.reduce((s, r) => s + r.gross_margin, 0);
    const avgMarginPct = totalSales > 0 ? (totalGrossMargin / totalSales) * 100 : 0;

    const totalInvoiced = filteredTables.customerBalances.reduce((s, r) => s + r.invoiced_total, 0);
    const totalCustomerPaid = filteredTables.customerBalances.reduce((s, r) => s + r.paid_total, 0);
    const totalReceivables = filteredTables.customerBalances.reduce(
      (s, r) => s + r.outstanding_total,
      0
    );

    const totalSupplierBilled = filteredTables.supplierBalances.reduce(
      (s, r) => s + r.billed_cost_total,
      0
    );
    const totalSupplierPaid = filteredTables.supplierBalances.reduce(
      (s, r) => s + r.remitted_total,
      0
    );
    const totalPayables = filteredTables.supplierBalances.reduce(
      (s, r) => s + r.outstanding_total,
      0
    );

    const totalExpenses = filteredTables.expenses.reduce((s, r) => s + r.total_amount, 0);
    const netProfit = totalGrossMargin - totalExpenses;

    const totalConfirmedCash = filteredTables.payments.reduce(
      (s, r) => s + r.confirmed_cash_received,
      0
    );
    const totalPendingCash = filteredTables.payments.reduce((s, r) => s + r.pending_amount, 0);

    return {
      totalSales,
      totalSupplierCost,
      totalGrossMargin,
      avgMarginPct,
      totalInvoiced,
      totalCustomerPaid,
      totalReceivables,
      totalSupplierBilled,
      totalSupplierPaid,
      totalPayables,
      totalExpenses,
      netProfit,
      totalConfirmedCash,
      totalPendingCash,
    };
  }, [filteredTables]);

  // Build CSV Export Data
  const downloadCsv = () => {
    const escapeCsv = (value: unknown) => {
      let text = String(value ?? '');
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };

    const sections: { title: string; headers: string[]; rows: unknown[][] }[] = [];

    if (activeTab === 'sales_margins' || activeTab === 'all_balances') {
      sections.push({
        title: 'Ticket Sales & Margins',
        headers: [
          'Booking Ref',
          'Ticket Number',
          'Customer',
          'Supplier',
          'Selling Price',
          'Supplier Cost',
          'Gross Margin',
          'Margin %',
        ],
        rows: filteredTables.ticketMargins.map((r) => [
          r.booking_code,
          r.ticket_number,
          r.customer_name,
          r.supplier_name,
          formatETB(r.selling_price),
          formatETB(r.supplier_cost),
          formatETB(r.gross_margin),
          `${r.margin_pct.toFixed(1)}%`,
        ]),
      });
    }

    if (activeTab === 'customer_balances' || activeTab === 'all_balances') {
      sections.push({
        title: 'Customer Balances (Accounts Receivable)',
        headers: ['Customer', 'Invoices', 'Invoiced Total', 'Paid Total', 'Outstanding Balance'],
        rows: filteredTables.customerBalances.map((r) => [
          r.customer_name,
          r.invoice_count,
          formatETB(r.invoiced_total),
          formatETB(r.paid_total),
          formatETB(r.outstanding_total),
        ]),
      });
    }

    if (activeTab === 'supplier_balances' || activeTab === 'all_balances') {
      sections.push({
        title: 'Supplier Balances (Accounts Payable)',
        headers: ['Supplier', 'Tickets', 'Billed Cost', 'Paid / Remitted', 'Outstanding Payable'],
        rows: filteredTables.supplierBalances.map((r) => [
          r.supplier_name,
          r.ticket_count,
          formatETB(r.billed_cost_total),
          formatETB(r.remitted_total),
          formatETB(r.outstanding_total),
        ]),
      });
    }

    if (activeTab === 'expenses_payments' || activeTab === 'all_balances') {
      sections.push({
        title: 'Operating Expenses',
        headers: ['Category', 'Entries', 'Total Expense'],
        rows: filteredTables.expenses.map((r) => [
          r.category,
          r.entry_count,
          formatETB(r.total_amount),
        ]),
      });
      sections.push({
        title: 'Payment Methods & Collections',
        headers: ['Method', 'Transactions', 'Confirmed Received', 'Pending Collection'],
        rows: filteredTables.payments.map((r) => [
          r.payment_method,
          r.payment_count,
          formatETB(r.confirmed_cash_received),
          formatETB(r.pending_amount),
        ]),
      });
    }

    if (!sections.length) return;

    const allRows: string[] = [];
    for (const section of sections) {
      allRows.push(`"${section.title} (${startDate} to ${endDate})"`);
      allRows.push(section.headers.map(escapeCsv).join(','));
      for (const row of section.rows) {
        allRows.push(row.map(escapeCsv).join(','));
      }
      allRows.push('');
    }

    const csv = allRows.join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `abajifar_${activeTab}_${startDate}_${endDate}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12 text-slate-800 print:space-y-4">
      {/* Top Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onBackToDashboard}
            className="text-xs font-semibold text-teal-700 hover:text-teal-900 print:hidden"
          >
            &larr; Back to Dashboard
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Financial & Operations Reports
            </h1>
            <span className="rounded-full bg-teal-50 border border-teal-200 px-2.5 py-0.5 text-xs font-semibold text-teal-800">
              ETB Ledger
            </span>
          </div>
          <p className="text-sm text-slate-500">
            Real-time ticket margins, accounts receivable, supplier payables, and cashflow analytics.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-end print:hidden">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50"
          >
            Print Report
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-800 px-4 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-teal-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download CSV
          </button>
        </div>
      </header>

      {loadError && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {loadError}
        </div>
      )}

      {/* Top 3 Period Benchmark Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <RevenueCard
          title="Today's Margin Profit"
          amount={marginSummary.today?.margin ?? 0}
          count={marginSummary.today?.count ?? 0}
          loading={loading}
          formatETB={formatETB}
        />
        <RevenueCard
          title="Last 7 Days Margin"
          amount={marginSummary.last_7_days?.margin ?? 0}
          count={marginSummary.last_7_days?.count ?? 0}
          loading={loading}
          formatETB={formatETB}
        />
        <RevenueCard
          title="This Month's Margin"
          amount={
            (marginSummary.this_month?.margin ?? 0) > 0
              ? marginSummary.this_month.margin
              : kpis.totalGrossMargin
          }
          count={
            (marginSummary.this_month?.count ?? 0) > 0
              ? marginSummary.this_month.count
              : filteredTables.ticketMargins.length
          }
          loading={loading}
          formatETB={formatETB}
          highlight
        />
      </div>

      {/* Executive Summary Bar for Filtered Period */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniKpiCard
          label="Gross Ticket Sales"
          value={formatETB(kpis.totalSales)}
          subtext={`${filteredTables.ticketMargins.length} issued ticket(s) • ${kpis.avgMarginPct.toFixed(1)}% avg margin`}
          tone="slate"
        />
        <MiniKpiCard
          label="Customer Receivables"
          value={formatETB(kpis.totalReceivables)}
          subtext={`Collected: ${formatETB(kpis.totalCustomerPaid)}`}
          tone={kpis.totalReceivables > 0 ? 'amber' : 'emerald'}
        />
        <MiniKpiCard
          label="Supplier Payables"
          value={formatETB(kpis.totalPayables)}
          subtext={`Total Cost: ${formatETB(kpis.totalSupplierBilled)}`}
          tone={kpis.totalPayables > 0 ? 'rose' : 'slate'}
        />
        <MiniKpiCard
          label="Net Operating Profit"
          value={formatETB(kpis.netProfit)}
          subtext={`Expenses: ${formatETB(kpis.totalExpenses)}`}
          tone="teal"
        />
      </div>

      {/* Main Report Workspace */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
        {/* Control Bar: Tabs + Date Presets + Filters */}
        <div className="border-b border-slate-200 bg-slate-50/70 p-4 space-y-4 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Report Tabs */}
            <div className="flex flex-wrap gap-1.5">
              {REPORT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => selectReportTab(tab.id)}
                  aria-pressed={activeTab === tab.id}
                  className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
                    activeTab === tab.id
                      ? 'bg-teal-800 text-white shadow-xs'
                      : 'bg-white text-slate-600 border border-slate-200/80 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Quick Date Presets */}
            <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
              {[
                { id: 'today', label: 'Today' },
                { id: 'last_7_days', label: '7 Days' },
                { id: 'this_month', label: 'This Month' },
                { id: 'last_month', label: 'Last Month' },
                { id: 'this_year', label: 'This Year' },
                { id: 'all_time', label: 'All Time' },
              ].map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyDatePreset(preset.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    activePreset === preset.id
                      ? 'bg-teal-100 text-teal-900 font-semibold'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Date Inputs & Search */}
          <div className="flex flex-wrap items-end gap-3 pt-1">
            <div className="flex flex-col gap-1">
              <label htmlFor="report-start-date" className="text-xs font-medium text-slate-500">
                From Date
              </label>
              <input
                id="report-start-date"
                type="date"
                value={startDate}
                max={endDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setActivePreset('custom');
                }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="report-end-date" className="text-xs font-medium text-slate-500">
                To Date
              </label>
              <input
                id="report-end-date"
                type="date"
                value={endDate}
                min={startDate}
                max={getToday()}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setActivePreset('custom');
                }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1 sm:min-w-64">
              <label htmlFor="report-search" className="text-xs font-medium text-slate-500">
                Filter records in view
              </label>
              <input
                id="report-search"
                type="search"
                placeholder="Search customer, supplier, PNR, ticket #, or method..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-teal-600 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Report Content Area */}
        <div className="p-5 space-y-8">
          {loading ? (
            <div className="p-12 text-center text-sm text-slate-500">
              <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" />
              Compiling financial ledger for {startDate} to {endDate}...
            </div>
          ) : (
            <>
              {/* 1. TICKET SALES & MARGINS TABLE */}
              {(activeTab === 'sales_margins' || activeTab === 'all_balances') && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <div>
                      <h3 className="text-base font-bold text-slate-900">
                        Ticket Sales & Profit Margins
                      </h3>
                      <p className="text-xs text-slate-500">
                        Breakdown of selling prices, supplier base fares, and gross agency markup per issued ticket.
                      </p>
                    </div>
                    <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                      {filteredTables.ticketMargins.length} Record(s)
                    </span>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    {filteredTables.ticketMargins.length === 0 ? (
                      <EmptyState message="No ticket sales found for this date range and filter." />
                    ) : (
                      <table className="w-full border-collapse text-left text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                            <th className="px-4 py-3">Ticket / Booking Ref</th>
                            <th className="px-4 py-3">Customer</th>
                            <th className="px-4 py-3">Supplier</th>
                            <th className="px-4 py-3 text-right">Selling Price</th>
                            <th className="px-4 py-3 text-right">Supplier Cost</th>
                            <th className="px-4 py-3 text-right">Gross Margin</th>
                            <th className="px-4 py-3 text-right">Markup %</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredTables.ticketMargins.map((row, idx) => (
                            <tr key={idx} className="transition-colors hover:bg-slate-50/80">
                              <td className="px-4 py-3">
                                <div className="font-mono text-xs font-semibold text-slate-900">
                                  {row.ticket_number}
                                </div>
                                {row.booking_code && (
                                  <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                                    Ref: {row.booking_code}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 font-medium text-slate-800">
                                {row.customer_name}
                              </td>
                              <td className="px-4 py-3">
                                <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                                  {row.supplier_name}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-800">
                                {formatETB(row.selling_price)}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                                {formatETB(row.supplier_cost)}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums font-semibold text-teal-800">
                                {formatETB(row.gross_margin)}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums">
                                <span
                                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                                    row.margin_pct >= 15
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : row.margin_pct > 0
                                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                      : 'bg-rose-50 text-rose-700 border border-rose-200'
                                  }`}
                                >
                                  {row.margin_pct.toFixed(1)}%
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                            <td colSpan={3} className="px-4 py-3 text-xs uppercase tracking-wider text-slate-500">
                              Period Total ({filteredTables.ticketMargins.length} Tickets)
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {formatETB(kpis.totalSales)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                              {formatETB(kpis.totalSupplierCost)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-teal-900">
                              {formatETB(kpis.totalGrossMargin)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-teal-900">
                              {kpis.avgMarginPct.toFixed(1)}%
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* 2. CUSTOMER BALANCES TABLE */}
              {(activeTab === 'customer_balances' || activeTab === 'all_balances') && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <div>
                      <h3 className="text-base font-bold text-slate-900">
                        Customer Balances (Accounts Receivable)
                      </h3>
                      <p className="text-xs text-slate-500">
                        Invoiced customer amounts, received payments, and remaining unpaid credit balances.
                      </p>
                    </div>
                    <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                      {filteredTables.customerBalances.length} Customer(s)
                    </span>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    {filteredTables.customerBalances.length === 0 ? (
                      <EmptyState message="No customer balance records found." />
                    ) : (
                      <table className="w-full border-collapse text-left text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                            <th className="px-4 py-3">Customer Name</th>
                            <th className="px-4 py-3 text-center">Invoices</th>
                            <th className="px-4 py-3 text-right">Total Invoiced</th>
                            <th className="px-4 py-3 text-right">Total Paid</th>
                            <th className="px-4 py-3 text-right">Outstanding Balance</th>
                            <th className="px-4 py-3 text-center">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredTables.customerBalances.map((row, idx) => {
                            const isSettled = row.outstanding_total <= 0;
                            const isPartial = row.outstanding_total > 0 && row.paid_total > 0;
                            return (
                              <tr key={idx} className="transition-colors hover:bg-slate-50/80">
                                <td className="px-4 py-3 font-semibold text-slate-800">
                                  {row.customer_name}
                                </td>
                                <td className="px-4 py-3 text-center tabular-nums text-slate-600">
                                  {row.invoice_count}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-800">
                                  {formatETB(row.invoiced_total)}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums text-emerald-700 font-medium">
                                  {formatETB(row.paid_total)}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums font-bold text-amber-800">
                                  {formatETB(row.outstanding_total)}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <span
                                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                                      isSettled
                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                        : isPartial
                                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                        : 'bg-rose-50 text-rose-700 border border-rose-200'
                                    }`}
                                  >
                                    {isSettled ? 'Settled' : isPartial ? 'Partial Credit' : 'Unpaid'}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                            <td colSpan={2} className="px-4 py-3 text-xs uppercase tracking-wider text-slate-500">
                              Total Accounts Receivable
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {formatETB(kpis.totalInvoiced)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-emerald-800">
                              {formatETB(kpis.totalCustomerPaid)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-amber-900">
                              {formatETB(kpis.totalReceivables)}
                            </td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* 3. SUPPLIER BALANCES TABLE */}
              {(activeTab === 'supplier_balances' || activeTab === 'all_balances') && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <div>
                      <h3 className="text-base font-bold text-slate-900">
                        Supplier Balances (Accounts Payable)
                      </h3>
                      <p className="text-xs text-slate-500">
                        Supplier base fare obligations from issued tickets and bills versus remitted supplier payments.
                      </p>
                    </div>
                    <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                      {filteredTables.supplierBalances.length} Supplier(s)
                    </span>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    {filteredTables.supplierBalances.length === 0 ? (
                      <EmptyState message="No supplier obligations found for this period." />
                    ) : (
                      <table className="w-full border-collapse text-left text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                            <th className="px-4 py-3">Supplier / Consolidation Partner</th>
                            <th className="px-4 py-3 text-center">Issued Tickets</th>
                            <th className="px-4 py-3 text-right">Billed / Ticket Cost</th>
                            <th className="px-4 py-3 text-right">Paid / Remitted</th>
                            <th className="px-4 py-3 text-right">Outstanding Payable</th>
                            <th className="px-4 py-3 text-center">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredTables.supplierBalances.map((row, idx) => {
                            const isSettled = row.outstanding_total <= 0;
                            const isPartial = row.outstanding_total > 0 && row.remitted_total > 0;
                            return (
                              <tr key={idx} className="transition-colors hover:bg-slate-50/80">
                                <td className="px-4 py-3 font-semibold text-slate-800">
                                  {row.supplier_name}
                                </td>
                                <td className="px-4 py-3 text-center tabular-nums text-slate-600">
                                  {row.ticket_count}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-800">
                                  {formatETB(row.billed_cost_total)}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums text-emerald-700 font-medium">
                                  {formatETB(row.remitted_total)}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums font-bold text-rose-700">
                                  {formatETB(row.outstanding_total)}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <span
                                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                                      isSettled
                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                        : isPartial
                                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                        : 'bg-rose-50 text-rose-700 border border-rose-200'
                                    }`}
                                  >
                                    {isSettled ? 'Remitted' : isPartial ? 'Partial Payable' : 'Payable Due'}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                            <td colSpan={2} className="px-4 py-3 text-xs uppercase tracking-wider text-slate-500">
                              Total Accounts Payable
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {formatETB(kpis.totalSupplierBilled)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-emerald-800">
                              {formatETB(kpis.totalSupplierPaid)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-rose-800">
                              {formatETB(kpis.totalPayables)}
                            </td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* 4. EXPENSES & PAYMENT METHODS TABLES */}
              {(activeTab === 'expenses_payments' || activeTab === 'all_balances') && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Payment Methods Breakdown */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-1">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">
                          Payment Methods & Collections
                        </h3>
                        <p className="text-xs text-slate-500">
                          Confirmed cash/bank inflows and pending receivables.
                        </p>
                      </div>
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      {filteredTables.payments.length === 0 ? (
                        <EmptyState message="No payment method records found for this range." />
                      ) : (
                        <table className="w-full border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                              <th className="px-4 py-3">Channel / Method</th>
                              <th className="px-4 py-3 text-center">Txns</th>
                              <th className="px-4 py-3 text-right">Confirmed</th>
                              <th className="px-4 py-3 text-right">Pending</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {filteredTables.payments.map((row, idx) => (
                              <tr key={idx} className="transition-colors hover:bg-slate-50/80">
                                <td className="px-4 py-3 font-semibold text-slate-800">
                                  {row.payment_method}
                                </td>
                                <td className="px-4 py-3 text-center tabular-nums text-slate-600">
                                  {row.payment_count}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums font-semibold text-emerald-700">
                                  {formatETB(row.confirmed_cash_received)}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums text-amber-700">
                                  {formatETB(row.pending_amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                              <td colSpan={2} className="px-4 py-3 text-xs uppercase tracking-wider text-slate-500">
                                Total Collections
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-emerald-800">
                                {formatETB(kpis.totalConfirmedCash)}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-amber-800">
                                {formatETB(kpis.totalPendingCash)}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      )}
                    </div>
                  </div>

                  {/* Expenses Breakdown */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-1">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">
                          Operating Expenses by Category
                        </h3>
                        <p className="text-xs text-slate-500">
                          Recorded office, administrative, and operational costs.
                        </p>
                      </div>
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      {filteredTables.expenses.length === 0 ? (
                        <EmptyState message="No operating expenses recorded for this date range." />
                      ) : (
                        <table className="w-full border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                              <th className="px-4 py-3">Expense Category</th>
                              <th className="px-4 py-3 text-center">Entries</th>
                              <th className="px-4 py-3 text-right">Total Expense</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {filteredTables.expenses.map((row, idx) => (
                              <tr key={idx} className="transition-colors hover:bg-slate-50/80">
                                <td className="px-4 py-3 font-semibold text-slate-800">
                                  {row.category}
                                </td>
                                <td className="px-4 py-3 text-center tabular-nums text-slate-600">
                                  {row.entry_count}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums font-semibold text-rose-700">
                                  {formatETB(row.total_amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                              <td colSpan={2} className="px-4 py-3 text-xs uppercase tracking-wider text-slate-500">
                                Total Operating Expenses
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-rose-800">
                                {formatETB(kpis.totalExpenses)}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-3 text-xs text-slate-500">
          <span>
            Monetary figures are displayed in ETB. Supplier obligations automatically cross-reference issued ticket costs and supplier bills.
          </span>
          <span className="font-mono text-[11px] text-slate-400">
            Period: {startDate} &rarr; {endDate}
          </span>
        </div>
      </section>
    </div>
  );
};

interface RevenueCardProps {
  title: string;
  amount: number;
  count: number;
  loading: boolean;
  formatETB: (value: unknown) => string;
  highlight?: boolean;
}

const RevenueCard: React.FC<RevenueCardProps> = ({
  title,
  amount,
  count,
  loading,
  formatETB,
  highlight,
}) => (
  <div
    className={`flex flex-col justify-center rounded-xl border p-5 shadow-2xs ${
      highlight ? 'border-teal-200 bg-teal-50/70' : 'border-slate-200 bg-white'
    }`}
  >
    <span className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {title}
    </span>
    {loading ? (
      <div className="my-2 h-8 w-3/4 animate-pulse rounded bg-slate-200" />
    ) : (
      <div
        className={`my-1 text-2xl font-bold tracking-tight tabular-nums ${
          highlight ? 'text-teal-950' : 'text-slate-900'
        }`}
      >
        {formatETB(amount)}
      </div>
    )}
    <div className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-3 text-sm">
      <span className="text-slate-500">Issued Tickets</span>
      {loading ? (
        <div className="h-4 w-6 animate-pulse rounded bg-slate-200" />
      ) : (
        <span className="font-semibold tabular-nums text-slate-800">{count}</span>
      )}
    </div>
  </div>
);

interface MiniKpiCardProps {
  label: string;
  value: string;
  subtext: string;
  tone: 'slate' | 'teal' | 'amber' | 'rose' | 'emerald';
}

const MiniKpiCard: React.FC<MiniKpiCardProps> = ({ label, value, subtext, tone }) => {
  const toneClasses = {
    slate: 'border-slate-200 bg-white text-slate-900',
    teal: 'border-teal-200 bg-teal-50/40 text-teal-950',
    amber: 'border-amber-200 bg-amber-50/40 text-amber-950',
    rose: 'border-rose-200 bg-rose-50/40 text-rose-950',
    emerald: 'border-emerald-200 bg-emerald-50/40 text-emerald-950',
  }[tone];

  return (
    <div className={`rounded-xl border p-4 shadow-2xs ${toneClasses}`}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums">{value}</div>
      <div className="mt-1 text-[11px] text-slate-500 truncate">{subtext}</div>
    </div>
  );
};

const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="p-8 text-center text-sm text-slate-400 bg-slate-50/30">{message}</div>
);