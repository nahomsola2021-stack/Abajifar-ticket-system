import React, { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock,
  History,
  PiggyBank,
  Receipt,
  RefreshCw,
  Ticket,
  Users,
  Wallet,
  Sparkles,
  Activity,
  Zap
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Card, CurrencyLines, EmptyState, Notice, Page, btnPrimary, formatDateTime, sentence } from '../ui';
import * as api from '../../lib/api';

interface OperationsOverviewProps {
  onNavigateTab: (tab: string) => void;
}

interface FigureProps {
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'in' | 'owed' | 'out';
  totals: { currency: string; amount: string | number }[];
  empty: string;
}

const TONES = {
  in: { 
    wrapper: 'bg-gradient-to-br from-emerald-50 to-teal-50/20 border-emerald-100/50', 
    chip: 'bg-emerald-100 text-emerald-600 shadow-inner', 
    amount: 'text-slate-900',
    iconFade: 'text-emerald-600/5'
  },
  owed: { 
    wrapper: 'bg-gradient-to-br from-amber-50 to-orange-50/20 border-amber-100/50', 
    chip: 'bg-amber-100 text-amber-600 shadow-inner', 
    amount: 'text-amber-950',
    iconFade: 'text-amber-600/5'
  },
  out: { 
    wrapper: 'bg-gradient-to-br from-rose-50 to-red-50/20 border-rose-100/50', 
    chip: 'bg-rose-100 text-rose-600 shadow-inner', 
    amount: 'text-slate-900',
    iconFade: 'text-rose-600/5'
  },
} as const;

