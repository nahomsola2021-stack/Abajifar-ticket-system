import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Ban, FilePlus2, Search, Wallet, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  createSupplierBill,
  createSupplierPayment,
  fetchBookings,
  fetchSupplierBills,
  fetchSupplierPayments,
  fetchSuppliers,
  voidSupplierBill,
} from '../../lib/api';
import type { BookingRecord, PaymentMethod, SupplierRecord } from '../../types/customer';
import type {
  SupplierBillRecord,
  SupplierBillStatus,
  SupplierPaymentRecord,
  SupplierPaymentStatus,
} from '../../types/finance';

const PAGE_SIZE = 50;

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'card_gateway', label: 'Card gateway' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

const BILL_STATUSES: { value: SupplierBillStatus; label: string }[] = [
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partially_paid', label: 'Part paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

const PAYMENT_STATUSES: { value: SupplierPaymentStatus; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'pending', label: 'Pending' },
  { value: 'voided', label: 'Voided' },
];

interface SupplierPaymentsViewProps {
  onBackToDashboard: () => void;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function formatAmount(amount: string | number, currency: string): string {
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

function statusLabel(status: string): string {
  return status.replace('_', ' ');
}

export const SupplierPaymentsView: React.FC<SupplierPaymentsViewProps> = ({ onBackToDashboard }) => {
  const { accessToken, staff } = useAuth();
  const [activePanel, setActivePanel] = useState<'bills' | 'payments'>('bills');

  const [bills, setBills] = useState<SupplierBillRecord[]>([]);
  const [billTotal, setBillTotal] = useState(0);
  const [billSearchInput, setBillSearchInput] = useState('');
  const [billSearch, setBillSearch] = useState('');
  const [billStatus, setBillStatus] = useState<SupplierBillStatus | ''>('');
  const [billPage, setBillPage] = useState(0);
  const [isBillLoading, setIsBillLoading] = useState(true);
  const [outstandingByCurrency, setOutstandingByCurrency] = useState<{ currency: string; amount: string }[]>([]);

  const [payments, setPayments] = useState<SupplierPaymentRecord[]>([]);
  const [paymentTotal, setPaymentTotal] = useState(0);
  const [paymentSearchInput, setPaymentSearchInput] = useState('');
  const [paymentSearch, setPaymentSearch] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<SupplierPaymentStatus | ''>('');
  const [paymentPage, setPaymentPage] = useState(0);
  const [isPaymentLoading, setIsPaymentLoading] = useState(false);
  const [paidByCurrency, setPaidByCurrency] = useState<{ currency: string; amount: string }[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [isBillFormOpen, setIsBillFormOpen] = useState(false);
  const [isSavingBill, setIsSavingBill] = useState(false);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [billSupplierId, setBillSupplierId] = useState('');
  const [billBookingId, setBillBookingId] = useState('');
  const [billReference, setBillReference] = useState('');
  const [billAmount, setBillAmount] = useState('');
  const [billCurrency, setBillCurrency] = useState('ETB');
  const [billDate, setBillDate] = useState(() => toDateInput(new Date()));
  const [billDueDate, setBillDueDate] = useState('');
  const [billNotes, setBillNotes] = useState('');

  const [paymentBillId, setPaymentBillId] = useState<number | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentCurrency, setPaymentCurrency] = useState('ETB');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('bank_transfer');
  const [paymentStatusValue, setPaymentStatusValue] = useState<SupplierPaymentStatus>('confirmed');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [isSavingPayment, setIsSavingPayment] = useState(false);

  const [voidTarget, setVoidTarget] = useState<SupplierBillRecord | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [isVoiding, setIsVoiding] = useState(false);

  const canRecord = Boolean(
    staff?.roles.some((role) => ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(role.toUpperCase())),
  );
  const billPageCount = Math.max(1, Math.ceil(billTotal / PAGE_SIZE));
  const paymentPageCount = Math.max(1, Math.ceil(paymentTotal / PAGE_SIZE));

  const openBills = useMemo(
    () => bills.filter((bill) => bill.status === 'unpaid' || bill.status === 'partially_paid'),
    [bills],
  );

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;
    fetchSupplierBills(accessToken, billSearch, billStatus, PAGE_SIZE, billPage * PAGE_SIZE)
      .then((result) => {
        if (!isCurrent) return;
        setBills(result.items);
        setBillTotal(result.total);
        setOutstandingByCurrency(result.outstanding_by_currency);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load supplier bills.');
      })
      .finally(() => {
        if (isCurrent) setIsBillLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, billSearch, billStatus, billPage, refreshKey]);

  useEffect(() => {
    if (!accessToken || activePanel !== 'payments') return;
    let isCurrent = true;
    fetchSupplierPayments(accessToken, paymentSearch, paymentStatus, PAGE_SIZE, paymentPage * PAGE_SIZE)
      .then((result) => {
        if (!isCurrent) return;
        setPayments(result.items);
        setPaymentTotal(result.total);
        setPaidByCurrency(result.paid_by_currency);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load supplier payments.');
      })
      .finally(() => {
        if (isCurrent) setIsPaymentLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, activePanel, paymentSearch, paymentStatus, paymentPage, refreshKey]);

  useEffect(() => {
    if (!accessToken || !isBillFormOpen) return;
    let isCurrent = true;
    fetchSuppliers(accessToken)
      .then((result) => {
        if (isCurrent) setSuppliers(result.filter((supplier) => supplier.is_active));
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load suppliers.');
      });
    fetchBookings(accessToken, '', '', 100, 0)
      .then((result) => {
        if (isCurrent) setBookings(result.items);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load bookings.');
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, isBillFormOpen]);

  const resetBillForm = () => {
    setBillSupplierId('');
    setBillBookingId('');
    setBillReference('');
    setBillAmount('');
    setBillCurrency('ETB');
    setBillDate(toDateInput(new Date()));
    setBillDueDate('');
    setBillNotes('');
  };

  const handleCreateBill = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !billSupplierId) return;

    setIsSavingBill(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createSupplierBill(accessToken, {
        supplier_id: Number(billSupplierId),
        booking_id: billBookingId ? Number(billBookingId) : null,
        supplier_invoice_reference: billReference.trim() || null,
        currency: billCurrency.trim().toUpperCase(),
        bill_date: billDate,
        due_date: billDueDate || null,
        amount: Number(billAmount),
        notes: billNotes.trim() || null,
      });
      resetBillForm();
      setIsBillFormOpen(false);
      setBillSearchInput('');
      setBillSearch('');
      setBillPage(0);
      setSuccess(
        `Bill ${created.bill_number ?? `#${created.id}`} recorded for ${created.supplier_name} · ${formatAmount(created.amount, created.currency)}.`,
      );
      setIsBillLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record the supplier bill.');
    } finally {
      setIsSavingBill(false);
    }
  };

  const startPayment = (bill: SupplierBillRecord) => {
    setPaymentBillId(bill.id);
    setPaymentAmount(String(Number(bill.outstanding_total)));
    setPaymentCurrency(bill.currency);
    setPaymentMethod('bank_transfer');
    setPaymentStatusValue('confirmed');
    setPaymentReference('');
    setPaymentNotes('');
    setError(null);
  };

  const handleCreatePayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || paymentBillId === null) return;

    setIsSavingPayment(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createSupplierPayment(accessToken, paymentBillId, {
        amount: Number(paymentAmount),
        currency: paymentCurrency.trim().toUpperCase(),
        payment_method: paymentMethod,
        status: paymentStatusValue,
        external_reference: paymentReference.trim() || null,
        notes: paymentNotes.trim() || null,
      });
      setPaymentBillId(null);
      setPaymentAmount('');
      setSuccess(
        `Payment of ${formatAmount(created.amount, created.currency)} recorded against bill ${created.bill_number ?? `#${created.supplier_bill_id}`}.`,
      );
      setIsBillLoading(true);
      setIsPaymentLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record the supplier payment.');
    } finally {
      setIsSavingPayment(false);
    }
  };

  const handleVoidBill = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !voidTarget) return;

    setIsVoiding(true);
    setError(null);
    setSuccess(null);
    try {
      const voided = await voidSupplierBill(accessToken, voidTarget.id, voidReason.trim());
      setVoidTarget(null);
      setVoidReason('');
      setSuccess(`Bill ${voided.bill_number ?? `#${voided.id}`} voided and removed from the outstanding balances.`);
      setIsBillLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not void the bill.');
    } finally {
      setIsVoiding(false);
    }
  };

  const billForPayment = bills.find((bill) => bill.id === paymentBillId) ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <button type="button" onClick={onBackToDashboard} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>Operations overview</span>
      </button>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase text-teal-800">Payables</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">Supplier Payments</h1>
        </div>
        {canRecord && (
          <button type="button" onClick={() => { setIsBillFormOpen((current) => !current); setError(null); }} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800">
            {isBillFormOpen ? <X className="h-4 w-4" /> : <FilePlus2 className="h-4 w-4" />}
            {isBillFormOpen ? 'Close form' : 'Record partner bill'}
          </button>
        )}
      </header>

      {error && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
      {success && <p role="status" className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-800">{success}</p>}

      <div role="tablist" aria-label="Supplier payment views" className="inline-flex border-b border-slate-200">
        <button type="button" role="tab" aria-selected={activePanel === 'bills'} onClick={() => setActivePanel('bills')} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-semibold ${activePanel === 'bills' ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          <Wallet className="h-3.5 w-3.5" /> Partner bills
        </button>
        <button type="button" role="tab" aria-selected={activePanel === 'payments'} onClick={() => setActivePanel('payments')} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-semibold ${activePanel === 'payments' ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          <Wallet className="h-3.5 w-3.5" /> Payments made
        </button>
      </div>

      {isBillFormOpen && canRecord && (
        <form onSubmit={handleCreateBill} className="space-y-4 border-b border-slate-200 pb-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Record a partner bill</h2>
            <p className="mt-1 text-xs text-slate-500">
              A bill is what the partner has invoiced the office. The office generates its own bill number and keeps
              the partner reference alongside it. Amounts stay in the currency the partner invoiced in.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium text-slate-700 sm:col-span-2">
              Supplier
              <select required value={billSupplierId} onChange={(event) => setBillSupplierId(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
                <option value="">Select supplier</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.trading_name || supplier.legal_name} · {supplier.settlement_currency}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-slate-700 sm:col-span-2">
              Linked booking <span className="font-normal text-slate-500">(optional)</span>
              <select value={billBookingId} onChange={(event) => setBillBookingId(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
                <option value="">No booking</option>
                {bookings.map((booking) => (
                  <option key={booking.id} value={booking.id}>
                    {booking.booking_code} · {booking.customer_name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-slate-700">
              Partner invoice reference <span className="font-normal text-slate-500">(optional)</span>
              <input maxLength={120} value={billReference} onChange={(event) => setBillReference(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" placeholder="The partner's own invoice number" />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Amount
              <input required type="number" min="0.0001" step="0.0001" value={billAmount} onChange={(event) => setBillAmount(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" placeholder="0.00" />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Currency
              <input required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" value={billCurrency} onChange={(event) => setBillCurrency(event.target.value.toUpperCase())} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs uppercase" />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Bill date
              <input required type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Due date <span className="font-normal text-slate-500">(optional)</span>
              <input type="date" min={billDate} value={billDueDate} onChange={(event) => setBillDueDate(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>

            <label className="text-xs font-medium text-slate-700 sm:col-span-2 lg:col-span-4">
              Notes <span className="font-normal text-slate-500">(optional)</span>
              <textarea rows={2} maxLength={2000} value={billNotes} onChange={(event) => setBillNotes(event.target.value)} className="mt-1 w-full resize-y rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
          </div>

          <button type="submit" disabled={isSavingBill || !billSupplierId || !billAmount} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
            <FilePlus2 className="h-3.5 w-3.5" />
            {isSavingBill ? 'Saving...' : 'Record bill'}
          </button>
        </form>
      )}

      {activePanel === 'bills' ? (
        <section aria-label="Partner bills" className="space-y-3">
          <div className="grid gap-2 border-b border-slate-200 pb-3 sm:grid-cols-[minmax(12rem,1fr)_12rem]">
            <label className="relative block">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <input value={billSearchInput} onChange={(event) => { setIsBillLoading(true); setBillSearchInput(event.target.value); setBillSearch(event.target.value.trim()); setBillPage(0); }} placeholder="Search supplier, bill number, or partner reference" className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-xs" />
            </label>
            <label className="sr-only" htmlFor="bill-status-filter">Bill status</label>
            <select id="bill-status-filter" value={billStatus} onChange={(event) => { setIsBillLoading(true); setBillStatus(event.target.value as SupplierBillStatus | ''); setBillPage(0); }} className="rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
              <option value="">All bill statuses</option>
              {BILL_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </select>
          </div>

          {outstandingByCurrency.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {outstandingByCurrency.map((total) => (
                <span key={total.currency} className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs">
                  <span className="font-mono font-semibold text-amber-900">{total.currency.trim()}</span>
                  <span className="font-mono text-amber-800">{formatAmount(total.amount, total.currency)}</span>
                  <span className="text-amber-700">owed</span>
                </span>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-xs">
              <thead className="text-[10px] uppercase text-slate-500">
                <tr className="border-b border-slate-200">
                  <th scope="col" className="px-3 py-2 font-semibold">Bill</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Supplier</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Booking</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Bill date</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Due</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Amount</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Outstanding</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bills.map((bill) => (
                  <tr key={bill.id} className="hover:bg-slate-50">
                    <td className="px-3 py-3">
                      <div className="font-mono font-semibold text-slate-800">{bill.bill_number || `#${bill.id}`}</div>
                      {bill.supplier_invoice_reference && (
                        <div className="mt-0.5 font-mono text-[10px] text-slate-500">{bill.supplier_invoice_reference}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-700">{bill.supplier_name}</td>
                    <td className="px-3 py-3 font-mono text-[10px] text-slate-500">{bill.booking_code || '—'}</td>
                    <td className="px-3 py-3 text-slate-600">{formatDate(bill.bill_date)}</td>
                    <td className="px-3 py-3 text-slate-600">{formatDate(bill.due_date)}</td>
                    <td className="px-3 py-3 font-mono font-semibold text-slate-800">{formatAmount(bill.amount, bill.currency)}</td>
                    <td className="px-3 py-3 font-mono text-slate-600">{formatAmount(bill.outstanding_total, bill.currency)}</td>
                    <td className="px-3 py-3 capitalize text-slate-600">{statusLabel(bill.status)}</td>
                    <td className="px-3 py-3 text-right">
                      {canRecord && (bill.status === 'unpaid' || bill.status === 'partially_paid') && (
                        <button type="button" onClick={() => startPayment(bill)} className="mr-2 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                          Pay
                        </button>
                      )}
                      {canRecord && bill.status !== 'void' && (
                        <button type="button" onClick={() => { setVoidTarget(bill); setVoidReason(''); }} aria-label={`Void bill ${bill.bill_number ?? bill.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-rose-50 hover:text-rose-700">
                          <Ban className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!isBillLoading && bills.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-10 text-center text-slate-500">No partner bills match this search.</td></tr>
                )}
              </tbody>
            </table>
            {isBillLoading && <p className="py-8 text-center text-xs text-slate-500">Loading bills...</p>}
          </div>

          {billTotal > 0 && (
            <div className="flex items-center justify-between border-t border-slate-200 py-3 text-xs text-slate-500">
              <span>{billTotal} bill{billTotal === 1 ? '' : 's'}</span>
              <div className="flex items-center gap-3">
                <button type="button" disabled={billPage === 0} onClick={() => { setIsBillLoading(true); setBillPage((current) => current - 1); }} className="font-semibold text-slate-700 disabled:opacity-40">Previous</button>
                <span>{billPage + 1} / {billPageCount}</span>
                <button type="button" disabled={billPage + 1 >= billPageCount} onClick={() => { setIsBillLoading(true); setBillPage((current) => current + 1); }} className="font-semibold text-slate-700 disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <section aria-label="Payments made to suppliers" className="space-y-3">
          <div className="grid gap-2 border-b border-slate-200 pb-3 sm:grid-cols-[minmax(12rem,1fr)_12rem]">
            <label className="relative block">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <input value={paymentSearchInput} onChange={(event) => { setIsPaymentLoading(true); setPaymentSearchInput(event.target.value); setPaymentSearch(event.target.value.trim()); setPaymentPage(0); }} placeholder="Search supplier, bill number, or reference" className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-xs" />
            </label>
            <label className="sr-only" htmlFor="payment-status-filter">Payment status</label>
            <select id="payment-status-filter" value={paymentStatus} onChange={(event) => { setIsPaymentLoading(true); setPaymentStatus(event.target.value as SupplierPaymentStatus | ''); setPaymentPage(0); }} className="rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
              <option value="">All payment statuses</option>
              {PAYMENT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </select>
          </div>

          {paidByCurrency.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {paidByCurrency.map((total) => (
                <span key={total.currency} className="inline-flex items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs">
                  <span className="font-mono font-semibold text-teal-900">{total.currency.trim()}</span>
                  <span className="font-mono text-teal-800">{formatAmount(total.amount, total.currency)}</span>
                  <span className="text-teal-700">paid</span>
                </span>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left text-xs">
              <thead className="text-[10px] uppercase text-slate-500">
                <tr className="border-b border-slate-200">
                  <th scope="col" className="px-3 py-2 font-semibold">Bill</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Supplier</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Paid</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Method</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Amount</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Reference</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-slate-50">
                    <td className="px-3 py-3 font-mono font-semibold text-slate-800">{payment.bill_number || `#${payment.supplier_bill_id}`}</td>
                    <td className="px-3 py-3 text-slate-700">{payment.supplier_name}</td>
                    <td className="px-3 py-3 text-slate-600">
                      {new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(payment.paid_at))}
                    </td>
                    <td className="px-3 py-3 capitalize text-slate-600">{statusLabel(payment.payment_method)}</td>
                    <td className="px-3 py-3 font-mono font-semibold text-slate-800">{formatAmount(payment.amount, payment.currency)}</td>
                    <td className="px-3 py-3 font-mono text-[10px] text-slate-500">{payment.external_reference || '—'}</td>
                    <td className="px-3 py-3 capitalize text-slate-600">{statusLabel(payment.status)}</td>
                  </tr>
                ))}
                {!isPaymentLoading && payments.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-500">No supplier payments match this search.</td></tr>
                )}
              </tbody>
            </table>
            {isPaymentLoading && <p className="py-8 text-center text-xs text-slate-500">Loading payments...</p>}
          </div>

          {paymentTotal > 0 && (
            <div className="flex items-center justify-between border-t border-slate-200 py-3 text-xs text-slate-500">
              <span>{paymentTotal} payment{paymentTotal === 1 ? '' : 's'}</span>
              <div className="flex items-center gap-3">
                <button type="button" disabled={paymentPage === 0} onClick={() => { setIsPaymentLoading(true); setPaymentPage((current) => current - 1); }} className="font-semibold text-slate-700 disabled:opacity-40">Previous</button>
                <span>{paymentPage + 1} / {paymentPageCount}</span>
                <button type="button" disabled={paymentPage + 1 >= paymentPageCount} onClick={() => { setIsPaymentLoading(true); setPaymentPage((current) => current + 1); }} className="font-semibold text-slate-700 disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </section>
      )}

      {paymentBillId !== null && (
        <section className="border-t border-slate-200 pt-4" aria-label="Pay a partner bill">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Pay bill {billForPayment?.bill_number || `#${paymentBillId}`}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                The payment must be in {billForPayment?.currency ?? 'the bill'} currency and cannot exceed the
                {` ${billForPayment?.outstanding_total ?? ''}`} still owed.
              </p>
            </div>
            <button type="button" aria-label="Close payment form" onClick={() => setPaymentBillId(null)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleCreatePayment} className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
            <label className="text-xs font-medium text-slate-700">
              Amount
              <input required type="number" min="0.0001" step="0.0001" max={billForPayment?.outstanding_total} value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
            <label className="text-xs font-medium text-slate-700">
              Currency
              <input required readOnly minLength={3} maxLength={3} value={paymentCurrency} className="mt-1 w-full rounded-md border border-slate-200 bg-slate-100 px-2.5 py-2 text-xs uppercase" />
            </label>
            <label className="text-xs font-medium text-slate-700">
              Method
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
                {PAYMENT_METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Status
              <select value={paymentStatusValue} onChange={(event) => setPaymentStatusValue(event.target.value as SupplierPaymentStatus)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs">
                {PAYMENT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Bank reference <span className="font-normal text-slate-500">(optional)</span>
              <input maxLength={120} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" />
            </label>
            <button type="submit" disabled={isSavingPayment || !paymentAmount} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
              <Wallet className="h-3.5 w-3.5" />
              {isSavingPayment ? 'Saving...' : 'Record payment'}
            </button>
          </form>
        </section>
      )}

      {voidTarget !== null && (
        <section className="border-t border-slate-200 pt-4" aria-label="Void a partner bill">
          <h2 className="text-sm font-semibold text-slate-900">
            Void bill {voidTarget.bill_number || `#${voidTarget.id}`}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Voiding keeps the record but removes it from the outstanding balances. It is not possible once a payment
            has been recorded against the bill.
          </p>
          <form onSubmit={handleVoidBill} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="min-w-[16rem] flex-1 text-xs font-medium text-slate-700">
              Reason
              <input required minLength={3} maxLength={500} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs" placeholder="Why is this bill being voided?" />
            </label>
            <button type="submit" disabled={isVoiding || voidReason.trim().length < 3} className="rounded-md bg-rose-700 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-800 disabled:opacity-50">
              {isVoiding ? 'Voiding...' : 'Void bill'}
            </button>
            <button type="button" onClick={() => setVoidTarget(null)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
          </form>
        </section>
      )}

      {openBills.length > 0 && activePanel === 'bills' && (
        <p className="text-[11px] text-slate-500">
          {openBills.length} bill{openBills.length === 1 ? '' : 's'} on this page still have money owed.
        </p>
      )}
    </div>
  );
};
