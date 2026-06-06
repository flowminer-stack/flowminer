import { Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface CoupaConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

const RESOURCES = ['purchase_orders', 'requisitions', 'invoices', 'approvals'];

export function CoupaConfig({ config, onChange, showPassword, onTogglePassword }: CoupaConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">Coupa Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Instance URL</label>
        <input
          type="url"
          value={config.instance_url || ''}
          onChange={(e) => onChange('instance_url', e.target.value)}
          placeholder="https://your-company.coupahost.com"
          className="input w-full"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">API key</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={config.api_key || ''}
              onChange={(e) => onChange('api_key', e.target.value)}
              placeholder="X-COUPA-API-KEY"
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
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Resource</label>
          <select
            value={config.resource || 'purchase_orders'}
            onChange={(e) => onChange('resource', e.target.value)}
            className="input w-full"
          >
            {RESOURCES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
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
