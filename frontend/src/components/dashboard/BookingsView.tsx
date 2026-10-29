import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  FilePlus2,
  Inbox,
  Loader2,
  Plane,
  Search,
  Sparkles,
  Ticket,
  Trash2,
  UserRound,
  X,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { BookingDetailsPanel } from './BookingDetailsPanel';
import {
  createBooking,
  deleteBooking,
  fetchBookings,
  fetchCustomers,
  updateBookingStatus as saveBookingStatus,
} from '../../lib/api';
import type {
  BookingChannel,
  BookingCreateInput,
  BookingRecord,
  BookingStatus,
  CustomerRecord,
} from '../../types/customer';

const PAGE_SIZE = 50;

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  requested: 'Requested',
  quoted: 'Quoted',
  confirmed: 'Confirmed',
  ticketing_pending: 'Ticketing Pending',
  partially_ticketed: 'Partially Ticketed',
  ticketed: 'Ticketed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  closed: 'Closed',
};

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-800 border-slate-300',
  requested: 'bg-amber-50 text-amber-800 border-amber-200',
  quoted: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  confirmed: 'bg-sky-50 text-sky-800 border-sky-200',
  ticketing_pending: 'bg-purple-50 text-purple-800 border-purple-200',
  partially_ticketed: 'bg-teal-50 text-teal-800 border-teal-200',
  ticketed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  cancelled: 'bg-rose-50 text-rose-800 border-rose-200',
  expired: 'bg-slate-100 text-slate-600 border-slate-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200',
};

