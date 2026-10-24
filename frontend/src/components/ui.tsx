import React, { useEffect, useRef } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Class tokens: one look for every form control and button            */
/* ------------------------------------------------------------------ */
export const labelCls = 'block text-sm font-medium text-slate-700';
export const hintCls = 'mt-1 text-xs text-slate-500';
export const inputCls =
  'mt-1.5 block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 shadow-xs focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-600/15';

const btnBase =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ' +
  'focus:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50';
export const btnPrimary = `${btnBase} bg-teal-700 text-white shadow-xs hover:bg-teal-800 focus-visible:ring-teal-600/30`;
export const btnSecondary = `${btnBase} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400/30`;
export const btnDanger = `${btnBase} bg-rose-700 text-white shadow-xs hover:bg-rose-800 focus-visible:ring-rose-600/30`;
export const btnGhost = `${btnBase} px-3 text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-slate-400/30`;

/* ------------------------------------------------------------------ */
/* Formatting helpers (replace the copies in every view)               */
/* ------------------------------------------------------------------ */
export function formatAmount(amount: string | number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.trim(),
      maximumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${currency.trim()} ${amount}`;
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${value.slice(0, 10)}T00:00:00Z`),
  );
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function toDateInput(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** "invoice.issued" -> "Invoice issued" */
export function sentence(value: string): string {
  const text = value.replace(/[._]/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */
export const Page: React.FC<{ children: React.ReactNode; wide?: boolean }> = ({ children, wide }) => (
  <div className={`mx-auto space-y-6 ${wide ? 'max-w-7xl' : 'max-w-6xl'}`}>{children}</div>
);

export const PageHeader: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <header className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
      {description && <p className="mt-1.5 max-w-2xl text-base text-slate-600">{description}</p>}
    </div>
    {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
  </header>
);

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</section>
);

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */
const NOTICE_STYLES = {
  error: { box: 'border-rose-200 bg-rose-50 text-rose-900', icon: AlertCircle, iconCls: 'text-rose-600' },
  success: { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: CheckCircle2, iconCls: 'text-emerald-600' },
  info: { box: 'border-sky-200 bg-sky-50 text-sky-900', icon: Info, iconCls: 'text-sky-600' },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-900', icon: AlertCircle, iconCls: 'text-amber-600' },
} as const;

export const Notice: React.FC<{
  kind: keyof typeof NOTICE_STYLES;
  children: React.ReactNode;
  onDismiss?: () => void;
}> = ({ kind, children, onDismiss }) => {
  const style = NOTICE_STYLES[kind];
  const Icon = style.icon;
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${style.box}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.iconCls}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="rounded p-0.5 text-current opacity-60 hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
};

const BADGE_TONES = {
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  bad: 'bg-rose-50 text-rose-800 ring-rose-600/20',
  info: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-500/20',
} as const;
const DOT_TONES = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
  info: 'bg-sky-500',
  neutral: 'bg-slate-400',
} as const;

export type Tone = keyof typeof BADGE_TONES;

export const StatusBadge: React.FC<{ label: string; tone?: Tone }> = ({ label, tone = 'neutral' }) => (
  <span
    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}
  >
    <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONES[tone]}`} aria-hidden="true" />
    {label}
  </span>
);

export const EmptyState: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}> = ({ icon: Icon, title, hint, action }) => (
  <div className="flex flex-col items-center px-6 py-14 text-center">
    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-teal-700">
      <Icon className="h-6 w-6" />
    </div>
    <p className="mt-4 text-base font-semibold text-slate-900">{title}</p>
    {hint && <p className="mt-1 max-w-sm text-sm text-slate-500">{hint}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const LoadingRows: React.FC<{ label: string }> = ({ label }) => (
  <div role="status" aria-label={label} className="space-y-3 p-6">
    {[0, 1, 2, 3].map((n) => (
      <div key={n} className="h-12 animate-pulse rounded-xl bg-slate-100" />
    ))}
  </div>
);

/* ------------------------------------------------------------------ */
/* Money summary: amounts are always listed per currency, never added  */
/* ------------------------------------------------------------------ */
export const CurrencyLines: React.FC<{
  totals: { currency: string; amount: string | number }[];
  empty: string;
  amountCls?: string;
}> = ({ totals, empty, amountCls = 'text-slate-900' }) => {
  if (totals.length === 0) return <p className="mt-2 text-sm text-slate-400">{empty}</p>;
  return (
    <ul className="mt-2 space-y-1">
      {totals.map((total) => (
        <li key={total.currency} className={`text-2xl font-semibold tabular-nums tracking-tight ${amountCls}`}>
          {formatAmount(total.amount, total.currency)}
        </li>
      ))}
    </ul>
  );
};

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */
export const Pagination: React.FC<{
  page: number;
  pageCount: number;
  total: number;
  noun: string;
  onPrevious: () => void;
  onNext: () => void;
}> = ({ page, pageCount, total, noun, onPrevious, onNext }) => {
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>
        {total} {noun}
        {total === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" disabled={page === 0} onClick={onPrevious} className={`${btnSecondary} px-3 py-1.5`}>
          Previous
        </button>
        <span className="px-1 tabular-nums">
          Page {page + 1} of {pageCount}
        </span>
        <button type="button" disabled={page + 1 >= pageCount} onClick={onNext} className={`${btnSecondary} px-3 py-1.5`}>
          Next
        </button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Dialog: Escape closes it, focus moves inside, background is dimmed  */
/* ------------------------------------------------------------------ */
export const Dialog: React.FC<{
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'md' | 'lg';
}> = ({ title, description, onClose, children, size = 'md' }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Runs once per open, so typing in a field never steals focus back to the panel.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl focus:outline-none sm:rounded-3xl sm:p-8 ${
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h2>
            {description && <p className="mt-1.5 text-sm text-slate-600">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
};

/** Confirmation step for anything that changes or removes a record. */
export const ConfirmDialog: React.FC<{
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  tone?: 'danger' | 'primary';
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}> = ({ title, message, confirmLabel, busyLabel, busy, tone = 'danger', confirmDisabled, onConfirm, onCancel, children }) => (
  <Dialog title={title} description={message} onClose={onCancel}>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
      className="space-y-5"
    >
      {children}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnSecondary}>
          Cancel
        </button>
        <button type="submit" disabled={busy || confirmDisabled} className={tone === 'danger' ? btnDanger : btnPrimary}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </form>
  </Dialog>
);