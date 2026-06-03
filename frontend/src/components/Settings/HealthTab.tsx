import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Shield,
  CheckCircle2,
  XCircle,
  Info,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { systemSettings } from '@/api/client';
import type { SystemHealthResponse } from '@/api/client';
import { useAuthStore } from '@/store';

export default function HealthTab() {
  const user = useAuthStore((s) => s.user);
  const canViewHealth = user?.role === 'admin';

  const [health, setHealth] = useState<SystemHealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  // Bumping this triggers the health-fetch effect — used by the
  // Refresh button so we re-run the same code path the tab uses on mount.
  const [healthReloadKey, setHealthReloadKey] = useState(0);

  // Fetch system health when the Health tab opens or the user clicks
  // Refresh (which bumps healthReloadKey).
  useEffect(() => {
    if (!canViewHealth) return;
    let cancelled = false;
    setHealthLoading(true);
    setHealthError(null);
    systemSettings
      .getSystemHealth()
      .then((res) => {
        if (cancelled) return;
        setHealth(res);
      })
      .catch((err) => {
        if (cancelled) return;
        let message = 'Failed to load system health.';
        if (axios.isAxiosError(err)) {
          const detail = err.response?.data?.detail;
          if (typeof detail === 'string') message = detail;
        }
        setHealth(null);
        setHealthError(message);
      })
      .finally(() => {
        if (!cancelled) setHealthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canViewHealth, healthReloadKey]);

  return (
    <div className="mt-6">
      {!canViewHealth ? (
        <div className="rounded-xl border border-dashed border-line bg-surface-2 p-10 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Shield size={20} />
          </div>
          <p className="mt-3 text-[13px] font-semibold text-fg">
            Admins only
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">
            The system-health diagnostics view is restricted to administrators.
          </p>
        </div>
      ) : (
        <div className="card p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[14px] font-semibold text-fg">
                System health
              </h2>
              <p className="mt-1 text-[12px] text-fg-muted">
                Live status of the components this deployment depends on.
                Use this to self-diagnose configuration issues without
                tailing container logs.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHealthReloadKey((k) => k + 1)}
              disabled={healthLoading}
              className="btn-secondary shrink-0"
            >
              <RefreshCw
                size={14}
                className={clsx(healthLoading && 'animate-spin')}
              />
              Refresh
            </button>
          </div>

          {healthLoading && !health && (
            <div className="mt-6 flex items-center gap-2 text-[12px] text-fg-muted">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
              Checking components…
            </div>
          )}

          {!healthLoading && healthError && !health && (
            <div className="mt-6 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] text-red-700 dark:border-red-900/40 dark:bg-red-500/10 dark:text-red-400">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{healthError}</span>
            </div>
          )}

          {health && (
            <ul className="mt-6 divide-y divide-line border-t border-line">
              {(
                [
                  { key: 'database', label: 'Database' },
                  { key: 'redis', label: 'Redis' },
                  { key: 'encryption', label: 'Encryption' },
                  { key: 'llm_provider', label: 'LLM provider' },
                  { key: 'smtp', label: 'SMTP (email alerts)' },
                  { key: 'upload_dir', label: 'Upload directory' },
                ] as const
              ).map(({ key, label }) => {
                const status = health[key];
                // Two components have a "configured but disabled" middle
                // state we render as a yellow indicator: SMTP without a
                // host, and the LLM null fallback. Everything else is a
                // straight green / red.
                const isYellow =
                  status.ok &&
                  ((key === 'smtp' && status.detail.startsWith('disabled')) ||
                    (key === 'llm_provider' && status.detail.startsWith('null')) ||
                    (key === 'encryption' &&
                      status.detail.startsWith('derived from SECRET_KEY')));
                return (
                  <li
                    key={key}
                    className="flex items-start justify-between gap-4 py-3"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={clsx(
                          'mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                          !status.ok
                            ? 'bg-red-500'
                            : isYellow
                              ? 'bg-amber-500'
                              : 'bg-emerald-500',
                        )}
                        aria-hidden
                      />
                      <div>
                        <p className="text-[13px] font-medium text-fg">
                          {label}
                        </p>
                        <p className="mt-0.5 break-words text-[11px] text-fg-muted">
                          {status.detail}
                        </p>
                      </div>
                    </div>
                    <span
                      className={clsx(
                        'badge shrink-0',
                        !status.ok
                          ? 'badge-rose'
                          : isYellow
                            ? 'badge-amber'
                            : 'badge-emerald',
                      )}
                    >
                      {!status.ok ? (
                        <>
                          <XCircle size={11} />
                          Error
                        </>
                      ) : isYellow ? (
                        <>
                          <Info size={11} />
                          Notice
                        </>
                      ) : (
                        <>
                          <CheckCircle2 size={11} />
                          OK
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-5 flex items-start gap-1.5 text-[11px] text-fg-faint">
            <Info size={11} className="mt-0.5 shrink-0" />
            <span>
              This view never shows secret values — only configuration
              state and source. Use the operator-only{' '}
              <span className="font-mono">/health/ready</span> probe for
              load-balancer health checks.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
