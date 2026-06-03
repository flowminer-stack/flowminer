import { Eye, EyeOff, Info } from 'lucide-react';

interface SapConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function SapConfig({ config, onChange, showPassword, onTogglePassword }: SapConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">SAP Settings</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Host</label>
          <input
            type="text"
            value={config.host || ''}
            onChange={(e) => onChange('host', e.target.value)}
            placeholder="sap-server.company.com"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">System Number</label>
          <input
            type="text"
            value={config.system_number || ''}
            onChange={(e) => onChange('system_number', e.target.value)}
            placeholder="00"
            className="input w-full font-mono"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Client</label>
          <input
            type="text"
            value={config.client || ''}
            onChange={(e) => onChange('client', e.target.value)}
            placeholder="100"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Username</label>
          <input
            type="text"
            value={config.username || ''}
            onChange={(e) => onChange('username', e.target.value)}
            placeholder="RFCUSER"
            className="input w-full"
          />
        </div>
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
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted transition-colors"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Table / RFC Function</label>
        <input
          type="text"
          value={config.table || ''}
          onChange={(e) => onChange('table', e.target.value)}
          placeholder="CDHDR or Z_GET_EVENTS"
          className="input w-full font-mono"
        />
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          Specify a table name (CDHDR, CDPOS) or a custom RFC function module
        </p>
      </div>
    </div>
  );
}
