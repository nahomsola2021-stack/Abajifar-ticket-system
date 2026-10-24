import React, { useEffect, useState } from 'react';
import { Mail, Phone, Plus, Search, Trash2, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { createCustomer, deleteCustomer, fetchCustomers } from '../../lib/api';
import type { CustomerCreateInput, CustomerRecord, CustomerType } from '../../types/customer';
import {
  Card,
  ConfirmDialog,
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
  hintCls,
  inputCls,
  labelCls,
} from '../ui';

const PAGE_SIZE = 50;

interface CustomerDirectoryViewProps {
  onBackToDashboard: () => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const CustomerDirectoryView: React.FC<CustomerDirectoryViewProps> = () => {
  const { accessToken } = useAuth();
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [customerType, setCustomerType] = useState<CustomerType>('individual');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<CustomerRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;

    fetchCustomers(accessToken, searchQuery, PAGE_SIZE, page * PAGE_SIZE)
      .then((result) => {
        if (!isCurrent) return;
        setCustomers(result.items);
        setTotal(result.total);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load customers.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [accessToken, searchQuery, page, refreshKey]);

  const closeForm = () => {
    setIsFormOpen(false);
    setCustomerType('individual');
    setDisplayName('');
    setEmail('');
    setPhone('');
  };

  const handleCreateCustomer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) {
      setError('Your session has expired. Sign in again to add customers.');
      return;
    }

    const customer: CustomerCreateInput = {
      customer_type: customerType,
      display_name: displayName.trim(),
      email: email.trim(),
      phone: phone.trim(),
    };

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await createCustomer(accessToken, customer);
      closeForm();
      setSearchInput('');
      setSearchQuery('');
      setPage(0);
      setSuccessMessage(`${customer.display_name} was added to your customers.`);
      setIsLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save the customer.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!accessToken || !deleteTarget) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteCustomer(accessToken, deleteTarget.id);
      setSuccessMessage(`${deleteTarget.display_name} was deleted.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete the customer.');
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
      setRefreshKey((key) => key + 1);
    }
  };

  const isCorporate = customerType === 'corporate';

  return (
    <Page>
      <PageHeader
        title="Customers"
        description="Everyone you sell tickets to, whether a person or a company."
        action={
          <button type="button" onClick={() => { setError(null); setIsFormOpen(true); }} className={btnPrimary}>
            <Plus className="h-4 w-4" />
            Add customer
          </button>
        }
      />

      {successMessage && (
        <Notice kind="success" onDismiss={() => setSuccessMessage(null)}>
          {successMessage}
        </Notice>
      )}
      {error && !isFormOpen && (
        <Notice kind="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      <Card>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const query = searchInput.trim();
            setIsLoading(true);
            setPage(0);
            if (query === searchQuery && page === 0) setRefreshKey((key) => key + 1);
            else setSearchQuery(query);
            setSuccessMessage(null);
            setError(null);
          }}
          className="flex items-center gap-2 border-b border-slate-200 p-4"
        >
          <label className="relative block flex-1">
            <span className="sr-only">Search customers</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by name, email or phone"
              className={`${inputCls} !mt-0 pl-10`}
            />
          </label>
          <button type="submit" className={btnSecondary}>
            Search
          </button>
        </form>

        {isLoading ? (
          <LoadingRows label="Loading customers" />
        ) : customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title={searchQuery ? 'No customers match your search' : 'No customers yet'}
            hint={searchQuery ? 'Check the spelling or try an email or phone number.' : 'Add your first customer to get started.'}
            action={
              searchQuery ? undefined : (
                <button type="button" onClick={() => setIsFormOpen(true)} className={btnPrimary}>
                  <Plus className="h-4 w-4" />
                  Add customer
                </button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {customers.map((customer) => (
              <li key={customer.id} className="flex flex-wrap items-center gap-4 px-4 py-4 hover:bg-slate-50/70 sm:px-5">
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal-100 text-sm font-semibold text-teal-800"
                >
                  {initials(customer.display_name)}
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-base font-semibold text-slate-900">{customer.display_name}</p>
                  <div className="mt-1">
                    <StatusBadge
                      label={customer.customer_type === 'corporate' ? 'Company' : 'Individual'}
                      tone={customer.customer_type === 'corporate' ? 'info' : 'neutral'}
                    />
                  </div>
                </div>
                <div className="min-w-0 space-y-1 text-sm text-slate-600">
                  {customer.email && (
                    <p className="flex items-center gap-2 truncate">
                      <Mail className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      {customer.email}
                    </p>
                  )}
                  {customer.phone && (
                    <p className="flex items-center gap-2">
                      <Phone className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      {customer.phone}
                    </p>
                  )}
                  {!customer.email && !customer.phone && <p className="text-slate-400">No contact details</p>}
                </div>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(customer)}
                  aria-label={`Delete ${customer.display_name}`}
                  className="rounded-lg p-2 text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-700"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {!isLoading && (
          <Pagination
            page={page}
            pageCount={pageCount}
            total={total}
            noun="customer"
            onPrevious={() => {
              setIsLoading(true);
              setPage((current) => current - 1);
            }}
            onNext={() => {
              setIsLoading(true);
              setPage((current) => current + 1);
            }}
          />
        )}
      </Card>

      {isFormOpen && (
        <Dialog title="Add a customer" description="Only the name is required. You can add contact details now or later." onClose={closeForm}>
          <form onSubmit={handleCreateCustomer} className="space-y-5">
            {error && <Notice kind="error">{error}</Notice>}
            <fieldset>
              <legend className={labelCls}>Who is the customer?</legend>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(['individual', 'corporate'] as const).map((type) => (
                  <label
                    key={type}
                    className={`flex cursor-pointer items-center justify-center rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors focus-within:ring-4 focus-within:ring-teal-600/15 ${
                      customerType === type ? 'border-teal-600 bg-teal-50 text-teal-900' : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="customer-type"
                      value={type}
                      checked={customerType === type}
                      onChange={() => setCustomerType(type)}
                      className="sr-only"
                    />
                    {type === 'individual' ? 'A person' : 'A company'}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className={labelCls}>
              {isCorporate ? 'Company name' : 'Full name'}
              <input
                required
                maxLength={200}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className={inputCls}
                placeholder={isCorporate ? 'Example Trading PLC' : 'Abebe Kebede'}
              />
            </label>
            <label className={labelCls}>
              Email <span className="font-normal text-slate-500">(optional)</span>
              <input
                type="email"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputCls}
                placeholder="name@example.com"
              />
            </label>
            <label className={labelCls}>
              Phone <span className="font-normal text-slate-500">(optional)</span>
              <input
                type="tel"
                maxLength={40}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className={inputCls}
                placeholder="+251 9…"
              />
              <span className={hintCls}>Customers are shared by every office.</span>
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={closeForm} className={btnSecondary}>
                Cancel
              </button>
              <button type="submit" disabled={isSaving || !displayName.trim()} className={btnPrimary}>
                {isSaving ? 'Saving…' : 'Save customer'}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.display_name}?`}
          message="Only customers with no bookings, invoices or payments can be deleted. This cannot be undone."
          confirmLabel="Delete customer"
          busyLabel="Deleting…"
          busy={isDeleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Page>
  );
};