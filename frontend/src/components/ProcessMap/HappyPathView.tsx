import { useEffect, useState } from 'react';
import { ArrowDown, GitBranch } from 'lucide-react';
import { mining } from '@/api/client';
import { formatDuration } from '@/utils/format';
import type { VariantResponse, Variant } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';

interface HappyPathViewProps {
  eventLogId: string;
}

/**
 * HappyPathView renders the top process variants as a set of linear
 * "trains" running top-to-bottom. Each train is one variant; each stop is
 * an activity. The first variant is usually the overwhelmingly-dominant
 * path (the "happy path") — subsequent trains show the major deviations
 * without the visual noise of a full DFG.
 */
export default function HappyPathView({ eventLogId }: HappyPathViewProps) {
  const [data, setData] = useState<VariantResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(3);

  useEffect(() => {
    if (!eventLogId) return;
    setLoading(true);
    setError(null);
    mining
      .getVariants(eventLogId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load variants'))
      .finally(() => setLoading(false));
  }, [eventLogId]);

  if (loading) return <LoadingSpinner size="lg" text="Computing happy path…" />;
  if (error) return <ErrorState message={error} />;

  const variants = data?.variants ?? [];
  if (variants.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No variants found"
        description="Upload an event log with case and activity data to see happy paths."
      />
    );
  }

  const shown = variants.slice(0, limit);
  const totalCases = data?.total_cases ?? 0;
  const coveredCases = shown.reduce((s, v) => s + v.frequency, 0);
  const coveragePct = totalCases > 0 ? (coveredCases / totalCases) * 100 : 0;

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Summary banner */}
      <div className="mx-auto mb-6 max-w-5xl rounded-xl border border-line bg-surface-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-fg">Happy path & top deviations</h2>
            <p className="mt-0.5 text-[12px] text-fg-muted">
              The top {shown.length} of {variants.length} variants cover{' '}
              <span className="font-semibold text-fg">{coveragePct.toFixed(1)}%</span> of{' '}
              {totalCases.toLocaleString()} cases.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-fg-muted">Show top</span>
            <div className="flex rounded-lg border border-line bg-surface-1 p-0.5 gap-0.5">
              {[1, 3, 5, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => setLimit(n)}
                  className={
                    limit === n
                      ? 'rounded-md bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-fg shadow-xs'
                      : 'rounded-md px-2.5 py-1 text-[11px] font-semibold text-fg-muted hover:text-fg'
                  }
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Variant trains */}
      <div className="mx-auto grid max-w-6xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((variant, idx) => (
          <VariantTrain
            key={variant.id ?? idx}
            variant={variant}
            rank={idx + 1}
            isHappyPath={idx === 0}
          />
        ))}
      </div>
    </div>
  );
}

function VariantTrain({
  variant,
  rank,
  isHappyPath,
}: {
  variant: Variant;
  rank: number;
  isHappyPath: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={
              isHappyPath
                ? 'flex h-6 w-6 items-center justify-center rounded-full bg-success/15 text-[11px] font-bold text-success'
                : 'flex h-6 w-6 items-center justify-center rounded-full bg-tint text-[11px] font-bold text-fg-muted'
            }
          >
            {rank}
          </span>
          <p className="text-[12px] font-semibold text-fg">
            {isHappyPath ? 'Happy path' : `Variant ${rank}`}
          </p>
        </div>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent tabular-nums">
          {variant.percentage.toFixed(1)}%
        </span>
      </div>

      <div className="mb-3 flex items-center gap-3 text-[11px] text-fg-muted">
        <span>
          <span className="font-semibold text-fg">{variant.frequency.toLocaleString()}</span> cases
        </span>
        {variant.avg_duration != null && (
          <span>
            avg{' '}
            <span className="font-semibold text-fg">{formatDuration(variant.avg_duration)}</span>
          </span>
        )}
      </div>

      <div className="flex flex-col items-center gap-1.5">
        {variant.activities.map((activity, i) => {
          const isStart = i === 0;
          const isEnd = i === variant.activities.length - 1;
          return (
            <div key={i} className="flex w-full flex-col items-center">
              <div
                className={
                  'w-full rounded-lg border px-3 py-2 text-center text-[11px] font-medium ' +
                  (isStart
                    ? 'border-success/30 bg-success/5 text-success'
                    : isEnd
                      ? 'border-danger/30 bg-danger/5 text-danger'
                      : 'border-line bg-surface-1 text-fg-secondary')
                }
              >
                {activity}
              </div>
              {i < variant.activities.length - 1 && (
                <ArrowDown size={12} className="my-0.5 text-fg-faint" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
