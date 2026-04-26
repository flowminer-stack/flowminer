import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  Trash2,
  ShieldCheck,
  ArrowLeft,
} from 'lucide-react';
import clsx from 'clsx';
import { admin as adminApi } from '@/api/client';
import { useAuthStore, useUIStore } from '@/store';
import type { User } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';

const ROLES = ['admin', 'analyst', 'viewer'] as const;
type Role = (typeof ROLES)[number];

const roleColors: Record<Role, string> = {
  admin: 'bg-danger/10 text-danger border border-danger/20',
  analyst: 'bg-accent/10 text-accent border border-accent/20',
  viewer: 'bg-surface-3 text-fg-muted border border-line',
};

export default function UserManagementPage() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const addNotification = useUIStore((s) => s.addNotification);

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // Guard: redirect non-admins
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      navigate('/projects');
    }
  }, [currentUser, navigate]);

  useEffect(() => {
    setLoading(true);
    adminApi
      .listUsers()
      .then(setUsers)
      .catch(() =>
        addNotification({ type: 'error', title: 'Failed to load users' }),
      )
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRoleChange = async (userId: string, role: string) => {
    setUpdatingId(userId);
    try {
      const updated = await adminApi.updateRole(userId, role);
      setUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)));
      addNotification({ type: 'success', title: 'Role updated' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to update role' });
    } finally {
      setUpdatingId(null);
    }
  };

  const handleStatusToggle = async (user: User) => {
    setUpdatingId(user.id);
    try {
      const updated = await adminApi.updateStatus(user.id, !user.is_active);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
      addNotification({
        type: 'success',
        title: updated.is_active ? 'User activated' : 'User deactivated',
      });
    } catch {
      addNotification({ type: 'error', title: 'Failed to update status' });
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDelete = async (user: User) => {
    if (
      !window.confirm(
        `Are you sure you want to delete "${user.full_name}"? This cannot be undone.`,
      )
    )
      return;

    setUpdatingId(user.id);
    try {
      await adminApi.deleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      addNotification({ type: 'success', title: 'User deleted' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete user' });
    } finally {
      setUpdatingId(null);
    }
  };

  if (loading) {
    return <LoadingSpinner size="lg" text="Loading users..." fullPage />;
  }

  return (
    <div>
      <button
        onClick={() => navigate('/settings')}
        className="btn-ghost mb-4 -ml-3"
      >
        <ArrowLeft size={16} />
        Back to Settings
      </button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight text-fg">
            <Users size={20} />
            User Management
          </h1>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {users.length} user{users.length !== 1 ? 's' : ''} in this workspace
          </p>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-line">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line bg-surface-2">
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Name
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Email
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Role
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Status
              </th>
              <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {users.map((user) => {
              const isCurrentUser = user.id === currentUser?.id;
              const busy = updatingId === user.id;

              return (
                <tr
                  key={user.id}
                  className={clsx(
                    'transition-colors hover:bg-tint/50',
                    busy && 'opacity-60',
                  )}
                >
                  {/* Name */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-tint text-[10px] font-bold text-fg-secondary">
                        {user.full_name
                          .split(' ')
                          .map((n) => n[0])
                          .join('')
                          .toUpperCase()
                          .slice(0, 2)}
                      </div>
                      <div>
                        <p className="text-[12px] font-medium text-fg">
                          {user.full_name}
                          {isCurrentUser && (
                            <span className="ml-1.5 text-[10px] text-fg-faint">(you)</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </td>

                  {/* Email */}
                  <td className="px-4 py-3 text-[12px] text-fg-muted">
                    {user.email}
                  </td>

                  {/* Role */}
                  <td className="px-4 py-3">
                    <select
                      value={user.role}
                      onChange={(e) => handleRoleChange(user.id, e.target.value)}
                      disabled={busy || isCurrentUser}
                      className={clsx(
                        'rounded px-2 py-1 text-[11px] font-semibold outline-none transition-colors',
                        roleColors[user.role as Role] ?? roleColors.viewer,
                        'cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r.charAt(0).toUpperCase() + r.slice(1)}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleStatusToggle(user)}
                      disabled={busy || isCurrentUser}
                      className={clsx(
                        'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                        user.is_active
                          ? 'bg-success/10 text-success hover:bg-success/20'
                          : 'bg-surface-3 text-fg-faint hover:bg-tint',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      <span
                        className={clsx(
                          'h-1.5 w-1.5 rounded-full',
                          user.is_active ? 'bg-success' : 'bg-fg-faint',
                        )}
                      />
                      {user.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(user)}
                      disabled={busy || isCurrentUser}
                      title="Delete user"
                      className="rounded p-1.5 text-fg-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {users.length === 0 && (
          <div className="flex flex-col items-center py-12 text-center">
            <ShieldCheck size={24} className="text-fg-ghost" />
            <p className="mt-3 text-[13px] text-fg-muted">No users found.</p>
          </div>
        )}
      </div>
    </div>
  );
}
