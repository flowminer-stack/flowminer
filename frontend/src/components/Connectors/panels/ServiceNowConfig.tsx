import { Eye, EyeOff } from 'lucide-react';

interface ServiceNowConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function ServiceNowConfig({ config, onChange, showPassword, onTogglePassword }: ServiceNowConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">ServiceNow Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Instance URL</label>
        <input
          type="url"
          value={config.instance_url || ''}
          onChange={(e) => onChange('instance_url', e.target.value)}
          placeholder="https://company.service-now.com"
          className="input w-full"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Username</label>
          <input
            type="text"
            value={config.username || ''}
            onChange={(e) => onChange('username', e.target.value)}
            placeholder="admin"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Password</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={config.password || ''}
              onChange={(e) => onChange('password', e.target.value)}
              placeholder="password"
              className="input w-full pr-10"
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
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Table</label>
          <input
            type="text"
            value={config.table || ''}
            onChange={(e) => onChange('table', e.target.value)}
            placeholder="incident"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Max Records</label>
          <input
            type="number"
            value={config.max_records ?? 5000}
            onChange={(e) => onChange('max_records', Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </div>
    </div>
  );
}
