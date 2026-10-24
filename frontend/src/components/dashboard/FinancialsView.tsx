import React, { useEffect, useState } from 'react';
import { ArrowLeft, BadgeCheck, BarChart3, Download, FilePlus2, Plus, Scale, Search, Trash2, Wallet, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { createInvoice, downloadCustomerBalancesCsv, downloadInvoicePdf, downloadSupplierBalancesCsv, fetchBookings, fetchCustomerBalanceReport, fetchInvoiceDetails, fetchInvoiceSalesReport, fetchInvoices, fetchSupplierBalanceReport, issueInvoice } from '../../lib/api';
import type {
  BookingRecord,
  CustomerBalanceReport,
  InvoiceCreateInput,
  InvoiceCreateItemInput,
  InvoiceDetails,
  InvoiceItemType,
  InvoiceRecord,
  InvoiceSalesReport,
  InvoiceStatus,
} from '../../types/customer';
import type { SupplierBalanceReport } from '../../types/finance';

const PAGE_SIZE = 50;
const INVOICE_STATUSES: InvoiceStatus[] = ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void', 'cancelled'];
const ITEM_TYPES: { value: InvoiceItemType; label: string }[] = [
  { value: 'airfare', label: 'Airfare' },
  { value: 'tax', label: 'Tax' },
  { value: 'agency_fee', label: 'Agency fee' },
  { value: 'change_fee', label: 'Change fee' },
  { value: 'cancellation_fee', label: 'Cancellation fee' },
  { value: 'other', label: 'Other' },
];

interface InvoiceDraftLine {
  item_type: InvoiceItemType;
  description: string;
  quantity: string;
  unit_price: string;
}

type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'custom';

interface FinancialsViewProps {
  onBackToDashboard: () => void;
}

const EMPTY_LINE: InvoiceDraftLine = {
  item_type: 'agency_fee',
  description: '',
  quantity: '1',
  unit_price: '',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function formatAmount(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.trim() }).format(Number(amount));
  } catch {
    return `${currency.trim()} ${amount}`;
  }
}

