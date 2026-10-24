import React, { useEffect, useState } from 'react';
import { Ban, PiggyBank, Plus, Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { createExpense, fetchExpenseCategories, fetchExpenses, voidExpense } from '../../lib/api';
import type { PaymentMethod } from '../../types/customer';
import type { ExpenseCategory, ExpenseCategoryOption, ExpenseRecord, ExpenseStatus } from '../../types/finance';
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
  formatAmount,
  formatDate,
  hintCls,
  inputCls,
  labelCls,
  toDateInput,
} from '../ui';

const PAGE_SIZE = 50;

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'card_gateway', label: 'Card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

const FALLBACK_CATEGORIES: ExpenseCategoryOption[] = [
  { code: 'rent', label: 'Rent' },
  { code: 'utilities', label: 'Electricity and water' },
  { code: 'internet', label: 'Internet' },
  { code: 'phone', label: 'Phone and airtime' },
  { code: 'transport', label: 'Transport and fuel' },
  { code: 'salary', label: 'Salaries' },
  { code: 'supplies', label: 'Office supplies' },
  { code: 'marketing', label: 'Marketing' },
  { code: 'licensing', label: 'Licences and fees' },
  { code: 'insurance', label: 'Insurance' },
  { code: 'bank_charges', label: 'Bank charges' },
  { code: 'maintenance', label: 'Repairs and maintenance' },
  { code: 'other', label: 'Other' },
];

interface ExpensesViewProps {
  onBackToDashboard: () => void;
}

