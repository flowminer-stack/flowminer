import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Upload,
  Activity,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  Search,
  FileText,
  Clock,
  BarChart3,
  CircleDot,
  Trash2,
  Target,
  GitCompareArrows,
  Wand2,
  Cpu,
  ChevronRight,
  Lock,
  CalendarRange,
  TrendingUp,
} from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';
import { projects as projectsApi, eventLogs as eventLogsApi } from '@/api/client';
import { useEventLogsStore, useUIStore, useProjectsStore, useAuthStore } from '@/store';
import type { Project, EventLog } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';

const statusConfig = {
  ready: { label: 'Ready', color: 'badge-emerald', icon: CheckCircle2 },
  processing: { label: 'Processing', color: 'badge-amber', icon: Clock },
  error: { label: 'Error', color: 'badge-rose', icon: AlertTriangle },
};

// Disabled-in-demo upload button — a consistent, obvious "this is off" state.
function DisabledUploadButton({
  label,
  size = 'md',
}: {
  label: string;
  size?: 'sm' | 'md';
}) {
  if (size === 'sm') {
    return (
      <button
        disabled
        title="Upload is disabled in demo mode"
        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] font-medium text-fg-muted cursor-not-allowed"
      >
        <Lock size={11} />
        {label}
        <span className="rounded bg-tint px-1 py-0 text-[10px] uppercase tracking-wider text-fg-faint">
          Demo
        </span>
      </button>
    );
  }
  return (
    <button
      disabled
      title="Upload is disabled in demo mode"
      className="btn-secondary shrink-0 cursor-not-allowed"
    >
      <Lock size={14} />
      {label}
      <span className="ml-1 rounded bg-tint px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
        Demo
      </span>
    </button>
  );
}

// Analyze-first, then Configure. Initiatives is elevated to a header CTA
// because it spans projects rather than being a per-project tool.
const analyzeTools = [
  { label: 'Benchmark', icon: GitCompareArrows, path: (id: string) => `/benchmark/${id}`, desc: 'Compare processes' },
  { label: 'Task Mining', icon: Cpu, path: (id: string) => `/task-mining/${id}`, desc: 'Discover tasks' },
];
const configureTools = [
  { label: 'Log Builder', icon: Wand2, path: (id: string) => `/builder/${id}`, desc: 'Build & transform' },
];

