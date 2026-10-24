import React from 'react';
import { ArrowLeft, Clock, ShieldCheck, FileCode, CheckCircle2 } from 'lucide-react';

interface ComingSoonViewProps {
  moduleKey: 'suppliers' | 'financials';
  onBackToDashboard: () => void;
}

const MODULE_DETAILS = {
  suppliers: {
    title: 'Airline & Rail Suppliers',
    category: 'Inventory & Stock Allotments',
    description:
      'Consolidator contracts, airline commission agreements, direct NDC (New Distribution Capability) connections, and ticket stock ranges.',
    endpoints: [
      'GET /api/suppliers',
      'GET /api/suppliers/{id}/allotments',
      'POST /api/suppliers/validate-credentials',
    ],
    plannedCapabilities: [
      'IATA carrier code directory & validating carrier tables',
      'Consolidator net-fare agreement management',
      'Rail carrier timetable & e-voucher API hooks',
      'Commission tier tracking by operating vs marketing carrier',
    ],
    phase: 'Phase 3 Architecture Deployment',
  },
  financials: {
    title: 'Financials & BSP Reconciliation',
    category: 'Accounting & Settlement',
    description:
      'Billing and Settlement Plan (BSP) reconciliation, daily sales reports, void window audit logs, refund processing, and agency service fees.',
    endpoints: [
      'GET /api/financials/daily-sales-report',
      'GET /api/financials/bsp-settlement-cycle',
      'POST /api/financials/reconcile-batch',
    ],
    plannedCapabilities: [
      'Automated IATA BSP billing file comparison (HOT file parser)',
      'Void vs. refund penalty calculator',
      'Agency merchant processing reconciliation',
      'Weekly audit summary for branch managers',
    ],
    phase: 'Phase 3 Architecture Deployment',
  },
};

export const ComingSoonView: React.FC<ComingSoonViewProps> = ({ moduleKey, onBackToDashboard }) => {
  const details = MODULE_DETAILS[moduleKey];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Back button */}
      <div>
        <button
          type="button"
          onClick={onBackToDashboard}
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Operations Overview</span>
        </button>
      </div>

      {/* Main Roadmap Card */}
      <div className="bg-white border border-slate-200/90 rounded-xl p-7 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-teal-800 uppercase tracking-wider mb-1">
              <span>{details.category}</span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span className="text-amber-700 font-mono">Module Coming Soon</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {details.title}
            </h1>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 font-mono">
            <Clock className="w-4 h-4 text-amber-600" />
            <span>{details.phase}</span>
          </div>
        </div>

        <p className="mt-4 text-sm text-slate-600 leading-relaxed">
          {details.description}
        </p>

        {/* Notice explaining why mock CRUD is prohibited */}
        <div className="mt-6 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-1">
          <div className="font-semibold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-teal-600 shrink-0" />
            <span>Operational Integrity Notice</span>
          </div>
          <p className="text-slate-600 leading-relaxed text-[11px]">
            Backend API endpoints for this module are not yet deployed to production. To preserve data consistency and ensure compliance with real ticketing records, the frontend does not create simulated CRUD data. Interface forms will activate as soon as the respective backend endpoints are released.
          </p>
        </div>

        {/* Planned Capabilities */}
        <div className="mt-6">
          <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3">
            Planned Module Capabilities
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {details.plannedCapabilities.map((item, index) => (
              <div
                key={index}
                className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-100 bg-slate-50/50 text-xs text-slate-800"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0 mt-0.5" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Planned Backend Endpoints */}
        <div className="mt-6 pt-6 border-t border-slate-100">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-900 uppercase tracking-wider mb-3">
            <FileCode className="w-4 h-4 text-slate-500" />
            <span>Associated Backend Endpoints (Specification)</span>
          </div>
          <div className="space-y-1.5 font-mono text-xs">
            {details.endpoints.map((ep, idx) => (
              <div
                key={idx}
                className="px-3 py-1.5 rounded-md bg-slate-100 text-slate-800 text-[11px] border border-slate-200/60"
              >
                {ep}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
