import { useState } from 'react';
import { AlertCircle, AlertTriangle, Info, ShieldCheck, Wrench } from 'lucide-react';
import clsx from 'clsx';
import { mining as miningApi, eventLogs as eventLogsApi } from '@/api/client';
import type { DataQualityResponse, DataQualityIssue, TimestampRepairResult } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { useAnalysisData } from '@/hooks/useAnalysisData';
import { useUIStore } from '@/store';

interface DataQualityCardProps {
  eventLogId: string;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-success';
  if (score >= 50) return 'text-warning';
  return 'text-danger';
}

function scoreBg(score: number): string {
  if (score >= 80) return 'bg-success/10 border-success/20';
  if (score >= 50) return 'bg-warning/10 border-warning/20';
  return 'bg-danger/10 border-danger/20';
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

const severityConfig: Record<
  DataQualityIssue['severity'],
  { icon: typeof AlertCircle; color: string; badge: string }
> = {
  error: {
    icon: AlertCircle,
    color: 'text-danger',
    badge: 'bg-danger/10 text-danger border border-danger/20',
  },
  warning: {
    icon: AlertTriangle,
    color: 'text-warning',
    badge: 'bg-warning/10 text-warning border border-warning/20',
  },
  info: {
    icon: Info,
    color: 'text-accent',
    badge: 'bg-accent/10 text-accent border border-accent/20',
  },
};

export default function DataQualityCard({ eventLogId }: DataQualityCardProps) {
  const { data, loading, error } = useAnalysisData<DataQualityResponse>(
    eventLogId, 'data_quality', miningApi.getQuality, 'Failed to load quality report.',
  );
  const addNotification = useUIStore((s) => s.addNotification);
  const [repairPreview, setRepairPreview] = useState<TimestampRepairResult | null>(null);
  const [repairing, setRepairing] = useState(false);

  const handlePreviewRepair = async () => {
    setRepairing(true);
    try {
      const preview = await eventLogsApi.previewTimestampRepair(eventLogId);
      setRepairPreview(preview);
    } catch {
      addNotification({ type: 'error', title: 'Could not preview timestamp repair' });
    } finally {
      setRepairing(false);
    }
  };

  const handleApplyRepair = async () => {
    setRepairing(true);
    try {
      const result = await eventLogsApi.applyTimestampRepair(eventLogId);
      setRepairPreview(null);
      addNotification({
        type: 'success',
        title: 'Timestamps repaired',
        message: `Fixed ${result.ties_fixed} tie${result.ties_fixed !== 1 ? 's' : ''} and ${result.inversions_fixed} inversion${result.inversions_fixed !== 1 ? 's' : ''}.`,
      });
    } catch {
      addNotification({ type: 'error', title: 'Timestamp repair failed' });
    } finally {
      setRepairing(false);
    }
  };

  if (loading) {
    return (
      <div className="card mt-6 p-6">
        <LoadingSpinner text="Analyzing data quality..." />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card mt-6 p-4 text-[12px] text-fg-muted">
        {error ?? 'No quality data available.'}
      </div>
    );
  }

  return (
    <div className="card mt-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold text-fg">Data Quality Report</h2>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {data.total_events.toLocaleString()} events analysed &mdash; {data.issues.length} issue
            {data.issues.length !== 1 ? 's' : ''} found
          </p>
        </div>

        {/* Score badge */}
        <div
          className={clsx(
            'flex min-w-[72px] flex-col items-center rounded-lg border px-4 py-2',
            scoreBg(data.overall_score),
          )}
        >
          <span className={clsx('text-2xl font-bold tabular-nums', scoreColor(data.overall_score))}>
            {data.overall_score}
          </span>
          <span className={clsx('text-[10px] font-semibold', scoreColor(data.overall_score))}>
            {scoreLabel(data.overall_score)}
          </span>
        </div>
      </div>

      {data.issues.length === 0 ? (
        <div className="mt-5 flex items-center gap-2 text-[13px] text-success">
          <ShieldCheck size={15} />
          No issues detected. Your data looks clean!
        </div>
      ) : (
        <div className="mt-5 divide-y divide-line/60 rounded-lg border border-line">
          {data.issues.map((issue, i) => {
            const cfg = severityConfig[issue.severity];
            const Icon = cfg.icon;
            return (
              <div key={i} className="flex items-start gap-3 px-3.5 py-3">
                <Icon size={14} className={clsx('mt-0.5 shrink-0', cfg.color)} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={clsx(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                        cfg.badge,
                      )}
                    >
                      {issue.category}
                    </span>
                    <p className="text-[12px] text-fg">{issue.message}</p>
                  </div>
                  <p className="mt-0.5 text-[11px] text-fg-faint">
                    Affects {issue.affected_count.toLocaleString()} rows (
                    {issue.affected_percentage.toFixed(1)}%)
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Timestamp repair */}
      <div className="mt-5 border-t border-line pt-4">
        {repairPreview ? (
          <div className="rounded-lg border border-line bg-surface-1 p-3">
            <p className="text-[12px] font-semibold text-fg mb-1">Repair preview</p>
            <div className="text-[11px] text-fg-muted space-y-0.5">
              <p>Ties to fix: <span className="font-semibold text-fg">{repairPreview.ties_fixed}</span></p>
              <p>Inversions to fix: <span className="font-semibold text-fg">{repairPreview.inversions_fixed}</span></p>
              {repairPreview.outliers_found > 0 && (
                <p className="text-warning">Outliers detected: {repairPreview.outliers_found} (manual review recommended)</p>
              )}
              {repairPreview.ties_fixed === 0 && repairPreview.inversions_fixed === 0 && (
                <p className="text-success">No timestamp issues found — no repair needed.</p>
              )}
            </div>
            {(repairPreview.ties_fixed > 0 || repairPreview.inversions_fixed > 0) && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleApplyRepair}
                  disabled={repairing}
                  className="btn-primary text-xs"
                >
                  {repairing ? 'Repairing…' : 'Apply repair'}
                </button>
                <button
                  onClick={() => setRepairPreview(null)}
                  className="btn-ghost text-xs"
                >
                  Cancel
                </button>
              </div>
            )}
            {repairPreview.ties_fixed === 0 && repairPreview.inversions_fixed === 0 && (
              <button onClick={() => setRepairPreview(null)} className="mt-2 btn-ghost text-xs">Dismiss</button>
            )}
          </div>
        ) : (
          <button
            onClick={handlePreviewRepair}
            disabled={repairing}
            className="flex items-center gap-1.5 text-[12px] text-fg-muted hover:text-fg transition-colors"
          >
            <Wrench size={12} />
            {repairing ? 'Checking…' : 'Repair timestamps'}
          </button>
        )}
      </div>
    </div>
  );
}
