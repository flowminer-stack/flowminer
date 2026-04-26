import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  User,
  Mail,
  Shield,
  Key,
  Eye,
  EyeOff,
  Save,
  Users,
  ChevronRight,
  Settings,
  Sparkles,
  CheckCircle2,
  XCircle,
  Info,
} from 'lucide-react';
import clsx from 'clsx';
import api, { systemSettings } from '@/api/client';
import type { LLMConfigResponse } from '@/api/client';
import PageHeader from '@/components/common/PageHeader';
import type { User as UserType } from '@/types';
import { useAuthStore, useUIStore } from '@/store';

type Tab = 'profile' | 'security' | 'ai';

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const demoMode = useAuthStore((s) => s.demoMode);
  const addNotification = useUIStore((s) => s.addNotification);

  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── AI (LLM) settings state ──────────────────────────────────────
  const [llmConfig, setLLMConfig] = useState<LLMConfigResponse | null>(null);
  const [llmLoading, setLLMLoading] = useState(false);
  const [llmProvider, setLLMProvider] = useState<string>('null');
  const [llmModel, setLLMModel] = useState<string>('');
  const [llmApiKey, setLLMApiKey] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState(false);

  const canEditLLM = user?.role === 'admin';

  // Fetch the current LLM config when the AI tab opens — admins only.
  useEffect(() => {
    if (activeTab !== 'ai' || !canEditLLM) return;
    let cancelled = false;
    setLLMLoading(true);
    systemSettings
      .getLLMConfig()
      .then((cfg) => {
        if (cancelled) return;
        setLLMConfig(cfg);
        setLLMProvider(cfg.provider);
        setLLMModel(cfg.model);
        // Never prefill the api key field — the backend doesn't
        // return it and we want the user to explicitly re-enter it
        // if they want to rotate it.
        setLLMApiKey('');
      })
      .catch(() => {
        if (!cancelled) setLLMConfig(null);
      })
      .finally(() => {
        if (!cancelled) setLLMLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, canEditLLM]);

  const handleSaveLLMConfig = async () => {
    if (!canEditLLM) return;
    setSaving(true);
    try {
      // Only send fields that actually changed. Sending an empty
      // string for api_key CLEARS the stored key; we only want to
      // do that when the user explicitly asked to.
      const body: {
        provider?: string;
        model?: string;
        api_key?: string;
      } = {};
      if (llmConfig && llmProvider !== llmConfig.provider) {
        body.provider = llmProvider;
      }
      if (llmConfig && llmModel !== llmConfig.model) {
        body.model = llmModel;
      }
      if (llmApiKey.trim()) {
        body.api_key = llmApiKey.trim();
      }
      if (Object.keys(body).length === 0) {
        addNotification({
          type: 'info',
          title: 'No changes',
          message: 'Nothing to save.',
        });
        return;
      }
      const next = await systemSettings.updateLLMConfig(body);
      setLLMConfig(next);
      setLLMProvider(next.provider);
      setLLMModel(next.model);
      setLLMApiKey('');
      addNotification({
        type: 'success',
        title: 'AI settings saved',
        message: next.is_configured
          ? `Using ${next.provider} (${next.model})`
          : 'Settings saved, but no API key is configured yet.',
      });
    } catch (error) {
      let message = 'Failed to save AI settings.';
      if (axios.isAxiosError(error) && error.response?.data?.detail) {
        message = error.response.data.detail;
      }
      addNotification({ type: 'error', title: 'Save failed', message });
    } finally {
      setSaving(false);
    }
  };

  const handleClearApiKey = async () => {
    if (!canEditLLM) return;
    if (!confirm('Clear the stored API key? The backend will fall back to environment variables.')) {
      return;
    }
    setSaving(true);
    try {
      const next = await systemSettings.updateLLMConfig({ api_key: '' });
      setLLMConfig(next);
      setLLMApiKey('');
      addNotification({
        type: 'success',
        title: 'API key cleared',
        message: 'Server will now use the environment variable if set.',
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Clear failed',
        message: 'Could not clear the stored API key.',
      });
    } finally {
      setSaving(false);
    }
  };

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

  const baseTabs = [
    { id: 'profile' as const, label: 'Profile', icon: User },
    { id: 'security' as const, label: 'Security', icon: Shield },
  ];
  const tabs = canEditLLM
    ? [...baseTabs, { id: 'ai' as const, label: 'AI', icon: Sparkles }]
    : baseTabs;

  if (demoMode) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader
          title="Settings"
          icon={Settings}
          description="Settings are read-only in the demo"
        />
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface-2 p-10 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Settings size={20} />
          </div>
          <p className="mt-3 text-[13px] font-semibold text-fg">
            Settings are disabled in the public demo
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">
            Every visitor shares the same demo account, so profile, password,
            and AI-provider changes are locked. To configure your own instance,
            self-host FlowMiner and make yourself an admin on boot.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => navigate('/projects')}
              className="btn-primary"
            >
              Browse demo logs
            </button>
            <a
              href="https://demo.flowminer.io"
              className="btn-secondary"
              target="_blank"
              rel="noreferrer"
            >
              About this demo
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Settings"
        icon={Settings}
        description="Manage your account and preferences"
      />

      {/* Tabs */}
      <div className="mt-6 flex gap-1 border-b border-line">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              'flex items-center gap-2 border-b-2 px-4 py-2.5 text-[12px] font-medium transition-colors',
              activeTab === tab.id
                ? 'border-accent text-accent'
                : 'border-transparent text-fg-muted hover:border-line-strong hover:text-fg-secondary',
            )}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {activeTab === 'profile' && (
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
      )}

      {/* Security tab */}
      {activeTab === 'security' && (
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
      )}

      {/* AI / LLM provider tab (admin-only) */}
      {activeTab === 'ai' && canEditLLM && (
        <div className="mt-6">
          <div className="card p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[14px] font-semibold text-fg">
                  AI provider
                </h2>
                <p className="mt-1 text-[12px] text-fg-muted">
                  Configure the large-language-model provider that powers Ask AI,
                  narration, and the other AI features. Keys are encrypted at rest
                  and never returned by the API.
                </p>
              </div>
              {llmConfig && (
                <div
                  className={clsx(
                    'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                    llmConfig.is_configured
                      ? 'border-success/30 bg-success/10 text-success'
                      : 'border-warning/30 bg-warning/10 text-warning',
                  )}
                >
                  {llmConfig.is_configured ? (
                    <>
                      <CheckCircle2 size={12} /> Configured
                    </>
                  ) : (
                    <>
                      <XCircle size={12} /> Not configured
                    </>
                  )}
                </div>
              )}
            </div>

            {llmLoading && !llmConfig && (
              <div className="mt-6 flex items-center gap-2 text-[12px] text-fg-muted">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
                Loading current config…
              </div>
            )}

            {llmConfig && (
              <div className="mt-6 space-y-5">
                {/* Provider select */}
                <div>
                  <label className="block text-[12px] font-medium text-fg-muted">
                    Provider
                  </label>
                  <div className="relative mt-1.5">
                    <Sparkles
                      size={16}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
                    />
                    <select
                      value={llmProvider}
                      onChange={(e) => setLLMProvider(e.target.value)}
                      className="input pl-9"
                    >
                      <option value="null">Null (disabled — template responses)</option>
                      <option value="openrouter">OpenRouter (many models, one key)</option>
                      <option value="anthropic">Anthropic (Claude)</option>
                      <option value="openai">OpenAI (GPT)</option>
                      <option value="ollama">Ollama (local, no key needed)</option>
                    </select>
                  </div>
                  <p className="mt-1 text-[11px] text-fg-faint">
                    Source:{' '}
                    <span className="font-mono">{llmConfig.provider_source}</span>
                    {' — '}
                    {llmConfig.provider_source === 'db'
                      ? 'set from this UI'
                      : llmConfig.provider_source === 'env'
                        ? 'inherited from FLOWMINER_LLM_PROVIDER env var'
                        : 'unset'}
                  </p>
                </div>

                {/* Model */}
                <div>
                  <label className="block text-[12px] font-medium text-fg-muted">
                    Model
                  </label>
                  <input
                    type="text"
                    value={llmModel}
                    onChange={(e) => setLLMModel(e.target.value)}
                    placeholder={
                      llmProvider === 'openrouter'
                        ? 'e.g. anthropic/claude-haiku-4-5'
                        : llmProvider === 'anthropic'
                          ? 'e.g. claude-sonnet-4-6'
                          : llmProvider === 'openai'
                            ? 'e.g. gpt-4o-mini'
                            : 'e.g. llama3.1'
                    }
                    className="input mt-1.5"
                  />
                  <p className="mt-1 text-[11px] text-fg-faint">
                    Source: <span className="font-mono">{llmConfig.model_source}</span>
                  </p>
                </div>

                {/* API key */}
                {llmProvider !== 'null' && llmProvider !== 'ollama' && (
                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted">
                      API key
                    </label>
                    <div className="relative mt-1.5">
                      <Key
                        size={16}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
                      />
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={llmApiKey}
                        onChange={(e) => setLLMApiKey(e.target.value)}
                        placeholder={
                          llmConfig.has_api_key
                            ? `Leave blank to keep current key (${llmConfig.api_key_preview ?? '…'})`
                            : 'Paste your API key'
                        }
                        className="input pl-9 pr-10 font-mono"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
                        aria-label={showApiKey ? 'Hide key' : 'Show key'}
                      >
                        {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-fg-faint">
                      <Info size={10} />
                      Keys are encrypted at rest with the server-side encryption key. Source:{' '}
                      <span className="font-mono">{llmConfig.api_key_source}</span>
                    </p>
                    {llmConfig.has_api_key && llmConfig.api_key_source === 'db' && (
                      <button
                        type="button"
                        onClick={handleClearApiKey}
                        className="mt-2 text-[11px] text-danger hover:underline"
                      >
                        Clear stored key
                      </button>
                    )}
                  </div>
                )}

                {llmProvider === 'ollama' && (
                  <div className="rounded-lg border border-line bg-surface-1 px-3 py-2 text-[11px] text-fg-muted">
                    Ollama runs locally and does not need an API key. Make sure
                    ``OLLAMA_HOST`` points at a reachable Ollama instance from
                    the backend container.
                  </div>
                )}

                {llmProvider === 'null' && (
                  <div className="rounded-lg border border-line bg-surface-1 px-3 py-2 text-[11px] text-fg-muted">
                    Null provider returns templated responses so the UI works
                    without real LLM credentials. Great for demos and CI.
                  </div>
                )}

                <div className="flex justify-end pt-2">
                  <button
                    onClick={handleSaveLLMConfig}
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
                        Save AI settings
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
