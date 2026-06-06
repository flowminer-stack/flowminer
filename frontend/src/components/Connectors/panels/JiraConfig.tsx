import { Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface JiraConfigProps {
  jiraInstanceUrl: string;
  setJiraInstanceUrl: (v: string) => void;
  jiraEmail: string;
  setJiraEmail: (v: string) => void;
  jiraApiToken: string;
  setJiraApiToken: (v: string) => void;
  jiraProjectKey: string;
  setJiraProjectKey: (v: string) => void;
  jiraMaxResults: number;
  setJiraMaxResults: (v: number) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function JiraConfig({
  jiraInstanceUrl,
  setJiraInstanceUrl,
  jiraEmail,
  setJiraEmail,
  jiraApiToken,
  setJiraApiToken,
  jiraProjectKey,
  setJiraProjectKey,
  jiraMaxResults,
  setJiraMaxResults,
  showPassword,
  onTogglePassword,
}: JiraConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">
        Jira Settings
      </h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Instance URL
        </label>
        <input
          type="url"
          value={jiraInstanceUrl}
          onChange={(e) => setJiraInstanceUrl(e.target.value)}
          placeholder="https://company.atlassian.net"
          className="input w-full"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Email
          </label>
          <input
            type="email"
            value={jiraEmail}
            onChange={(e) => setJiraEmail(e.target.value)}
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
              value={jiraApiToken}
              onChange={(e) => setJiraApiToken(e.target.value)}
              placeholder="Atlassian API token"
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
          Project Key
        </label>
        <input
          type="text"
          value={jiraProjectKey}
          onChange={(e) => setJiraProjectKey(e.target.value)}
          placeholder="PROJ"
          className="input w-full font-mono"
        />
      </div>
      <Disclosure label="Advanced settings" hint="result limit">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Max Results
          </label>
          <input
            type="number"
            value={jiraMaxResults}
            onChange={(e) => setJiraMaxResults(Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </Disclosure>
    </div>
  );
}