const QUICK_FILTER_TABS: Array<{ value: BookingStatus | ''; label: string }> = [
  { value: '', label: 'All' },
  { value: 'requested', label: 'Requested' },
  { value: 'quoted', label: 'Quoted' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'ticketing_pending', label: 'Ticketing' },
  { value: 'ticketed', label: 'Ticketed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const AVAILABLE_NEXT_STATUSES: Partial<Record<string, BookingStatus[]>> = {
  draft: ['cancelled'],
  requested: ['quoted', 'confirmed', 'cancelled', 'expired'],
  quoted: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['ticketing_pending', 'cancelled'],
  ticketing_pending: ['cancelled'],
  ticketed: [], // No unsupported 'closed' transition that triggers backend validation failure
  cancelled: [],
  expired: [],
};

const GDS_PRESETS = ['Amadeus', 'Galileo', 'Sabre', 'Ethiopian Airlines', 'Direct Airline'];

interface BookingsViewProps {
  onBackToDashboard: () => void;
}

export const BookingsView: React.FC<BookingsViewProps> = ({ onBackToDashboard }) => {
  const { accessToken } = useAuth();
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<BookingStatus | ''>('');
  const [page, setPage] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Split-Workspace Selection State
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null);
  const [copiedPnr, setCopiedPnr] = useState(false);
  const [savingStatusFor, setSavingStatusFor] = useState<number | null>(null);

  // Centered Multi-Step New Booking Modal State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [newBookingStep, setNewBookingStep] = useState<1 | 2>(1);
  const [isSaving, setIsSaving] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerRecord[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRecord | null>(null);
  const [customerLookupLoading, setCustomerLookupLoading] = useState(false);
  const [bookingChannel, setBookingChannel] = useState<BookingChannel>('office');
  const [externalPnr, setExternalPnr] = useState('');
  const [reservationSystem, setReservationSystem] = useState('');
  const [customerNotes, setCustomerNotes] = useState('');

  const selectedBooking = useMemo(
    () => bookings.find((b) => b.id === selectedBookingId) ?? null,
    [bookings, selectedBookingId],
  );

  // Operational pipeline counters
  const stats = useMemo(() => {
    const needsQuoteOrConfirm = bookings.filter(
      (b) => b.status === 'requested' || b.status === 'quoted' || (b.status as string) === 'draft',
    ).length;
    const awaitingTicket = bookings.filter(
      (b) => b.status === 'confirmed' || b.status === 'ticketing_pending',
    ).length;
    const ticketed = bookings.filter(
      (b) => b.status === 'ticketed' || b.status === 'partially_ticketed',
    ).length;
    return { needsQuoteOrConfirm, awaitingTicket, ticketed };
  }, [bookings]);

  // Auto-dismiss popup notification
  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(null), 4500);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  // Debounce search input automatically
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = searchInput.trim();
      if (trimmed !== searchQuery) {
        setIsLoading(true);
        setPage(0);
        setSearchQuery(trimmed);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchQuery]);

  // Fetch bookings list
  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;

    fetchBookings(accessToken, searchQuery, statusFilter, PAGE_SIZE, page * PAGE_SIZE)
      .then((result) => {
        if (!isCurrent) return;
        setBookings(result.items);
        setTotal(result.total);
        if (result.items.length > 0 && !result.items.some((b) => b.id === selectedBookingId)) {
          setSelectedBookingId(result.items[0].id);
        } else if (result.items.length === 0) {
          setSelectedBookingId(null);
        }
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(requestError instanceof Error ? requestError.message : 'Could not load bookings.');
        }
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, searchQuery, statusFilter, page, refreshKey]);

  // Customer lookup in centered modal
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
          if (isCurrent) {
            setError(
              requestError instanceof Error ? requestError.message : 'Could not search customers.',
            );
          }
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

  const resetBookingForm = () => {
    setSelectedCustomer(null);
    setCustomerQuery('');
    setCustomerResults([]);
    setBookingChannel('office');
    setExternalPnr('');
    setReservationSystem('');
    setCustomerNotes('');
    setNewBookingStep(1);
  };

  const handleCreateBooking = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) {
      setError('Your session has expired. Sign in again to add bookings.');
      return;
    }
    if (!selectedCustomer) {
      setError('Select a customer before creating a booking.');
      return;
    }

    const booking: BookingCreateInput = {
      customer_id: selectedCustomer.id,
      booking_channel: bookingChannel,
      external_pnr: externalPnr.trim(),
      reservation_system: reservationSystem.trim(),
      customer_notes: customerNotes.trim(),
    };

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const created = await createBooking(accessToken, booking);
      resetBookingForm();
      setIsFormOpen(false);
      setSearchInput('');
      setSearchQuery('');
      setStatusFilter('');
      setPage(0);
      setSelectedBookingId(created.id);
      setSuccessMessage(`Booking ${created.booking_code} created and opened in your workspace.`);
      setIsLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save the booking.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleInstantStatusChange = async (booking: BookingRecord, nextStatus: BookingStatus) => {
    if (!accessToken || !nextStatus) return;

    setSavingStatusFor(booking.id);
    setError(null);
    setSuccessMessage(null);
    try {
      const updated = await saveBookingStatus(accessToken, booking.id, nextStatus);
      setBookings((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSuccessMessage(
        `${updated.booking_code} moved to ${STATUS_LABELS[updated.status] ?? updated.status}.`,
      );
    } catch (requestError: unknown) {
      setError(
        requestError instanceof Error ? requestError.message : 'Could not update booking status.',
      );
    } finally {
      setSavingStatusFor(null);
    }
  };

  const handleCopyPnr = (pnr: string) => {
    void navigator.clipboard.writeText(pnr);
    setCopiedPnr(true);
    window.setTimeout(() => setCopiedPnr(false), 1800);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* PREMIUM FLOATING POP-UP NOTIFICATIONS */}
      {successMessage && (
        <div className="fixed inset-x-0 top-6 z-[100] mx-auto flex max-w-md px-4 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="flex w-full items-start gap-3.5 rounded-2xl border border-emerald-200 bg-white p-4 shadow-2xl ring-4 ring-emerald-500/10">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                Action Completed
              </p>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">{successMessage}</p>
            </div>
            <button
              type="button"
              onClick={() => setSuccessMessage(null)}
              className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="fixed inset-x-0 top-6 z-[100] mx-auto flex max-w-md px-4 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="flex w-full items-start gap-3.5 rounded-2xl border border-rose-200 bg-white p-4 shadow-2xl ring-4 ring-rose-500/10">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-md">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-wider text-rose-700">
                Attention Required
              </p>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => setError(null)}
              className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Top Header & Primary Action */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Back to Operations Overview</span>
          </button>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Bookings & PNR Command Center
            </h1>
            <span className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-800">
              {total} total
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Select a booking on the left and step through its guided fulfillment workflow on the right.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setError(null);
            resetBookingForm();
            setIsFormOpen(true);
          }}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-teal-700 to-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:from-teal-800 hover:to-emerald-700 hover:shadow-lg active:scale-95"
        >
          <FilePlus2 className="h-4 w-4" />
          <span>New Booking / PNR</span>
        </button>
      </div>

      {/* Pipeline KPI Cards (One-Click Filters) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => {
            setIsLoading(true);
            setPage(0);
            setStatusFilter('');
          }}
          className={`flex items-center justify-between rounded-xl border p-3.5 text-left transition-all ${
            statusFilter === ''
              ? 'border-slate-900 bg-slate-900 text-white shadow-xs'
              : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300'
          }`}
        >
          <div>
            <p className={`text-xs font-medium ${statusFilter === '' ? 'text-slate-300' : 'text-slate-500'}`}>
              All Active Queue
            </p>
            <p className="mt-1 text-xl font-bold">{total}</p>
          </div>
          <Inbox className={`h-5 w-5 ${statusFilter === '' ? 'text-teal-400' : 'text-slate-400'}`} />
        </button>

        <button
          type="button"
          onClick={() => {
            setIsLoading(true);
            setPage(0);
            setStatusFilter(statusFilter === 'requested' ? '' : 'requested');
          }}
          className={`flex items-center justify-between rounded-xl border p-3.5 text-left transition-all ${
            statusFilter === 'requested'
              ? 'border-amber-600 bg-amber-50/80 ring-2 ring-amber-500/20'
              : 'border-slate-200 bg-white hover:border-amber-300'
          }`}
        >
          <div>
            <p className="text-xs font-medium text-amber-800">Drafts & Requests</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{stats.needsQuoteOrConfirm}</p>
          </div>
          <Clock className="h-5 w-5 text-amber-600" />
        </button>

        <button
          type="button"
          onClick={() => {
            setIsLoading(true);
            setPage(0);
            setStatusFilter(statusFilter === 'ticketing_pending' ? '' : 'ticketing_pending');
          }}
          className={`flex items-center justify-between rounded-xl border p-3.5 text-left transition-all ${
            statusFilter === 'ticketing_pending'
              ? 'border-purple-600 bg-purple-50/80 ring-2 ring-purple-500/20'
              : 'border-slate-200 bg-white hover:border-purple-300'
          }`}
        >
          <div>
            <p className="text-xs font-medium text-purple-800">Awaiting Ticket</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{stats.awaitingTicket}</p>
          </div>
          <Plane className="h-5 w-5 text-purple-600" />
        </button>

        <button
          type="button"
          onClick={() => {
            setIsLoading(true);
            setPage(0);
            setStatusFilter(statusFilter === 'ticketed' ? '' : 'ticketed');
          }}
          className={`flex items-center justify-between rounded-xl border p-3.5 text-left transition-all ${
            statusFilter === 'ticketed'
              ? 'border-emerald-600 bg-emerald-50/80 ring-2 ring-emerald-500/20'
              : 'border-slate-200 bg-white hover:border-emerald-300'
          }`}
        >
          <div>
            <p className="text-xs font-medium text-emerald-800">Ticketed</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{stats.ticketed}</p>
          </div>
          <Ticket className="h-5 w-5 text-emerald-600" />
        </button>
      </div>

      {/* SPLIT WORKSPACE: Left Queue (4 cols) + Right Command Center (8 cols) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start">
        {/* LEFT COLUMN: Search, Quick Pills & Booking Queue */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs lg:col-span-4">
          <div className="space-y-2.5 border-b border-slate-100 bg-slate-50/70 p-3.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-8 text-xs focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                placeholder="Search PNR, booking code, or customer..."
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput('')}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Quick Status Pills */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {QUICK_FILTER_TABS.map((tab) => {
                const isActive = statusFilter === tab.value;
                return (
                  <button
                    key={tab.value || 'all'}
                    type="button"
                    onClick={() => {
                      setIsLoading(true);
                      setPage(0);
                      setStatusFilter(tab.value);
                      setError(null);
                    }}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      isActive
                        ? 'bg-slate-900 text-white'
                        : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Queue List */}
          <div className="max-h-[600px] divide-y divide-slate-100 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 p-12 text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-teal-700" />
                <span>Loading bookings...</span>
              </div>
            ) : bookings.length === 0 ? (
              <div className="p-10 text-center">
                <Plane className="mx-auto h-7 w-7 text-slate-300" />
                <p className="mt-2 text-sm font-semibold text-slate-800">No bookings match</p>
                <p className="mt-1 text-xs text-slate-500">
                  {searchQuery || statusFilter
                    ? 'Try resetting your active filters.'
                    : 'Click "New Booking / PNR" to start.'}
                </p>
                {(searchQuery || statusFilter) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setSearchQuery('');
                      setStatusFilter('');
                    }}
                    className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Reset filters
                  </button>
                )}
              </div>
            ) : (
              bookings.map((booking) => {
                const isSelected = booking.id === selectedBookingId;
                return (
                  <button
                    key={booking.id}
                    type="button"
                    onClick={() => setSelectedBookingId(booking.id)}
                    className={`flex w-full flex-col gap-1.5 p-3.5 text-left transition-colors ${
                      isSelected
                        ? 'border-l-4 border-l-teal-700 bg-teal-50/40'
                        : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs font-bold text-slate-900">
                          {booking.booking_code}
                        </span>
                        {booking.external_pnr ? (
                          <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-white">
                            {booking.external_pnr}
                          </span>
                        ) : (
                          <span className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-400">
                            No PNR
                          </span>
                        )}
                      </div>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                          STATUS_STYLES[booking.status] ?? 'bg-slate-100 text-slate-700 border-slate-200'
                        }`}
                      >
                        {STATUS_LABELS[booking.status] ?? booking.status}
                      </span>
                    </div>

                    <p className="truncate text-sm font-semibold text-slate-800">
                      {booking.customer_name}
                    </p>

                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span className="capitalize">
                        {booking.booking_channel}
                        {booking.reservation_system ? ` · ${booking.reservation_system}` : ''}
                      </span>
                      <span>
                        {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(
                          new Date(booking.created_at),
                        )}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Pagination Footer */}
          {!isLoading && total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-3.5 py-2.5 text-xs">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => {
                  setIsLoading(true);
                  setPage((p) => p - 1);
                }}
                className="rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-slate-700 disabled:opacity-40"
              >
                Prev
              </button>
              <span className="text-slate-500">
                Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}
              </span>
              <button
                type="button"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => {
                  setIsLoading(true);
                  setPage((p) => p + 1);
                }}
                className="rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-slate-700 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Active Booking Command Center */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-xs lg:col-span-8">
          {!selectedBooking ? (
            <div className="flex min-h-[480px] flex-col items-center justify-center p-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <Plane className="h-6 w-6" />
              </div>
              <h2 className="mt-3 text-base font-bold text-slate-800">No Booking Selected</h2>
              <p className="mt-1 max-w-sm text-xs text-slate-500">
                Click any booking on the left queue to open its guided workspace.
              </p>
            </div>
          ) : (
            <div>
              {/* Command Center Header */}
              <div className="border-b border-slate-100 p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-base font-bold text-slate-900">
                        {selectedBooking.booking_code}
                      </span>
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                          STATUS_STYLES[selectedBooking.status] ?? 'bg-slate-100 text-slate-700 border-slate-200'
                        }`}
                      >
                        {STATUS_LABELS[selectedBooking.status] ?? selectedBooking.status}
                      </span>
                    </div>
                    <h2 className="mt-1 text-xl font-bold text-slate-900">
                      {selectedBooking.customer_name}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1 capitalize">
                        <Building2 className="h-3.5 w-3.5 text-slate-400" />
                        {selectedBooking.booking_channel} channel
                      </span>
                      {selectedBooking.reservation_system && (
                        <span>• GDS: {selectedBooking.reservation_system}</span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
                        {new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(
                          new Date(selectedBooking.created_at),
                        )}
                      </span>
                    </div>
                  </div>

                  {/* PNR Callout Card & Draft Delete */}
                  <div className="flex items-center gap-2">
                    {selectedBooking.external_pnr ? (
                      <div className="flex items-center gap-2.5 rounded-xl border border-teal-200 bg-teal-50/60 px-3.5 py-2">
                        <div>
                          <span className="block text-[10px] font-bold uppercase tracking-wider text-teal-700">
                            GDS / Airline PNR
                          </span>
                          <span className="font-mono text-base font-extrabold tracking-widest text-teal-950">
                            {selectedBooking.external_pnr}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopyPnr(selectedBooking.external_pnr!)}
                          className="rounded-lg border border-teal-200 bg-white p-1.5 text-teal-700 transition-colors hover:bg-teal-100"
                          title="Copy PNR"
                        >
                          {copiedPnr ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3.5 py-2 text-xs text-slate-500">
                        No PNR linked
                      </div>
                    )}

                    {(selectedBooking.status === 'requested' ||
                      (selectedBooking.status as string) === 'draft') && (
                      <button
                        type="button"
                        title="Delete unused draft booking"
                        onClick={async () => {
                          if (!accessToken) return;
                          if (
                            !window.confirm(
                              `Delete draft booking ${selectedBooking.booking_code}?`,
                            )
                          )
                            return;
                          try {
                            await deleteBooking(accessToken, selectedBooking.id);
                            setSuccessMessage(`Draft ${selectedBooking.booking_code} deleted.`);
                            setRefreshKey((k) => k + 1);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : 'Could not delete booking.');
                          }
                        }}
                        className="rounded-xl border border-rose-200 bg-rose-50/50 p-2.5 text-rose-700 transition-colors hover:bg-rose-100"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Quick Status Bar */}
                {(AVAILABLE_NEXT_STATUSES[selectedBooking.status] ?? []).length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2">
                    <span className="text-[11px] font-semibold text-slate-500">
                      Quick Status Actions:
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(AVAILABLE_NEXT_STATUSES[selectedBooking.status] ?? []).map((nextStatus) => {
                        const isDestructive =
                          nextStatus === 'cancelled' || nextStatus === 'expired';
                        const isBusy = savingStatusFor === selectedBooking.id;
                        return (
                          <button
                            key={nextStatus}
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void handleInstantStatusChange(selectedBooking, nextStatus)
                            }
                            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                              isDestructive
                                ? 'border border-rose-200 bg-white text-rose-700 hover:bg-rose-50'
                                : 'bg-slate-900 text-white hover:bg-slate-800'
                            }`}
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : isDestructive ? (
                              <XCircle className="h-3.5 w-3.5" />
                            ) : (
                              <Sparkles className="h-3.5 w-3.5 text-teal-400" />
                            )}
                            <span>Move to {STATUS_LABELS[nextStatus] ?? nextStatus}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Embedded Step-by-Step Guided Workspace */}
              <div className="p-5 sm:p-6">
                <BookingDetailsPanel
                  booking={selectedBooking}
                  onTicketRecorded={() => setRefreshKey((current) => current + 1)}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CENTERED STEP-BY-STEP WIZARD MODAL: Create New Booking */}
      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-200">
            {/* Modal Header & Stepper Indicator */}
            <div className="border-b border-slate-100 bg-slate-900 px-6 py-5 text-white">
              <div className="flex items-center justify-between">
                <div>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-teal-400">
                    <Sparkles className="h-3.5 w-3.5" />
                    Guided Reservation Setup
                  </span>
                  <h2 className="mt-0.5 text-xl font-bold text-white">
                    Create New Booking & PNR
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    resetBookingForm();
                    setIsFormOpen(false);
                  }}
                  className="rounded-xl bg-white/10 p-2 text-slate-300 transition-colors hover:bg-white/20 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* 2-Step Progress Bar */}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setNewBookingStep(1)}
                  className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left transition-all ${
                    newBookingStep === 1
                      ? 'bg-teal-500 text-slate-950 font-bold shadow-md'
                      : selectedCustomer
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-white/10 text-slate-300'
                  }`}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/20 text-xs font-bold">
                    {selectedCustomer && newBookingStep !== 1 ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      '1'
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-bold leading-none">Select Customer</p>
                    <p className="mt-1 truncate text-[10px] opacity-80">
                      {selectedCustomer ? selectedCustomer.display_name : 'Who is paying?'}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  disabled={!selectedCustomer}
                  onClick={() => selectedCustomer && setNewBookingStep(2)}
                  className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                    newBookingStep === 2
                      ? 'bg-teal-500 text-slate-950 font-bold shadow-md'
                      : 'bg-white/10 text-slate-300'
                  }`}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/20 text-xs font-bold">
                    2
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-bold leading-none">PNR & Channel</p>
                    <p className="mt-1 truncate text-[10px] opacity-80">
                      Airline code & notes
                    </p>
                  </div>
                </button>
              </div>
            </div>

            {/* Modal Body (No Scrolling - Strictly Separated Steps) */}
            <form id="create-booking-form" onSubmit={handleCreateBooking} className="p-6">
              {newBookingStep === 1 && (
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="booking-customer-search"
                      className="block text-sm font-bold text-slate-900"
                    >
                      Step 1: Choose or Search Customer <span className="text-rose-600">*</span>
                    </label>
                    <p className="text-xs text-slate-500">
                      Select the client or corporate account responsible for this booking.
                    </p>
                  </div>

                  {selectedCustomer ? (
                    <div className="flex items-center justify-between rounded-2xl border-2 border-teal-600 bg-teal-50/50 p-4 shadow-xs">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-700 text-white">
                          <UserRound className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-900">
                            {selectedCustomer.display_name}
                          </p>
                          <span className="inline-block rounded bg-white px-2 py-0.5 text-[10px] font-semibold capitalize text-teal-800 shadow-2xs">
                            {selectedCustomer.customer_type}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCustomer(null);
                          setCustomerQuery('');
                        }}
                        className="rounded-lg border border-teal-200 bg-white px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
                        <input
                          id="booking-customer-search"
                          value={customerQuery}
                          onChange={(e) => setCustomerQuery(e.target.value)}
                          placeholder="Search customer by name, phone, or email..."
                          className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-4 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                          autoComplete="off"
                          autoFocus
                        />
                      </div>
                      <div className="mt-2.5 max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/50">
                        {customerLookupLoading ? (
                          <p className="p-4 text-center text-xs text-slate-500">
                            Searching customers...
                          </p>
                        ) : customerResults.length === 0 ? (
                          <p className="p-4 text-center text-xs text-slate-500">
                            No matching customers found. Add them in Customers first.
                          </p>
                        ) : (
                          customerResults.map((customer) => (
                            <button
                              key={customer.id}
                              type="button"
                              onClick={() => {
                                setSelectedCustomer(customer);
                                setNewBookingStep(2);
                              }}
                              className="flex w-full items-center justify-between bg-white px-4 py-3 text-left transition-colors hover:bg-teal-50/80"
                            >
                              <span className="truncate text-sm font-semibold text-slate-800">
                                {customer.display_name}
                              </span>
                              <span className="ml-2 rounded-md bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold capitalize text-slate-600">
                                {customer.customer_type}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {newBookingStep === 2 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                      GDS / Airline PNR <span className="font-normal text-slate-400">(opt)</span>
                      <input
                        maxLength={30}
                        value={externalPnr}
                        onChange={(e) => setExternalPnr(e.target.value.toUpperCase())}
                        placeholder="e.g. HYTGFT"
                        autoFocus
                        className="mt-1.5 block w-full rounded-xl border border-slate-300 px-3.5 py-2.5 font-mono text-sm font-bold uppercase tracking-wider focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                      />
                    </label>

                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                      Booking Channel
                      <select
                        value={bookingChannel}
                        onChange={(e) => setBookingChannel(e.target.value as BookingChannel)}
                        className="mt-1.5 block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium focus:border-teal-600 focus:outline-none"
                      >
                        <option value="office">Walk-in / Office</option>
                        <option value="whatsapp">WhatsApp</option>
                        <option value="phone">Phone Call</option>
                        <option value="corporate">Corporate</option>
                        <option value="email">Email</option>
                        <option value="website">Website</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                      Reservation System <span className="font-normal text-slate-400">(opt)</span>
                      <input
                        maxLength={60}
                        value={reservationSystem}
                        onChange={(e) => setReservationSystem(e.target.value)}
                        placeholder="Amadeus, Galileo, Ethiopian Airlines..."
                        className="mt-1.5 block w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-normal focus:border-teal-600 focus:outline-none"
                      />
                    </label>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {GDS_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setReservationSystem(preset)}
                          className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                            reservationSystem === preset
                              ? 'bg-teal-700 text-white shadow-2xs'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                    Customer Notes <span className="font-normal text-slate-400">(opt)</span>
                    <textarea
                      maxLength={2000}
                      rows={2}
                      value={customerNotes}
                      onChange={(e) => setCustomerNotes(e.target.value)}
                      placeholder="Preferred dates, route requests, or special assistance..."
                      className="mt-1.5 block w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-normal focus:border-teal-600 focus:outline-none"
                    />
                  </label>
                </div>
              )}
            </form>

            {/* Modal Guided Footer */}
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-6 py-4">
              {newBookingStep === 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      resetBookingForm();
                      setIsFormOpen(false);
                    }}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!selectedCustomer}
                    onClick={() => setNewBookingStep(2)}
                    className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-teal-800 disabled:opacity-40"
                  >
                    <span>Next Step: PNR & Details</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setNewBookingStep(1)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    <span>Back to Customer</span>
                  </button>
                  <button
                    type="submit"
                    form="create-booking-form"
                    disabled={isSaving || !selectedCustomer}
                    className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-teal-700 to-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:from-teal-800 hover:to-emerald-700 disabled:opacity-50"
                  >
                    {isSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    <span>{isSaving ? 'Creating...' : 'Create & Open Workspace'}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};