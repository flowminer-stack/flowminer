import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Upload, Plus, Trash2, ArrowRight, Wand2 } from 'lucide-react';
import { logBuilder } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore } from '@/store';

interface ColumnInfo {
  name: string;
  dtype: string;
  kind: string;
  nunique: number;
  null_ratio: number;
}

interface Preview {
  staging_path: string;
  file_name: string;
  columns: ColumnInfo[];
  sample_rows: any[];
  total_rows: number;
}

interface EventMapping {
  id: number;
  activity_name: string;
  timestamp_column: string;
}

const KIND_COLORS: Record<string, string> = {
  datetime: 'badge-accent',
  datetime_like: 'badge-accent',
  numeric: 'badge-emerald',
  text: 'badge-slate',
};

export default function EventLogBuilderPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [uploading, setUploading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [logName, setLogName] = useState('Built log');
  const [caseIdColumn, setCaseIdColumn] = useState('');
  const [resourceColumn, setResourceColumn] = useState<string>('');
  const [events, setEvents] = useState<EventMapping[]>([]);
  const [passthrough, setPassthrough] = useState<string[]>([]);
  const [nextId, setNextId] = useState(1);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const r = await logBuilder.uploadRaw(file);
      setPreview(r);
      // Auto-suggest: first non-datetime column as case id, auto-detect timestamp columns
      const nonDatetime = r.columns.find((c: ColumnInfo) => c.kind !== 'datetime' && c.kind !== 'datetime_like');
      if (nonDatetime) setCaseIdColumn(nonDatetime.name);
      const tsCols = r.columns.filter((c: ColumnInfo) => c.kind === 'datetime' || c.kind === 'datetime_like');
      const mapped = tsCols.slice(0, 6).map((c: ColumnInfo, i: number) => ({
        id: i + 1,
        activity_name: humanize(c.name),
        timestamp_column: c.name,
      }));
      setEvents(mapped);
      setNextId(mapped.length + 1);
    } catch (err: any) {
      addNotification({ type: 'error', title: 'Upload failed', message: err?.response?.data?.detail || String(err) });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const addEvent = () => {
    setEvents([...events, { id: nextId, activity_name: '', timestamp_column: '' }]);
    setNextId(nextId + 1);
  };

  const removeEvent = (id: number) => setEvents(events.filter((e) => e.id !== id));

  const updateEvent = (id: number, field: keyof EventMapping, value: string) =>
    setEvents(events.map((e) => (e.id === id ? { ...e, [field]: value } : e)));

  const togglePassthrough = (col: string) =>
    setPassthrough((p) => (p.includes(col) ? p.filter((c) => c !== col) : [...p, col]));

  const canBuild =
    preview &&
    caseIdColumn &&
    events.length > 0 &&
    events.every((e) => e.activity_name && e.timestamp_column) &&
    logName;

  const handleBuild = async () => {
    if (!canBuild || !projectId || !preview) return;
    setBuilding(true);
    try {
      const r = await logBuilder.build({
        project_id: projectId,
        name: logName,
        staging_path: preview.staging_path,
        case_id_column: caseIdColumn,
        events: events.map((e) => ({ activity_name: e.activity_name, timestamp_column: e.timestamp_column })),
        resource_column: resourceColumn || null,
        passthrough_columns: passthrough,
      });
      addNotification({ type: 'success', title: `Built event log: ${r.total_events} events` });
      navigate(`/process/${r.event_log_id}`);
    } catch (err: any) {
      addNotification({
        type: 'error',
        title: 'Build failed',
        message: err?.response?.data?.detail || String(err),
      });
    } finally {
      setBuilding(false);
    }
  };

  if (uploading) return <LoadingSpinner size="lg" text="Uploading..." fullPage />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Event Log Builder"
        icon={Wand2}
        description="Turn a wide table with multiple timestamp columns into a standard event log"
        backTo={-1}
      />

      {!preview ? (
        <div className="rounded-lg border-2 border-dashed border-line bg-surface-1 p-12 text-center">
          <Upload size={32} className="mx-auto text-fg-faint" />
          <p className="mt-3 text-[13px] text-fg-muted">Upload a raw table (CSV, Parquet, or Excel)</p>
          <p className="mt-1 text-[11px] text-fg-faint">
            The file should have one row per case with timestamp columns for each step
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.parquet,.xlsx,.xls"
            onChange={handleUpload}
            className="hidden"
          />
          <button onClick={() => fileInputRef.current?.click()} className="btn-primary mt-4">
            Choose file
          </button>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[13px] font-semibold text-fg">{preview.file_name}</h2>
                <p className="text-[11px] text-fg-faint">
                  {preview.total_rows.toLocaleString()} rows · {preview.columns.length} columns
                </p>
              </div>
              <button onClick={() => setPreview(null)} className="btn-ghost text-[11px]">
                Start over
              </button>
            </div>

            <div className="mt-4 overflow-x-auto rounded border border-line">
              <table className="w-full text-[10px]">
                <thead className="bg-tint/40 text-fg-faint">
                  <tr>
                    {preview.columns.slice(0, 12).map((c) => (
                      <th key={c.name} className="px-2 py-1.5 text-left">
                        <div className="text-[11px] font-semibold text-fg">{c.name}</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`badge ${KIND_COLORS[c.kind] || 'badge-slate'}`}>{c.kind}</span>
                          <span className="text-fg-faint">{c.nunique}u</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample_rows.slice(0, 6).map((row, i) => (
                    <tr key={i} className="border-t border-line">
                      {preview.columns.slice(0, 12).map((c) => (
                        <td key={c.name} className="px-2 py-1 text-fg-muted">
                          {String(row[c.name] ?? '').slice(0, 40)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-lg border border-line bg-surface-1 p-4">
              <h2 className="mb-3 text-[13px] font-semibold text-fg">Configuration</h2>
              <div className="space-y-3">
                <Field label="New event log name">
                  <input className="input w-full" value={logName} onChange={(e) => setLogName(e.target.value)} />
                </Field>
                <Field label="Case ID column">
                  <select
                    className="input w-full"
                    value={caseIdColumn}
                    onChange={(e) => setCaseIdColumn(e.target.value)}
                  >
                    <option value="">— Select —</option>
                    {preview.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Resource column (optional)">
                  <select
                    className="input w-full"
                    value={resourceColumn}
                    onChange={(e) => setResourceColumn(e.target.value)}
                  >
                    <option value="">— None —</option>
                    {preview.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Passthrough columns (optional)">
                  <div className="flex flex-wrap gap-1">
                    {preview.columns
                      .filter((c) => c.name !== caseIdColumn && !events.find((e) => e.timestamp_column === c.name))
                      .map((c) => {
                        const sel = passthrough.includes(c.name);
                        return (
                          <button
                            key={c.name}
                            onClick={() => togglePassthrough(c.name)}
                            className={`rounded border px-2 py-0.5 text-[10px] ${
                              sel ? 'border-accent bg-accent/10 text-accent' : 'border-line text-fg-muted'
                            }`}
                          >
                            {c.name}
                          </button>
                        );
                      })}
                  </div>
                </Field>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface-1 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-fg">Events</h2>
                <button onClick={addEvent} className="btn-ghost flex items-center gap-1 text-[11px]">
                  <Plus size={12} /> Add event
                </button>
              </div>
              <div className="space-y-2">
                {events.length === 0 && (
                  <p className="py-4 text-center text-[11px] text-fg-faint">No events mapped yet</p>
                )}
                {events.map((ev) => (
                  <div key={ev.id} className="flex items-center gap-2 rounded border border-line bg-tint/20 p-2">
                    <input
                      className="input flex-1 text-[11px]"
                      placeholder="Activity name"
                      value={ev.activity_name}
                      onChange={(e) => updateEvent(ev.id, 'activity_name', e.target.value)}
                    />
                    <ArrowRight size={13} className="text-fg-faint" />
                    <select
                      className="input flex-1 text-[11px]"
                      value={ev.timestamp_column}
                      onChange={(e) => updateEvent(ev.id, 'timestamp_column', e.target.value)}
                    >
                      <option value="">— Timestamp column —</option>
                      {preview.columns
                        .filter((c) => c.kind === 'datetime' || c.kind === 'datetime_like')
                        .map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                    <button onClick={() => removeEvent(ev.id)} className="btn-ghost p-1 text-danger">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleBuild}
              disabled={!canBuild || building}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              <Wand2 size={14} />
              {building ? 'Building...' : 'Build event log'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-fg-muted">{label}</label>
      {children}
    </div>
  );
}

function humanize(col: string): string {
  return col
    .replace(/_at$|_ts$|_time$|_date$|_timestamp$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .trim() || col;
}