function lastIngestedAt(logs: EventLog[]): Date | null {
  if (logs.length === 0) return null;
  const times = logs.map((l) => new Date(l.created_at).getTime());
  return new Date(Math.max(...times));
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const { eventLogs, loading: logsLoading, fetchEventLogs, removeEventLog } = useEventLogsStore();
  const setCurrentProject = useProjectsStore((s) => s.setCurrentProject);
  const demoMode = useAuthStore((s) => s.demoMode);
  const addNotification = useUIStore((s) => s.addNotification);

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    const loadProject = async () => {
      setLoading(true);
      try {
        const p = await projectsApi.get(projectId);
        setProject(p);
        setCurrentProject(p);
      } catch {
        addNotification({ type: 'error', title: 'Failed to load project' });
        navigate('/projects');
      } finally {
        setLoading(false);
      }
    };
    loadProject();
    fetchEventLogs(projectId);
  }, [projectId, fetchEventLogs, setCurrentProject, addNotification, navigate]);

  if (loading || !project) {
    return <LoadingSpinner size="lg" text="Loading project…" fullPage />;
  }

  const readyLogs = eventLogs.filter((el) => el.status === 'ready');
  const totalCases = readyLogs.reduce((sum, el) => sum + el.total_cases, 0);
  const totalActivities = readyLogs.reduce((sum, el) => sum + el.total_activities, 0);
  const lastIngested = lastIngestedAt(readyLogs);

  return (
    <div>
      {/* Project header */}
      <div className="mb-7">
        <PageHeader
          title={project.name}
          description={project.description}
          subtitle={`Created ${format(new Date(project.created_at), 'MMM d, yyyy')}`}
          backTo="/projects"
          backLabel="Projects"
          actions={
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate(`/initiatives/${projectId}`)}
                className="btn-secondary"
              >
                <Target size={14} />
                Initiatives
              </button>
              <DisabledUploadButton label="Upload Log" />
            </div>
          }
        />
      </div>

      {/* Stats — three actually-useful tiles (dropped redundant "Event Logs" count) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mb-7">
        <div className="stat-card col-span-1">
          <div className="stat-icon bg-accent/10">
            <BarChart3 size={18} className="text-accent" />
          </div>
          <div>
            <p className="stat-value">{totalCases.toLocaleString()}</p>
            <p className="stat-label">Total Cases</p>
          </div>
        </div>
        <div className="stat-card col-span-1">
          <div className="stat-icon bg-success/10">
            <CircleDot size={18} className="text-success" />
          </div>
          <div>
            <p className="stat-value">{totalActivities.toLocaleString()}</p>
            <p className="stat-label">Unique Activities</p>
          </div>
        </div>
        <div className="stat-card col-span-1">
          <div className="stat-icon bg-warning/10">
            <CalendarRange size={18} className="text-warning" />
          </div>
          <div>
            <p className="stat-value text-[16px]">
              {lastIngested ? format(lastIngested, 'MMM d, yyyy') : 'No data'}
            </p>
            <p className="stat-label">Last ingested</p>
          </div>
        </div>
      </div>

      {/* Project tools — grouped by purpose */}
      <div className="mb-7">
        <h2 className="section-heading mb-3">Analyze</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {analyzeTools.map((tool) => (
            <ToolCard key={tool.label} tool={tool} projectId={projectId!} onNavigate={navigate} />
          ))}
        </div>
        <h2 className="section-heading mb-3 mt-5">Configure</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {configureTools.map((tool) => (
            <ToolCard key={tool.label} tool={tool} projectId={projectId!} onNavigate={navigate} />
          ))}
        </div>
      </div>

      {/* Event logs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="section-heading">Event Logs</h2>
          {eventLogs.length > 0 && <DisabledUploadButton label="Upload new" size="sm" />}
        </div>

        {logsLoading && eventLogs.length === 0 ? (
          <div className="mt-4">
            <LoadingSpinner text="Loading event logs…" />
          </div>
        ) : eventLogs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Upload size={20} />
            </div>
            <h3 className="empty-state-title">
              {demoMode ? 'No demo logs loaded yet' : 'No event logs yet'}
            </h3>
            <p className="empty-state-desc">
              {demoMode
                ? 'Demo data is resetting. Refresh in a moment.'
                : 'Upload your first event log to start discovering processes.'}
            </p>
            <div className="mt-5">
              <DisabledUploadButton label="Upload Event Log" />
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {eventLogs.map((eventLog) => (
              <EventLogCard
                key={eventLog.id}
                eventLog={eventLog}
                onNavigate={() =>
                  navigate(
                    eventLog.log_type === 'ocel'
                      ? `/ocpm/${eventLog.id}`
                      : `/process/${eventLog.id}`,
                  )
                }
                onDelete={async () => {
                  if (!window.confirm(`Delete "${eventLog.name}"? This cannot be undone.`)) return;
                  try {
                    await eventLogsApi.delete(eventLog.id);
                    removeEventLog(eventLog.id);
                    addNotification({ type: 'success', title: 'Event log deleted' });
                  } catch {
                    addNotification({ type: 'error', title: 'Failed to delete event log' });
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCard({
  tool,
  projectId,
  onNavigate,
}: {
  tool: { label: string; icon: any; path: (id: string) => string; desc: string };
  projectId: string;
  onNavigate: (to: string) => void;
}) {
  return (
    <button
      onClick={() => onNavigate(tool.path(projectId))}
      className="group flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-left transition-all duration-150 hover:border-line-strong hover:bg-surface-3"
      style={{ boxShadow: 'var(--shadow-xs)' }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tint transition-colors group-hover:bg-accent/10">
        <tool.icon size={16} className="text-fg-muted transition-colors group-hover:text-accent" />
      </div>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-fg leading-tight">{tool.label}</p>
        <p className="text-[12px] text-fg-muted mt-0.5 truncate">{tool.desc}</p>
      </div>
    </button>
  );
}

function EventLogCard({
  eventLog,
  onNavigate,
  onDelete,
}: {
  eventLog: EventLog;
  onNavigate: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const demoMode = useAuthStore((s) => s.demoMode);
  const status = statusConfig[eventLog.status];
  const StatusIcon = status.icon;

  const quickActions =
    eventLog.status === 'ready' && eventLog.log_type !== 'ocel'
      ? [
          { label: 'Process Map', icon: Activity, path: `/process/${eventLog.id}` },
          { label: 'Variants', icon: GitBranch, path: `/variants/${eventLog.id}` },
          { label: 'Bottlenecks', icon: AlertTriangle, path: `/bottlenecks/${eventLog.id}` },
          { label: 'Concept Drift', icon: TrendingUp, path: `/drift/${eventLog.id}` },
          { label: 'Conformance', icon: CheckCircle2, path: `/conformance/${eventLog.id}` },
          { label: 'Root Cause', icon: Search, path: `/root-cause/${eventLog.id}` },
        ]
      : eventLog.status === 'ready' && eventLog.log_type === 'ocel'
        ? [{ label: 'Object-Centric View', icon: Activity, path: `/ocpm/${eventLog.id}` }]
        : [];

  return (
    <div
      className="group card cursor-pointer transition-all duration-150 hover:border-line-strong overflow-hidden"
      style={{ '--tw-shadow': 'var(--shadow-sm)' } as React.CSSProperties}
      onClick={onNavigate}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          {/* Left: icon + info + status — all primary info lives on the left */}
          <div className="flex items-start gap-3.5 min-w-0 flex-1">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-3 mt-0.5">
              <FileText size={16} className="text-fg-muted" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-[14px] font-semibold text-fg leading-tight truncate">{eventLog.name}</h3>
                <span className={clsx('badge', status.color)}>
                  <StatusIcon size={11} />
                  {status.label}
                </span>
                {eventLog.log_type === 'ocel' && (
                  <span className="badge badge-accent">OCEL</span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-fg-muted">
                <span>{eventLog.total_events.toLocaleString()} events</span>
                <span className="text-fg-ghost">·</span>
                <span>{eventLog.total_cases.toLocaleString()} cases</span>
                <span className="text-fg-ghost">·</span>
                <span>{eventLog.total_activities} activities</span>
                <span className="text-fg-ghost">·</span>
                <span className="text-fg-faint">
                  {format(new Date(eventLog.created_at), 'MMM d, yyyy')}
                </span>
              </div>
            </div>
          </div>

          {/* Right: delete only. Single action, single purpose. */}
          {!demoMode && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="rounded-lg p-1.5 text-fg-faint transition-colors hover:bg-danger/10 hover:text-danger shrink-0"
              title="Delete event log"
              aria-label="Delete event log"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Quick actions bar */}
      {quickActions.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-line/60 bg-surface-1/50 px-4 py-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          {quickActions.map((action) => (
            <button
              key={action.label}
              onClick={() => navigate(action.path)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
            >
              <action.icon size={12} />
              {action.label}
            </button>
          ))}
          <div className="ml-auto">
            <button
              onClick={onNavigate}
              className="flex items-center gap-1 text-[12px] font-semibold text-accent hover:text-accent-hover transition-colors"
            >
              Open
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
