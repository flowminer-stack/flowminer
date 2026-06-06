import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { Disclosure } from './Disclosure';

interface GithubConfigProps {
  githubToken: string;
  setGithubToken: (v: string) => void;
  githubOwner: string;
  setGithubOwner: (v: string) => void;
  githubRepo: string;
  setGithubRepo: (v: string) => void;
  githubEventType: string;
  setGithubEventType: (v: string) => void;
  githubMaxItems: number;
  setGithubMaxItems: (v: number) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export function GithubConfig({
  githubToken,
  setGithubToken,
  githubOwner,
  setGithubOwner,
  githubRepo,
  setGithubRepo,
  githubEventType,
  setGithubEventType,
  githubMaxItems,
  setGithubMaxItems,
  showPassword,
  onTogglePassword,
}: GithubConfigProps) {
  return (
    <div className="space-y-4 p-4 bg-surface-1 rounded-xl border border-line">
      <h3 className="text-sm font-semibold text-fg-secondary">
        GitHub Settings
      </h3>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Personal Access Token
        </label>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
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
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Owner
          </label>
          <input
            type="text"
            value={githubOwner}
            onChange={(e) => setGithubOwner(e.target.value)}
            placeholder="orgname"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Repository
          </label>
          <input
            type="text"
            value={githubRepo}
            onChange={(e) => setGithubRepo(e.target.value)}
            placeholder="reponame"
            className="input w-full"
          />
        </div>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-fg-faint mb-1">
          Event Type
        </label>
        <div className="relative">
          <select
            value={githubEventType}
            onChange={(e) => setGithubEventType(e.target.value)}
            className="select w-full"
          >
            <option value="pull_requests">Pull Requests</option>
            <option value="issues">Issues</option>
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
        </div>
      </div>
      <Disclosure label="Advanced settings" hint="item limit">
        <div>
          <label className="block text-[11px] font-medium text-fg-faint mb-1">
            Max Items
          </label>
          <input
            type="number"
            value={githubMaxItems}
            onChange={(e) => setGithubMaxItems(Number(e.target.value))}
            min={1}
            className="input w-full"
          />
        </div>
      </Disclosure>
    </div>
  );
}
