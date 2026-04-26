import { AlertCircle, RefreshCw } from 'lucide-react';

interface ErrorStateProps {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  compact?: boolean;
}

export default function ErrorState({ title, message, onRetry, compact }: ErrorStateProps) {
  if (compact) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger"
      >
        <AlertCircle size={14} aria-hidden="true" className="shrink-0" />
        <span className="flex-1">{message || title || 'Something went wrong'}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-danger hover:bg-danger/10"
            aria-label="Retry"
          >
            <RefreshCw size={10} /> Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-danger/30 bg-danger/5 p-10 text-center"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-danger/10">
        <AlertCircle size={20} aria-hidden="true" className="text-danger" />
      </div>
      <div>
        <h3 className="text-[13px] font-semibold text-fg">{title || 'Something went wrong'}</h3>
        {message && <p className="mt-1 text-[12px] text-fg-muted">{message}</p>}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="btn-secondary mt-1 text-[12px]"
        >
          <RefreshCw size={12} /> Try again
        </button>
      )}
    </div>
  );
}
