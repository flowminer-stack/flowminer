import { Eye, EyeOff, Info } from 'lucide-react';

interface SnowflakeConfigProps {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function SnowflakeConfig({ config, onChange, showPassword, onTogglePassword }: SnowflakeConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">Snowflake Settings</h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">Account</label>
        <input
          type="text"
          value={config.account || ''}
          onChange={(e) => onChange('account', e.target.value)}
          placeholder="company.us-east-1"
          className="input w-full font-mono"
        />
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          The account identifier from your Snowflake URL
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Username</label>
          <input
            type="text"
            value={config.username || ''}
            onChange={(e) => onChange('username', e.target.value)}
            placeholder="SVCUSER"
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
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Warehouse</label>
          <input
            type="text"
            value={config.warehouse || ''}
            onChange={(e) => onChange('warehouse', e.target.value)}
            placeholder="COMPUTE_WH"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Database</label>
          <input
            type="text"
            value={config.database || ''}
            onChange={(e) => onChange('database', e.target.value)}
            placeholder="EVENTS_DB"
            className="input w-full font-mono"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">Schema</label>
          <input
            type="text"
            value={config.schema || ''}
            onChange={(e) => onChange('schema', e.target.value)}
            placeholder="PUBLIC"
            className="input w-full font-mono"
          />
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">SQL Query or Table</label>
        <textarea
          value={config.query || ''}
          onChange={(e) => onChange('query', e.target.value)}
          placeholder="SELECT * FROM event_log WHERE created_at > '{{last_sync}}'"
          rows={3}
          className="input w-full font-mono resize-none"
        />
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          Use {'{{last_sync}}'} as a placeholder for incremental fetching
        </p>
      </div>
    </div>
  );
}
