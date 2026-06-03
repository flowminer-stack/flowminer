import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Boxes,
  RefreshCw,
  ChevronDown,
  X,
  Check,
  BarChart3,
  Sparkles,
} from 'lucide-react';
import clsx from 'clsx';
import { ocel, projects as projectsApi, eventLogs as logsApi } from '@/api/client';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import ImprovementReport from '@/components/OCPM/ImprovementReport';
import OcelDropZone from '@/components/OCPM/OcelDropZone';
import MultiSelect from '@/components/OCPM/MultiSelect';
import SummaryCards from '@/components/OCPM/SummaryCards';
import OCDFGGraph from '@/components/OCPM/OCDFGGraph';
import OCELInsightsPanel from '@/components/OCPM/OCELInsightsPanel';
import NativeAnalysisHub from '@/components/OCPM/NativeAnalysisHub';
import AnalysisSection from '@/components/OCPM/AnalysisSection';
import { getTypeColor } from '@/components/OCPM/shared';
import type {
  OCELSummary,
  OCDFGResponse,
  EventLog,
} from '@/types';

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OCPMPage() {
  const { eventLogId } = useParams<{ eventLogId?: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);

  // State
  const [uploadLoading, setUploadLoading] = useState(false);
  const [convertLoading, setConvertLoading] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);

  const [summary, setSummary] = useState<OCELSummary | null>(null);
  const [dfg, setDfg] = useState<OCDFGResponse | null>(null);

  // Top-level page tab: 'overview' | 'analysis' | 'improvements'
  const [pageTab, setPageTab] = useState<'overview' | 'analysis' | 'improvements'>('overview');

  // Convert from existing event log
  const [allEventLogs, setAllEventLogs] = useState<EventLog[]>([]);
  const [eventLogsLoading, setEventLogsLoading] = useState(false);
  const [selectedEventLogId, setSelectedEventLogId] = useState('');
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [eventLogDropdownOpen, setEventLogDropdownOpen] = useState(false);
  const eventLogDropdownRef = useRef<HTMLDivElement>(null);

  // Load all event logs for the convert panel
  useEffect(() => {
    setEventLogsLoading(true);
    projectsApi.list().then(async (projs) => {
      const results = await Promise.allSettled(
        projs.map((p) => logsApi.list(p.id)),
      );
      const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      setAllEventLogs(all);
      setEventLogsLoading(false);
    }).catch(() => setEventLogsLoading(false));
  }, []);

  // Close event log dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (eventLogDropdownRef.current && !eventLogDropdownRef.current.contains(e.target as Node)) {
        setEventLogDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedLog = allEventLogs.find((l) => l.id === selectedEventLogId);
  const columnOptions = selectedLog
    ? [
        selectedLog.case_id_column,
        selectedLog.activity_column,
        selectedLog.timestamp_column,
        selectedLog.resource_column,
        ...(selectedLog.additional_columns ?? []),
      ].filter((c): c is string => Boolean(c))
    : [];

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSummaryLoaded = useCallback(async (s: OCELSummary) => {
    setSummary(s);
    setDfg(null);

    setDiscoverLoading(true);
    try {
      const g = await ocel.discover(s.ocel_id);
      setDfg(g);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Discovery failed',
        message: e instanceof Error ? e.message : 'Could not discover OC-DFG',
      });
    } finally {
      setDiscoverLoading(false);
    }
  }, [addNotification]);

  // Auto-load when navigated from project with an event log ID
  useEffect(() => {
    if (!eventLogId || summary) return;
    setDiscoverLoading(true);
    ocel
      .getSummary(eventLogId)
      .then((s) => handleSummaryLoaded(s))
      .catch(() => {
        addNotification({
          type: 'error',
          title: 'OCEL not found',
          message: 'The OCEL data may have been cleared. Please re-upload the file.',
        });
        setDiscoverLoading(false);
      });
  }, [eventLogId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = useCallback(async (file: File) => {
    setUploadLoading(true);
    try {
      const uploadResult = await ocel.upload(file);
      const ocelId = (uploadResult as any).id ?? (uploadResult as any).ocel_id;
      addNotification({ type: 'success', title: 'OCEL uploaded', message: `${uploadResult.event_count} events loaded` });
      const fullSummary = await ocel.getSummary(ocelId);
      await handleSummaryLoaded(fullSummary);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Upload failed',
        message: e instanceof Error ? e.message : 'Could not upload OCEL file',
      });
    } finally {
      setUploadLoading(false);
    }
  }, [addNotification, handleSummaryLoaded]);

  const handleConvert = useCallback(async () => {
    if (!selectedEventLogId || selectedColumns.length === 0) return;
    setConvertLoading(true);
    try {
      const convertResult = await ocel.convert(selectedEventLogId, selectedColumns);
      const ocelId = (convertResult as any).id ?? (convertResult as any).ocel_id;
      addNotification({ type: 'success', title: 'Converted to OCEL', message: `${convertResult.object_types.length} object types` });
      const fullSummary = await ocel.getSummary(ocelId);
      await handleSummaryLoaded(fullSummary);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Conversion failed',
        message: e instanceof Error ? e.message : 'Could not convert event log',
      });
    } finally {
      setConvertLoading(false);
    }
  }, [selectedEventLogId, selectedColumns, addNotification, handleSummaryLoaded]);

  const handleFlatten = useCallback(async (objectType: string) => {
    if (!summary) return;
    try {
      const result = await ocel.flatten(summary.ocel_id, objectType);
      if (result?.event_log_id) {
        navigate(`/process/${result.event_log_id}`);
      } else {
        addNotification({ type: 'info', title: 'Flatten complete', message: `Flattened for "${objectType}"` });
      }
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Flatten failed',
        message: e instanceof Error ? e.message : 'Could not flatten OCEL',
      });
    }
  }, [summary, navigate, addNotification]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <PageHeader
        title="Object-Centric Process Mining"
        icon={Boxes}
        description="Discover object-centric directly-follows graphs from OCEL 2.0 data or convert existing event logs."
      />

      {/* Loading state when auto-loading from event log */}
      {!summary && eventLogId && (
        <div className="mt-8">
          <LoadingSpinner size="lg" text="Loading OCEL data..." fullPage />
        </div>
      )}

      {/* Entry panels */}
      {!summary && !eventLogId && !discoverLoading && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Upload OCEL */}
          <div className="card p-4">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">Upload OCEL File</h2>
            <OcelDropZone onFile={handleUpload} loading={uploadLoading} />
          </div>

          {/* Convert from event log */}
          <div className="card p-4">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">Convert from Event Log</h2>

            {/* Event log selector */}
            <div className="mb-3">
              <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">Event Log</label>
              <div className="relative" ref={eventLogDropdownRef}>
                <button
                  type="button"
                  onClick={() => setEventLogDropdownOpen((o) => !o)}
                  disabled={eventLogsLoading}
                  className="flex w-full items-center justify-between rounded-md border border-line bg-surface-1 px-3 py-2 text-left text-[12px] text-fg-secondary transition-colors hover:border-accent/50 focus:outline-none disabled:opacity-50"
                >
                  <span className={clsx('truncate', !selectedLog && 'text-fg-muted')}>
                    {eventLogsLoading
                      ? 'Loading event logs…'
                      : selectedLog
                        ? selectedLog.name
                        : 'Select an event log'}
                  </span>
                  <ChevronDown
                    size={12}
                    className={clsx('ml-2 shrink-0 text-fg-faint transition-transform', eventLogDropdownOpen && 'rotate-180')}
                  />
                </button>
                {eventLogDropdownOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-full animate-fade-in overflow-y-auto rounded-md border border-line bg-surface-2 py-1 shadow-xl">
                    {allEventLogs.length === 0 ? (
                      <p className="px-3 py-2 text-[11px] text-fg-faint">No event logs found</p>
                    ) : (
                      allEventLogs.map((log) => (
                        <button
                          key={log.id}
                          type="button"
                          onClick={() => {
                            setSelectedEventLogId(log.id);
                            setSelectedColumns([]);
                            setEventLogDropdownOpen(false);
                          }}
                          className={clsx(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-tint',
                            log.id === selectedEventLogId ? 'text-accent' : 'text-fg-secondary',
                          )}
                        >
                          {log.id === selectedEventLogId && <Check size={11} className="shrink-0" />}
                          <span className="truncate">{log.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Column multi-select */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">
                Object Type Columns
              </label>
              <MultiSelect
                options={columnOptions}
                selected={selectedColumns}
                onChange={setSelectedColumns}
                placeholder={selectedLog ? 'Select columns…' : 'Select an event log first'}
              />
              <p className="mt-1 text-[10px] text-fg-faint">
                Each selected column becomes an object type in the OCEL.
              </p>
            </div>

            <button
              onClick={handleConvert}
              disabled={!selectedEventLogId || selectedColumns.length === 0 || convertLoading}
              className="btn-primary w-full"
            >
              {convertLoading ? (
                <span className="flex items-center gap-2">
                  <RefreshCw size={13} className="animate-spin" />
                  Converting…
                </span>
              ) : (
                'Convert to OCEL'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {summary && (
        <div className="flex flex-col gap-4">
          {/* Summary + actions */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <SummaryCards summary={summary} />
            </div>
            <button
              onClick={() => { setSummary(null); setDfg(null); setPageTab('overview'); }}
              className="btn-ghost mt-1 shrink-0 text-[11px]"
            >
              <X size={13} />
              Reset
            </button>
          </div>

          {/* ── OCEL Insights ─────────────────────────────────────────────── */}
          <OCELInsightsPanel ocelId={summary.ocel_id} />

          {/* ── Page tab bar + Ask AI ───────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-1 p-1 w-fit">
              {([
                { id: 'overview', label: 'Overview', icon: Boxes },
                { id: 'analysis', label: 'Analysis', icon: BarChart3 },
                { id: 'improvements', label: 'Improvements', icon: Sparkles },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPageTab(t.id)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-medium transition-colors',
                    pageTab === t.id
                      ? 'bg-accent text-white'
                      : 'text-fg-muted hover:bg-tint hover:text-fg-secondary',
                  )}
                >
                  <t.icon size={12} />
                  {t.label}
                </button>
              ))}
            </div>

            {/* Ask AI lives next to the page tabs because, like the
                tabs, it is scoped to the current OCEL. The floating
                chat panel opens with a prefilled question about the
                log the operator is looking at. */}
            <button
              onClick={() =>
                useUIStore.getState().askAI(
                  `What are the most important findings for this OCEL log across its ${summary.object_types.length} object types?`,
                )
              }
              className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-accent/90"
              title="Ask AI about this OCEL log"
              data-tour="ask-ai"
            >
              <Sparkles size={12} />
              Ask AI
            </button>
          </div>

          {/* ── Overview tab ──────────────────────────────────────────────── */}
          {pageTab === 'overview' && (
            <>
              {/* Per-Object-Type Analysis (flatten) — clicking a type
                  flattens the OCEL into a standard log for that type and
                  opens its full process view. */}
              <div className="card p-4">
                <h3 className="mb-1 text-[13px] font-semibold text-fg">
                  Analyze by Object Type
                </h3>
                <p className="mb-3 text-[11px] text-fg-muted">
                  Select an object type to open its process view with full analysis — process map,
                  variants, bottlenecks, conformance, 13+ analysis algorithms, and more.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {summary.object_types.map((type) => {
                    const color = getTypeColor(summary.object_types, type);
                    const count = summary.objects_per_type?.[type] ?? 0;
                    return (
                      <button
                        key={type}
                        onClick={() => handleFlatten(type)}
                        className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-1 px-3.5 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-fg">{type}</p>
                          <p className="text-[10px] text-fg-muted">{count.toLocaleString()} objects</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* OC-DFG Graph */}
              <div className="card overflow-hidden" style={{ height: '480px' }}>
                {discoverLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <LoadingSpinner size="lg" text="Discovering OC-DFG…" />
                  </div>
                ) : dfg ? (
                  <OCDFGGraph data={dfg} summary={summary} />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="text-center">
                      <Boxes size={36} className="mx-auto mb-2 text-fg-ghost" />
                      <p className="text-[12px] text-fg-muted">OC-DFG not available</p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── OCEL-Native Analysis Panels (existing 3) ──────────────── */}
              <AnalysisSection
                ocelId={summary.ocel_id}
                objectTypes={summary.object_types}
              />
            </>
          )}

          {/* ── Analysis tab ──────────────────────────────────────────────── */}
          {pageTab === 'analysis' && (
            <NativeAnalysisHub
              ocelId={summary.ocel_id}
              objectTypes={summary.object_types}
            />
          )}

          {/* ── Improvements tab ──────────────────────────────────────────── */}
          {pageTab === 'improvements' && (
            <ImprovementReport ocelId={summary.ocel_id} />
          )}
        </div>
      )}
    </div>
  );
}