export const ExpensesView: React.FC<ExpensesViewProps> = () => {
  const { accessToken, staff } = useAuth();
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [categories, setCategories] = useState<ExpenseCategoryOption[]>(FALLBACK_CATEGORIES);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | ''>('');
  const [statusFilter, setStatusFilter] = useState<ExpenseStatus | ''>('');
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [totalByCurrency, setTotalByCurrency] = useState<{ currency: string; amount: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [expenseDate, setExpenseDate] = useState(() => toDateInput(new Date()));
  const [category, setCategory] = useState<ExpenseCategory>('utilities');
  const [description, setDescription] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('ETB');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');

  const [voidTarget, setVoidTarget] = useState<ExpenseRecord | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [isVoiding, setIsVoiding] = useState(false);

  const canRecord = Boolean(staff?.roles.some((role) => ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(role.toUpperCase())));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;
    fetchExpenses(accessToken, search, categoryFilter, statusFilter, PAGE_SIZE, page * PAGE_SIZE)
      .then((result) => {
        if (!isCurrent) return;
        setExpenses(result.items);
        setTotal(result.total);
        setTotalByCurrency(result.total_by_currency);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load expenses.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, search, categoryFilter, statusFilter, page, refreshKey]);

  useEffect(() => {
    if (!accessToken) return;
    let isCurrent = true;
    fetchExpenseCategories(accessToken)
      .then((result) => {
        if (isCurrent && result.length > 0) setCategories(result);
      })
      .catch(() => {
        // The built-in list keeps the form usable if the lookup fails.
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken]);

  const closeForm = () => {
    setIsFormOpen(false);
    setExpenseDate(toDateInput(new Date()));
    setCategory('utilities');
    setDescription('');
    setSupplierName('');
    setAmount('');
    setCurrency('ETB');
    setPaymentMethod('cash');
  };

  const handleCreateExpense = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) return;

    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createExpense(accessToken, {
        expense_date: expenseDate,
        category,
        description: description.trim(),
        supplier_name: supplierName.trim() || null,
        currency: currency.trim().toUpperCase(),
        amount: Number(amount),
        payment_method: paymentMethod,
      });
      closeForm();
      setSuccess(`Expense saved: ${formatAmount(created.amount, created.currency)} for ${created.description}.`);
      setIsLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save the expense.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleVoidExpense = async () => {
    if (!accessToken || !voidTarget) return;
    setIsVoiding(true);
    setError(null);
    setSuccess(null);
    try {
      await voidExpense(accessToken, voidTarget.id, voidReason.trim());
      setSuccess('Expense cancelled. It stays on record but no longer counts in your totals.');
      setIsLoading(true);
      setRefreshKey((key) => key + 1);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not cancel the expense.');
    } finally {
      setIsVoiding(false);
      setVoidTarget(null);
      setVoidReason('');
    }
  };

  const methodLabel = (value: PaymentMethod) => PAYMENT_METHODS.find((method) => method.value === value)?.label ?? value;

  return (
    <Page wide>
      <PageHeader
        title="Expenses"
        description="What it costs to run the office: rent, bills, salaries and supplies. Supplier ticket costs are tracked separately."
        action={
          canRecord && (
            <button type="button" onClick={() => { setError(null); setIsFormOpen(true); }} className={btnPrimary}>
              <Plus className="h-4 w-4" />
              Add expense
            </button>
          )
        }
      />

      {success && (
        <Notice kind="success" onDismiss={() => setSuccess(null)}>
          {success}
        </Notice>
      )}
      {error && !isFormOpen && (
        <Notice kind="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      {totalByCurrency.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {totalByCurrency.map((item) => (
            <div key={item.currency} className="rounded-2xl border border-rose-100 bg-rose-50/60 px-5 py-3">
              <p className="text-xs font-medium text-rose-800">Spent in {item.currency.trim()}</p>
              <p className="text-xl font-semibold tabular-nums text-slate-900">{formatAmount(item.amount, item.currency)}</p>
            </div>
          ))}
        </div>
      )}

      <Card>
        <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-[minmax(12rem,1fr)_13rem_10rem]">
          <label className="relative block">
            <span className="sr-only">Search expenses</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={searchInput}
              onChange={(event) => {
                setIsLoading(true);
                setSearchInput(event.target.value);
                setSearch(event.target.value.trim());
                setPage(0);
              }}
              placeholder="Search by description or who was paid"
              className={`${inputCls} !mt-0 pl-10`}
            />
          </label>
          <label>
            <span className="sr-only">Category</span>
            <select
              value={categoryFilter}
              onChange={(event) => {
                setIsLoading(true);
                setCategoryFilter(event.target.value as ExpenseCategory | '');
                setPage(0);
              }}
              className={`${inputCls} !mt-0`}
            >
              <option value="">All categories</option>
              {categories.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => {
                setIsLoading(true);
                setStatusFilter(event.target.value as ExpenseStatus | '');
                setPage(0);
              }}
              className={`${inputCls} !mt-0`}
            >
              <option value="">All expenses</option>
              <option value="recorded">Counted</option>
              <option value="void">Cancelled</option>
            </select>
          </label>
        </div>

        {isLoading ? (
          <LoadingRows label="Loading expenses" />
        ) : expenses.length === 0 ? (
          <EmptyState
            icon={PiggyBank}
            title={search || categoryFilter || statusFilter ? 'No expenses match your search' : 'No expenses yet'}
            hint={search || categoryFilter || statusFilter ? 'Try clearing a filter.' : 'Add an expense to start keeping track of office costs.'}
            action={
              canRecord && !(search || categoryFilter || statusFilter) ? (
                <button type="button" onClick={() => setIsFormOpen(true)} className={btnPrimary}>
                  <Plus className="h-4 w-4" />
                  Add expense
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-3">Date</th>
                  <th scope="col" className="px-4 py-3">What it was for</th>
                  <th scope="col" className="px-4 py-3">Paid by</th>
                  <th scope="col" className="px-4 py-3 text-right">Amount</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="w-14 px-4 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {expenses.map((expense) => {
                  const isVoid = expense.status === 'void';
                  return (
                    <tr key={expense.id} className="align-top hover:bg-slate-50/70">
                      <td className="whitespace-nowrap px-4 py-4 text-slate-600">{formatDate(expense.expense_date)}</td>
                      <td className="px-4 py-4">
                        <div className={`font-medium ${isVoid ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{expense.description}</div>
                        <div className="mt-0.5 text-slate-500">
                          {expense.category_label}
                          {expense.supplier_name ? `, paid to ${expense.supplier_name}` : ''}
                        </div>
                        {isVoid && expense.void_reason && <div className="mt-1 text-xs text-rose-700">Cancelled because: {expense.void_reason}</div>}
                      </td>
                      <td className="px-4 py-4 text-slate-600">{methodLabel(expense.payment_method)}</td>
                      <td className={`px-4 py-4 text-right font-semibold tabular-nums ${isVoid ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                        {formatAmount(expense.amount, expense.currency)}
                      </td>
                      <td className="px-4 py-4">
                        <StatusBadge label={isVoid ? 'Cancelled' : 'Counted'} tone={isVoid ? 'neutral' : 'good'} />
                      </td>
                      <td className="px-4 py-4 text-right">
                        {canRecord && !isVoid && (
                          <button
                            type="button"
                            onClick={() => { setVoidTarget(expense); setVoidReason(''); }}
                            aria-label={`Cancel expense: ${expense.description}`}
                            title="Cancel this expense"
                            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-700"
                          >
                            <Ban className="h-4 w-4" />
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
            noun="expense"
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

      {isFormOpen && canRecord && (
        <Dialog title="Add an expense" description="Amounts stay in the currency they were paid in." onClose={closeForm} size="lg">
          <form onSubmit={handleCreateExpense} className="space-y-5">
            {error && <Notice kind="error">{error}</Notice>}
            <label className={labelCls}>
              What was it for?
              <input
                required
                minLength={3}
                maxLength={500}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className={inputCls}
                placeholder="October office rent"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <label className={labelCls}>
                Amount
                <input
                  required
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className={inputCls}
                  placeholder="0.00"
                />
              </label>
              <label className={labelCls}>
                Currency
                <input
                  required
                  minLength={3}
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  className={`${inputCls} uppercase`}
                />
                <span className={hintCls}>3 letters, like ETB</span>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <label className={labelCls}>
                Date
                <input required type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} className={inputCls} />
              </label>
              <label className={labelCls}>
                Category
                <select value={category} onChange={(event) => setCategory(event.target.value as ExpenseCategory)} className={inputCls}>
                  {categories.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                Paid by
                <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)} className={inputCls}>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method.value} value={method.value}>
                      {method.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className={labelCls}>
              Paid to <span className="font-normal text-slate-500">(optional)</span>
              <input maxLength={200} value={supplierName} onChange={(event) => setSupplierName(event.target.value)} className={inputCls} placeholder="Landlord, utility company…" />
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={closeForm} className={btnSecondary}>
                Cancel
              </button>
              <button type="submit" disabled={isSaving || !amount || description.trim().length < 3} className={btnPrimary}>
                {isSaving ? 'Saving…' : 'Save expense'}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {voidTarget && (
        <ConfirmDialog
          title="Cancel this expense?"
          message={`“${voidTarget.description}” stays on record for your audit trail, but its ${formatAmount(voidTarget.amount, voidTarget.currency)} no longer counts in your totals.`}
          confirmLabel="Cancel expense"
          busyLabel="Cancelling…"
          busy={isVoiding}
          confirmDisabled={voidReason.trim().length < 3}
          onConfirm={() => void handleVoidExpense()}
          onCancel={() => setVoidTarget(null)}
        >
          <label className={labelCls}>
            Why is it being cancelled?
            <input
              required
              minLength={3}
              maxLength={500}
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              className={inputCls}
              placeholder="Entered twice by mistake"
            />
          </label>
        </ConfirmDialog>
      )}
    </Page>
  );
};