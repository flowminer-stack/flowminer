import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User,
  Shield,
  Settings,
  Sparkles,
  Activity,
} from 'lucide-react';
import clsx from 'clsx';
import PageHeader from '@/components/common/PageHeader';
import { useAuthStore } from '@/store';
import ProfileTab from '@/components/Settings/ProfileTab';
import SecurityTab from '@/components/Settings/SecurityTab';
import AISettingsTab from '@/components/Settings/AISettingsTab';
import HealthTab from '@/components/Settings/HealthTab';

type Tab = 'profile' | 'security' | 'ai' | 'health';

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const demoMode = useAuthStore((s) => s.demoMode);

  const [activeTab, setActiveTab] = useState<Tab>('profile');

  const canEditLLM = user?.role === 'admin';

  const baseTabs = [
    { id: 'profile' as const, label: 'Profile', icon: User },
    { id: 'security' as const, label: 'Security', icon: Shield },
  ];
  const adminTabs = [
    { id: 'ai' as const, label: 'AI', icon: Sparkles },
    { id: 'health' as const, label: 'Health', icon: Activity },
  ];
  const tabs = canEditLLM ? [...baseTabs, ...adminTabs] : baseTabs;

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
      {activeTab === 'profile' && <ProfileTab />}

      {/* Security tab */}
      {activeTab === 'security' && <SecurityTab />}

      {/* AI / LLM provider tab (admin-only) */}
      {activeTab === 'ai' && canEditLLM && <AISettingsTab />}

      {/* System health tab (admin-only) */}
      {activeTab === 'health' && <HealthTab />}
    </div>
  );
}
