import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Search, Ticket, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { deleteTicketSale, fetchTicketSales } from '../../lib/api';
import type { CurrencyTotal, TicketSaleRecord, TicketSaleStatus } from '../../types/customer';
import {
  Card,
  ConfirmDialog,
  CurrencyLines,
  Dialog,
  EmptyState,
  LoadingRows,
  Notice,
  Page,
  PageHeader,
  Pagination,
  StatusBadge,
  btnPrimary,
  btnSecondary,
  formatAmount,
  formatDate,
  inputCls,
  type Tone,
} from '../ui';

const PAGE_SIZE = 50;

const FILTERS: { value: TicketSaleStatus | ''; label: string }[] = [
  { value: '', label: 'All sales' },
  { value: 'pending', label: 'Waiting for ticket number' },
  { value: 'issued', label: 'Ticketed' },
  { value: 'exchanged', label: 'Exchanged' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'voided', label: 'Voided' },
];

const STATUS: Record<TicketSaleStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for ticket number', tone: 'warn' },
  issued: { label: 'Ticketed', tone: 'good' },
  exchanged: { label: 'Exchanged', tone: 'info' },
  refunded: { label: 'Refunded', tone: 'info' },
  voided: { label: 'Voided', tone: 'neutral' },
};

interface TicketSalesViewProps {
  onBackToDashboard: () => void;
}

const Summary: React.FC<{ label: string; hint: string; totals: CurrencyTotal[]; amountCls?: string }> = ({
  label,
  hint,
  totals,
  amountCls,
}) => (
  <Card className="p-5">
    <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
    <p className="text-xs text-slate-500">{hint}</p>
    <CurrencyLines totals={totals} empty="Nothing recorded yet" amountCls={amountCls} />
  </Card>
);

