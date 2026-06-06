import { useEffect, useState } from 'react';
import {
  BarChart2,
  Key,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import api from '@/api/http';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { useUIStore } from '@/store';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface NewKeyResult {
  id: string;
  name: string;
  key: string;
  key_prefix: string;
  created_at: string;
  notice: string;
}

// ─── BI table schema summary ──────────────────────────────────────────────────

const BI_TABLES = [
  { name: 'statistics', desc: '1-row KPI headline (totals, durations)' },
  { name: 'variants', desc: 'Process variants ranked by frequency' },
  { name: 'bottlenecks', desc: 'Activities ranked by wait / duration' },
  { name: 'activities', desc: 'Occurrence count per distinct activity' },
  { name: 'cases', desc: 'One row per case with start/end/duration' },
  { name: 'events', desc: 'Flat event stream, one row per event' },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available in some contexts
    }
  };

  return (
    <button
      onClick={handleCopy}
      title={`Copy ${label ?? 'value'}`}
      className="ml-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-tint hover:text-fg"
    >
      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-1 px-4 py-3 text-[11px] leading-relaxed text-fg-secondary">
      <code>{children}</code>
    </pre>
  );
}

function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-line">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-6 py-4 text-left transition-colors hover:bg-tint"
      >
        <span className="text-[13px] font-semibold text-fg">{title}</span>
        {open ? (
          <ChevronDown size={15} className="text-fg-muted" />
        ) : (
          <ChevronRight size={15} className="text-fg-muted" />
        )}
      </button>
      {open && <div className="px-6 pb-5">{children}</div>}
    </div>
  );
}

// ─── API key sub-panel ────────────────────────────────────────────────────────

