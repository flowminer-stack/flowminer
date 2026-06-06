import { Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface WorkdayConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function WorkdayConfig({ config, onChange, showPassword, onTogglePassword }: WorkdayConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">Workday Settings</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Tenant</label>
          <input
            type="text"
            value={config.tenant || ''}
            onChange={(e) => onChange('tenant', e.target.value)}
            placeholder="acme_impl"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Base URL</label>
          <input
            type="url"
            value={config.base_url || ''}
            onChange={(e) => onChange('base_url', e.target.value)}
            placeholder="https://wd1-impl-services1.workday.com"
            className="input w-full"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Client ID</label>
          <input
            type="text"
            value={config.client_id || ''}
            onChange={(e) => onChange('client_id', e.target.value)}
            placeholder="client_id"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Client Secret</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={config.client_secret || ''}
              onChange={(e) => onChange('client_secret', e.target.value)}
              placeholder="client_secret"
              className="input w-full pr-10 font-mono"
            />
            <button
              type="button"
              onClick={onTogglePassword}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">REST endpoint</label>
        <input
          type="text"
          value={config.endpoint || ''}
          onChange={(e) => onChange('endpoint', e.target.value)}
          placeholder="common/v1/workers"
          className="input w-full font-mono"
        />
      </div>
      <Disclosure label="Advanced settings" hint="row limit">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Max rows</label>
          <input
            type="number"
            value={config.limit ?? 10000}
            onChange={(e) => onChange('limit', Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </Disclosure>
    </div>
  );
}
