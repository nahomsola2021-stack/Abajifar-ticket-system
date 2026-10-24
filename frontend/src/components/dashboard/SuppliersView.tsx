import React, { useEffect, useState } from 'react';
import { Building2, Plus, Power } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { createSupplier, fetchSuppliers, updateSupplierStatus } from '../../lib/api';
import type { SupplierCreateInput, SupplierRecord, SupplierType } from '../../types/customer';
import {
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  LoadingRows,
  Notice,
  Page,
  PageHeader,
  StatusBadge,
  btnGhost,
  btnPrimary,
  btnSecondary,
  hintCls,
  inputCls,
  labelCls,
} from '../ui';

const SUPPLIER_TYPE_LABELS: Record<SupplierType, string> = {
  airline: 'Airline',
  consolidator: 'Consolidator',
  host_agency: 'Host agency',
  gds: 'Booking system (GDS)',
  hotel: 'Hotel',
  other: 'Other',
};

type TextKey = 'legal_name' | 'trading_name' | 'contact_name' | 'phone' | 'email' | 'account_reference' | 'settlement_currency' | 'notes';

const EMPTY_FORM: SupplierCreateInput = {
  supplier_type: 'airline',
  legal_name: '',
  trading_name: '',
  contact_name: '',
  phone: '',
  email: '',
  account_reference: '',
  settlement_currency: 'ETB',
  notes: '',
};

interface SuppliersViewProps {
  onBackToDashboard: () => void;
}

