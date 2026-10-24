/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';

import { SignInForm } from './components/auth/SignInForm';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';

const OperationsOverview = lazy(() => import('./components/dashboard/OperationsOverview').then(m => ({ default: m.OperationsOverview })));
const BookingsView = lazy(() => import('./components/dashboard/BookingsView').then(m => ({ default: m.BookingsView })));
const TicketSalesView = lazy(() => import('./components/dashboard/TicketSalesView').then(m => ({ default: m.TicketSalesView })));
const CustomerDirectoryView = lazy(() => import('./components/dashboard/CustomerDirectoryView').then(m => ({ default: m.CustomerDirectoryView })));
const SuppliersView = lazy(() => import('./components/dashboard/SuppliersView').then(m => ({ default: m.SuppliersView })));
const SupplierBillsView = lazy(() => import('./components/dashboard/SupplierBillsView').then(m => ({ default: m.SupplierBillsView })));
const FinancialsView = lazy(() => import('./components/dashboard/FinancialsView').then(m => ({ default: m.FinancialsView })));
const PaymentsView = lazy(() => import('./components/dashboard/PaymentsView').then(m => ({ default: m.PaymentsView })));
const SupplierPaymentsView = lazy(() => import('./components/dashboard/SupplierPaymentsView').then(m => ({ default: m.SupplierPaymentsView })));
const ExpensesView = lazy(() => import('./components/dashboard/ExpensesView').then(m => ({ default: m.ExpensesView })));
const ReportsView = lazy(() => import('./components/dashboard/ReportsView').then(m => ({ default: m.ReportsView })));
const StaffManagementView = lazy(() => import('./components/dashboard/StaffManagementView').then(m => ({ default: m.StaffManagementView })));

import { ConfigModal } from './components/common/ConfigModal';

import {
  AlertCircle,
  RefreshCw,
  LogOut,
  Building,
} from 'lucide-react';

/**
 * Normalize legacy IDs from the existing Header and other components.
 * All navigation state uses the IDs defined in Sidebar.tsx.
 */
const TAB_ALIASES: Record<string, string> = {
  overview: 'dashboard',

  sales: 'ticket-sales',
  money: 'invoices',
  reports: 'reports-sales',
  settings: 'settings-staff',

  financials: 'invoices',
  payments: 'customer-payments',

  staff: 'settings-staff',
  suppliers: 'settings-suppliers',

  'customer-balances': 'reports-customer-balances',
  'supplier-balances': 'reports-supplier-balances',
  'sales-margins': 'reports-sales',
  'reports-payment-methods': 'reports-expenses',
};

const REPORT_TAB_IDS = new Set([
  'reports-sales',
  'reports-customer-balances',
  'reports-supplier-balances',
  'reports-expenses',
]);

function normalizeTab(tab: string): string {
  return TAB_ALIASES[tab] ?? tab;
}

