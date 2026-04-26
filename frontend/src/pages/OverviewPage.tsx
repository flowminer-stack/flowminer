import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderKanban,
  FileText,
  Activity,
  Bell,
  Target,
  DollarSign,
  TrendingUp,
  ArrowRight,
  Clock,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { mining } from '@/api/client';
import type { OverviewResponse } from '@/types';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';

export default function OverviewPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    mining
      .getOverview()
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load overview');
        setLoading(false);
      });
  };

  useEffect(load, []);

  if (loading) return <LoadingSpinner size="lg" text="Loading overview…" fullPage />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const { totals, alerts, initiatives, working_capital, recent_event_logs } = data;

  if (totals.event_logs === 0) {
    return (
      <div>
        <PageHeader
          title="Overview"
          icon={LayoutDashboard}
          description="Executive rollup across every project you can see."
        />
        <div className="mt-6">
          <EmptyState
            icon={FolderKanban}
            title="No event logs yet"
            description="Upload an event log to start seeing cross-project KPIs, alerts, and initiative rollups here."
            action={
              <button onClick={() => navigate('/projects')} className="btn-primary text-[12px]">
                Go to Projects
              </button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Overview"
        icon={LayoutDashboard}
        description="Executive rollup across every project you can see. Click a tile to drill in."
      />

      {/* Top band: stat tiles */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          icon={FolderKanban}
          label="Projects"
          value={totals.projects.toLocaleString()}
          href="/projects"
        />
        <StatTile
          icon={FileText}
          label="Event logs"
          value={totals.event_logs.toLocaleString()}
          href="/projects"
        />
        <StatTile
          icon={Activity}
          label="Total cases"
          value={totals.total_cases.toLocaleString()}
          href="/projects"
          tone="accent"
        />
        <StatTile
          icon={Zap}
          label="Total events"
          value={totals.total_events.toLocaleString()}
          href="/projects"
          tone="accent"
        />
        <StatTile
          icon={Bell}
          label="Active alerts"
          value={alerts.active.toLocaleString()}
          sub={
            alerts.triggered_last_24h > 0
              ? `${alerts.triggered_last_24h} fired in 24h`
              : undefined
          }
          href="/alerts"
          tone={alerts.triggered_last_24h > 0 ? 'warning' : undefined}
        />
        <StatTile
          icon={Target}
          label="Active initiatives"
          value={initiatives.active.toLocaleString()}
          sub={
            initiatives.achieved > 0
              ? `${initiatives.achieved} achieved`
              : undefined
          }
          href="/initiatives"
          tone="success"
        />
      </div>

      {/* Working capital / value summary */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Realized savings card */}
        <ValueCard
          icon={DollarSign}
          label="Realized savings"
          value={
            initiatives.realized_savings > 0
              ? '$' + initiatives.realized_savings.toLocaleString()
              : '—'
          }
          description={
            initiatives.total > 0
              ? `Tracked across ${initiatives.total} initiative${initiatives.total === 1 ? '' : 's'}`
              : 'No initiatives yet — start tracking savings from any bottleneck or conformance finding.'
          }
          actionLabel={initiatives.total === 0 ? 'Create an initiative' : 'View initiatives'}
          onAction={() => navigate('/initiatives')}
          tone="success"
        />

        {/* Cycle time / throughput summary */}
        <ValueCard
          icon={TrendingUp}
          label="Throughput density"
          value={
            totals.avg_events_per_case > 0
              ? totals.avg_events_per_case.toFixed(1) + ' events/case'
              : '—'
          }
          description={`${totals.total_activities.toLocaleString()} unique activities across ${totals.event_logs} ready logs.`}
          actionLabel="Open projects"
          onAction={() => navigate('/projects')}
          tone="accent"
        />

        {/* Working capital — drills into the cost-filtered projects list */}
        <ValueCard
          icon={DollarSign}
          label="Working capital"
          value={
            working_capital
              ? `${working_capital.logs_with_cost} log${working_capital.logs_with_cost === 1 ? '' : 's'} with cost data`
              : 'Not tracked'
          }
          description={
            working_capital
              ? 'Cost per case rolls up from event logs where you mapped a cost column. Click to filter projects to just the ones with cost data.'
              : 'Map a cost column on any event log and this tile will start tracking per-case cost and savings potential.'
          }
          actionLabel={working_capital ? 'See cost-tracked projects' : 'Manage event logs'}
          onAction={() =>
            navigate(working_capital ? '/projects?filter=has_cost' : '/projects')
          }
          tone="warning"
        />
      </div>

      {/* Recent activity feed */}
      <div className="mt-6 card p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold text-fg">Recent event logs</h2>
            <p className="mt-0.5 text-[12px] text-fg-muted">
              The {recent_event_logs.length} most recently uploaded logs.
            </p>
          </div>
          <Link
            to="/projects"
            className="text-[12px] font-semibold text-accent hover:text-accent-hover"
          >
            View all →
          </Link>
        </div>
        <div className="mt-4 divide-y divide-line/60">
          {recent_event_logs.map((log) => (
            <Link
              key={log.id}
              to={`/process/${log.id}`}
              className="group flex items-center gap-3 py-3 first:pt-0 last:pb-0 transition-colors"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10">
                <FileText size={14} className="text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-fg group-hover:text-accent transition-colors">
                  {log.name}
                </p>
                <div className="mt-0.5 flex items-center gap-3 text-[11px] text-fg-muted">
                  {log.project_name && (
                    <span className="truncate">{log.project_name}</span>
                  )}
                  <span className="tabular-nums">
                    {log.total_cases.toLocaleString()} cases · {log.total_events.toLocaleString()} events
                  </span>
                  {log.created_at && (
                    <span className="flex items-center gap-0.5 text-fg-faint">
                      <Clock size={10} />
                      {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
              <ArrowRight
                size={14}
                className="text-fg-ghost transition-all group-hover:translate-x-0.5 group-hover:text-fg-muted"
              />
            </Link>
          ))}
          {recent_event_logs.length === 0 && (
            <p className="py-6 text-center text-[12px] text-fg-muted">
              No recent activity.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Stat tile ──────────────────────────────────────────────────────────── */

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  href,
  tone,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
  sub?: string;
  href?: string;
  tone?: 'accent' | 'success' | 'warning';
}) {
  const iconColor =
    tone === 'success'
      ? 'text-success bg-success/10'
      : tone === 'warning'
        ? 'text-warning bg-warning/10'
        : 'text-accent bg-accent/10';

  const content = (
    <div className="card h-full p-4 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${iconColor}`}>
          <Icon size={14} />
        </div>
        {href && (
          <ArrowRight size={13} className="text-fg-ghost transition-colors group-hover:text-fg-muted" />
        )}
      </div>
      <p className="mt-3 text-[18px] font-bold tabular-nums text-fg leading-tight">{value}</p>
      <p className="mt-0.5 text-[11px] text-fg-muted">{label}</p>
      {sub && <p className="mt-1 text-[10px] text-fg-faint">{sub}</p>}
    </div>
  );

  if (href) {
    return (
      <Link to={href} className="group block">
        {content}
      </Link>
    );
  }
  return content;
}

/* ── Value card ─────────────────────────────────────────────────────────── */

function ValueCard({
  icon: Icon,
  label,
  value,
  description,
  actionLabel,
  onAction,
  tone,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  tone: 'accent' | 'success' | 'warning';
}) {
  const iconColor =
    tone === 'success'
      ? 'text-success bg-success/10'
      : tone === 'warning'
        ? 'text-warning bg-warning/10'
        : 'text-accent bg-accent/10';

  return (
    <button
      onClick={onAction}
      className="card group block w-full p-5 text-left transition-colors hover:border-line-strong"
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${iconColor}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {label}
          </p>
          <p className="mt-1 text-[22px] font-bold tabular-nums text-fg leading-tight">
            {value}
          </p>
        </div>
      </div>
      <p className="mt-3 text-[12px] text-fg-muted leading-relaxed">{description}</p>
      <span className="mt-3 inline-flex text-[12px] font-semibold text-fg-muted transition-colors group-hover:text-accent">
        {actionLabel} →
      </span>
    </button>
  );
}

