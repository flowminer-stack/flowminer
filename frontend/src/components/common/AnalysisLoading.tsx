import LoadingSpinner from './LoadingSpinner';

interface AnalysisLoadingProps {
  /** Seconds the request has been running. */
  elapsedSec?: number;
  /** Context label shown under the spinner. */
  label?: string;
}

/**
 * Standard loading indicator for analysis sub-panels. Adds elapsed-time
 * feedback so users don't mistake a slow (but progressing) analysis for a
 * hung request. After 10s, nudges the user that long traces are expensive.
 */
export default function AnalysisLoading({
  elapsedSec = 0,
  label = 'Loading analysis…',
}: AnalysisLoadingProps) {
  const slow = elapsedSec >= 10;
  const verySlow = elapsedSec >= 30;

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <LoadingSpinner size="md" />
      <div className="text-center">
        <p className="text-[12px] font-medium text-fg-muted">{label}</p>
        {elapsedSec > 0 && (
          <p className="mt-1 text-[11px] tabular-nums text-fg-faint">
            {elapsedSec}s elapsed
          </p>
        )}
        {slow && !verySlow && (
          <p className="mt-2 max-w-xs text-[11px] text-fg-faint">
            Still working — this analysis can be slow on logs with long traces.
          </p>
        )}
        {verySlow && (
          <p className="mt-2 max-w-xs text-[11px] text-warning">
            This is taking longer than expected. Will time out at 45s if the
            algorithm is too heavy for this log shape.
          </p>
        )}
      </div>
    </div>
  );
}
