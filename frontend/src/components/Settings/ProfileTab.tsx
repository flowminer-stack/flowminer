import { useState } from 'react';
import axios from 'axios';
import { User, Mail, Save } from 'lucide-react';
import api from '@/api/client';
import type { User as UserType } from '@/types';
import { useAuthStore, useUIStore } from '@/store';

export default function ProfileTab() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const addNotification = useUIStore((s) => s.addNotification);

  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [saving, setSaving] = useState(false);

  const initials = user?.full_name
    ? user.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '??';

  const handleSaveProfile = async () => {
    if (!fullName.trim()) {
      addNotification({
        type: 'error',
        title: 'Validation error',
        message: 'Full name cannot be empty.',
      });
      return;
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      addNotification({
        type: 'error',
        title: 'Validation error',
        message: 'Please enter a valid email address.',
      });
      return;
    }

    setSaving(true);
    try {
      const body: { full_name?: string; email?: string } = {};
      if (fullName !== user?.full_name) body.full_name = fullName;
      if (email !== user?.email) body.email = email;

      if (Object.keys(body).length === 0) {
        addNotification({
          type: 'info',
          title: 'No changes',
          message: 'Your profile is already up to date.',
        });
        return;
      }

      const response = await api.patch<UserType>('/users/me', body);
      setUser(response.data);
      addNotification({
        type: 'success',
        title: 'Profile updated',
        message: 'Your profile has been saved.',
      });
    } catch (error) {
      let message = 'Failed to update profile.';
      if (axios.isAxiosError(error)) {
        const detail = error.response?.data?.detail;
        if (typeof detail === 'string') message = detail;
      }
      addNotification({
        type: 'error',
        title: 'Update failed',
        message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="card p-6">
        {/* Avatar */}
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-tint text-xl font-bold text-fg-secondary">
            {initials}
          </div>
          <div>
            <p className="text-[14px] font-semibold text-fg">
              {user?.full_name}
            </p>
            <p className="text-[12px] text-fg-muted">{user?.email}</p>
            <span className="badge badge-accent mt-1">
              {user?.role
                ? user.role.charAt(0).toUpperCase() + user.role.slice(1)
                : 'User'}
            </span>
          </div>
        </div>

        <div className="mt-8 space-y-5">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Full name
            </label>
            <div className="relative mt-1.5">
              <User
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
              />
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="input pl-9"
              />
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Email address
            </label>
            <div className="relative mt-1.5">
              <Mail
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input pl-9"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={handleSaveProfile}
              disabled={saving}
              className="btn-primary"
            >
              {saving ? (
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Saving...
                </div>
              ) : (
                <>
                  <Save size={16} />
                  Save Changes
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