function ApiKeysPanel() {
  const addNotification = useUIStore((s) => s.addNotification);

  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [revealedKey, setRevealedKey] = useState<NewKeyResult | null>(null);

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    setLoading(true);
    try {
      const r = await api.get<ApiKeyRecord[]>('/api-keys');
      setKeys(r.data.filter((k) => !k.revoked_at));
    } catch {
      addNotification({ type: 'error', title: 'Could not load API keys' });
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    const name = newKeyName.trim();
    if (!name) {
      addNotification({ type: 'error', title: 'Enter a name for the key' });
      return;
    }
    setCreating(true);
    try {
      const r = await api.post<NewKeyResult>('/api-keys', { name });
      setRevealedKey(r.data);
      setNewKeyName('');
      await fetchKeys();
    } catch {
      addNotification({ type: 'error', title: 'Failed to create API key' });
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!window.confirm(`Revoke key "${name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/api-keys/${id}`);
      setKeys((prev) => prev.filter((k) => k.id !== id));
      if (revealedKey?.id === id) setRevealedKey(null);
      addNotification({ type: 'success', title: 'API key revoked' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to revoke key' });
    }
  };

  if (loading) {
    return <LoadingSpinner size="sm" text="Loading keys…" />;
  }

  return (
    <div className="space-y-4">
      {/* Revealed key — shown once on create */}
      {revealedKey && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-fg">
                Save this key now — it will never be shown again
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-surface-1 px-3 py-1.5 font-mono text-[12px] text-fg-secondary">
                  {revealedKey.key}
                </code>
                <CopyButton value={revealedKey.key} label="key" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Existing keys */}
      {keys.length > 0 && (
        <div className="divide-y divide-line rounded-lg border border-line">
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <div>
                <p className="text-[12px] font-semibold text-fg">{k.name}</p>
                <p className="mt-0.5 font-mono text-[11px] text-fg-faint">
                  {k.key_prefix}••••••••
                </p>
              </div>
              <div className="flex items-center gap-3">
                {k.last_used_at ? (
                  <span className="text-[11px] text-fg-faint">
                    Used{' '}
                    {new Date(k.last_used_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                ) : (
                  <span className="text-[11px] text-fg-faint">Never used</span>
                )}
                <button
                  onClick={() => handleRevoke(k.id, k.name)}
                  className="btn-ghost p-1.5 text-danger hover:bg-danger/10 hover:text-danger"
                  title="Revoke key"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {keys.length === 0 && !revealedKey && (
        <p className="text-[12px] text-fg-muted">
          No active API keys. Create one below to connect your BI tool.
        </p>
      )}

      {/* Create form */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="Key name, e.g. Power BI Desktop"
          className="input flex-1 text-[12px]"
        />
        <button
          onClick={handleCreate}
          disabled={creating || !newKeyName.trim()}
          className="btn-secondary flex items-center gap-1.5 whitespace-nowrap"
        >
          {creating ? (
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-fg-faint border-t-fg-secondary" />
          ) : (
            <Plus size={14} />
          )}
          New Key
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * BiExportCard — connection instructions + API key management for BI tools.
 *
 * Drop this into ConnectorsPage (or SettingsPage) — it has no required props
 * and is entirely self-contained.
 */
export default function BiExportCard() {
  // Derive the base URL from the current window location so it works in every
  // deployment (local, staging, prod).
  const biBaseUrl =
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.host}/api/v1/bi`
      : '/api/v1/bi';

  const hostOrigin =
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.host}`
      : 'https://your-flowminer.example.com';

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-4 px-6 py-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10">
          <BarChart2 size={20} className="text-accent" />
        </div>
        <div className="flex-1">
          <h2 className="text-[14px] font-semibold text-fg">
            BI Connector
          </h2>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            Connect Power BI or Tableau directly to FlowMiner's live data.
            Six flat tables, stable columns, no row caps — refreshes pull
            from the mining cache so they're fast.
          </p>
        </div>
      </div>

      {/* Base URL pill */}
      <div className="border-t border-line px-6 py-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
          BI Base URL
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 rounded-lg border border-line bg-surface-1 px-3 py-2 font-mono text-[12px] text-fg-secondary">
            {biBaseUrl}
          </code>
          <CopyButton value={biBaseUrl} label="base URL" />
        </div>
        <p className="mt-2 text-[11px] text-fg-faint">
          All six tables are available under this path. Authenticate every
          request with{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            Authorization: Bearer fmk_…
          </code>
        </p>
      </div>

      {/* Available tables */}
      <CollapsibleSection title="Available Tables" defaultOpen>
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {BI_TABLES.map((t) => (
            <div key={t.name} className="flex items-center gap-4 px-4 py-2.5">
              <code className="w-28 shrink-0 font-mono text-[12px] text-fg-secondary">
                {t.name}
              </code>
              <span className="text-[12px] text-fg-muted">{t.desc}</span>
              <CopyButton
                value={`${biBaseUrl}/${t.name}?event_log_id=<uuid>`}
                label={`${t.name} URL`}
              />
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-fg-faint">
          Every table accepts{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            ?event_log_id=&lt;uuid&gt;
          </code>{' '}
          as a required query param. Large tables (
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            cases
          </code>
          ,{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            events
          </code>
          ) also accept{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            limit
          </code>{' '}
          and{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            offset
          </code>
          .
        </p>
      </CollapsibleSection>

      {/* API Keys */}
      <CollapsibleSection title="API Keys" defaultOpen>
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-surface-1 px-4 py-3">
          <Key size={14} className="mt-0.5 shrink-0 text-fg-muted" />
          <p className="text-[12px] text-fg-muted">
            Use an API key (
            <code className="rounded bg-tint px-1 text-fg-secondary">
              fmk_…
            </code>
            ) as the bearer token. Keys are scoped to your account — the BI
            tool can only see event logs you already have access to.
          </p>
        </div>
        <ApiKeysPanel />
      </CollapsibleSection>

      {/* Power BI instructions */}
      <CollapsibleSection title="Power BI — Power Query connector">
        <ol className="space-y-3 text-[12px] text-fg-muted">
          <li className="flex gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
              1
            </span>
            Open Power BI Desktop and go to{' '}
            <strong className="text-fg">Home → Transform data → New Source → Blank Query</strong>.
          </li>
          <li className="flex gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
              2
            </span>
            <span>
              Go to{' '}
              <strong className="text-fg">Home → Advanced Editor</strong> and
              paste the full contents of{' '}
              <code className="rounded bg-surface-1 px-1 text-fg-secondary">
                flowminer.pq
              </code>{' '}
              (download below).
            </span>
          </li>
          <li className="flex gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
              3
            </span>
            <span>
              Click <strong className="text-fg">Done</strong>, then in the
              formula bar call:
            </span>
          </li>
        </ol>
        <CodeBlock>{`= FlowMiner.Contents("${hostOrigin}", "fmk_YOUR_API_KEY")`}</CodeBlock>
        <p className="mt-3 text-[12px] text-fg-muted">
          Expand the returned record — you'll see an{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            EventLogs
          </code>{' '}
          table and a function per BI table. Call any function with an event
          log ID to pull rows:
        </p>
        <CodeBlock>{`= FlowMiner.Contents(...)[GetVariants]("00000000-0000-0000-0000-000000000000")`}</CodeBlock>
        <div className="mt-4">
          <a
            href="/deploy/bi/flowminer.pq"
            download="flowminer.pq"
            className="btn-secondary inline-flex items-center gap-1.5 text-[12px]"
          >
            <ExternalLink size={13} />
            Download flowminer.pq
          </a>
        </div>
      </CollapsibleSection>

      {/* Tableau instructions */}
      <CollapsibleSection title="Tableau Desktop — Web Data Connector">
        <ol className="space-y-3 text-[12px] text-fg-muted">
          <li className="flex gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
              1
            </span>
            <span>
              Host{' '}
              <code className="rounded bg-surface-1 px-1 text-fg-secondary">
                flowminer-wdc.html
              </code>{' '}
              (download below) on any HTTPS endpoint Tableau can reach — S3,
              GitHub Pages, or your own server.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
              2
            </span>
            In Tableau Desktop, choose{' '}
            <strong className="text-fg">Connect → To a Server → Web Data Connector</strong>{' '}
            and paste the URL of the hosted HTML file.
          </li>
          <li className="flex gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
              3
            </span>
            Fill in the base URL (
            <code className="rounded bg-surface-1 px-1 text-fg-secondary">
              {hostOrigin}
            </code>
            ), your API key, the event log ID, and the table name, then click{' '}
            <strong className="text-fg">Get Data</strong>.
          </li>
        </ol>
        <p className="mt-4 text-[12px] text-fg-muted">
          The WDC auto-paginates large tables (
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            cases
          </code>
          ,{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            events
          </code>
          ) at 10,000 rows per request until the API returns an empty page.
        </p>
        <div className="mt-4">
          <a
            href="/deploy/bi/flowminer-wdc.html"
            download="flowminer-wdc.html"
            className="btn-secondary inline-flex items-center gap-1.5 text-[12px]"
          >
            <ExternalLink size={13} />
            Download flowminer-wdc.html
          </a>
        </div>
      </CollapsibleSection>

      {/* Direct REST / curl */}
      <CollapsibleSection title="Direct REST (curl / any HTTP client)">
        <p className="text-[12px] text-fg-muted">
          Every BI endpoint is a plain GET — no special client needed. Pass
          the API key as a bearer token:
        </p>
        <CodeBlock>{`curl -H "Authorization: Bearer fmk_YOUR_API_KEY" \\
  "${biBaseUrl}/statistics?event_log_id=<uuid>"`}</CodeBlock>
        <p className="mt-3 text-[12px] text-fg-muted">
          Responses are JSON arrays — pipe directly into your script or
          notebook. Use the Python SDK (
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            pip install flowminer
          </code>
          ) for an async convenience wrapper:
        </p>
        <CodeBlock>{`from flowminer import Client

async with Client("${hostOrigin}", token="fmk_YOUR_KEY") as c:
    stats = await c.bi_statistics("<event-log-id>")
    variants = await c.bi_variants("<event-log-id>")
    cases = await c.bi_cases("<event-log-id>", limit=5000, offset=0)`}</CodeBlock>
      </CollapsibleSection>

      {/* Security note */}
      <div className="border-t border-line px-6 py-4">
        <p className="text-[11px] text-fg-faint">
          API keys use{' '}
          <code className="rounded bg-surface-1 px-1 text-fg-secondary">
            Authorization: Bearer fmk_…
          </code>{' '}
          headers — always use HTTPS in production. Keys carry your
          account's access level; rotate them immediately at{' '}
          <strong>API Keys</strong> above if one leaks. The BI endpoints
          enforce the same row-level authorization as the web UI.
        </p>
      </div>
    </div>
  );
}
