import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface ApiEndpointConfigProps {
  apiUrl: string;
  setApiUrl: (v: string) => void;
  apiMethod: string;
  setApiMethod: (v: string) => void;
  apiHeaders: string;
  setApiHeaders: (v: string) => void;
  apiBody: string;
  setApiBody: (v: string) => void;
  apiAuth: string;
  setApiAuth: (v: string) => void;
  apiToken: string;
  setApiToken: (v: string) => void;
  apiDataPath: string;
  setApiDataPath: (v: string) => void;
  apiPaginationType: string;
  setApiPaginationType: (v: string) => void;
  apiPageSize: number;
  setApiPageSize: (v: number) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function ApiEndpointConfig({
  apiUrl,
  setApiUrl,
  apiMethod,
  setApiMethod,
  apiHeaders,
  setApiHeaders,
  apiBody,
  setApiBody,
  apiAuth,
  setApiAuth,
  apiToken,
  setApiToken,
  apiDataPath,
  setApiDataPath,
  apiPaginationType,
  setApiPaginationType,
  apiPageSize,
  setApiPageSize,
  showPassword,
  onTogglePassword,
}: ApiEndpointConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">
        API Settings
      </h3>
      <div className="flex gap-3">
        <div className="w-28">
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Method
          </label>
          <div className="relative">
            <select
              value={apiMethod}
              onChange={(e) => setApiMethod(e.target.value)}
              className="select w-full"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
          </div>
        </div>
        <div className="flex-1">
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            URL <span className="text-danger">*</span>
          </label>
          <input
            type="url"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder="https://api.example.com/events"
            className="input w-full"
          />
        </div>
      </div>

      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Authentication
        </label>
        <div className="relative">
          <select
            value={apiAuth}
            onChange={(e) => setApiAuth(e.target.value)}
            className="select w-full"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer Token</option>
            <option value="api_key">API Key</option>
            <option value="basic">Basic Auth</option>
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
        </div>
      </div>
      {apiAuth !== 'none' && (
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Token / Credentials
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="Enter token..."
              className="input w-full pr-10"
            />
            <button
              type="button"
              onClick={onTogglePassword}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg-muted"
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      )}

      <Disclosure label="Advanced settings" hint="headers, response path, pagination">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Headers (JSON)
          </label>
          <textarea
            value={apiHeaders}
            onChange={(e) => setApiHeaders(e.target.value)}
            placeholder='{"Content-Type": "application/json"}'
            rows={2}
            className="input w-full font-mono resize-none"
          />
        </div>
        {apiMethod === 'POST' && (
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">
              Body (JSON)
            </label>
            <textarea
              value={apiBody}
              onChange={(e) => setApiBody(e.target.value)}
              placeholder='{"filter": {}}'
              rows={2}
              className="input w-full font-mono resize-none"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">
              Data Path
            </label>
            <input
              type="text"
              value={apiDataPath}
              onChange={(e) => setApiDataPath(e.target.value)}
              placeholder="data.items"
              className="input w-full font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-fg-faint mb-1">
              Pagination Type
            </label>
            <div className="relative">
              <select
                value={apiPaginationType}
                onChange={(e) => setApiPaginationType(e.target.value)}
                className="select w-full"
              >
                <option value="none">None</option>
                <option value="offset">Offset</option>
                <option value="page">Page</option>
                <option value="cursor">Cursor</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
            </div>
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Page Size
          </label>
          <input
            type="number"
            value={apiPageSize}
            onChange={(e) => setApiPageSize(Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </Disclosure>
    </div>
  );
}
