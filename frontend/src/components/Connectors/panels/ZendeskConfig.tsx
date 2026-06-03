import { Eye, EyeOff } from 'lucide-react';

interface ZendeskConfigProps {
  zendeskSubdomain: string;
  setZendeskSubdomain: (v: string) => void;
  zendeskEmail: string;
  setZendeskEmail: (v: string) => void;
  zendeskApiToken: string;
  setZendeskApiToken: (v: string) => void;
  zendeskMaxTickets: number;
  setZendeskMaxTickets: (v: number) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function ZendeskConfig({
  zendeskSubdomain,
  setZendeskSubdomain,
  zendeskEmail,
  setZendeskEmail,
  zendeskApiToken,
  setZendeskApiToken,
  zendeskMaxTickets,
  setZendeskMaxTickets,
  showPassword,
  onTogglePassword,
}: ZendeskConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">
        Zendesk Settings
      </h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Subdomain
        </label>
        <div className="flex items-center gap-0">
          <input
            type="text"
            value={zendeskSubdomain}
            onChange={(e) => setZendeskSubdomain(e.target.value)}
            placeholder="company"
            className="input w-full rounded-r-none"
          />
          <span className="px-3 py-2 bg-tint border border-l-0 border-line rounded-r-lg text-[11px] text-fg-faint whitespace-nowrap">
            .zendesk.com
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Email
          </label>
          <input
            type="email"
            value={zendeskEmail}
            onChange={(e) => setZendeskEmail(e.target.value)}
            placeholder="you@company.com"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            API Token
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={zendeskApiToken}
              onChange={(e) => setZendeskApiToken(e.target.value)}
              placeholder="Zendesk API token"
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
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Max Tickets
        </label>
        <input
          type="number"
          value={zendeskMaxTickets}
          onChange={(e) => setZendeskMaxTickets(Number(e.target.value))}
          min={1}
          className="input w-full"
        />
      </div>
    </div>
  );
}
