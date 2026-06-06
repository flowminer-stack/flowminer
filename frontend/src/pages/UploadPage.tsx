import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Upload, BarChart2 } from 'lucide-react';
import clsx from 'clsx';
import { eventLogs as eventLogsApi, projects as projectsApi } from '@/api/client';
import type { Project, EventLogPreview, ColumnMapping } from '@/types';
import FileUpload from '@/components/common/FileUpload';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore, useEventLogsStore, useAuthStore } from '@/store';
import DataQualityCard from '@/components/DataQuality/DataQualityCard';
import ColumnMapper from '@/components/ColumnMapper/ColumnMapper';

type Step = 'upload' | 'mapping' | 'done';

// Loose ISO-date prefix for the at-a-glance date range in the summary card.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export default function UploadPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);
  const addEventLog = useEventLogsStore((s) => s.addEventLog);
  const demoMode = useAuthStore((s) => s.demoMode);

  const [, setProject] = useState<Project | null>(null);
  const [step, setStep] = useState<Step>('upload');
  const [eventLogId, setEventLogId] = useState<string | null>(null);
  const [uploadedLogType, setUploadedLogType] = useState<string>('standard');
  const [preview, setPreview] = useState<EventLogPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Confidence score (0-1) per target field, populated by the fuzzy
  // auto-mapper. Surfaced in ColumnMapper's badge pill (Mehrwerk mpmX parity).
  const [confidence, setConfidence] = useState<{
    case_id: number;
    activity: number;
    timestamp: number;
    resource: number;
    cost: number;
  }>({
    case_id: 0,
    activity: 0,
    timestamp: 0,
    resource: 0,
    cost: 0,
  });
  const [mappingSaving, setMappingSaving] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    projectsApi.get(projectId).then(setProject).catch(() => {
      navigate('/projects');
    });
  }, [projectId, navigate]);

  const handleUpload = async (file: File) => {
    if (!projectId) return;
    const log = await eventLogsApi.upload(projectId, file);
    setEventLogId(log.id);
    setUploadedLogType(log.log_type ?? 'standard');
    addEventLog(log);

    // OCEL files skip column mapping — they're self-describing
    if (log.log_type === 'ocel') {
      addNotification({
        type: 'success',
        title: 'OCEL file uploaded',
        message: `${log.total_events} events, ${log.object_types?.length ?? 0} object types detected.`,
      });
      setStep('done');
      return;
    }

    // Standard logs: load preview and run name-based auto-detection to
    // pre-populate confidence scores that ColumnMapper surfaces as pills.
    setPreviewLoading(true);
    try {
      const p = await eventLogsApi.preview(log.id);
      setPreview(p);

      // Confidence-scored auto-mapping. Each candidate keyword has a
      // weight; a column's score is the sum of weights for keywords it
      // matches (bounded at 1.0). We pick the highest-scoring column
      // per target field and surface the score as a pill in the UI,
      // mirroring Mehrwerk mpmX's "94% confident" column mapper.
      const targets: Record<string, Array<[string, number]>> = {
        case_id: [
          ['case', 0.6],
          ['trace', 0.5],
          ['journey', 0.4],
          ['order', 0.3],
          ['ticket', 0.3],
          ['instance', 0.4],
          ['_id', 0.3],
          ['id', 0.2],
        ],
        activity: [
          ['activity', 0.7],
          ['event', 0.5],
          ['action', 0.4],
          ['step', 0.4],
          ['status', 0.3],
          ['stage', 0.3],
          ['task', 0.4],
        ],
        timestamp: [
          ['time', 0.5],
          ['date', 0.4],
          ['ts', 0.4],
          ['created', 0.4],
          ['updated', 0.4],
          ['started', 0.4],
          ['completed', 0.4],
          ['timestamp', 0.7],
        ],
        resource: [
          ['resource', 0.7],
          ['user', 0.4],
          ['agent', 0.4],
          ['owner', 0.3],
          ['assignee', 0.5],
          ['performed_by', 0.6],
          ['handler', 0.4],
        ],
        cost: [
          ['cost', 0.7],
          ['price', 0.5],
          ['amount', 0.4],
          ['value', 0.2],
          ['total', 0.3],
          ['expense', 0.5],
        ],
      };

      const scoreCol = (col: string, kws: Array<[string, number]>): number => {
        const lower = col.toLowerCase();
        let s = 0;
        for (const [kw, w] of kws) if (lower.includes(kw)) s += w;
        return Math.min(1, s);
      };

      const autoConf = {
        case_id: 0,
        activity: 0,
        timestamp: 0,
        resource: 0,
        cost: 0,
      };
      for (const field of Object.keys(targets) as Array<keyof typeof autoConf>) {
        let best: { score: number } | null = null;
        for (const col of p.columns) {
          const s = scoreCol(col, targets[field]);
          if (s > 0 && (!best || s > best.score)) best = { score: s };
        }
        if (best) {
          autoConf[field] = best.score;
        }
      }

      setConfidence(autoConf);
    } catch {
      // Preview may fail; ColumnMapper still works without a preview
    } finally {
      setPreviewLoading(false);
    }

    setStep('mapping');
  };

  // Called by ColumnMapper when the user clicks "Start Mining".
  // Adapts ColumnMapper's {case_id, activity, timestamp, resource, cost}
  // to UploadPage's backend-facing ColumnMapping shape and saves it.
  const handleMappingComplete = async (mapperResult: {
    case_id: string;
    activity: string;
    timestamp: string;
    resource?: string;
    cost?: string;
    additional_columns?: string[];
  }) => {
    if (!eventLogId) return;

    const mapping: ColumnMapping = {
      case_id_column: mapperResult.case_id,
      activity_column: mapperResult.activity,
      timestamp_column: mapperResult.timestamp,
      ...(mapperResult.resource && { resource_column: mapperResult.resource }),
      ...(mapperResult.cost && { cost_column: mapperResult.cost }),
      ...(mapperResult.additional_columns && {
        additional_columns: mapperResult.additional_columns,
      }),
    };

    setMappingSaving(true);
    try {
      await eventLogsApi.setColumnMapping(eventLogId, mapping);
      // Celebrate with a sample-based estimate (full stats compute async) and
      // take the user straight to the first-value view instead of a dead-end
      // "done" screen with manual CTAs.
      const rows = preview?.sample_rows ?? [];
      const cases = new Set(rows.map((r) => r[mapperResult.case_id])).size;
      const acts = new Set(rows.map((r) => r[mapperResult.activity])).size;
      addNotification({
        type: 'success',
        title: 'Event log ready 🎉',
        message: rows.length
          ? `~${cases} cases · ${acts} activities (from sample) — opening your process map.`
          : 'Opening your process map…',
      });
      navigate(`/mission-control/${eventLogId}`);
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to save mapping',
      });
      setMappingSaving(false);
    }
  };

  // At-a-glance summary shown above the mapper: row count, column count, and a
  // best-effort date range read from the sample (labelled as a sample).
  const fileSummary = useMemo(() => {
    if (!preview) return null;
    const rows = preview.sample_rows ?? [];
    let best: { col: string; hits: number } | null = null;
    for (const col of preview.columns) {
      const hits = rows.filter((r) => ISO_DATE_RE.test(String(r[col] ?? ''))).length;
      if (hits > 0 && (!best || hits > best.hits)) best = { col, hits };
    }
    let dateRange: [string, string] | null = null;
    if (best) {
      const vals = rows
        .map((r) => String(r[best!.col] ?? ''))
        .filter((v) => ISO_DATE_RE.test(v))
        .map((v) => v.slice(0, 10))
        .sort();
      if (vals.length) dateRange = [vals[0], vals[vals.length - 1]];
    }
    return { rows: preview.total_rows, cols: preview.columns.length, dateRange };
  }, [preview]);

  const steps = [
    { id: 'upload' as const, label: 'Upload File' },
    { id: 'mapping' as const, label: 'Map Columns' },
    { id: 'done' as const, label: 'Complete' },
  ];

  const currentStepIndex = steps.findIndex((s) => s.id === step);

  if (demoMode) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader
          title="Upload Event Log"
          icon={Upload}
          description="Uploads are disabled in the demo"
          backTo={`/projects/${projectId}`}
        />
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface-2 p-10 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Upload size={20} />
          </div>
          <p className="mt-3 text-[13px] font-semibold text-fg">
            Uploads are disabled in the public demo
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">
            The demo ships with a handful of preloaded logs so every visitor
            gets the same analytics surface. To upload your own, self-host
            FlowMiner — <code className="px-1.5 py-0.5 rounded bg-surface-3 text-[11px] text-accent">docker compose up -d</code>
            {' '}is all it takes.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => navigate(`/projects/${projectId}`)}
              className="btn-primary"
            >
              <ArrowLeft size={14} />
              Back to the log
            </button>
            <button
              onClick={() => navigate('/projects')}
              className="btn-secondary"
            >
              Browse all demo logs
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Upload Event Log"
        icon={Upload}
        description="Upload and configure your event log file"
        backTo={`/projects/${projectId}`}
      />

      {/* Step indicator */}
      <div className="mt-6 flex items-center gap-2">
        {steps.map((s, index) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={clsx(
                'flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                index < currentStepIndex
                  ? 'bg-accent text-surface-0'
                  : index === currentStepIndex
                    ? 'bg-accent text-surface-0'
                    : 'bg-tint text-fg-muted',
              )}
            >
              {index < currentStepIndex ? (
                <Check size={16} />
              ) : (
                index + 1
              )}
            </div>
            <span
              className={clsx(
                'text-[12px] font-medium',
                index <= currentStepIndex
                  ? 'text-fg'
                  : 'text-fg-faint',
              )}
            >
              {s.label}
            </span>
            {index < steps.length - 1 && (
              <div
                className={clsx(
                  'mx-2 h-px w-8',
                  index < currentStepIndex
                    ? 'bg-accent'
                    : 'bg-tint',
                )}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="mt-8">
        {step === 'upload' && (
          <div className="card p-6">
            <h2 className="text-[14px] font-semibold text-fg">
              Select your event log file
            </h2>
            <p className="mt-1 text-[12px] text-fg-muted">
              Drop a CSV, XES, Excel, Parquet, or OCEL file — we’ll auto-detect
              your columns and let you adjust them before mining.
            </p>
            <div className="mt-4">
              <FileUpload
                onUpload={handleUpload}
                accept={{
                  'text/csv': ['.csv'],
                  'application/xml': ['.xes', '.xmlocel'],
                  'application/json': ['.json', '.jsonocel'],
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
                  'application/octet-stream': ['.parquet', '.sqlite'],
                }}
              />
            </div>
          </div>
        )}

        {step === 'mapping' && (
          <div className="card p-6">
            {previewLoading ? (
              <div className="py-12">
                <LoadingSpinner text="Loading file preview..." />
              </div>
            ) : mappingSaving ? (
              <div className="py-12">
                <LoadingSpinner text="Saving column mapping..." />
              </div>
            ) : (
              <>
                {fileSummary && (
                  <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-surface-1 px-4 py-3 text-[12px]">
                    <span className="font-semibold text-fg">
                      {fileSummary.rows.toLocaleString()} rows
                    </span>
                    <span className="text-fg-muted">{fileSummary.cols} columns</span>
                    {fileSummary.dateRange && (
                      <span className="text-fg-muted">
                        {fileSummary.dateRange[0]} → {fileSummary.dateRange[1]}
                      </span>
                    )}
                  </div>
                )}
                <ColumnMapper
                  eventLogId={eventLogId ?? ''}
                  columns={preview?.columns ?? []}
                  sampleRows={preview?.sample_rows ?? []}
                  onMappingComplete={handleMappingComplete}
                  confidenceScores={confidence}
                />
                <div className="mt-4 flex justify-start">
                  <button
                    onClick={() => setStep('upload')}
                    className="btn-secondary"
                  >
                    <ArrowLeft size={16} />
                    Back
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {step === 'done' && (
          <>
            <div className="card flex flex-col items-center p-12 text-center">
              <div className="rounded-full bg-success/10 p-4">
                <Check size={32} className="text-success" />
              </div>
              <h2 className="mt-4 text-[14px] font-semibold text-fg">
                Upload Complete!
              </h2>
              <p className="mt-2 text-[12px] text-fg-muted">
                Your event log is being processed. You can view the process map
                once processing is complete.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                {/* Primary CTA: See Insights — most valuable next step */}
                {eventLogId && uploadedLogType !== 'ocel' && (
                  <button
                    onClick={() => navigate(`/mission-control/${eventLogId}`)}
                    className="btn-primary"
                  >
                    <BarChart2 size={16} />
                    See Insights
                  </button>
                )}
                {/* Secondary CTAs */}
                {eventLogId && (
                  <button
                    onClick={() => navigate(
                      uploadedLogType === 'ocel'
                        ? `/ocpm/${eventLogId}`
                        : `/process/${eventLogId}`,
                    )}
                    className="btn-secondary"
                  >
                    {uploadedLogType === 'ocel' ? 'View OCPM' : 'View Process Map'}
                    <ArrowRight size={16} />
                  </button>
                )}
                <button
                  onClick={() => navigate(`/projects/${projectId}`)}
                  className="btn-secondary"
                >
                  Back to Project
                </button>
              </div>
            </div>

            {eventLogId && uploadedLogType !== 'ocel' && (
              <DataQualityCard eventLogId={eventLogId} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
