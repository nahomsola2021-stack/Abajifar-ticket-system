import { FileText } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { fetchSupplierBills } from '../../lib/api';
import type { SupplierBillRecord } from '../../types/finance';
import {
  Card,
  EmptyState,
  LoadingRows,
  Notice,
  Page,
  PageHeader,
  StatusBadge,
  inputCls,
} from '../ui';
import { useEffect, useState } from 'react';

export function SupplierBillsView() {
  const { accessToken } = useAuth();
  const [bills, setBills] = useState<SupplierBillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!accessToken) return;
    setLoading(true);
    fetchSupplierBills(accessToken, search)
      .then((result) => {
        setBills(Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : []);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load bills'))
      .finally(() => setLoading(false));
  }, [accessToken, search]);

  const filtered = bills.filter((b) => {
    const q = search.toLowerCase();
    return (
      !q ||
      b.supplier_name?.toLowerCase().includes(q) ||
      b.bill_number?.toLowerCase().includes(q)
    );
  });

  return (
    <Page>
      <PageHeader title="Supplier Bills" description="Manage supplier bills and payments" />
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by supplier or bill reference..."
          className={inputCls}
        />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {loading ? (
        <LoadingRows label="Loading supplier bills..." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={FileText} title="No supplier bills found" hint="Supplier bills will appear here once tickets are recorded." />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-semibold text-slate-500">
                <th className="px-3 py-2">Bill Reference</th>
                <th className="px-3 py-2">Supplier Name</th>
                <th className="px-3 py-2">Issue Date</th>
                <th className="px-3 py-2">Due Date</th>
                <th className="px-3 py-2 text-right">Total Amount</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((bill) => (
                <tr key={bill.id} className="border-b border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">{bill.bill_number ?? `#${bill.id}`}</td>
                  <td className="px-3 py-2">{bill.supplier_name}</td>
                  <td className="px-3 py-2">{bill.bill_date}</td>
                  <td className="px-3 py-2">{bill.due_date ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{bill.amount} {bill.currency}</td>
                  <td className="px-3 py-2">
                    <StatusBadge label={bill.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}