export const TicketSalesView: React.FC<TicketSalesViewProps> = () => {
  const { accessToken } = useAuth();
  const [sales, setSales] = useState<TicketSaleRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [sellingTotals, setSellingTotals] = useState<CurrencyTotal[]>([]);
  const [costTotals, setCostTotals] = useState<CurrencyTotal[]>([]);
  const [marginTotals, setMarginTotals] = useState<CurrencyTotal[]>([]);
  const [marginBasis, setMarginBasis] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<TicketSaleStatus | ''>('');
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TicketSaleRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;

    fetchTicketSales(accessToken, search)
      .then((result) => {
        if (!isCurrent) return;
        setSales(result.items);
        setTotal(result.total);
        setSellingTotals(result.selling_total_by_currency);
        setCostTotals(result.supplier_cost_total_by_currency);
        setMarginTotals(result.gross_margin_by_currency);
        setMarginBasis(result.margin_basis);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load ticket sales.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, search, status, page, refreshKey]);

  const handleDelete = async () => {
    if (!accessToken || !deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteTicketSale(accessToken, deleteTarget.id);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete the sale.');
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
      setRefreshKey((key) => key + 1);
    }
  };

  return (
    <Page wide>
      <PageHeader
        title="Ticket sales"
        description="Every ticket you have sold, with what the customer paid, what the supplier charged and what you kept."
        action={
          <>
            <button type="button" onClick={() => setRefreshKey((key) => key + 1)} className={btnSecondary}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <button type="button" onClick={() => setIsFormOpen(true)} className={btnPrimary}>
              <Plus className="h-4 w-4" />
              Record ticket sale
            </button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Summary label="Sold for" hint="What customers were charged" totals={sellingTotals} />
        <Summary label="Supplier cost" hint="What suppliers charged you" totals={costTotals} />
        <Summary label="Gross margin" hint="Sold for minus supplier cost" totals={marginTotals} amountCls="text-emerald-700" />
      </div>
      {marginBasis && <p className="-mt-2 text-xs text-slate-500">{marginBasis}</p>}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setIsLoading(true);
              setPage(0);
              if (searchInput.trim() === search && page === 0) setRefreshKey((key) => key + 1);
              else setSearch(searchInput.trim());
            }}
            className="flex min-w-[16rem] flex-1 items-center gap-2"
          >
            <label className="relative block flex-1">
              <span className="sr-only">Search ticket sales</span>
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search by customer, booking, PNR or ticket number"
                className={`${inputCls} !mt-0 pl-10`}
              />
            </label>
            <button type="submit" className={btnSecondary}>
              Search
            </button>
          </form>
          <label>
            <span className="sr-only">Filter by status</span>
            <select
              value={status}
              onChange={(event) => {
                setIsLoading(true);
                setPage(0);
                setStatus(event.target.value as TicketSaleStatus | '');
              }}
              className={`${inputCls} !mt-0 w-auto pr-9`}
            >
              {FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <div className="p-4">
            <Notice kind="error" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          </div>
        )}

        {isLoading ? (
          <LoadingRows label="Loading ticket sales" />
        ) : sales.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title={search || status ? 'No sales match your search' : 'No ticket sales yet'}
            hint={search || status ? 'Try a different name, number or status.' : 'When you record a sale it will show up here.'}
            action={
              search || status ? undefined : (
                <button type="button" onClick={() => setIsFormOpen(true)} className={btnPrimary}>
                  <Plus className="h-4 w-4" />
                  Record ticket sale
                </button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-3">Customer and passenger</th>
                  <th scope="col" className="px-4 py-3">Booking</th>
                  <th scope="col" className="px-4 py-3">Supplier</th>
                  <th scope="col" className="px-4 py-3">Ticket</th>
                  <th scope="col" className="px-4 py-3 text-right">Sold for</th>
                  <th scope="col" className="px-4 py-3 text-right">Supplier cost</th>
                  <th scope="col" className="px-4 py-3 text-right">Margin</th>
                  <th scope="col" className="w-12 px-4 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sales.map((sale) => {
                  const state = STATUS[sale.ticket_status];
                  const margin = sale.margin_computable && sale.gross_margin !== null ? Number(sale.gross_margin) : null;
                  return (
                    <tr key={sale.id} className="align-top hover:bg-slate-50/70">
                      <td className="px-4 py-4">
                        <div className="font-medium text-slate-900">{sale.customer_name}</div>
                        <div className="mt-0.5 text-slate-500">{sale.passenger_name}</div>
                      </td>
                      <td className="px-4 py-4 font-mono text-xs text-slate-700">{sale.booking_code}</td>
                      <td className="px-4 py-4 text-slate-700">{sale.supplier_name}</td>
                      <td className="px-4 py-4">
                        <div className="font-mono text-xs text-slate-900">{sale.ticket_number || 'Not issued yet'}</div>
                        <div className="mt-1.5">
                          <StatusBadge label={state.label} tone={state.tone} />
                        </div>
                        {sale.issue_date && <div className="mt-1 text-xs text-slate-500">Issued {formatDate(sale.issue_date)}</div>}
                      </td>
                      <td className="px-4 py-4 text-right font-medium tabular-nums text-slate-900">
                        {sale.selling_price && sale.selling_currency ? formatAmount(sale.selling_price, sale.selling_currency) : '—'}
                      </td>
                      <td className="px-4 py-4 text-right tabular-nums text-slate-700">
                        {sale.supplier_cost && sale.supplier_cost_currency ? formatAmount(sale.supplier_cost, sale.supplier_cost_currency) : '—'}
                      </td>
                      <td className="px-4 py-4 text-right tabular-nums">
                        {margin !== null ? (
                          <span className={`font-semibold ${margin < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                            {formatAmount(margin, sale.selling_currency ?? 'ETB')}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400" title={marginBasis}>
                            Different currencies
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-right">
                        {sale.ticket_status === 'pending' && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(sale)}
                            aria-label={`Delete pending sale for ${sale.passenger_name}`}
                            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!isLoading && (
          <Pagination
            page={page}
            pageCount={pageCount}
            total={total}
            noun="sale"
            onPrevious={() => {
              setIsLoading(true);
              setPage((current) => Math.max(0, current - 1));
            }}
            onNext={() => {
              setIsLoading(true);
              setPage((current) => current + 1);
            }}
          />
        )}
      </Card>

      {isFormOpen && (
        <Dialog
          title="Record a ticket sale"
          description="Sales are recorded from the booking they belong to, so the passenger, route and supplier are checked for you."
          onClose={() => setIsFormOpen(false)}
        >
          <ol className="space-y-2 text-sm text-slate-700">
            <li>1. Open <strong>Bookings</strong> and find (or create) the customer’s booking.</li>
            <li>2. Choose <strong>Travel details</strong> on that booking.</li>
            <li>3. Fill in <strong>Record a sale</strong> with the price and supplier.</li>
          </ol>
          <div className="mt-6 flex justify-end">
            <button type="button" onClick={() => setIsFormOpen(false)} className={btnPrimary}>
              Got it
            </button>
          </div>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this pending sale?"
          message={`The sale for ${deleteTarget.passenger_name} has no ticket number yet. Deleting it cannot be undone.`}
          confirmLabel="Delete sale"
          busyLabel="Deleting…"
          busy={isDeleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Page>
  );
};