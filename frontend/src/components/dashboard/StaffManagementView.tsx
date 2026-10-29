import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Link2, Lock, Pencil, Plus, Trash2, UserPlus, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  createStaffWithPassword,
  deleteStaff,
  fetchManagedStaff,
  fetchStaffAdminOptions,
  linkStaffSignIn,
  updateManagedStaff,
} from '../../lib/api';
import type { StaffAdminOptions, StaffAdminRecord, StaffRoleOption } from '../../types/admin';
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
  type Tone,
} from '../ui';

interface StaffManagementViewProps {
  onBackToDashboard: () => void;
}

interface EditDraft {
  branch_id: number;
  role_ids: number[];
  is_active: boolean;
}

const ROLE_LABELS: Record<string, { label: string; tone: Tone }> = {
  ADMIN: { label: 'Administrator', tone: 'bad' },
  MANAGER: { label: 'Manager', tone: 'info' },
  ACCOUNTANT: { label: 'Accountant', tone: 'info' },
  CASHIER: { label: 'Cashier', tone: 'good' },
  AGENT: { label: 'Ticket agent', tone: 'warn' },
};

const roleName = (code: string) => ROLE_LABELS[code]?.label ?? code;

const RoleChoices: React.FC<{
  roles: StaffRoleOption[];
  selected: number[];
  onToggle: (roleId: number) => void;
}> = ({ roles, selected, onToggle }) => (
  <fieldset>
    <legend className={labelCls}>What can they do?</legend>
    <p className={hintCls}>Pick at least one. Someone with no role cannot sign in.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {roles.map((role) => (
        <label
          key={role.id}
          className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors focus-within:ring-4 focus-within:ring-teal-600/15 ${
            selected.includes(role.id) ? 'border-teal-600 bg-teal-50' : 'border-slate-200 hover:bg-slate-50'
          }`}
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-teal-700"
            checked={selected.includes(role.id)}
            onChange={() => onToggle(role.id)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-900">{roleName(role.code)}</span>
            <span className="block text-sm text-slate-500">{role.description}</span>
          </span>
        </label>
      ))}
    </div>
  </fieldset>
);

export const StaffManagementView: React.FC<StaffManagementViewProps> = () => {
  const { accessToken, staff } = useAuth();
  const isAdministrator = Boolean(staff?.roles.some((role) => role.toUpperCase() === 'ADMIN'));

  const [options, setOptions] = useState<StaffAdminOptions | null>(null);
  const [staffRecords, setStaffRecords] = useState<StaffAdminRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [isLinkFormOpen, setIsLinkFormOpen] = useState(false);
  const [linkEmail, setLinkEmail] = useState('');
  const [linkName, setLinkName] = useState('');
  const [linkBranchId, setLinkBranchId] = useState<number | ''>('');
  const [linkRoleIds, setLinkRoleIds] = useState<number[]>([]);
  const [linkPassword, setLinkPassword] = useState('');
  const [linkConfirmPassword, setLinkConfirmPassword] = useState('');

  // Password visibility eye toggles
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [editingStaffId, setEditingStaffId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [linkingStaffId, setLinkingStaffId] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<StaffAdminRecord | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    if (!accessToken || !isAdministrator) return;
    let isCurrent = true;
    Promise.all([fetchStaffAdminOptions(accessToken), fetchManagedStaff(accessToken)])
      .then(([optionsResult, staffResult]) => {
        if (!isCurrent) return;
        setOptions(optionsResult);
        setStaffRecords(staffResult);
        if (optionsResult.branches.length > 0) setLinkBranchId(optionsResult.branches[0].id);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : 'Could not load your team.');
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [accessToken, isAdministrator]);

  const roleOptions: StaffRoleOption[] = options?.roles ?? [];

  const visibleStaff = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return staffRecords;
    return staffRecords.filter((record) =>
      [record.full_name, record.email, record.branch_code ?? '', record.roles.map(roleName).join(' ')].join(' ').toLowerCase().includes(term),
    );
  }, [staffRecords, search]);

  const toggle = (roleId: number, selected: number[]) =>
    selected.includes(roleId) ? selected.filter((id) => id !== roleId) : [...selected, roleId];

  const closeAddForm = () => {
    setIsLinkFormOpen(false);
    setLinkEmail('');
    setLinkName('');
    setLinkRoleIds([]);
    setLinkPassword('');
    setLinkConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

  const handleLinkStaff = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !linkBranchId) return;
    if (linkRoleIds.length === 0) {
      setError('Choose at least one role. Someone with no role cannot sign in.');
      return;
    }
    if (linkPassword !== linkConfirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createStaffWithPassword(accessToken, {
        email: linkEmail.trim().toLowerCase(),
        full_name: linkName.trim(),
        branch_id: linkBranchId,
        role_ids: linkRoleIds,
        password: linkPassword,
        confirm_password: linkConfirmPassword,
      });
      setStaffRecords((current) => [created, ...current]);
      closeAddForm();
      setSuccess(`${created.full_name} has been added and can sign in now.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not add the team member.');
    } finally {
      setIsSaving(false);
    }
  };

  const startEditing = (record: StaffAdminRecord) => {
    setError(null);
    setSuccess(null);
    setEditingStaffId(record.staff_id);
    setEditDraft({
      branch_id: record.branch_id ?? options?.branches[0]?.id ?? 0,
      role_ids: [...record.role_ids],
      is_active: record.is_active,
    });
  };

  const closeEdit = () => {
    setEditingStaffId(null);
    setEditDraft(null);
  };

  const handleSaveAccess = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken || !editDraft || editingStaffId === null) return;
    if (editDraft.role_ids.length === 0) {
      setError('Choose at least one role. Someone with no role cannot sign in.');
      return;
    }
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateManagedStaff(accessToken, editingStaffId, {
        branch_id: editDraft.branch_id,
        role_ids: editDraft.role_ids,
        is_active: editDraft.is_active,
      });
      setStaffRecords((current) => current.map((record) => (record.staff_id === updated.staff_id ? updated : record)));
      closeEdit();
      setSuccess(`${updated.full_name} was updated${updated.is_active ? '' : ' and can no longer sign in'}.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save the changes.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLinkSignIn = async (record: StaffAdminRecord) => {
    if (!accessToken) return;
    setLinkingStaffId(record.staff_id);
    setError(null);
    setSuccess(null);
    try {
      const updated = await linkStaffSignIn(accessToken, record.staff_id);
      setStaffRecords((current) => current.map((item) => (item.staff_id === updated.staff_id ? updated : item)));
      setSuccess(`${updated.full_name} can now sign in.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not turn on sign-in for this person.');
    } finally {
      setLinkingStaffId(null);
    }
  };

  const handleRemove = async () => {
    if (!accessToken || !removeTarget) return;
    setIsRemoving(true);
    setError(null);
    setSuccess(null);
    try {
      await deleteStaff(accessToken, removeTarget.staff_id);
      setStaffRecords((current) => current.filter((item) => item.staff_id !== removeTarget.staff_id));
      setSuccess(`${removeTarget.full_name} was removed.`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not remove this person.');
    } finally {
      setIsRemoving(false);
      setRemoveTarget(null);
    }
  };

  const editingRecord = staffRecords.find((record) => record.staff_id === editingStaffId);

  return (
    <Page wide>
      <PageHeader
        title="Staff and roles"
        description="Choose who works in each office and what they are allowed to do."
        action={
          isAdministrator && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setSuccess(null);
                setIsLinkFormOpen(true);
              }}
              className={btnPrimary}
            >
              <UserPlus className="h-4 w-4" />
              Add team member
            </button>
          )
        }
      />

      {!isAdministrator ? (
        <Card>
          <EmptyState
            icon={Lock}
            title="Only administrators can manage staff"
            hint="Ask an administrator to change someone’s access for you."
          />
        </Card>
      ) : (
        <>
          {success && <Notice kind="success" onDismiss={() => setSuccess(null)}>{success}</Notice>}
          {error && !isLinkFormOpen && editingStaffId === null && <Notice kind="error" onDismiss={() => setError(null)}>{error}</Notice>}

          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
              <input
                className="rounded border border-slate-300 px-2.5 py-1 text-sm focus:border-teal-600 focus:outline-none"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, email, office or role"
              />
              <p className="text-sm text-slate-600">
                {staffRecords.filter((record) => record.is_active).length} active of {staffRecords.length}
              </p>
            </div>

            {isLoading ? (
              <LoadingRows label="Loading your team" />
            ) : visibleStaff.length === 0 ? (
              <EmptyState icon={Users} title="Nobody matches your search" hint="Check the spelling or clear the search box." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                    <tr>
                      <th scope="col" className="px-4 py-3">Team member</th>
                      <th scope="col" className="px-4 py-3">Office</th>
                      <th scope="col" className="px-4 py-3">Roles</th>
                      <th scope="col" className="px-4 py-3">Status</th>
                      <th scope="col" className="px-4 py-3 text-right"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visibleStaff.map((record) => (
                      <tr key={record.staff_id} className="align-top hover:bg-slate-50/70">
                        <td className="px-4 py-4">
                          <div className="font-semibold text-slate-900">{record.full_name}</div>
                          <div className="mt-0.5 text-slate-500">{record.email}</div>
                        </td>
                        <td className="px-4 py-4 text-slate-700">
                          <div>{record.branch_name ?? record.branch_code ?? '—'}</div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-1.5">
                            {record.roles.length === 0 ? (
                              <StatusBadge label="No role" tone="bad" />
                            ) : (
                              record.roles.map((code) => (
                                <StatusBadge key={code} label={roleName(code)} tone={ROLE_LABELS[code]?.tone ?? 'neutral'} />
                              ))
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <StatusBadge label={record.is_active ? 'Active' : 'Deactivated'} tone={record.is_active ? 'good' : 'neutral'} />
                          {record.has_sign_in === false && (
                            <p className="mt-1.5 text-xs text-amber-800">Sign-in not set up yet</p>
                          )}
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center justify-end gap-1">
                            {record.has_sign_in === false && (
                              <button
                                type="button"
                                onClick={() => void handleLinkSignIn(record)}
                                disabled={linkingStaffId === record.staff_id}
                                className={btnGhost}
                              >
                                <Link2 className="h-4 w-4" />
                                {linkingStaffId === record.staff_id ? 'Setting up…' : 'Set up sign-in'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => startEditing(record)}
                              className={btnGhost}
                              aria-label={`Change access for ${record.full_name}`}
                            >
                              <Pencil className="h-4 w-4" />
                              Change access
                            </button>
                            <button
                              type="button"
                              onClick={() => setRemoveTarget(record)}
                              aria-label={`Remove ${record.full_name}`}
                              className="rounded-lg p-2 text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-700"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {/* ADD A TEAM MEMBER MODAL */}
      {isAdministrator && isLinkFormOpen && (
        <Dialog
          title="Add a team member"
          description="They sign in with their work email and the password you set here."
          onClose={closeAddForm}
          size="lg"
        >
          <form onSubmit={handleLinkStaff} className="space-y-5">
            {error && <Notice kind="error">{error}</Notice>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={labelCls}>
                Full name
                <input
                  required
                  maxLength={160}
                  value={linkName}
                  onChange={(event) => setLinkName(event.target.value)}
                  className={inputCls}
                />
              </label>
              <label className={labelCls}>
                Work email
                <input
                  required
                  type="email"
                  maxLength={254}
                  value={linkEmail}
                  onChange={(event) => setLinkEmail(event.target.value)}
                  placeholder="name@example.com"
                  className={inputCls}
                />
              </label>
              <label className={`${labelCls} sm:col-span-2`}>
                Office
                <select
                  required
                  value={linkBranchId}
                  onChange={(event) => setLinkBranchId(Number(event.target.value))}
                  className={inputCls}
                >
                  {options?.branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name} ({branch.code})
                    </option>
                  ))}
                </select>
              </label>

              {/* FIRST PASSWORD WITH EYE TOGGLE */}
              <label className={labelCls}>
                First password
                <div className="relative">
                  <input
                    required
                    type={showPassword ? 'text' : 'password'}
                    minLength={8}
                    value={linkPassword}
                    onChange={(event) => setLinkPassword(event.target.value)}
                    className={`${inputCls} pr-10`}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 transition-colors hover:text-slate-600 focus:outline-none"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <span className={hintCls}>At least 8 characters</span>
              </label>

              {/* CONFIRM PASSWORD WITH EYE TOGGLE */}
              <label className={labelCls}>
                Type it again
                <div className="relative">
                  <input
                    required
                    type={showConfirmPassword ? 'text' : 'password'}
                    minLength={8}
                    value={linkConfirmPassword}
                    onChange={(event) => setLinkConfirmPassword(event.target.value)}
                    className={`${inputCls} pr-10`}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 transition-colors hover:text-slate-600 focus:outline-none"
                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  >
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </label>
            </div>

            <RoleChoices
              roles={roleOptions}
              selected={linkRoleIds}
              onToggle={(id) => setLinkRoleIds((current) => toggle(id, current))}
            />

            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeAddForm} className={btnSecondary}>
                Cancel
              </button>
              <button type="submit" disabled={isSaving} className={btnPrimary}>
                <Plus className="h-4 w-4" />
                {isSaving ? 'Adding…' : 'Add team member'}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {/* EDIT ACCESS MODAL */}
      {isAdministrator && editingStaffId !== null && editDraft && (
        <Dialog title="Change access" description={editingRecord?.full_name} onClose={closeEdit} size="lg">
          <form onSubmit={handleSaveAccess} className="space-y-5">
            {error && <Notice kind="error">{error}</Notice>}
            <label className={labelCls}>
              Office
              <select
                required
                value={editDraft.branch_id}
                onChange={(event) =>
                  setEditDraft((current) => (current ? { ...current, branch_id: Number(event.target.value) } : current))
                }
                className={inputCls}
              >
                {options?.branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.code})
                  </option>
                ))}
              </select>
            </label>
            <RoleChoices
              roles={roleOptions}
              selected={editDraft.role_ids}
              onToggle={(id) =>
                setEditDraft((current) => (current ? { ...current, role_ids: toggle(id, current.role_ids) } : current))
              }
            />
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 px-3.5 py-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-teal-700"
                checked={editDraft.is_active}
                onChange={(event) =>
                  setEditDraft((current) => (current ? { ...current, is_active: event.target.checked } : current))
                }
              />
              <span>
                <span className="block text-sm font-semibold text-slate-900">This person can sign in</span>
                <span className="block text-sm text-slate-500">Untick to block their access without deleting them.</span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeEdit} className={btnSecondary}>
                Cancel
              </button>
              <button type="submit" disabled={isSaving} className={btnPrimary}>
                {isSaving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {removeTarget && (
        <ConfirmDialog
          title={`Remove ${removeTarget.full_name}?`}
          message="This deletes their staff record. If you only want to stop them signing in, use “Change access” and untick the sign-in box instead."
          confirmLabel="Remove person"
          busyLabel="Removing…"
          busy={isRemoving}
          onConfirm={() => void handleRemove()}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </Page>
  );
};