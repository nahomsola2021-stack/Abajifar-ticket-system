import React, { useEffect, useState } from 'react';
import { ArrowLeft, Banknote, FilePlus2, Link2, Plus, Search, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  allocatePaymentToInvoice,
  createPayment,
  fetchAllocatableInvoices,
  fetchCustomers,
  fetchPayments,
} from '../../lib/api';
import type {
  AllocatableInvoiceRecord,
  CustomerRecord,
  PaymentMethod,
  PaymentRecord,
  PaymentStatus,
} from '../../types/customer';

const PAGE_SIZE = 50;

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'card_gateway', label: 'Card gateway' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

const PAYMENT_STATUSES: { value: PaymentStatus; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'pending', label: 'Pending' },
  { value: 'voided', label: 'Voided' },
];

interface PaymentsViewProps {
  onBackToDashboard: () => void;
}

function formatAmount(amount: string | number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.trim() }).format(Number(amount));
  } catch {
    return `${currency.trim()} ${amount}`;
  }
}

export const PaymentsView: React.FC<PaymentsViewProps> = ({ onBackToDashboard }) => {
  const { accessToken, staff } = useAuth();
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerRecord[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRecord | null>(null);
  const [customerLookupLoading, setCustomerLookupLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('ETB');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('confirmed');
  const [receiptNumber, setReceiptNumber] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [notes, setNotes] = useState('');

  const [allocationPaymentId, setAllocationPaymentId] = useState<number | null>(null);
  const [isAllocating, setIsAllocating] = useState(false);
  const [openInvoices, setOpenInvoices] = useState<AllocatableInvoiceRecord[]>([]);
  const [allocationInvoiceId, setAllocationInvoiceId] = useState('');
  const [allocationAmount, setAllocationAmount] = useState('');

  const canRecordPayments = Boolean(
    staff?.roles.some((role) => ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'CASHIER'].includes(role.toUpperCase())),
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectedPayment = payments.find((payment) => payment.id === allocationPaymentId) ?? null;
  // The server requires the payment and the invoice to share a currency, so
  // only invoices in the payment's currency can take this money.
  const allocatableInvoices = selectedPayment
    ? openInvoices.filter((invoice) => invoice.currency === selectedPayment.currency)
    : openInvoices;
  const selectedInvoice = allocatableInvoices.find((invoice) => String(invoice.id) === allocationInvoiceId) ?? null;
  // The amount can never be more than what the invoice still owes, nor more
  // than what is left unallocated on the payment.
  const maxAllocatableAmount = selectedInvoice
    ? Math.min(
        Number(selectedInvoice.balance_due),
        selectedPayment ? Number(selectedPayment.unallocated_total) : Number(selectedInvoice.balance_due),
      )
    : null;

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;

    fetchPayments(accessToken, search, PAGE_SIZE, page * PAGE_SIZE)
      .then((result) => {
        if (!isCurrent) return;
        setPayments(result.items);
        setTotal(result.total);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load payments.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, search, page, refreshKey]);

  useEffect(() => {
    if (!accessToken || !isFormOpen || selectedCustomer) return;
    let isCurrent = true;
    const timeoutId = window.setTimeout(() => {
      setCustomerLookupLoading(true);
      fetchCustomers(accessToken, customerQuery, 20, 0)
        .then((result) => {
          if (isCurrent) setCustomerResults(result.items);
        })
        .catch((requestError: unknown) => {
          if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not search customers.');
        })
        .finally(() => {
          if (isCurrent) setCustomerLookupLoading(false);
        });
    }, 250);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
    };
  }, [accessToken, isFormOpen, customerQuery, selectedCustomer]);

  useEffect(() => {
    if (!accessToken || allocationPaymentId === null) return;
    let isCurrent = true;

    fetchAllocatableInvoices(accessToken, 200)
      .then((items) => {
        if (isCurrent) setOpenInvoices(items);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load invoices.');
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, allocationPaymentId]);

  const resetPaymentForm = () => {
    setSelectedCustomer(null);
    setCustomerQuery('');
    setCustomerResults([]);
    setAmount('');
    setCurrency('ETB');
    setPaymentMethod('cash');
    setPaymentStatus('confirmed');
    setReceiptNumber('');
    setExternalReference('');
    setNotes('');
  };

  const handleCreatePayment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !selectedCustomer) return;

    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createPayment(accessToken, {
        customer_id: selectedCustomer.id,
        currency: currency.trim().toUpperCase(),
        amount: Number(amount),
        payment_method: paymentMethod,
        status: paymentStatus,
        receipt_number: receiptNumber.trim() || null,
        external_reference: externalReference.trim() || null,
        notes: notes.trim() || null,
      });
      resetPaymentForm();
      setIsFormOpen(false);
      setSearchInput('');
      setSearch('');
      setPage(0);
      setSuccess(`Payment of ${formatAmount(created.amount, created.currency)} recorded for ${created.customer_name}.`);
      setIsLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not record the payment.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAllocate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || allocationPaymentId === null || !allocationInvoiceId) return;

    setIsAllocating(true);
    setError(null);
    setSuccess(null);
    try {
      const allocation = await allocatePaymentToInvoice(accessToken, allocationPaymentId, {
        invoice_id: Number(allocationInvoiceId),
        amount: Number(allocationAmount),
      });
      const sourcePayment = payments.find((item) => item.id === allocationPaymentId);
      setAllocationInvoiceId('');
      setAllocationAmount('');
      setSuccess(
        `Allocated ${formatAmount(allocation.amount, sourcePayment?.currency ?? 'ETB')} to invoice ${allocation.invoice_number}.`,
      );
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not allocate the payment.');
    } finally {
      setIsAllocating(false);
    }
  };

  const toggleAllocation = (paymentId: number) => {
    setAllocationPaymentId((current) => (current === paymentId ? null : paymentId));
    setAllocationInvoiceId('');
    setAllocationAmount('');
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <button type="button" onClick={onBackToDashboard} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-3.5 w-3.5" />
        <span>Operations overview</span>
      </button>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase text-teal-800">Cash collection</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">Customer Payments</h1>
        </div>
        {canRecordPayments && (
          <button type="button" onClick={() => { setIsFormOpen((current) => !current); setError(null); }} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800">
            {isFormOpen ? <X className="h-4 w-4" /> : <FilePlus2 className="h-4 w-4" />}
            {isFormOpen ? 'Close form' : 'Record payment'}
          </button>
        )}
      </header>

      {error && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
      {success && <p role="status" className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-800">{success}</p>}

      {isFormOpen && canRecordPayments && (
        <form onSubmit={handleCreatePayment} className="space-y-4 border-b border-slate-200 pb-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Record a customer payment</h2>
            <p className="mt-1 text-xs text-slate-500">
              Amounts are stored in the currency you select. A payment stays unallocated until it is applied to an invoice.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label htmlFor="payment-customer-search" className="text-xs font-medium text-slate-700">
                Customer
              </label>
              {selectedCustomer ? (
                <div className="mt-1 flex items-center justify-between rounded-md border border-teal-300 bg-white px-3 py-2">
                  <span className="truncate text-sm font-medium text-slate-900">{selectedCustomer.display_name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCustomer(null);
                      setCustomerQuery('');
                    }}
                    className="ml-2 text-xs font-semibold text-teal-800 hover:text-teal-950"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    id="payment-customer-search"
                    value={customerQuery}
                    onChange={(event) => setCustomerQuery(event.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                    placeholder="Search customer name, email, or phone"
                    autoComplete="off"
                  />
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white">
                    {customerLookupLoading ? (
                      <p className="px-3 py-2 text-xs text-slate-500">Searching customers...</p>
                    ) : customerResults.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-slate-500">
                        {customerQuery ? 'No matching customers.' : 'Start typing to search customers.'}
                      </p>
                    ) : (
                      customerResults.map((customer) => (
                        <button
                          key={customer.id}
                          type="button"
                          onClick={() => setSelectedCustomer(customer)}
                          className="flex w-full items-center justify-between border-b border-slate-100 px-3 py-2 text-left last:border-0 hover:bg-teal-50"
                        >
                          <span className="truncate text-sm font-medium text-slate-800">{customer.display_name}</span>
                          <span className="ml-3 shrink-0 text-xs capitalize text-slate-500">{customer.customer_type}</span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>

            <label className="text-xs font-medium text-slate-700">
              Amount
              <input
                required
                type="number"
                min="0.0001"
                step="0.0001"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs"
                placeholder="0.00"
              />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Currency
              <input
                required
                minLength={3}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs uppercase"
              />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Payment method
              <select
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs"
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method.value} value={method.value}>{method.label}</option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-slate-700">
              Status
              <select
                value={paymentStatus}
                onChange={(event) => setPaymentStatus(event.target.value as PaymentStatus)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs"
              >
                {PAYMENT_STATUSES.map((status) => (
                  <option key={status.value} value={status.value}>{status.label}</option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-slate-700">
              Receipt number <span className="font-normal text-slate-500">(optional)</span>
              <input
                maxLength={40}
                value={receiptNumber}
                onChange={(event) => setReceiptNumber(event.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs"
              />
            </label>

            <label className="text-xs font-medium text-slate-700">
              External reference <span className="font-normal text-slate-500">(optional)</span>
              <input
                maxLength={120}
                value={externalReference}
                onChange={(event) => setExternalReference(event.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs"
                placeholder="Transaction or slip number"
              />
            </label>

            <label className="text-xs font-medium text-slate-700 sm:col-span-2 lg:col-span-4">
              Notes <span className="font-normal text-slate-500">(optional)</span>
              <textarea
                rows={2}
                maxLength={2000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="mt-1 w-full resize-y rounded-md border border-slate-300 px-2.5 py-2 text-xs"
              />
            </label>
          </div>

          <button type="submit" disabled={isSaving || !selectedCustomer || !amount} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
            <Banknote className="h-3.5 w-3.5" />
            {isSaving ? 'Saving...' : 'Record payment'}
          </button>
        </form>
      )}

      <section aria-label="Customer payments">
        <div className="grid gap-2 border-b border-slate-200 pb-3 sm:grid-cols-[minmax(12rem,1fr)_auto]">
          <label className="relative block">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
                setSearch(event.target.value.trim());
                setPage(0);
              }}
              placeholder="Search customer, receipt number, or reference"
              className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-xs"
            />
          </label>
        </div>

        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-xs">
            <thead className="text-[10px] uppercase text-slate-500">
              <tr className="border-b border-slate-200">
                <th scope="col" className="px-3 py-2 font-semibold">Receipt</th>
                <th scope="col" className="px-3 py-2 font-semibold">Customer</th>
                <th scope="col" className="px-3 py-2 font-semibold">Received</th>
                <th scope="col" className="px-3 py-2 font-semibold">Method</th>
                <th scope="col" className="px-3 py-2 font-semibold">Amount</th>
                <th scope="col" className="px-3 py-2 font-semibold">Allocated</th>
                <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((payment) => {
                const unallocated = Number(payment.unallocated_total);
                const canAllocate = payment.status !== 'voided' && unallocated > 0;
                return (
                  <tr key={payment.id} className="hover:bg-slate-50">
                    <td className="px-3 py-3">
                      <div className="font-mono font-semibold text-slate-800">
                        {payment.receipt_number || `#${payment.id}`}
                      </div>
                      {payment.external_reference && (
                        <div className="mt-0.5 font-mono text-[10px] text-slate-500">{payment.external_reference}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-700">{payment.customer_name}</td>
                    <td className="px-3 py-3 text-slate-600">
                      {payment.received_at
                        ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(payment.received_at))
                        : '—'}
                    </td>
                    <td className="px-3 py-3 capitalize text-slate-600">
                      {payment.payment_method.replace('_', ' ')}
                    </td>
                    <td className="px-3 py-3 font-mono font-semibold text-slate-800">
                      {formatAmount(payment.amount, payment.currency)}
                    </td>
                    <td className="px-3 py-3 font-mono text-slate-600">
                      {formatAmount(payment.allocated_total, payment.currency)}
                      {unallocated > 0 && (
                        <div className="mt-0.5 text-[10px] text-amber-700">
                          {formatAmount(payment.unallocated_total, payment.currency)} unallocated
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 capitalize text-slate-600">{payment.status}</td>
                    <td className="px-3 py-3 text-right">
                      {canAllocate && (
                        <button
                          type="button"
                          onClick={() => toggleAllocation(payment.id)}
                          aria-expanded={allocationPaymentId === payment.id}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          {allocationPaymentId === payment.id ? 'Close' : 'Allocate'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!isLoading && payments.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-slate-500">
                    No payments match this search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {isLoading && <p className="py-8 text-center text-xs text-slate-500">Loading payments...</p>}
        </div>

        {total > 0 && (
          <div className="flex items-center justify-between border-t border-slate-200 py-3 text-xs text-slate-500">
            <span>{total} payment{total === 1 ? '' : 's'}</span>
            <div className="flex items-center gap-3">
              <button type="button" disabled={page === 0} onClick={() => setPage((current) => current - 1)} className="font-semibold text-slate-700 disabled:opacity-40">Previous</button>
              <span>{page + 1} / {pageCount}</span>
              <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)} className="font-semibold text-slate-700 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </section>

      {allocationPaymentId !== null && (
        <section className="border-t border-slate-200 pt-4" aria-label="Allocate payment to invoice">
          <h2 className="text-sm font-semibold text-slate-900">Allocate payment to an invoice</h2>
          <p className="mt-1 text-xs text-slate-500">
            The payment and invoice must use the same currency. The allocation cannot exceed either the unallocated
            payment balance or the unpaid invoice balance.
          </p>
          <form onSubmit={handleAllocate} className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
            <label className="text-xs font-medium text-slate-700">
              Invoice with an outstanding balance
              <select
                required
                value={allocationInvoiceId}
                onChange={(event) => {
                  const invoiceId = event.target.value;
                  setAllocationInvoiceId(invoiceId);
                  const selected = allocatableInvoices.find((invoice) => String(invoice.id) === invoiceId);
                  if (!selected) {
                    setAllocationAmount('');
                    return;
                  }
                  const payable = Math.min(
                    Number(selected.balance_due),
                    selectedPayment ? Number(selectedPayment.unallocated_total) : Number(selected.balance_due),
                  );
                  setAllocationAmount(String(payable));
                }}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs"
              >
                <option value="">{allocatableInvoices.length === 0 ? 'No invoices awaiting payment' : 'Select invoice'}</option>
                {allocatableInvoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.invoice_number} · {invoice.customer_name} · {formatAmount(invoice.balance_due, invoice.currency)} due
                    {invoice.status === 'partially_paid' ? ' (part paid)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Amount to apply
              <input
                required
                type="number"
                min="0.0001"
                step="0.0001"
                max={maxAllocatableAmount !== null ? String(maxAllocatableAmount) : undefined}
                value={allocationAmount}
                onChange={(event) => setAllocationAmount(event.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs"
              />
              {selectedInvoice && (
                <span className="mt-1 block text-[11px] text-slate-500">
                  {formatAmount(selectedInvoice.balance_due, selectedInvoice.currency)} still owing on this invoice
                </span>
              )}
            </label>
            <button type="submit" disabled={isAllocating || !allocationInvoiceId || !allocationAmount} className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" />
              {isAllocating ? 'Allocating...' : 'Apply payment'}
            </button>
          </form>
        </section>
      )}
    </div>
  );
};
