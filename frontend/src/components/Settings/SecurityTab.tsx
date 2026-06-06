import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  Shield,
  Key,
  Eye,
  EyeOff,
  Users,
  ChevronRight,
  ScrollText,
  BarChart2,
} from 'lucide-react';
import api from '@/api/client';
import { useAuthStore, useUIStore } from '@/store';

export default function SecurityTab() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const addNotification = useUIStore((s) => s.addNotification);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleChangePassword = async () => {
    if (!currentPassword) {
      addNotification({
        type: 'error',
        title: 'Validation error',
        message: 'Current password is required.',
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      addNotification({
        type: 'error',
        title: 'Passwords do not match',
      });
      return;
    }
    if (newPassword.length < 10) {
      addNotification({
        type: 'error',
        title: 'Password too short',
        message: 'Password must be at least 10 characters.',
      });
      return;
    }
    if (currentPassword === newPassword) {
      addNotification({
        type: 'error',
        title: 'Same password',
        message: 'New password must be different from the current password.',
      });
      return;
    }

    setSaving(true);
    try {
      await api.post('/users/me/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      addNotification({
        type: 'success',
        title: 'Password changed',
        message: 'Your password has been updated.',
      });
    } catch (error) {
      let message = 'Failed to update password.';
      if (axios.isAxiosError(error)) {
        const detail = error.response?.data?.detail;
        if (typeof detail === 'string') message = detail;
      }
      addNotification({
        type: 'error',
        title: 'Password change failed',
        message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="card p-6">
        <h2 className="text-[14px] font-semibold text-fg">
          Change Password
        </h2>
        <p className="mt-1 text-[12px] text-fg-muted">
          Update your password to keep your account secure.
        </p>

        <div className="mt-6 space-y-5">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Current password
            </label>
            <div className="relative mt-1.5">
              <Key
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
              />
              <input
                type={showCurrentPassword ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                className="input pl-9 pr-10"
              />
              <button
                type="button"
                onClick={() =>
                  setShowCurrentPassword(!showCurrentPassword)
                }
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
              >
                {showCurrentPassword ? (
                  <EyeOff size={16} />
                ) : (
                  <Eye size={16} />
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              New password
            </label>
            <div className="relative mt-1.5">
              <Key
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
              />
              <input
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 10 characters"
                className="input pl-9 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(!showNewPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
              >
                {showNewPassword ? (
                  <EyeOff size={16} />
                ) : (
                  <Eye size={16} />
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Confirm new password
            </label>
            <div className="relative mt-1.5">
              <Key
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
              />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
                className="input pl-9"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={handleChangePassword}
              disabled={
                saving ||
                !currentPassword ||
                !newPassword ||
                !confirmPassword
              }
              className="btn-primary"
            >
              {saving ? (
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Updating...
                </div>
              ) : (
                <>
                  <Shield size={16} />
                  Change Password
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Admin section */}
      {user?.role === 'admin' && (
        <div className="card mt-6 p-6">
          <h2 className="text-[14px] font-semibold text-fg">
            Administration
          </h2>
          <p className="mt-1 text-[12px] text-fg-muted">
            Admin-only tools for managing this workspace.
          </p>
          <button
            onClick={() => navigate('/admin/users')}
            className="mt-4 flex w-full items-center justify-between rounded-lg border border-line bg-surface-1 px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-tint"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10">
                <Users size={15} className="text-accent" />
              </div>
              <div>
                <p className="text-[12px] font-semibold text-fg">User Management</p>
                <p className="text-[11px] text-fg-muted">
                  Manage users, roles, and access
                </p>
              </div>
            </div>
            <ChevronRight size={14} className="text-fg-faint" />
          </button>
          <button
            onClick={() => navigate('/admin/audit')}
            className="mt-2 flex w-full items-center justify-between rounded-lg border border-line bg-surface-1 px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-tint"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10">
                <ScrollText size={15} className="text-accent" />
              </div>
              <div>
                <p className="text-[12px] font-semibold text-fg">Audit Log</p>
                <p className="text-[11px] text-fg-muted">
                  Review admin actions and access history
                </p>
              </div>
            </div>
            <ChevronRight size={14} className="text-fg-faint" />
          </button>
          <button
            onClick={() => navigate('/admin/usage')}
            className="mt-2 flex w-full items-center justify-between rounded-lg border border-line bg-surface-1 px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-tint"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10">
                <BarChart2 size={15} className="text-accent" />
              </div>
              <div>
                <p className="text-[12px] font-semibold text-fg">Usage Metering</p>
                <p className="text-[11px] text-fg-muted">
                  LLM tokens, connector syncs, and mining consumption
                </p>
              </div>
            </div>
            <ChevronRight size={14} className="text-fg-faint" />
          </button>
        </div>
      )}

      {/* Account info */}
      <div className="card mt-6 p-6" id="account-info">
        <h2 className="text-[14px] font-semibold text-fg">
          Account Information
        </h2>
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between py-2">
            <span className="text-[12px] text-fg-muted">Account ID</span>
            <span className="font-mono text-[12px] text-fg-secondary">
              {user?.id ?? '--'}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-line py-2">
            <span className="text-[12px] text-fg-muted">Role</span>
            <span className="badge badge-accent">
              {user?.role
                ? user.role.charAt(0).toUpperCase() + user.role.slice(1)
                : '--'}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-line py-2">
            <span className="text-[12px] text-fg-muted">Status</span>
            <span className="badge badge-emerald">
              {user?.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-line py-2">
            <span className="text-[12px] text-fg-muted">
              Member since
            </span>
            <span className="text-[12px] text-fg-secondary">
              {user?.created_at
                ? new Date(user.created_at).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })
                : '--'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