function toDateInput(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function getReportPeriodDates(period: Exclude<ReportPeriod, 'custom'>, referenceDate: Date): [string, string] {
  const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  if (period === 'daily') return [toDateInput(end), toDateInput(end)];
  if (period === 'weekly') {
    const daysSinceMonday = (end.getDay() + 6) % 7;
    const start = new Date(end);
    start.setDate(end.getDate() - daysSinceMonday);
    return [toDateInput(start), toDateInput(end)];
  }
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return [toDateInput(start), toDateInput(end)];
}

export const FinancialsView: React.FC<FinancialsViewProps> = ({ onBackToDashboard }) => {
  const { accessToken, staff } = useAuth();
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | ''>('');
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [hasLoadedBookings, setHasLoadedBookings] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [currency, setCurrency] = useState('ETB');
  const [dueDate, setDueDate] = useState('');
  const [taxTotal, setTaxTotal] = useState('0');
  const [discountTotal, setDiscountTotal] = useState('0');
  const [notes, setNotes] = useState('');
  const [draftLines, setDraftLines] = useState<InvoiceDraftLine[]>([{ ...EMPTY_LINE }]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [isIssuing, setIsIssuing] = useState(false);
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<number | null>(null);
  const [activePanel, setActivePanel] = useState<'invoices' | 'report' | 'balances' | 'suppliers'>('invoices');
  const [balanceReport, setBalanceReport] = useState<CustomerBalanceReport | null>(null);
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);
  const [isExportingBalances, setIsExportingBalances] = useState(false);
  const [supplierReport, setSupplierReport] = useState<SupplierBalanceReport | null>(null);
  const [isSupplierReportLoading, setIsSupplierReportLoading] = useState(false);
  const [isExportingSupplierBalances, setIsExportingSupplierBalances] = useState(false);
  const [reportReferenceDate] = useState(() => new Date());
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>('monthly');
  const [reportStartDate, setReportStartDate] = useState(() => getReportPeriodDates('monthly', reportReferenceDate)[0]);
  const [reportEndDate, setReportEndDate] = useState(() => getReportPeriodDates('monthly', reportReferenceDate)[1]);
  const [salesReport, setSalesReport] = useState<InvoiceSalesReport | null>(null);
  const [isReportLoading, setIsReportLoading] = useState(false);
  const bookingLoading = isFormOpen && !hasLoadedBookings;
  const canCreateInvoices = Boolean(staff?.roles.some((role) => ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(role.toUpperCase())));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;
    fetchInvoices(accessToken, search, statusFilter, PAGE_SIZE, page * PAGE_SIZE)
      .then((result) => {
        if (!isCurrent) return;
        setInvoices(result.items);
        setTotal(result.total);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load invoices.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, search, statusFilter, page]);

  useEffect(() => {
    if (!accessToken || !isFormOpen || hasLoadedBookings) return;
    let isCurrent = true;
    fetchBookings(accessToken, '', '', 100, 0)
      .then((result) => {
        if (isCurrent) setBookings(result.items);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load branch bookings.');
      })
      .finally(() => {
        if (isCurrent) setHasLoadedBookings(true);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, isFormOpen, hasLoadedBookings]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

  const resetInvoiceForm = () => {
    setInvoiceNumber('');
    setBookingId('');
    setCurrency('ETB');
    setDueDate('');
    setTaxTotal('0');
    setDiscountTotal('0');
    setNotes('');
    setDraftLines([{ ...EMPTY_LINE }]);
  };

  const handleCreateInvoice = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !bookingId) return;
    const items: InvoiceCreateItemInput[] = draftLines.map((line) => ({
      item_type: line.item_type,
      description: line.description.trim(),
      quantity: Number(line.quantity),
      unit_price: Number(line.unit_price),
    }));
    const invoice: InvoiceCreateInput = {
      invoice_number: invoiceNumber.trim(),
      booking_id: Number(bookingId),
      currency: currency.trim().toUpperCase(),
      due_date: dueDate || null,
      tax_total: Number(taxTotal),
      discount_total: Number(discountTotal),
      notes: notes.trim(),
      items,
    };
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createInvoice(accessToken, invoice);
      setInvoices((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setTotal((current) => current + 1);
      setSelectedInvoiceId(created.id);
      setSelectedInvoice(created);
      setStatusFilter('');
      setPage(0);
      setIsFormOpen(false);
      resetInvoiceForm();
      setSuccess('Draft invoice created. It has not been issued to the customer.');
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create invoice.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenInvoice = async (invoice: InvoiceRecord) => {
    if (!accessToken) return;
    if (selectedInvoiceId === invoice.id) {
      setSelectedInvoiceId(null);
      setSelectedInvoice(null);
      return;
    }
    setSelectedInvoiceId(invoice.id);
    setSelectedInvoice(null);
    setDetailsLoading(true);
    setError(null);
    try {
      setSelectedInvoice(await fetchInvoiceDetails(accessToken, invoice.id));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load invoice details.');
    } finally {
      setDetailsLoading(false);
    }
  };

  const handleIssueInvoice = async () => {
    if (!accessToken || !selectedInvoice || selectedInvoice.status !== 'draft' || !canCreateInvoices) return;
    const confirmed = window.confirm(
      `Mark invoice ${selectedInvoice.invoice_number} (${formatAmount(selectedInvoice.grand_total, selectedInvoice.currency)}) as issued? This records the issue date and status only; it does not send a PDF/email or record payment.`,
    );
    if (!confirmed) return;

    setIsIssuing(true);
    setError(null);
    setSuccess(null);
    try {
      const issued = await issueInvoice(accessToken, selectedInvoice.id);
      setSelectedInvoice(issued);
      setInvoices((current) => current.flatMap((invoice) => {
        if (invoice.id !== issued.id) return [invoice];
        return statusFilter && statusFilter !== issued.status ? [] : [issued];
      }));
      if (statusFilter && statusFilter !== issued.status) {
        setTotal((current) => Math.max(0, current - 1));
      }
      setSuccess(`Invoice ${issued.invoice_number} marked as issued.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not issue invoice.');
    } finally {
      setIsIssuing(false);
    }
  };

  const handleRunSalesReport = async () => {
    if (!accessToken) return;
    setIsReportLoading(true);
    setError(null);
    setSuccess(null);
    try {
      setSalesReport(await fetchInvoiceSalesReport(accessToken, reportStartDate, reportEndDate));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load the invoice sales report.');
    } finally {
      setIsReportLoading(false);
    }
  };

  const handleReportPeriodChange = (period: ReportPeriod) => {
    setReportPeriod(period);
    setSalesReport(null);
    if (period === 'custom') return;
    const [start, end] = getReportPeriodDates(period, reportReferenceDate);
    setReportStartDate(start);
    setReportEndDate(end);
  };

  const handleRunBalanceReport = async () => {
    if (!accessToken) return;
    setIsBalanceLoading(true);
    setError(null);
    setSuccess(null);
    try {
      setBalanceReport(await fetchCustomerBalanceReport(accessToken));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load the customer balances report.');
    } finally {
      setIsBalanceLoading(false);
    }
  };

  const handleExportBalances = async () => {
    if (!accessToken) return;
    setIsExportingBalances(true);
    setError(null);
    try {
      await downloadCustomerBalancesCsv(accessToken);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not export the balances report.');
    } finally {
      setIsExportingBalances(false);
    }
  };

  const handleRunSupplierReport = async () => {
    if (!accessToken) return;
    setIsSupplierReportLoading(true);
    setError(null);
    setSuccess(null);
    try {
      setSupplierReport(await fetchSupplierBalanceReport(accessToken));
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load the supplier balances report.');
    } finally {
      setIsSupplierReportLoading(false);
    }
  };

  const handleExportSupplierBalances = async () => {
    if (!accessToken) return;
    setIsExportingSupplierBalances(true);
    setError(null);
    try {
      await downloadSupplierBalancesCsv(accessToken);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not export the supplier balances report.');
    } finally {
      setIsExportingSupplierBalances(false);
    }
  };

  const handleDownloadInvoice = async (invoice: InvoiceRecord | InvoiceDetails) => {
    if (!accessToken || invoice.status === 'draft' || invoice.status === 'void') return;
    setDownloadingInvoiceId(invoice.id);
    setError(null);
    try {
      const pdf = await downloadInvoicePdf(accessToken, invoice.id);
      const downloadUrl = URL.createObjectURL(pdf);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${invoice.invoice_number.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not download the invoice PDF.');
    } finally {
      setDownloadingInvoiceId(null);
    }
  };

  const updateDraftLine = (index: number, changes: Partial<InvoiceDraftLine>) => {
    setDraftLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...changes } : line));
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <button type="button" onClick={onBackToDashboard} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>Operations overview</span>
      </button>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase text-teal-800">Customer billing</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">Invoices</h1>
        </div>
        {canCreateInvoices && (
          <button type="button" onClick={() => { setIsFormOpen((current) => !current); setError(null); }} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800">
            {isFormOpen ? <X className="h-4 w-4" /> : <FilePlus2 className="h-4 w-4" />}
            {isFormOpen ? 'Close form' : 'Create draft invoice'}
          </button>
        )}
      </header>

      {error && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
      {success && <p role="status" className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-800">{success}</p>}

      <div role="tablist" aria-label="Financial views" className="inline-flex border-b border-slate-200">
        <button type="button" role="tab" aria-selected={activePanel === 'invoices'} onClick={() => setActivePanel('invoices')} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-semibold ${activePanel === 'invoices' ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          <FilePlus2 className="h-3.5 w-3.5" /> Invoices
        </button>
        <button type="button" role="tab" aria-selected={activePanel === 'report'} onClick={() => setActivePanel('report')} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-semibold ${activePanel === 'report' ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          <BarChart3 className="h-3.5 w-3.5" /> Issued sales
        </button>
        <button type="button" role="tab" aria-selected={activePanel === 'balances'} onClick={() => setActivePanel('balances')} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-semibold ${activePanel === 'balances' ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          <Wallet className="h-3.5 w-3.5" /> Balances
        </button>
        <button type="button" role="tab" aria-selected={activePanel === 'suppliers'} onClick={() => setActivePanel('suppliers')} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-semibold ${activePanel === 'suppliers' ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          <Scale className="h-3.5 w-3.5" /> Supplier balances
        </button>
      </div>

      {activePanel === 'report' ? (
        <section aria-label="Issued invoice sales report" className="space-y-4">
          <div role="group" aria-label="Report period" className="inline-flex border-b border-slate-200">
            {(['daily', 'weekly', 'monthly', 'custom'] as const).map((period) => (
              <button key={period} type="button" aria-pressed={reportPeriod === period} onClick={() => handleReportPeriodChange(period)} className={`border-b-2 px-3 py-2 text-xs font-semibold capitalize ${reportPeriod === period ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                {period}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 pb-4">
            <label className="text-xs font-medium text-slate-700">
              From
              <input type="date" value={reportStartDate} onChange={(event) => { setReportPeriod('custom'); setSalesReport(null); setReportStartDate(event.target.value); }} className="mt-1 block rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
            <label className="text-xs font-medium text-slate-700">
              To
              <input type="date" value={reportEndDate} onChange={(event) => { setReportPeriod('custom'); setSalesReport(null); setReportEndDate(event.target.value); }} className="mt-1 block rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
            <button type="button" disabled={isReportLoading || !reportStartDate || !reportEndDate || reportStartDate > reportEndDate} onClick={handleRunSalesReport} className="rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
              {isReportLoading ? 'Loading...' : 'Run report'}
            </button>
          </div>
          <p className="text-xs text-slate-500">Issued invoice sales grouped by invoice currency and issue date. These are billed amounts, not cash collected or accounting revenue recognition.</p>
          {salesReport && (
            <>
              <p className="text-xs font-medium text-slate-700">
                {formatDate(salesReport.start_date)} to {formatDate(salesReport.end_date)} · {salesReport.invoice_count} issued invoice{salesReport.invoice_count === 1 ? '' : 's'}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-xs">
                  <thead className="text-[10px] uppercase text-slate-500">
                    <tr className="border-b border-slate-200">
                      <th scope="col" className="px-3 py-2 font-semibold">Currency</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Invoices</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Subtotal</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Tax</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Discount</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Billed total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {salesReport.by_currency.map((total) => (
                      <tr key={total.currency}>
                        <td className="px-3 py-3 font-mono font-semibold text-slate-800">{total.currency.trim()}</td>
                        <td className="px-3 py-3 text-slate-700">{total.invoice_count}</td>
                        <td className="px-3 py-3 font-mono text-slate-700">{formatAmount(total.subtotal, total.currency)}</td>
                        <td className="px-3 py-3 font-mono text-slate-700">{formatAmount(total.tax_total, total.currency)}</td>
                        <td className="px-3 py-3 font-mono text-slate-700">{formatAmount(total.discount_total, total.currency)}</td>
                        <td className="px-3 py-3 font-mono font-semibold text-slate-900">{formatAmount(total.grand_total, total.currency)}</td>
                      </tr>
                    ))}
                    {salesReport.by_currency.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500">No issued invoices in this date range.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ) : activePanel === 'balances' ? (
        <section aria-label="Customer outstanding balances" className="space-y-4">
          <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 pb-4">
            <button
              type="button"
              disabled={isBalanceLoading}
              onClick={handleRunBalanceReport}
              className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              <Wallet className="h-3.5 w-3.5" />
              {isBalanceLoading ? 'Loading...' : 'Run balances report'}
            </button>
            <button
              type="button"
              disabled={isExportingBalances}
              onClick={handleExportBalances}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {isExportingBalances ? 'Exporting...' : 'Export CSV'}
            </button>
          </div>

          <p className="text-xs text-slate-500">
            Amounts still owed on issued invoices, after confirmed payments are applied. Currencies are reported
            separately and are never added together.
          </p>

          {balanceReport && (
            <>
              <p className="text-xs font-medium text-slate-700">
                As of {formatDate(balanceReport.as_of_date)} · {balanceReport.items.length} customer
                {balanceReport.items.length === 1 ? '' : 's'} with an outstanding balance
              </p>

              {balanceReport.totals_by_currency.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {balanceReport.totals_by_currency.map((total) => (
                    <span
                      key={total.currency}
                      className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs"
                    >
                      <span className="font-mono font-semibold text-amber-900">{total.currency.trim()}</span>
                      <span className="font-mono text-amber-800">
                        {formatAmount(total.grand_total, total.currency)}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse text-left text-xs">
                  <thead className="text-[10px] uppercase text-slate-500">
                    <tr className="border-b border-slate-200">
                      <th scope="col" className="px-3 py-2 font-semibold">Customer</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Currency</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Open invoices</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Invoiced</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Paid</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Outstanding</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Oldest due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {balanceReport.items.map((item) => (
                      <tr key={`${item.customer_id}-${item.currency}`} className="hover:bg-slate-50">
                        <td className="px-3 py-3 font-medium text-slate-800">{item.customer_name}</td>
                        <td className="px-3 py-3 font-mono text-slate-700">{item.currency.trim()}</td>
                        <td className="px-3 py-3 text-slate-600">{item.invoice_count}</td>
                        <td className="px-3 py-3 font-mono text-slate-600">
                          {formatAmount(item.invoiced_total, item.currency)}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-600">
                          {formatAmount(item.paid_total, item.currency)}
                        </td>
                        <td className="px-3 py-3 font-mono font-semibold text-amber-800">
                          {formatAmount(item.outstanding_total, item.currency)}
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          {item.oldest_due_date
                            ? formatDate(item.oldest_due_date)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                    {balanceReport.items.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                          Every issued invoice in this branch is settled.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!balanceReport && !isBalanceLoading && (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
              Run the report to see which customers still owe money.
            </p>
          )}
        </section>
      ) : (
        <>
      {isFormOpen && canCreateInvoices && (
        <form onSubmit={handleCreateInvoice} className="space-y-4 border-b border-slate-200 pb-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">New draft invoice</h2>
            <p className="mt-1 text-xs text-slate-500">Drafts are branch-scoped and do not record a payment or issue a customer invoice.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium text-slate-700">
              Invoice number
              <input required maxLength={40} value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs uppercase" />
            </label>
            <label className="text-xs font-medium text-slate-700 sm:col-span-2">
              Branch booking
              <select required value={bookingId} onChange={(event) => setBookingId(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
                <option value="">{bookingLoading ? 'Loading bookings...' : 'Select booking'}</option>
                {bookings.map((booking) => <option key={booking.id} value={booking.id}>{booking.booking_code} · {booking.customer_name}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Currency
              <input required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs uppercase" />
            </label>
            <label className="text-xs font-medium text-slate-700">
              Due date <span className="font-normal text-slate-500">(optional)</span>
              <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
            <label className="text-xs font-medium text-slate-700">
              Tax total
              <input required type="number" min="0" step="0.0001" value={taxTotal} onChange={(event) => setTaxTotal(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
            <label className="text-xs font-medium text-slate-700">
              Discount total
              <input required type="number" min="0" step="0.0001" value={discountTotal} onChange={(event) => setDiscountTotal(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
            <label className="text-xs font-medium text-slate-700 sm:col-span-2 lg:col-span-4">
              Notes <span className="font-normal text-slate-500">(optional)</span>
              <textarea rows={2} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} className="mt-1 w-full resize-y rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold text-slate-800">Invoice lines</h3>
              <button type="button" onClick={() => setDraftLines((current) => [...current, { ...EMPTY_LINE }])} className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-800 hover:text-teal-950">
                <Plus className="h-3.5 w-3.5" /> Add line
              </button>
            </div>
            {draftLines.map((line, index) => (
              <div key={index} className="grid gap-2 border-b border-slate-100 pb-3 sm:grid-cols-[9rem_minmax(12rem,1fr)_7rem_8rem_auto] sm:items-end">
                <label className="text-[11px] font-medium text-slate-600">
                  Type
                  <select value={line.item_type} onChange={(event) => updateDraftLine(index, { item_type: event.target.value as InvoiceItemType })} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-xs">
                    {ITEM_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label className="text-[11px] font-medium text-slate-600">
                  Description
                  <input required maxLength={1000} value={line.description} onChange={(event) => updateDraftLine(index, { description: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs" />
                </label>
                <label className="text-[11px] font-medium text-slate-600">
                  Quantity
                  <input required type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateDraftLine(index, { quantity: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs" />
                </label>
                <label className="text-[11px] font-medium text-slate-600">
                  Unit price
                  <input required type="number" min="0" step="0.0001" value={line.unit_price} onChange={(event) => updateDraftLine(index, { unit_price: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs" />
                </label>
                <button type="button" title="Remove invoice line" aria-label={`Remove invoice line ${index + 1}`} disabled={draftLines.length === 1} onClick={() => setDraftLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} className="mb-1 rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-rose-700 disabled:opacity-30">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <button type="submit" disabled={isSaving || bookingLoading || bookings.length === 0} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
            <FilePlus2 className="h-3.5 w-3.5" />
            {isSaving ? 'Saving...' : 'Save draft invoice'}
          </button>
        </form>
      )}

      <section aria-label="Invoices">
        <div className="grid gap-2 border-b border-slate-200 pb-3 sm:grid-cols-[minmax(12rem,1fr)_12rem]">
          <label className="relative block">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search invoice, booking, or customer" className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-xs" />
          </label>
          <label className="sr-only" htmlFor="invoice-status-filter">Invoice status</label>
          <select id="invoice-status-filter" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as InvoiceStatus | ''); setPage(0); }} className="rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
            <option value="">All invoice statuses</option>
            {INVOICE_STATUSES.map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
          </select>
        </div>

        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-xs">
            <thead className="text-[10px] uppercase text-slate-500">
              <tr className="border-b border-slate-200">
                <th scope="col" className="px-3 py-2 font-semibold">Invoice</th>
                <th scope="col" className="px-3 py-2 font-semibold">Customer / booking</th>
                <th scope="col" className="px-3 py-2 font-semibold">Issued</th>
                <th scope="col" className="px-3 py-2 font-semibold">Due</th>
                <th scope="col" className="px-3 py-2 font-semibold">Total</th>
                <th scope="col" className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => handleOpenInvoice(invoice)} className="font-mono font-semibold text-teal-800 hover:underline">{invoice.invoice_number}</button>
                      {invoice.status !== 'draft' && invoice.status !== 'void' && (
                        <button type="button" title="Download invoice PDF" aria-label={`Download invoice ${invoice.invoice_number} PDF`} disabled={downloadingInvoiceId === invoice.id} onClick={() => handleDownloadInvoice(invoice)} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-teal-800 disabled:opacity-50">
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-500">{invoice.item_count} line{invoice.item_count === 1 ? '' : 's'}</div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-slate-800">{invoice.customer_name}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-slate-500">{invoice.booking_code}</div>
                  </td>
                  <td className="px-3 py-3 text-slate-600">{invoice.status === 'draft' ? '—' : formatDate(invoice.issue_date)}</td>
                  <td className="px-3 py-3 text-slate-600">{formatDate(invoice.due_date)}</td>
                  <td className="px-3 py-3 font-mono font-semibold text-slate-800">{formatAmount(invoice.grand_total, invoice.currency)}</td>
                  <td className="px-3 py-3">
                    {invoice.status === 'overdue' ? (
                      <span className="font-semibold text-amber-700">Overdue</span>
      ) : activePanel === 'suppliers' ? (
        <section aria-label="Supplier outstanding balances" className="space-y-4">
          <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 pb-4">
            <button
              type="button"
              disabled={isSupplierReportLoading}
              onClick={handleRunSupplierReport}
              className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              <Scale className="h-3.5 w-3.5" />
              {isSupplierReportLoading ? 'Loading...' : 'Run supplier balances'}
            </button>
            <button
              type="button"
              disabled={isExportingSupplierBalances}
              onClick={handleExportSupplierBalances}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {isExportingSupplierBalances ? 'Exporting...' : 'Export CSV'}
            </button>
          </div>

          <p className="text-xs text-slate-500">
            Amounts still owed to ticket suppliers, taken from the bills recorded against each partner. Currencies
            are reported separately and are never added together.
          </p>

          {supplierReport && (
            <>
              <p className="text-xs font-medium text-slate-700">
                As of {formatDate(supplierReport.as_of_date)} · {supplierReport.items.length} supplier
                {supplierReport.items.length === 1 ? '' : 's'} with an outstanding balance
              </p>

              {supplierReport.totals_by_currency.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {supplierReport.totals_by_currency.map((total) => (
                    <span
                      key={total.currency}
                      className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs"
                    >
                      <span className="font-mono font-semibold text-amber-900">{total.currency.trim()}</span>
                      <span className="font-mono text-amber-800">
                        {formatAmount(total.outstanding_total, total.currency)}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse text-left text-xs">
                  <thead className="text-[10px] uppercase text-slate-500">
                    <tr className="border-b border-slate-200">
                      <th scope="col" className="px-3 py-2 font-semibold">Supplier</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Currency</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Bills</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Billed</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Paid</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Outstanding</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Overdue</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Oldest due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {supplierReport.items.map((item) => (
                      <tr key={`${item.supplier_id}-${item.currency}`} className="hover:bg-slate-50">
                        <td className="px-3 py-3 font-medium text-slate-800">{item.supplier_name}</td>
                        <td className="px-3 py-3 font-mono text-slate-700">{item.currency.trim()}</td>
                        <td className="px-3 py-3 text-slate-600">{item.bill_count}</td>
                        <td className="px-3 py-3 font-mono text-slate-600">
                          {formatAmount(item.billed_total, item.currency)}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-600">
                          {formatAmount(item.paid_total, item.currency)}
                        </td>
                        <td className="px-3 py-3 font-mono font-semibold text-amber-800">
                          {formatAmount(item.outstanding_total, item.currency)}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-600">
                          {formatAmount(item.overdue_total, item.currency)}
                          {item.overdue_bill_count > 0 && (
                            <div className="mt-0.5 text-[10px] text-amber-700">
                              {item.overdue_bill_count} overdue bill{item.overdue_bill_count === 1 ? '' : 's'}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          {item.oldest_due_date ? formatDate(item.oldest_due_date) : '—'}
                        </td>
                      </tr>
                    ))}
                    {supplierReport.items.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                          Every supplier bill in this branch is settled.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="border-t border-slate-200 pt-4">
                <h3 className="text-sm font-semibold text-slate-900">Partner invoice vs ticket fare</h3>
                <p className="mt-1 text-xs text-slate-500">{supplierReport.basis_note}</p>

                {supplierReport.reconciliation.length === 0 ? (
                  <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
                    No booking has both a partner bill and issued tickets from that partner.
                  </p>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                      <thead className="text-[10px] uppercase text-slate-500">
                        <tr className="border-b border-slate-200">
                          <th scope="col" className="px-3 py-2 font-semibold">Booking</th>
                          <th scope="col" className="px-3 py-2 font-semibold">Supplier</th>
                          <th scope="col" className="px-3 py-2 font-semibold">Currency</th>
                          <th scope="col" className="px-3 py-2 font-semibold">Billed</th>
                          <th scope="col" className="px-3 py-2 font-semibold">Ticket fare</th>
                          <th scope="col" className="px-3 py-2 font-semibold">Variance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {supplierReport.reconciliation.map((item) => (
                          <tr key={`${item.booking_id}-${item.supplier_id}-${item.currency}`} className="hover:bg-slate-50">
                            <td className="px-3 py-3 font-mono text-slate-700">{item.booking_code}</td>
                            <td className="px-3 py-3 text-slate-700">{item.supplier_name}</td>
                            <td className="px-3 py-3 font-mono text-slate-700">{item.currency.trim()}</td>
                            <td className="px-3 py-3 font-mono text-slate-600">
                              {formatAmount(item.billed_total, item.currency)}
                            </td>
                            <td className="px-3 py-3 font-mono text-slate-600">
                              {formatAmount(item.ticket_fare_total, item.currency)}
                            </td>
                            <td
                              className={`px-3 py-3 font-mono font-semibold ${
                                Number(item.variance) === 0
                                  ? 'text-slate-600'
                                  : Number(item.variance) > 0
                                    ? 'text-amber-700'
                                    : 'text-teal-700'
                              }`}
                            >
                              {Number(item.variance) > 0 ? '+' : ''}
                              {formatAmount(item.variance, item.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {!supplierReport && !isSupplierReportLoading && (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
              Run the report to see which suppliers the office still owes.
            </p>
          )}
        </section>
      ) : (
                      <span className="capitalize text-slate-600">{invoice.status.replace('_', ' ')}</span>
                    )}
                  </td>
                </tr>
              ))}
              {!isLoading && invoices.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">No invoices match this search.</td></tr>
              )}
            </tbody>
          </table>
          {isLoading && <p className="py-8 text-center text-xs text-slate-500">Loading invoices...</p>}
        </div>

        {total > 0 && (
          <div className="flex items-center justify-between border-t border-slate-200 py-3 text-xs text-slate-500">
            <span>{total} invoice{total === 1 ? '' : 's'}</span>
            <div className="flex items-center gap-3">
              <button type="button" disabled={page === 0} onClick={() => setPage((current) => current - 1)} className="font-semibold text-slate-700 disabled:opacity-40">Previous</button>
              <span>{page + 1} / {pageCount}</span>
              <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)} className="font-semibold text-slate-700 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </section>

      {selectedInvoiceId !== null && (
        <section className="border-t border-slate-200 pt-4" aria-label="Invoice details">
          {detailsLoading ? <p className="text-xs text-slate-500">Loading invoice details...</p> : selectedInvoice ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">{selectedInvoice.invoice_number}</h2>
                  <p className="mt-1 text-xs capitalize text-slate-500">{selectedInvoice.customer_name} · {selectedInvoice.booking_code} · {selectedInvoice.status.replace('_', ' ')}</p>
                </div>
                <div className="flex items-center gap-2">
                  {selectedInvoice.status !== 'draft' && selectedInvoice.status !== 'void' && (
                    <button type="button" title="Download invoice PDF" aria-label={`Download invoice ${selectedInvoice.invoice_number} PDF`} disabled={downloadingInvoiceId === selectedInvoice.id} onClick={() => handleDownloadInvoice(selectedInvoice)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-teal-800 disabled:opacity-50">
                      <Download className="h-4 w-4" />
                    </button>
                  )}
                  {selectedInvoice.status === 'draft' && canCreateInvoices && (
                    <button type="button" disabled={isIssuing} onClick={handleIssueInvoice} className="inline-flex items-center gap-1.5 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
                      <BadgeCheck className="h-3.5 w-3.5" />
                      {isIssuing ? 'Issuing...' : 'Mark as issued'}
                    </button>
                  )}
                  <button type="button" aria-label="Close invoice details" onClick={() => { setSelectedInvoiceId(null); setSelectedInvoice(null); }} className="rounded p-1.5 text-slate-500 hover:bg-slate-100">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {selectedInvoice.status === 'draft' && (
                <p className="mt-2 text-[11px] text-slate-500">Issuing records the invoice date and status. It does not generate or send an invoice document or record payment.</p>
              )}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs">
                  <thead className="border-b border-slate-200 text-[10px] uppercase text-slate-500">
                    <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">Quantity</th><th className="px-3 py-2">Unit price</th><th className="px-3 py-2">Line total</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedInvoice.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-3 py-2"><div className="font-medium text-slate-800">{item.description}</div><div className="mt-0.5 capitalize text-[10px] text-slate-500">{item.item_type.replace('_', ' ')}</div></td>
                        <td className="px-3 py-2 text-slate-600">{item.quantity}</td>
                        <td className="px-3 py-2 font-mono text-slate-600">{formatAmount(item.unit_price, selectedInvoice.currency)}</td>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-800">{formatAmount(item.line_total, selectedInvoice.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-slate-200 text-slate-600">
                    <tr><th colSpan={3} className="px-3 py-2 text-right font-medium">Subtotal</th><td className="px-3 py-2 font-mono">{formatAmount(selectedInvoice.subtotal, selectedInvoice.currency)}</td></tr>
                    <tr><th colSpan={3} className="px-3 py-2 text-right font-medium">Tax</th><td className="px-3 py-2 font-mono">{formatAmount(selectedInvoice.tax_total, selectedInvoice.currency)}</td></tr>
                    <tr><th colSpan={3} className="px-3 py-2 text-right font-medium">Discount</th><td className="px-3 py-2 font-mono">−{formatAmount(selectedInvoice.discount_total, selectedInvoice.currency)}</td></tr>
                    <tr><th colSpan={3} className="px-3 py-2 text-right font-semibold text-slate-900">Total</th><td className="px-3 py-2 font-mono font-semibold text-slate-900">{formatAmount(selectedInvoice.grand_total, selectedInvoice.currency)}</td></tr>
                  </tfoot>
                </table>
              </div>
              {selectedInvoice.notes && <p className="mt-3 whitespace-pre-wrap text-xs text-slate-600">{selectedInvoice.notes}</p>}
            </>
          ) : null}
        </section>
      )}
        </>
      )}
    </div>
  );
};