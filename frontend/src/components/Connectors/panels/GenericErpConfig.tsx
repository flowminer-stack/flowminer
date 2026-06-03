import { Eye, EyeOff } from 'lucide-react';
import { types, ConnectorType } from './types';

interface GenericErpConfigProps {
  type: ConnectorType;
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function GenericErpConfig({
  type,
  config,
  onChange,
  showPassword,
  onTogglePassword,
}: GenericErpConfigProps) {
  const label = types.find((t) => t.value === type)?.label ?? type;
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">{label} Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Base URL</label>
        <input
          type="url"
          value={config.base_url || ''}
          onChange={(e) => onChange('base_url', e.target.value)}
          placeholder="https://api.example.com"
          className="input w-full"
        />
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
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Entity / Table</label>
          <input
            type="text"
            value={config.entity || ''}
            onChange={(e) => onChange('entity', e.target.value)}
            placeholder="WorkerHistory"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Max Records</label>
          <input
            type="number"
            value={config.max_records ?? 10000}
            onChange={(e) => onChange('max_records', Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </div>
    </div>
  );
}