export const SuppliersView: React.FC<SuppliersViewProps> = () => {
  const { accessToken, staff } = useAuth();
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<SupplierType | ''>('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<SupplierCreateInput>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [savingStatusId, setSavingStatusId] = useState<number | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<SupplierRecord | null>(null);
  const canManageSuppliers = Boolean(staff?.roles.some((role) => ['ADMIN', 'MANAGER'].includes(role.toUpperCase())));

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;
    fetchSuppliers(accessToken)
      .then((result) => {
        if (isCurrent) setSuppliers(result);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load suppliers.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken]);

  const visibleSuppliers = suppliers.filter((supplier) => {
    const searchable = [supplier.legal_name, supplier.trading_name, supplier.contact_name, supplier.email, supplier.phone, supplier.account_reference]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return (
      (!search.trim() || searchable.includes(search.trim().toLowerCase())) &&
      (!typeFilter || supplier.supplier_type === typeFilter) &&
      (statusFilter === 'all' || supplier.is_active === (statusFilter === 'active'))
    );
  });

  const closeForm = () => {
    setIsFormOpen(false);
    setForm(EMPTY_FORM);
  };

  const handleCreateSupplier = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createSupplier(accessToken, {
        ...form,
        legal_name: form.legal_name.trim(),
        trading_name: form.trading_name.trim(),
        contact_name: form.contact_name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        account_reference: form.account_reference.trim(),
        settlement_currency: form.settlement_currency.trim().toUpperCase(),
        notes: form.notes.trim(),
      });
      setSuppliers((current) => [created, ...current]);
      closeForm();
      setStatusFilter('active');
      setSuccess(`${created.trading_name || created.legal_name} was added to your suppliers.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save the supplier.');
    } finally {
      setIsSaving(false);
    }
  };

  const changeStatus = async (supplier: SupplierRecord) => {
    if (!accessToken) return;
    setSavingStatusId(supplier.id);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateSupplierStatus(accessToken, supplier.id, !supplier.is_active);
      setSuppliers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSuccess(`${supplier.trading_name || supplier.legal_name} is now ${updated.is_active ? 'active' : 'inactive'}.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not change the supplier.');
    } finally {
      setSavingStatusId(null);
      setDeactivateTarget(null);
    }
  };

  const text = (key: TextKey) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = key === 'settlement_currency' ? event.target.value.toUpperCase() : event.target.value;
      setForm((current) => ({ ...current, [key]: value }));
    },
  });

  return (
    <Page wide>
      <PageHeader
        title="Suppliers"
        description="The airlines and ticketing partners you buy tickets from."
        action={
          canManageSuppliers && (
            <button type="button" onClick={() => { setError(null); setIsFormOpen(true); }} className={btnPrimary}>
              <Plus className="h-4 w-4" />
              Add supplier
            </button>
          )
        }
      />

      {success && <Notice kind="success" onDismiss={() => setSuccess(null)}>{success}</Notice>}
      {error && !isFormOpen && <Notice kind="error" onDismiss={() => setError(null)}>{error}</Notice>}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <input className="border rounded px-2 py-1" value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="Search by name, contact or account" />
          <label>
            <span className="sr-only">Supplier type</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as SupplierType | '')} className={`${inputCls} !mt-0 w-auto`}>
              <option value="">All types</option>
              {Object.entries(SUPPLIER_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Supplier status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className={`${inputCls} !mt-0 w-auto`}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
          </label>
        </div>

        {isLoading ? (
          <LoadingRows label="Loading suppliers" />
        ) : visibleSuppliers.length === 0 ? (
          <EmptyState icon={Building2} title="No suppliers found" hint="Try a different search, or switch the filter to “All”." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-3">Supplier</th>
                  <th scope="col" className="px-4 py-3">Type</th>
                  <th scope="col" className="px-4 py-3">Contact</th>
                  <th scope="col" className="px-4 py-3">Paid in</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  {canManageSuppliers && <th scope="col" className="px-4 py-3 text-right"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleSuppliers.map((supplier) => (
                  <tr key={supplier.id} className="align-top hover:bg-slate-50/70">
                    <td className="px-4 py-4">
                      <div className="font-semibold text-slate-900">{supplier.trading_name || supplier.legal_name}</div>
                      {supplier.trading_name && <div className="mt-0.5 text-slate-500">{supplier.legal_name}</div>}
                      {supplier.account_reference && <div className="mt-0.5 text-xs text-slate-500">Account {supplier.account_reference}</div>}
                    </td>
                    <td className="px-4 py-4 text-slate-700">{SUPPLIER_TYPE_LABELS[supplier.supplier_type]}</td>
                    <td className="px-4 py-4 text-slate-600">
                      <div>{supplier.contact_name || '—'}</div>
                      <div className="mt-0.5">{supplier.email || supplier.phone || ''}</div>
                    </td>
                    <td className="px-4 py-4 font-medium text-slate-700">{supplier.settlement_currency.trim()}</td>
                    <td className="px-4 py-4">
                      <StatusBadge label={supplier.is_active ? 'Active' : 'Inactive'} tone={supplier.is_active ? 'good' : 'neutral'} />
                    </td>
                    {canManageSuppliers && (
                      <td className="px-4 py-4 text-right">
                        <button
                          type="button"
                          disabled={savingStatusId === supplier.id}
                          onClick={() => (supplier.is_active ? setDeactivateTarget(supplier) : void changeStatus(supplier))}
                          className={btnGhost}
                        >
                          <Power className="h-4 w-4" />
                          {supplier.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {isFormOpen && canManageSuppliers && (
        <Dialog title="Add a supplier" description="Start with the name and the currency you pay them in." onClose={closeForm} size="lg">
          <form onSubmit={handleCreateSupplier} className="space-y-5">
            {error && <Notice kind="error">{error}</Notice>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={labelCls}>
                Type of supplier
                <select value={form.supplier_type} onChange={(event) => setForm((current) => ({ ...current, supplier_type: event.target.value as SupplierType }))} className={inputCls}>
                  {Object.entries(SUPPLIER_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                Currency you pay in
                <input required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" {...text('settlement_currency')} className={`${inputCls} uppercase`} />
                <span className={hintCls}>3 letters, like ETB or USD</span>
              </label>
              <label className={labelCls}>
                Legal name
                <input required maxLength={200} {...text('legal_name')} className={inputCls} />
              </label>
              <label className={labelCls}>
                Trading name <span className="font-normal text-slate-500">(optional)</span>
                <input maxLength={200} {...text('trading_name')} className={inputCls} />
              </label>
              <label className={labelCls}>
                Contact person <span className="font-normal text-slate-500">(optional)</span>
                <input maxLength={160} {...text('contact_name')} className={inputCls} />
              </label>
              <label className={labelCls}>
                Account number <span className="font-normal text-slate-500">(optional)</span>
                <input maxLength={120} {...text('account_reference')} className={inputCls} />
              </label>
              <label className={labelCls}>
                Email <span className="font-normal text-slate-500">(optional)</span>
                <input type="email" maxLength={254} {...text('email')} className={inputCls} />
              </label>
              <label className={labelCls}>
                Phone <span className="font-normal text-slate-500">(optional)</span>
                <input maxLength={40} {...text('phone')} className={inputCls} />
              </label>
            </div>
            <label className={labelCls}>
              Notes <span className="font-normal text-slate-500">(optional)</span>
              <textarea rows={2} maxLength={2000} {...text('notes')} className={`${inputCls} resize-y`} />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeForm} className={btnSecondary}>Cancel</button>
              <button type="submit" disabled={isSaving} className={btnPrimary}>{isSaving ? 'Saving…' : 'Save supplier'}</button>
            </div>
          </form>
        </Dialog>
      )}

      {deactivateTarget && (
        <ConfirmDialog
          title={`Deactivate ${deactivateTarget.trading_name || deactivateTarget.legal_name}?`}
          message="They will no longer appear when you record new sales or bills. Their history is kept, and you can activate them again any time."
          confirmLabel="Deactivate"
          busyLabel="Saving…"
          busy={savingStatusId === deactivateTarget.id}
          onConfirm={() => void changeStatus(deactivateTarget)}
          onCancel={() => setDeactivateTarget(null)}
        />
      )}
    </Page>
  );
};
