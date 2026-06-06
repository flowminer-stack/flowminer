import { useState } from 'react';
import { Eye, EyeOff, Info, Link2 } from 'lucide-react';
import { ConnectorType } from './types';

interface DatabaseConfigProps {
  host: string;
  setHost: (v: string) => void;
  port: string;
  setPort: (v: string) => void;
  database: string;
  setDatabase: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  query: string;
  setQuery: (v: string) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
  getDefaultPort: (t: ConnectorType) => string;
  type: ConnectorType;
}

export function DatabaseConfig({
  host,
  setHost,
  port,
  setPort,
  database,
  setDatabase,
  username,
  setUsername,
  password,
  setPassword,
  query,
  setQuery,
  showPassword,
  onTogglePassword,
  getDefaultPort,
  type,
}: DatabaseConfigProps) {
  const [connString, setConnString] = useState('');

  // Paste a full connection URI and we split it into the individual fields, so
  // most users fill one box instead of five. Best-effort: anything we can't
  // parse yet is ignored until the string is complete.
  const applyConnectionString = (raw: string) => {
    setConnString(raw);
    const s = raw.trim();
    if (!s) return;
    try {
      const u = new URL(s);
      if (u.hostname) setHost(u.hostname);
      if (u.port) setPort(u.port);
      const db = u.pathname.replace(/^\//, '');
      if (db) setDatabase(decodeURIComponent(db));
      if (u.username) setUsername(decodeURIComponent(u.username));
      if (u.password) setPassword(decodeURIComponent(u.password));
    } catch {
      /* not a complete URI yet — leave the manual fields alone */
    }
  };

  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">
        Connection Settings
      </h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Connection string <span className="font-normal">(optional shortcut)</span>
        </label>
        <div className="relative">
          <Link2 className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <input
            type="text"
            value={connString}
            onChange={(e) => applyConnectionString(e.target.value)}
            placeholder="postgresql://user:pass@host:5432/dbname"
            className="input w-full pl-9 font-mono"
          />
        </div>
        <p className="mt-1 text-[11px] text-fg-faint flex items-center gap-1">
          <Info className="w-3 h-3" />
          Paste a full URI to auto-fill the fields below — or just enter them manually.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Host
          </label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="localhost"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Port
          </label>
          <input
            type="text"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder={getDefaultPort(type)}
            className="input w-full"
          />
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Database
        </label>
        <input
          type="text"
          value={database}
          onChange={(e) => setDatabase(e.target.value)}
          placeholder="my_database"
          className="input w-full"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="user"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Password
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              className="input w-full pr-10"
            />
            <button
              type="button"
              onClick={onTogglePassword}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted transition-colors"
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          SQL Query or Table Name
        </label>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
