import { Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface AribaConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function AribaConfig({ config, onChange, showPassword, onTogglePassword }: AribaConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">SAP Ariba Settings</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Base URL</label>
          <input
            type="url"
            value={config.base_url || ''}
            onChange={(e) => onChange('base_url', e.target.value)}
            placeholder="https://openapi.ariba.com"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Realm</label>
          <input
            type="text"
            value={config.realm || ''}
            onChange={(e) => onChange('realm', e.target.value)}
            placeholder="my-realm"
            className="input w-full font-mono"
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
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Application key</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={config.api_key || ''}
              onChange={(e) => onChange('api_key', e.target.value)}
              placeholder="apiKey"
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
          <label className="block text-[11px] font-medium text-fg-faint mb-1">View</label>
          <input
            type="text"
            value={config.view || ''}
            onChange={(e) => onChange('view', e.target.value)}
            placeholder="PurchaseOrderHeader"
            className="input w-full font-mono"
          />
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
