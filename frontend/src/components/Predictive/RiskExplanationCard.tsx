import { useEffect, useState } from 'react';
import { X, Info, TrendingUp, TrendingDown, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { predictive } from '@/api/predictive';
import type { ExplainResponse } from '@/types/predictive';
import LoadingSpinner from '@/components/common/LoadingSpinner';

interface RiskExplanationCardProps {
  eventLogId: string;
  caseId: string;
  /** SLA threshold in seconds — forwarded to the explain endpoint. */
  slaThreshold?: number;
  /** Number of feature contributions to request. */
  topN?: number;
  onClose: () => void;
}

function formatValue(value: number | string | boolean | null): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }
  return value;
}

/**
 * SHAP explanation panel for a single at-risk case. Fetches signed feature
 * contributions and renders them as diverging spark-bars. Handles the
 * `available: false` case gracefully (e.g. model not trained / unsupported).
 */
export default function RiskExplanationCard({
  eventLogId,
  caseId,
  slaThreshold,
  topN = 8,
  onClose,
}: RiskExplanationCardProps) {
  const [data, setData] = useState<ExplainResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    predictive
      .explainCase(eventLogId, caseId, { kind: 'outcome', topN, slaThreshold })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load explanation',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventLogId, caseId, topN, slaThreshold]);

  const contributions = data?.top_contributions ?? [];
  const maxAbs = Math.max(
    1e-9,
    ...contributions.map((c) => Math.abs(c.contribution)),
  );

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Sparkles size={14} />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">
              Why is case{' '}
              <span className="font-mono text-fg-secondary">{caseId}</span> at
              risk?
            </h3>
            <p className="text-[11px] text-fg-faint">
              SHAP feature contributions toward the predicted outcome
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-fg-faint hover:bg-tint hover:text-fg"
          aria-label="Close explanation"
        >
          <X size={14} />
        </button>
      </div>

      {loading && (
        <div className="py-8">
          <LoadingSpinner size="md" text="Computing explanation…" />
        </div>
      )}

      {!loading && error && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
          <Info size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && data && !data.available && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-tint px-3 py-2.5 text-[12px] text-fg-muted">
          <Info size={14} className="mt-0.5 shrink-0 text-fg-faint" />
          <span>
            {data.reason ??
              'No explanation is available for this case yet. The outcome model may not be trained, or this prefix is unsupported.'}
          </span>
        </div>
      )}

      {!loading && !error && data && data.available && (
        <>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-fg-muted">
            {data.current_activity && (
              <span>
                Current activity:{' '}
                <span className="font-medium text-fg-secondary">
                  {data.current_activity}
                </span>
              </span>
            )}
            {data.prefix_length !== undefined && (
              <span>
                Prefix length:{' '}
                <span className="font-medium text-fg-secondary tabular-nums">
                  {data.prefix_length}
                </span>
              </span>
            )}
            {data.kind && (
              <span>
                Model:{' '}
                <span className="font-medium text-fg-secondary">
                  {data.kind}
                </span>
              </span>
            )}
          </div>

          {contributions.length === 0 ? (
            <p className="mt-4 text-[12px] text-fg-muted">
              No feature contributions were returned for this case.
            </p>
          ) : (
            <div className="mt-4 space-y-2.5">
              {contributions.map((c, i) => {
                const positive = c.contribution >= 0;
                const widthPct = (Math.abs(c.contribution) / maxAbs) * 50; // half-axis
                return (
                  <div key={`${c.feature}-${i}`} className="text-[12px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 truncate text-fg-secondary">
                        {positive ? (
                          <TrendingUp size={12} className="shrink-0 text-danger" />
                        ) : (
                          <TrendingDown
                            size={12}
                            className="shrink-0 text-success"
                          />
                        )}
                        <span className="truncate font-medium" title={c.feature}>
                          {c.feature}
                        </span>
                        <span className="shrink-0 text-fg-faint">
                          = {formatValue(c.value)}
                        </span>
                      </span>
                      <span
                        className={clsx(
                          'shrink-0 font-mono tabular-nums',
                          positive ? 'text-danger' : 'text-success',
                        )}
                      >
                        {positive ? '+' : ''}
                        {c.contribution.toFixed(3)}
                      </span>
                    </div>
                    {/* Diverging spark-bar: center axis, grows left (good) / right (bad) */}
                    <div className="mt-1 flex h-2 items-stretch overflow-hidden rounded-full bg-tint">
                      <div className="flex w-1/2 justify-end">
                        {!positive && (
                          <div
                            className="rounded-l-full bg-success/70"
                            style={{ width: `${widthPct * 2}%` }}
                          />
                        )}
                      </div>
                      <div className="w-px bg-line-strong" />
                      <div className="flex w-1/2 justify-start">
                        {positive && (
                          <div
                            className="rounded-r-full bg-danger/70"
                            style={{ width: `${widthPct * 2}%` }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-4 flex items-center gap-4 text-[10px] text-fg-faint">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-danger/70" />
              Increases breach risk
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-success/70" />
              Decreases breach risk
            </span>
          </div>
        </>
      )}
    </div>
  );
}
