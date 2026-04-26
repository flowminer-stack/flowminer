import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Upload } from 'lucide-react';
import clsx from 'clsx';
import { eventLogs as eventLogsApi, projects as projectsApi } from '@/api/client';
import type { Project, EventLogPreview, ColumnMapping } from '@/types';
import FileUpload from '@/components/common/FileUpload';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore, useEventLogsStore, useAuthStore } from '@/store';
import DataQualityCard from '@/components/DataQuality/DataQualityCard';

type Step = 'upload' | 'mapping' | 'done';

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
  const [mapping, setMapping] = useState<ColumnMapping>({
    case_id_column: '',
    activity_column: '',
    timestamp_column: '',
  });
  // Confidence score (0-1) per target field, populated by the fuzzy
  // auto-mapper. Shown in the mapping UI as a small percentage pill
  // next to each field (Mehrwerk mpmX parity).
  const [confidence, setConfidence] = useState<{
    case_id_column: number;
    activity_column: number;
    timestamp_column: number;
    resource_column: number;
    cost_column: number;
  }>({
    case_id_column: 0,
    activity_column: 0,
    timestamp_column: 0,
    resource_column: 0,
    cost_column: 0,
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

    // Standard logs: load preview and auto-detect column mapping
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
        case_id_column: [
          ['case', 0.6],
          ['trace', 0.5],
          ['journey', 0.4],
          ['order', 0.3],
          ['ticket', 0.3],
          ['instance', 0.4],
          ['_id', 0.3],
          ['id', 0.2],
        ],
        activity_column: [
          ['activity', 0.7],
          ['event', 0.5],
          ['action', 0.4],
          ['step', 0.4],
          ['status', 0.3],
          ['stage', 0.3],
          ['task', 0.4],
        ],
        timestamp_column: [
          ['time', 0.5],
          ['date', 0.4],
          ['ts', 0.4],
          ['created', 0.4],
          ['updated', 0.4],
          ['started', 0.4],
          ['completed', 0.4],
          ['timestamp', 0.7],
        ],
        resource_column: [
          ['resource', 0.7],
          ['user', 0.4],
          ['agent', 0.4],
          ['owner', 0.3],
          ['assignee', 0.5],
          ['performed_by', 0.6],
          ['handler', 0.4],
        ],
        cost_column: [
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

      const autoMapping: ColumnMapping = {
        case_id_column: '',
        activity_column: '',
        timestamp_column: '',
      };
      const autoConf = {
        case_id_column: 0,
        activity_column: 0,
        timestamp_column: 0,
        resource_column: 0,
        cost_column: 0,
      };
      for (const field of Object.keys(targets)) {
        let best: { col: string; score: number } | null = null;
        for (const col of p.columns) {
          const s = scoreCol(col, targets[field]);
          if (s > 0 && (!best || s > best.score)) best = { col, score: s };
        }
        if (best) {
          (autoMapping as any)[field] = best.col;
          (autoConf as any)[field] = best.score;
        }
      }

      setMapping(autoMapping);
      setConfidence(autoConf);
    } catch {
      // Preview may fail, continue anyway
    } finally {
      setPreviewLoading(false);
    }

    setStep('mapping');
  };

  const handleSaveMapping = async () => {
    if (!eventLogId) return;

    setMappingSaving(true);
    try {
      await eventLogsApi.setColumnMapping(eventLogId, mapping);
      addNotification({
        type: 'success',
        title: 'Column mapping saved',
        message: 'Your event log is being processed.',
      });
      setStep('done');
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to save mapping',
      });
    } finally {
      setMappingSaving(false);
    }
  };

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
    <div className="mx-auto max-w-3xl">
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
              Upload a CSV, XES, Excel, Parquet, or OCEL file containing your event data.
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
            <h2 className="text-[14px] font-semibold text-fg">
              Map your columns
            </h2>
            <p className="mt-1 text-[12px] text-fg-muted">
              Tell us which columns contain the case ID, activity, and timestamp.
            </p>

            {previewLoading ? (
              <div className="mt-6">
                <LoadingSpinner text="Loading file preview..." />
              </div>
            ) : (
              <>
                {/* Column mapping form */}
                <div className="mt-6 space-y-4">
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="block text-[12px] font-medium text-fg-muted">
                        Case ID Column <span className="text-danger">*</span>
                      </label>
                      <ConfidencePill score={confidence.case_id_column} />
                    </div>
                    <select
                      value={mapping.case_id_column}
                      onChange={(e) =>
                        setMapping({ ...mapping, case_id_column: e.target.value })
                      }
                      className="select mt-1.5"
                    >
                      <option value="">Select column...</option>
                      {preview?.columns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <label className="block text-[12px] font-medium text-fg-muted">
                        Activity Column <span className="text-danger">*</span>
                      </label>
                      <ConfidencePill score={confidence.activity_column} />
                    </div>
                    <select
                      value={mapping.activity_column}
                      onChange={(e) =>
                        setMapping({ ...mapping, activity_column: e.target.value })
                      }
                      className="select mt-1.5"
                    >
                      <option value="">Select column...</option>
                      {preview?.columns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <label className="block text-[12px] font-medium text-fg-muted">
                        Timestamp Column <span className="text-danger">*</span>
                      </label>
                      <ConfidencePill score={confidence.timestamp_column} />
                    </div>
                    <select
                      value={mapping.timestamp_column}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          timestamp_column: e.target.value,
                        })
                      }
                      className="select mt-1.5"
                    >
                      <option value="">Select column...</option>
                      {preview?.columns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted">
                      Resource Column{' '}
                      <span className="font-normal text-fg-faint">
                        (optional)
                      </span>
                    </label>
                    <select
                      value={mapping.resource_column ?? ''}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          resource_column: e.target.value || undefined,
                        })
                      }
                      className="select mt-1.5"
                    >
                      <option value="">None</option>
                      {preview?.columns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted">
                      Cost Column{' '}
                      <span className="font-normal text-fg-faint">
                        (optional)
                      </span>
                    </label>
                    <select
                      value={mapping.cost_column ?? ''}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          cost_column: e.target.value || undefined,
                        })
                      }
                      className="select mt-1.5"
                    >
                      <option value="">None</option>
                      {preview?.columns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Preview table */}
                {preview && preview.sample_rows.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-[13px] font-medium text-fg-secondary">
                      Data Preview
                    </h3>
                    <div className="mt-2 overflow-x-auto rounded-lg border border-line">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-surface-3">
                            {preview.columns.map((col) => (
                              <th
                                key={col}
                                className="whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted"
                              >
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sample_rows.slice(0, 5).map((row, i) => (
                            <tr
                              key={i}
                              className="border-t border-line/40"
                            >
                              {preview.columns.map((col) => (
                                <td
                                  key={col}
                                  className="whitespace-nowrap px-3 py-2 text-[12px] text-fg-secondary"
                                >
                                  {String(row[col] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-1 text-[11px] text-fg-faint">
                      Showing {Math.min(5, preview.sample_rows.length)} of{' '}
                      {preview.total_rows.toLocaleString()} rows
                    </p>
                  </div>
                )}

                {/* Actions */}
                <div className="mt-6 flex justify-end gap-3">
                  <button
                    onClick={() => setStep('upload')}
                    className="btn-secondary"
                  >
                    <ArrowLeft size={16} />
                    Back
                  </button>
                  <button
                    onClick={handleSaveMapping}
                    disabled={
                      mappingSaving ||
                      !mapping.case_id_column ||
                      !mapping.activity_column ||
                      !mapping.timestamp_column
                    }
                    className="btn-primary"
                  >
                    {mappingSaving ? (
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                        Saving...
                      </div>
                    ) : (
                      <>
                        Save & Process
                        <ArrowRight size={16} />
                      </>
                    )}
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
              <div className="mt-8 flex gap-3">
                <button
                  onClick={() => navigate(`/projects/${projectId}`)}
                  className="btn-secondary"
                >
                  Back to Project
                </button>
                {eventLogId && (
                  <button
                    onClick={() => navigate(
                      uploadedLogType === 'ocel'
                        ? `/ocpm/${eventLogId}`
                        : `/process/${eventLogId}`,
                    )}
                    className="btn-primary"
                  >
                    {uploadedLogType === 'ocel' ? 'View OCPM' : 'View Process Map'}
                    <ArrowRight size={16} />
                  </button>
                )}
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

// Small confidence badge next to each auto-mapped column. Shown only
// when a suggestion exists. Colour scales with the score so users can
// tell at a glance which suggestions to double-check.
function ConfidencePill({ score }: { score: number }) {
  if (!score) return null;
  const pct = Math.round(score * 100);
  const tone =
    pct >= 70 ? 'text-success bg-success/10' : pct >= 40 ? 'text-warning bg-warning/10' : 'text-fg-muted bg-tint';
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${tone}`} title="Auto-mapping confidence">
      auto · {pct}%
    </span>
  );
}
