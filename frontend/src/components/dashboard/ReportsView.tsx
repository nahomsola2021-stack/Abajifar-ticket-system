import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../lib/api';

type ReportTab = 'sales_margins' | 'financial_balances';

interface ReportsViewProps {
  onBackToDashboard: () => void;
  currentTab?: string;
  onTabChange?: (tab: string) => void;
}

const NAV_TO_REPORT_TAB: Record<string, ReportTab> = {
  reports: 'sales_margins',
  'reports-sales': 'sales_margins',
  'reports-customer-balances': 'financial_balances',
  'reports-supplier-balances': 'financial_balances',
  'reports-expenses': 'financial_balances',
};

const REPORT_TO_NAV_TAB: Record<ReportTab, string> = {
  sales_margins: 'reports-sales',
  financial_balances: 'reports-customer-balances',
};

const REPORT_TABS: { id: ReportTab; label: string }[] = [
  { id: 'sales_margins', label: 'Sales & Margins' },
  { id: 'financial_balances', label: 'Financial Balances' },
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

function getFirstDayOfMonth(): string {
  const date = new Date();
  date.setDate(1);
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

  const [activeTab, setActiveTab] = useState<ReportTab>(
    () => NAV_TO_REPORT_TAB[currentTab ?? 'reports-sales'] ?? 'sales_margins'
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const skipNextRouteSync = useRef(false);

  // New state for backend margin summary
  const [marginSummary, setMarginSummary] = useState({
    today: { margin: 0, count: 0 },
    last_7_days: { margin: 0, count: 0 },
    this_month: { margin: 0, count: 0 },
  });

  const [balanceReport, setBalanceReport] = useState<any>(null);
  const [ticketSales, setTicketSales] = useState<any[]>([]);
  const [mgmtReport, setMgmtReport] = useState<any>(null);

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

  useEffect(() => {
    if (!accessToken) {
      setLoadError('Please sign in to view reports.');
      return;
    }

    let isMounted = true;

    const loadData = async () => {
      setLoading(true);
      setLoadError('');

      try {
        const balanceResult = await api.fetchCustomerBalanceReport(accessToken);
        if (isMounted) setBalanceReport(balanceResult);
      } catch (error) {
        console.error('Failed to load customer balances:', error);
      }

      // Fetch Dedicated Backend Margin Summary
      try {
        const extendedApi = api as any;
        if (typeof extendedApi.fetchMarginSummary === 'function') {
          const summaryResult = await extendedApi.fetchMarginSummary(accessToken);
          if (isMounted && summaryResult) setMarginSummary(summaryResult);
        }
      } catch (error) {
        console.error('Failed to load backend margin summary:', error);
      }

      // Fetch Tickets (sending startDate and endDate to the backend!)
      try {
        const extendedApi = api as any;
        if (typeof extendedApi.fetchTicketSales === 'function') {
          const result = await extendedApi.fetchTicketSales(accessToken, '', startDate, endDate);
          if (isMounted) {
            const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
            setTicketSales(items);
          }
        }
      } catch (error) {
        console.error('Failed to load ticket sales report:', error);
        if (isMounted) setLoadError('Ticket margin data could not be loaded.');
      }

      try {
        const extendedApi = api as any;
        if (typeof extendedApi.fetchFinancialManagementReport === 'function') {
          const result = await extendedApi.fetchFinancialManagementReport(accessToken, startDate, endDate);
          if (isMounted && result) setMgmtReport(result);
        }
      } catch (error) {
        console.error('Failed to load financial management report:', error);
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

  const tables = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filterEtb = (items?: any[]) =>
      (items ?? []).filter((item) => {
        const curr = item.currency ?? item.selling_currency;
        return !curr || curr === 'ETB';
      });

    const search = (items: any[] | undefined, fields: string[]) =>
      (items ?? []).filter((item) =>
        !query || fields.some((field) => String(item[field] ?? '').toLowerCase().includes(query))
      );

    return {
      customerBalances: search(filterEtb(balanceReport?.items), ['customer_name']),
      supplierBalances: search(filterEtb(mgmtReport?.supplier_balances), ['supplier_name']),
      // No client-side date dropping here. If the backend sends it, we display it.
      ticketMargins: search(ticketSales, ['ticket_number', 'customer_name', 'booking_code', 'pnr']),
      expenses: filterEtb(mgmtReport?.expense_categories),
      payments: filterEtb(mgmtReport?.payment_methods),
    };
  }, [mgmtReport, balanceReport, ticketSales, searchQuery]);

  const activeReportSections = useMemo(() => {
    if (activeTab === 'sales_margins') {
      return [
        {
          title: 'Ticket Sales & Margins',
          headers: ['Ticket / PNR', 'Customer', 'Supplier', 'Selling Price', 'Supplier Cost', 'Gross Margin'],
          rows: tables.ticketMargins.map((row: any) => [
            `${row.booking_code ?? ''} ${row.ticket_number ?? 'Pending'}`,
            row.customer_name,
            row.supplier_name,
            formatETB(row.selling_price),
            formatETB(row.supplier_cost ?? row.fare_amount),
            formatETB(row.gross_margin ?? (toNumber(row.selling_price) - toNumber(row.supplier_cost ?? row.fare_amount))),
          ]),
        },
      ];
    } else {
      return [
        {
          title: 'Customer Balances',
          headers: ['Customer', 'Invoices', 'Invoiced', 'Paid', 'Outstanding Balance'],
          rows: tables.customerBalances.map((row: any) => [
            row.customer_name,
            row.invoice_count,
            formatETB(row.invoiced_total),
            formatETB(row.paid_total),
            formatETB(row.outstanding_total),
          ]),
        },
        {
          title: 'Supplier Balances',
          headers: ['Supplier', 'Tickets', 'Billed', 'Paid', 'Outstanding Balance'],
          rows: tables.supplierBalances.map((row: any) => [
            row.supplier_name,
            row.ticket_count,
            formatETB(row.billed_cost_total),
            formatETB(row.remitted_total),
            formatETB(row.outstanding_total),
          ]),
        },
        {
          title: 'Expenses',
          headers: ['Category', 'Entries', 'Total'],
          rows: tables.expenses.map((row: any) => [
            row.category,
            row.entry_count,
            formatETB(row.total_amount),
          ]),
        },
        {
          title: 'Payment Methods',
          headers: ['Method', 'Transactions', 'Confirmed', 'Pending'],
          rows: tables.payments.map((row: any) => [
            row.payment_method,
            row.payment_count,
            formatETB(row.confirmed_cash_received),
            formatETB(row.pending_amount),
          ]),
        },
      ];
    }
  }, [activeTab, tables]);

  const downloadCsv = () => {
    if (!activeReportSections.length) return;
    const escapeCsv = (value: unknown) => {
      let text = String(value ?? '');
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const allRows: string[] = [];
    for (const section of activeReportSections) {
      allRows.push(`"${section.title}"`);
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
    link.download = `${activeTab}_${startDate}_${endDate}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-10 text-slate-800">
      <header className="flex flex-col gap-2 border-b border-slate-200 pb-4">
        <button
          type="button"
          onClick={onBackToDashboard}
          className="self-start text-xs font-medium text-teal-700 hover:text-teal-900"
        >
          &larr; Back to Dashboard
        </button>
        <h1 className="text-2xl font-bold text-slate-900">Revenue & Reports</h1>
        <p className="text-sm text-slate-500">
          Review sales, gross profit margins, customer balances, supplier balances, expenses and payments.
        </p>
      </header>

      {loadError && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <RevenueCard
          title="Today's Margin Profit"
          amount={marginSummary.today?.margin ?? 0}
          count={marginSummary.today?.count ?? 0}
          loading={loading}
          formatETB={formatETB}
        />
        <RevenueCard
          title="Last 7 Days"
          amount={marginSummary.last_7_days?.margin ?? 0}
          count={marginSummary.last_7_days?.count ?? 0}
          loading={loading}
          formatETB={formatETB}
        />
        <RevenueCard
          title="This Month"
          amount={marginSummary.this_month?.margin ?? 0}
          count={marginSummary.this_month?.count ?? 0}
          loading={loading}
          formatETB={formatETB}
          highlight
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50/60 p-3">
          <div className="flex gap-1 overflow-x-auto">
            {REPORT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectReportTab(tab.id)}
                aria-pressed={activeTab === tab.id}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-teal-800 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-200 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="report-start-date" className="text-xs font-medium text-slate-500">From</label>
              <input
                id="report-start-date"
                type="date"
                value={startDate}
                max={endDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-2 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="report-end-date" className="text-xs font-medium text-slate-500">To</label>
              <input
                id="report-end-date"
                type="date"
                value={endDate}
                min={startDate}
                max={getToday()}
                onChange={(event) => setEndDate(event.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-2 text-sm"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1 sm:min-w-56">
              <label htmlFor="report-search" className="text-xs font-medium text-slate-500">Search this report</label>
              <input
                id="report-search"
                type="search"
                placeholder="Search names or references..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={downloadCsv}
              disabled={loading}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-teal-800 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download CSV
            </button>
          </div>
        </div>

        <div className="p-4 space-y-8">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading report data...</div>
          ) : (
            activeReportSections.map((section, idx) => (
              <div key={idx} className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700 px-2">{section.title}</h3>
                <div className="overflow-x-auto rounded-lg border border-slate-100">
                  <CompactGrid headers={section.headers} rows={section.rows} />
                </div>
              </div>
            ))
          )}
        </div>
        <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          Monetary figures are displayed in ETB when the returned data identifies the currency as ETB.
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

const RevenueCard: React.FC<RevenueCardProps> = ({ title, amount, count, loading, formatETB, highlight }) => (
  <div className={`flex flex-col justify-center rounded-xl border p-5 ${highlight ? 'border-teal-200 bg-teal-50' : 'border-slate-200 bg-white'}`}>
    <span className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</span>
    {loading ? (
      <div className="my-2 h-8 w-3/4 animate-pulse rounded bg-slate-200" />
    ) : (
      <div className={`my-1 text-2xl font-bold tracking-tight ${highlight ? 'text-teal-950' : 'text-slate-900'}`}>
        {formatETB(amount)}
      </div>
    )}
    <div className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-3 text-sm">
      <span className="text-slate-500">Issued Tickets</span>
      {loading ? (
        <div className="h-4 w-6 animate-pulse rounded bg-slate-200" />
      ) : (
        <span className="font-semibold text-slate-700">{count}</span>
      )}
    </div>
  </div>
);

interface CompactGridProps {
  headers: string[];
  rows: unknown[][];
}

const CompactGrid: React.FC<CompactGridProps> = ({ headers, rows }) => {
  if (!rows.length) {
    return (
      <div className="p-6 text-center text-sm text-slate-400">
        No records found for this section and date range.
      </div>
    );
  }
  return (
    <table className="w-full min-w-max border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200 bg-slate-50">
          {headers.map((header) => (
            <th key={header} className="whitespace-nowrap px-4 py-3 font-medium text-slate-500">{header}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="transition-colors hover:bg-slate-50">
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className={`whitespace-nowrap px-4 py-3 ${cellIndex > 0 ? 'text-right tabular-nums text-slate-600' : 'font-medium text-slate-800'}`}
              >
                {cell === null || cell === undefined || cell === '' ? '—' : String(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};