/**
 * CostOfQualityCard
 *
 * Fetches POST /scorecards/cost-of-quality/{event_log_id} and renders the
 * dollar cost of quality issues — a headline total plus a per-line breakdown
 * (Rework / Bottleneck queues / Escalations). Includes an inline "Adjust
 * assumptions" editor so the user can re-cost with their own rates.
 *
 * Self-contained: takes only `eventLogId`. Drop it into a project/process
 * overview surface.
 */

import { useCallback, useEffect, useState } from 'react';
import { DollarSign, Loader2, RefreshCw, SlidersHorizontal } from 'lucide-react';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import { costOfQuality } from '@/api/scorecards';
import type { CostInputs, CostOfQualityResult } from '@/types/scorecards';

interface Props {
  eventLogId: string;
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const DEFAULT_INPUTS: CostInputs = {
  fte_cost_per_hour: 50,
  cost_per_rework_case: 25,
  cost_per_escalation: 100,
};

const INPUT_FIELDS: { key: keyof CostInputs; label: string }[] = [
  { key: 'fte_cost_per_hour', label: 'FTE cost / hour' },
  { key: 'cost_per_rework_case', label: 'Cost / rework case' },
  { key: 'cost_per_escalation', label: 'Cost / escalation' },
];

function errMessage(e: unknown): string {
  const ax = e as { response?: { data?: { detail?: string } }; message?: string };
  return ax?.response?.data?.detail || ax?.message || 'Failed to load cost of quality.';
}

export default function CostOfQualityCard({ eventLogId }: Props) {
  const [data, setData] = useState<CostOfQualityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [inputs, setInputs] = useState<CostInputs>(DEFAULT_INPUTS);

  const load = useCallback(
    (body?: Partial<CostInputs>) => {
      if (!eventLogId) return;
      setLoading(true);
      setError(null);
      costOfQuality(eventLogId, body)
        .then((r) => {
          setData(r);
          setInputs(r.inputs);
        })
        .catch((e) => {
          setError(errMessage(e));
          setData(null);
        })
        .finally(() => setLoading(false));
    },
    [eventLogId],
  );

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="card flex min-h-[200px] items-center justify-center p-6">
        <LoadingSpinner size="md" text="Costing quality issues…" />
      </div>
    );
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={() => load()} />;
  }

  if (!data) return null;

  return (
    <div className="card p-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <DollarSign size={17} />
          </div>
          <div>
            <h3 className="text-[14px] font-semibold text-fg">Cost of Quality</h3>
            <p className="text-[11px] text-fg-muted">
              Annualised dollar impact of rework, bottlenecks and escalations.
            </p>
          </div>
        </div>
        <button
          onClick={() => setEditing((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-tint hover:text-fg"
          aria-expanded={editing}
        >
          <SlidersHorizontal size={12} />
          {editing ? 'Hide' : 'Adjust'}
        </button>
      </div>

      {/* Total */}
      <div className="mt-4">
        <div className="text-3xl font-bold tabular-nums text-fg">
          {usd.format(data.total)}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-faint">total cost of quality</div>
      </div>

      {/* Assumptions editor */}
      {editing && (
        <div className="mt-4 rounded-lg border border-line bg-surface-1 p-3">
          <div className="grid grid-cols-3 gap-2.5">
            {INPUT_FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[10.5px] font-medium text-fg-faint">
                  {f.label}
                </span>
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-fg-faint">
                    $
                  </span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={inputs[f.key]}
                    onChange={(e) =>
                      setInputs((prev) => ({
                        ...prev,
                        [f.key]: Number(e.target.value),
                      }))
                    }
                    className="input w-full pl-5 text-[12px] tabular-nums"
                  />
                </div>
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => load(inputs)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-wait disabled:opacity-70"
            >
              {loading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Recompute
            </button>
            <button
              onClick={() => {
                setInputs(DEFAULT_INPUTS);
                load(DEFAULT_INPUTS);
              }}
              disabled={loading}
              className="btn-secondary text-[11px]"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* Line items */}
      <div className="mt-4 space-y-2">
        {data.line_items.map((li) => {
          const share = data.total > 0 ? (li.value / data.total) * 100 : 0;
          return (
            <div key={li.label}>
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] font-medium text-fg">{li.label}</span>
                <span className="text-[12px] font-semibold tabular-nums text-fg">
                  {usd.format(li.value)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                  />
                </div>
                <span className="w-28 shrink-0 text-right text-[10.5px] text-fg-faint">
                  {li.detail}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 text-[11px] text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