const Figure: React.FC<FigureProps> = ({ label, hint, icon: Icon, tone, totals, empty }) => (
  <Card className={`relative overflow-hidden p-6 transition-all duration-300 hover:shadow-md ${TONES[tone].wrapper}`}>
    <Icon className={`absolute -right-4 -top-4 h-32 w-32 -rotate-12 transform ${TONES[tone].iconFade}`} />
    
    <div className="relative z-10 flex items-center gap-4">
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${TONES[tone].chip}`}>
        <Icon className="h-6 w-6" />
      </span>
      <div>
        <h3 className="text-sm font-bold tracking-tight text-slate-900">{label}</h3>
        <p className="text-xs font-medium text-slate-500">{hint}</p>
      </div>
    </div>
    <div className="relative z-10 mt-5">
      <CurrencyLines totals={totals} empty={empty} amountCls={`text-2xl font-black tracking-tight ${TONES[tone].amount}`} />
    </div>
  </Card>
);

const SHORTCUTS: { tab: string; title: string; text: string; icon: React.ComponentType<{ className?: string }>, color: string }[] = [
  { icon: Ticket, tab: 'bookings', title: 'Bookings', text: 'Manage reservations', color: 'from-blue-500 to-cyan-500' },
  { icon: Receipt, tab: 'financials', title: 'Invoices', text: 'Issue customer bills', color: 'from-violet-500 to-purple-500' },
  { icon: Banknote, tab: 'payments', title: 'Payments In', text: 'Record cash received', color: 'from-emerald-500 to-teal-500' },
  { icon: Users, tab: 'customers', title: 'Customers', text: 'Client database', color: 'from-pink-500 to-rose-500' },
  { icon: Wallet, tab: 'supplier-payments', title: 'Payables', text: 'Settle partner bills', color: 'from-amber-500 to-orange-500' },
  { icon: Building2, tab: 'suppliers', title: 'Suppliers', text: 'Partner network', color: 'from-slate-500 to-slate-700' },
  { icon: PiggyBank, tab: 'expenses', title: 'Expenses', text: 'Office overhead', color: 'from-red-500 to-rose-600' },
];

export const OperationsOverview: React.FC<OperationsOverviewProps> = ({ onNavigateTab }) => {
  const { staff, overview, session, isOverviewLoading, overviewError, refreshOverview, refreshIdentity } = useAuth();
  
  const [marginSummary, setMarginSummary] = useState<any>(null);

  const firstName = staff?.full_name?.trim().split(/\s+/)[0] || 'there';
  const today = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' }).format(new Date());

  const fetchMarginData = useCallback(() => {
    if (session?.access_token) {
      const extendedApi = api as any;
      if (typeof extendedApi.fetchMarginSummary === 'function') {
        extendedApi.fetchMarginSummary(session.access_token)
          .then((res: any) => setMarginSummary(res))
          .catch((err: any) => console.error('Failed to fetch margin summary:', err));
      }
    }
  }, [session?.access_token]);

  // Initial fetch on mount or session change
  useEffect(() => {
    fetchMarginData();
  }, [fetchMarginData]);

  // Live Auto-Refresh Listener: Listens for mutations across the app and window focus
  useEffect(() => {
    const handleDataUpdate = () => {
      refreshOverview();
      refreshIdentity();
      fetchMarginData();
    };

    window.addEventListener('app-data-updated', handleDataUpdate);
    window.addEventListener('focus', handleDataUpdate);

    return () => {
      window.removeEventListener('app-data-updated', handleDataUpdate);
      window.removeEventListener('focus', handleDataUpdate);
    };
  }, [refreshOverview, refreshIdentity, fetchMarginData]);

  const attention: { icon: React.ComponentType<{ className?: string }>; text: React.ReactNode; tab: string; color: string }[] = [];
  if (overview) {
    if (overview.overdue_invoice_count > 0) {
      attention.push({
        icon: AlertTriangle,
        tab: 'financials',
        color: 'text-rose-500 bg-rose-100',
        text: (
          <>
            <strong className="font-bold text-rose-700">{overview.overdue_invoice_count}</strong> overdue invoice{overview.overdue_invoice_count === 1 ? '' : 's'} to follow up
          </>
        ),
      });
    }
    if (overview.pending_ticketing_count > 0) {
      attention.push({
        icon: Clock,
        tab: 'bookings',
        color: 'text-amber-500 bg-amber-100',
        text: (
          <>
            <strong className="font-bold text-amber-700">{overview.pending_ticketing_count}</strong> booking{overview.pending_ticketing_count === 1 ? '' : 's'} awaiting ticketing
          </>
        ),
      });
    }
    if (overview.upcoming_departures_count > 0) {
      attention.push({
        icon: CalendarDays,
        tab: 'bookings',
        color: 'text-blue-500 bg-blue-100',
        text: (
          <>
            <strong className="font-bold text-blue-700">{overview.upcoming_departures_count}</strong> flight{overview.upcoming_departures_count === 1 ? '' : 's'} departing in next 7 days
          </>
        ),
      });
    }
  }

  const todayMarginTotals = marginSummary?.today?.margin 
    ? [{ currency: 'ETB', amount: marginSummary.today.margin }] 
    : [];

  return (
    <Page>
      {/* Hero Welcome Section */}
      <div className="relative mb-8 overflow-hidden rounded-3xl bg-slate-900 px-6 py-10 shadow-2xl sm:px-12 sm:py-14">
        <div className="absolute -left-20 -top-20 h-72 w-72 rounded-full bg-teal-500/20 blur-3xl mix-blend-screen"></div>
        <div className="absolute -right-20 -bottom-20 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl mix-blend-screen"></div>
        <div className="absolute right-20 top-10 h-32 w-32 rounded-full bg-rose-500/20 blur-2xl mix-blend-screen"></div>

        <div className="relative z-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-teal-400" />
              <p className="text-sm font-medium tracking-wide text-teal-300/80 uppercase">{today}</p>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-5xl">
              Good to see you, <span className="text-transparent bg-clip-text bg-gradient-to-r from-teal-400 to-cyan-300">{firstName}</span>
            </h1>
            <p className="mt-3 text-lg text-slate-300">Here’s what’s happening across your operations today.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              refreshOverview();
              refreshIdentity();
              fetchMarginData();
            }}
            disabled={isOverviewLoading}
            className="group relative flex items-center gap-2 overflow-hidden rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold text-white backdrop-blur-md transition-all hover:bg-white/20 hover:shadow-lg hover:shadow-white/5 active:scale-95 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 transition-transform ${isOverviewLoading ? 'animate-spin text-teal-400' : 'group-hover:rotate-180'}`} />
            {isOverviewLoading ? 'Syncing data...' : 'Refresh dashboard'}
          </button>
        </div>
      </div>

      {overviewError && (
        <div className="mb-8 animate-in fade-in slide-in-from-bottom-2">
          <Notice kind="error">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              <p className="font-semibold">Failed to sync live figures.</p>
            </div>
            <p className="mt-1 text-sm opacity-90">{overviewError.message}</p>
            <button type="button" onClick={() => { refreshOverview(); fetchMarginData(); }} className={`${btnPrimary} mt-3 px-4 py-2 text-sm shadow-sm`}>
              Try again
            </button>
          </Notice>
        </div>
      )}

      {isOverviewLoading && !overview && (
        <div className="mb-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading figures">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="h-40 animate-pulse rounded-3xl bg-slate-200/60" />
          ))}
        </div>
      )}

      {overview && !overviewError && (
        <div className="space-y-8 animate-in fade-in duration-500">
          
          {/* Main KPI Grid */}
          <div>
            <div className="mb-4 flex items-center gap-2">
              <Activity className="h-5 w-5 text-slate-400" />
              <h2 className="text-lg font-bold text-slate-900">Financial Pulse</h2>
            </div>
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              <Figure label="Today's Margin Profit" hint="Ticket margins generated today" icon={Receipt} tone="in" totals={todayMarginTotals} empty="No margins recorded yet" />
              <Figure label="Cash Collected" hint="Customer payments today" icon={Banknote} tone="in" totals={overview.today_payments_by_currency} empty="No cash received yet" />
              <Figure label="Accounts Receivable" hint="Total unpaid invoices" icon={Wallet} tone="owed" totals={overview.outstanding_balance_by_currency} empty="All accounts settled" />
              <Figure label="Accounts Payable" hint="Unpaid supplier bills" icon={Building2} tone="owed" totals={overview.supplier_outstanding_by_currency} empty="All suppliers paid" />
              <Figure label="Operational Burn" hint="Office expenses this month" icon={PiggyBank} tone="out" totals={overview.month_expenses_by_currency} empty="No expenses logged" />
            </div>
            <p className="mt-3 text-xs font-medium text-slate-400 pl-1">Figures are isolated by currency for strict accounting accuracy.</p>
          </div>

          <div className="grid gap-8 lg:grid-cols-5">
            {/* Action Center - Spans 2 cols */}
            <div className="lg:col-span-2 space-y-6">
              <Card className="flex h-full flex-col p-0 overflow-hidden border-slate-200/60 shadow-sm">
                <div className="border-b border-slate-100 bg-slate-50/50 px-6 py-5">
                  <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                    <Zap className="h-5 w-5 text-amber-500 fill-amber-500/20" />
                    Priority Desk
                  </h2>
                </div>
                
                <div className="flex-1 p-6">
                  {attention.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center text-center">
                      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
                        <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                      </div>
                      <h3 className="text-sm font-bold text-slate-900">Inbox Zero</h3>
                      <p className="mt-1 text-sm text-slate-500">Everything is running smoothly. Nothing requires your immediate attention.</p>
                    </div>
                  ) : (
                    <ul className="space-y-3">
                      {attention.map((item, index) => (
                        <li key={index} className="group relative">
                          {index === 0 && <span className="absolute -left-1 -top-1 flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span><span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500"></span></span>}
                          
                          <button
                            type="button"
                            onClick={() => onNavigateTab(item.tab)}
                            className="flex w-full items-center gap-4 rounded-2xl border border-slate-200/70 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-200"
                          >
                            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${item.color}`}>
                              <item.icon className="h-5 w-5" />
                            </div>
                            <span className="flex-1 text-sm text-slate-700 leading-snug">{item.text}</span>
                            <ArrowRight className="h-4 w-4 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-slate-600" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </div>

            {/* Quick Actions / Shortcuts - Spans 3 cols */}
            <div className="lg:col-span-3">
              <h2 className="mb-4 text-lg font-bold text-slate-900">Quick Actions</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
                {SHORTCUTS.map((shortcut) => (
                  <button
                    key={shortcut.tab}
                    type="button"
                    onClick={() => onNavigateTab(shortcut.tab)}
                    className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white p-5 text-left shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-transparent hover:shadow-xl focus:outline-none"
                  >
                    <div className={`absolute inset-0 opacity-0 bg-gradient-to-br ${shortcut.color} transition-opacity duration-300 group-hover:opacity-100`}></div>
                    <div className="absolute inset-[1px] rounded-[15px] bg-white transition-colors duration-300 group-hover:bg-slate-50/90"></div>
                    
                    <div className="relative z-10 flex items-center justify-between">
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${shortcut.color} text-white shadow-inner transition-transform duration-300 group-hover:scale-110`}>
                        <shortcut.icon className="h-5 w-5" />
                      </span>
                      <ArrowRight className="h-5 w-5 shrink-0 text-slate-200 transition-all duration-300 group-hover:-rotate-45 group-hover:text-slate-700" />
                    </div>
                    <div className="relative z-10 mt-4 min-w-0">
                      <span className="block text-sm font-bold text-slate-900">{shortcut.title}</span>
                      <span className="mt-1 block text-xs font-medium text-slate-500">{shortcut.text}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Activity Timeline */}
          <div>
            <Card className="overflow-hidden border-slate-200/60 shadow-sm p-0">
              <div className="border-b border-slate-100 bg-slate-50/50 px-6 py-5">
                <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                  <History className="h-5 w-5 text-indigo-500" />
                  Latest Activity
                </h2>
              </div>
              <div className="p-6">
                {overview.recent_activity.length === 0 ? (
                  <p className="text-sm italic text-slate-500">No activity recorded on your account yet.</p>
                ) : (
                  <div className="relative border-l-2 border-slate-100 ml-3 py-2 space-y-8">
                    {overview.recent_activity.map((entry, index) => (
                      <div key={`${entry.created_at}-${index}`} className="relative pl-6">
                        <div className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-slate-300 ring-4 ring-white transition-colors hover:bg-indigo-400"></div>
                        
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{sentence(entry.action)}</p>
                            <p className="mt-0.5 text-sm text-slate-500">
                              {entry.detail ? `${entry.detail} ` : ''}
                              <span className="font-medium text-slate-700">{entry.actor_name ?? 'System Action'}</span>
                            </p>
                          </div>
                          <time dateTime={entry.created_at} className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">
                            {formatDateTime(entry.created_at)}
                          </time>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {!overview && !isOverviewLoading && !overviewError && (
        <div className="mt-8">
          <Card className="border-dashed border-slate-300 bg-slate-50">
            <EmptyState icon={Activity} title="Dashboard offline" hint="Press “Refresh dashboard” to load today’s live figures." />
          </Card>
        </div>
      )}
    </Page>
  );
};