const DashboardContent: React.FC = () => {
  const {
    session,
    staff,
    isLoading,
    authError,
    refreshIdentity,
    signOut,
    config,
  } = useAuth();

  // Initialize tab from URL query param if present, defaulting cleanly to 'dashboard' on fresh loads
  const [currentTab, setCurrentTab] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    return tabParam ? normalizeTab(tabParam) : 'dashboard';
  });

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);

  /**
   * Use this for both Sidebar and Header navigation.
   */
  const setTab = (requestedTab: string) => {
    const nextTab = normalizeTab(requestedTab);

    console.debug('[Navigation]', {
      requestedTab,
      nextTab,
    });

    setCurrentTab(nextTab);
    setMobileSidebarOpen(false);

    // Sync URL query param so specific pages can be refreshed or shared, 
    // while a clean URL defaults back to the dashboard on hard reloads.
    const url = new URL(window.location.href);
    if (nextTab === 'dashboard') {
      url.searchParams.delete('tab');
    } else {
      url.searchParams.set('tab', nextTab);
    }
    window.history.replaceState({}, '', url.toString());
  };

  const backToDashboard = () => {
    setTab('dashboard');
  };

  // No authenticated user: show the login screen.
  if (!session) {
    return <SignInForm />;
  }

  // Authenticated, but staff details are still loading.
  if (isLoading && !staff && !authError) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100">
        <div className="w-12 h-12 rounded-xl bg-teal-900/60 border border-teal-500/30 flex items-center justify-center text-teal-300 mb-4 shadow-lg">
          <Building className="w-6 h-6 animate-pulse" />
        </div>

        <div className="w-5 h-5 border-2 border-teal-500/20 border-t-teal-400 rounded-full animate-spin mb-3" />

        <h2 className="text-base font-semibold text-white">
          Authenticating Staff Workspace
        </h2>

        <p className="text-xs text-slate-400 mt-1 max-w-sm text-center leading-relaxed">
          Retrieving verified staff profile from{' '}
          <code className="text-teal-400 font-mono">
            GET /api/auth/me
          </code>
          ...
        </p>
      </div>
    );
  }

  // Authentication succeeded, but staff verification failed.
  if (authError && !staff) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-7 shadow-2xl">
          <div className="w-10 h-10 rounded-xl bg-rose-950/70 border border-rose-500/40 flex items-center justify-center text-rose-400 mb-4">
            <AlertCircle className="w-5 h-5" />
          </div>

          <h2 className="text-lg font-bold text-white">
            {authError.code === 'MISSING_STAFF_PROFILE'
              ? 'Staff Profile Unassigned'
              : authError.code === 'INACTIVE_ACCOUNT'
                ? 'Staff Account Restricted'
                : authError.code === 'BACKEND_CONNECTION_ERROR'
                  ? 'Backend API Unreachable'
                  : authError.code === 'SESSION_EXPIRED'
                    ? 'Session Expired'
                    : 'Staff Workspace Authorization Error'}
          </h2>

          <p className="mt-2 text-xs text-slate-300 leading-relaxed">
            {authError.message}
          </p>

          {authError.details && (
            <div className="mt-3 p-2.5 rounded bg-slate-950 text-[11px] font-mono text-slate-400 border border-slate-800 break-all">
              {authError.details}
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-400">
            Backend Endpoint:{' '}
            <code className="text-teal-400 font-mono">
              {config.apiUrl}/api/auth/me
            </code>
          </div>

          <div className="mt-6 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => signOut()}
              className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign out</span>
            </button>

            <button
              type="button"
              onClick={() => refreshIdentity()}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-xs"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Verification</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  /**
   * Render the selected page.
   * Each recognized navigation ID has an explicit mapping.
   */
  const renderCurrentPage = (): React.ReactNode => {
    switch (currentTab) {
      case 'dashboard':
        return <OperationsOverview onNavigateTab={setTab} />;

      case 'bookings':
        return <BookingsView onBackToDashboard={backToDashboard} />;

      case 'ticket-sales':
        return <TicketSalesView onBackToDashboard={backToDashboard} />;

      case 'customers':
        return (
          <CustomerDirectoryView
            onBackToDashboard={backToDashboard}
          />
        );

      case 'invoices':
        return <FinancialsView onBackToDashboard={backToDashboard} />;

      case 'customer-payments':
        return <PaymentsView onBackToDashboard={backToDashboard} />;

      case 'supplier-payments':
        return (
          <SupplierPaymentsView
            onBackToDashboard={backToDashboard}
          />
        );

      case 'expenses':
        return <ExpensesView onBackToDashboard={backToDashboard} />;

      case 'settings-suppliers':
        return <SuppliersView onBackToDashboard={backToDashboard} />;

      case 'settings-staff':
        return (
          <StaffManagementView
            onBackToDashboard={backToDashboard}
          />
        );

      case 'reports-sales':
      case 'reports-customer-balances':
      case 'reports-supplier-balances':
      case 'reports-expenses':
        return (
          <ReportsView
            currentTab={currentTab}
            onTabChange={setTab}
            onBackToDashboard={backToDashboard}
          />
        );

      case 'supplier-bills':
        return <SupplierBillsView />;

      default:
        return (
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <h1 className="text-lg font-semibold text-slate-900">
              Page not connected
            </h1>

            <p className="mt-2 text-sm text-slate-600">
              No page is registered for this navigation ID:
            </p>

            <code className="mt-2 block rounded bg-slate-50 p-3 text-sm text-slate-800">
              {currentTab}
            </code>

            <button
              type="button"
              onClick={backToDashboard}
              className="mt-4 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
            >
              Return to Dashboard
            </button>
          </section>
        );
    }
  };

  const isReportTab = REPORT_TAB_IDS.has(currentTab);

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Sidebar
        currentTab={currentTab}
        onTabChange={setTab}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onOpenConfig={() => setIsConfigModalOpen(true)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onTabChange={setTab}
          onToggleMobileSidebar={() =>
            setMobileSidebarOpen((open) => !open)
          }
          onOpenConfig={() => setIsConfigModalOpen(true)}
        />

        <main
          className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto"
          data-current-tab={currentTab}
          data-report-tab={isReportTab ? currentTab : undefined}
        >
          {renderCurrentPage() && (
            <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
              {renderCurrentPage()}
            </Suspense>
          )}
        </main>
      </div>

      <ConfigModal
        isOpen={isConfigModalOpen}
        onClose={() => setIsConfigModalOpen(false)}
      />
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <DashboardContent />
    </AuthProvider>
  );
}