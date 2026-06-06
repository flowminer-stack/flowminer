import { Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface OracleFusionConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function OracleFusionConfig({
  config,
  onChange,
  showPassword,
  onTogglePassword,
}: OracleFusionConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">Oracle Fusion Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Base URL</label>
        <input
          type="url"
          value={config.base_url || ''}
          onChange={(e) => onChange('base_url', e.target.value)}
          placeholder="https://abc-prod.oraclecloud.com"
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
            placeholder="fusion.user"
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
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Resource</label>
        <input
          type="text"
          value={config.resource || ''}
          onChange={(e) => onChange('resource', e.target.value)}
          placeholder="purchaseOrders"
          className="input w-full font-mono"
        />
      </div>
      <Disclosure label="Advanced settings" hint="filter & row limit">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">oData-style filter</label>
          <input
            type="text"
            value={config.query || ''}
            onChange={(e) => onChange('query', e.target.value)}
            placeholder="Status = 'OPEN'"
            className="input w-full font-mono"
          />
        </div>
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
