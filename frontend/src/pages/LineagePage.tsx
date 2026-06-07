import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  GitBranch,
  Share2,
  LayoutDashboard,
  Bell,
  Workflow,
  Target,
  Zap,
  Gauge,
  CalendarClock,
  Database,
  StickyNote,
  History,
  AlertTriangle,
  ShieldCheck,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { lineage as lineageApi } from '@/api/lineage';
import type { EventLogLineage, LineageRef } from '@/types/lineage';
import PageHeader from '@/components/common/PageHeader';
import FeatureGuide from '@/components/common/FeatureGuide';
import EmptyState from '@/components/common/EmptyState';
import ErrorState from '@/components/common/ErrorState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { formatNumber, formatDate } from '@/utils/format';

// ─── Dependency group descriptor ─────────────────────────────────────────────

interface DepGroup {
  key: string;
  label: string;
  singular: string;
  icon: LucideIcon;
  items: { id: string; name: string; meta?: string; muted?: boolean }[];
  /** Builds an in-app link for an item, when one exists. */
  href?: (id: string) => string;
  /** Why deleting the log affects these resources. */
  impact: string;
}

export default function LineagePage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<EventLogLineage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLineage = () => {
    if (!eventLogId) return;
    setLoading(true);
    setError(null);
    lineageApi
      .get(eventLogId)
      .then((res) => setData(res))
      .catch((e) =>
        setError(
          e?.response?.data?.detail ||
            e?.message ||
            'Failed to load lineage for this event log.',
        ),
      )
      .finally(() => setLoading(false));
  };

  useEffect(fetchLineage, [eventLogId]);

  const groups = useMemo<DepGroup[]>(() => {
    if (!data) return [];
    return [
      {
        key: 'dashboards',
        label: 'Dashboards',
        singular: 'dashboard',
        icon: LayoutDashboard,
        items: data.dashboards.map((d: LineageRef) => ({ id: d.id, name: d.name })),
        href: (id) => `/dashboards/${id}`,
        impact: 'Widgets sourced from this log would stop rendering.',
      },
      {
        key: 'alerts',
        label: 'Alerts',
        singular: 'alert',
        icon: Bell,
        items: data.alerts.map((a) => ({
          id: a.id,
          name: a.name,
          meta: a.is_active ? 'active' : 'paused',
          muted: !a.is_active,
        })),
        href: () => '/alerts',
        impact: 'Monitors evaluating this log would stop firing.',
      },
      {
        key: 'custom_kpis',
        label: 'Custom KPIs',
        singular: 'KPI',
        icon: Gauge,
        items: data.custom_kpis.map((k) => ({ id: k.id, name: k.name, meta: k.metric })),
        impact: 'Derived metrics would lose their data source.',
      },
      {
        key: 'initiatives',
        label: 'Initiatives',
        singular: 'initiative',
        icon: Target,
        items: data.initiatives.map((i) => ({
          id: i.id,
          name: i.name,
          meta: `${i.status} · ${i.metric}`,
        })),
        impact: 'Value-tracking baselines and targets reference this log.',
      },
      {
        key: 'action_rules',
        label: 'Action Rules',
        singular: 'rule',
        icon: Zap,
        items: data.action_rules.map((r) => ({
          id: r.id,
          name: r.name,
          meta: `${r.enabled ? 'enabled' : 'disabled'} · fired ${formatNumber(r.trigger_count)}×`,
          muted: !r.enabled,
        })),
        href: () => '/action-rules',
        impact: 'Automation triggered by this log would stop running.',
      },
      {
        key: 'scheduled_reports',
        label: 'Scheduled Reports',
        singular: 'report',
        icon: CalendarClock,
        items: data.scheduled_reports.map((s) => ({ id: s.id, name: s.name, meta: s.frequency })),
        impact: 'Recurring exports built on this log would fail.',
      },
      {
        key: 'etl_pipelines',
        label: 'ETL Pipelines',
        singular: 'pipeline',
        icon: Workflow,
        items: data.etl_pipelines.map((e) => ({ id: e.id, name: e.name })),
        href: () => '/connectors',
        impact: 'Ingestion that feeds this project would lose its target.',
      },
      {
        key: 'derived_logs',
        label: 'Derived Logs',
        singular: 'derived log',
        icon: Database,
        items: data.derived_logs.map((d) => ({
          id: d.id,
          name: d.name,
          meta: d.created_at ? formatDate(d.created_at) : undefined,
        })),
        impact: 'OCEL flattens and builder outputs derived from this log.',
      },
    ];
  }, [data]);

  // ─── Loading / error / empty ────────────────────────────────────────────
  if (loading) {
    return <LoadingSpinner size="lg" text="Tracing data lineage…" fullPage />;
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Data Lineage" icon={GitBranch} backTo={-1} />
        <div className="mt-6">
          <ErrorState message={error} onRetry={fetchLineage} />
        </div>
      </div>
    );
  }

  if (!data) return null;

  // ─── Impact summary ──────────────────────────────────────────────────────
  const directDeps = groups.reduce((sum, g) => sum + g.items.length, 0);
  const totalImpacted = directDeps + data.annotations_count;
  const hasImpact = totalImpacted > 0;
  const populatedGroups = groups.filter((g) => g.items.length > 0);

  const log = data.event_log;

  return (
    <div>
      <PageHeader
        title="Data Lineage & Impact"
        icon={GitBranch}
        backTo={-1}
        description="Everything downstream that depends on this event log. Review before deleting, re-importing, or changing its column mapping — these resources would be affected."
        subtitle={
          <>
            {log.name} &mdash; {formatNumber(log.total_cases ?? 0)} cases,{' '}
            {formatNumber(log.total_events ?? 0)} events
            {log.created_at && <> &middot; added {formatDate(log.created_at)}</>}
          </>
        }
      />
      <FeatureGuide
        storageKey="lineage"
        icon={Share2}
        title="What data lineage tells you"
        lead="Every dashboard, KPI, alert, report and scheduled job that depends on this event log, in one place — so before you re-ingest, filter or delete the log you know exactly what breaks downstream."
        steps={[
          { label: 'Scan the dependents', detail: 'grouped by type — dashboards, reports, alerts, KPIs' },
          { label: 'Gauge the blast radius', detail: 'the counts show how widely this log is relied on' },
          { label: 'Change it safely', detail: 'update or retire the log knowing what it affects' },
        ]}
      />

      {/* Deletion-impact banner */}
      <div
        className={clsx(
          'mt-6 flex items-start gap-3 rounded-xl border p-4',
          hasImpact
            ? 'border-warning/30 bg-warning/5'
            : 'border-success/30 bg-success/5',
        )}
      >
        <div
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            hasImpact ? 'bg-warning/10' : 'bg-success/10',
          )}
        >
          {hasImpact ? (
            <AlertTriangle size={18} className="text-warning" />
          ) : (
            <ShieldCheck size={18} className="text-success" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-fg">
            {hasImpact
              ? `Deleting this log would affect ${totalImpacted} downstream resource${totalImpacted !== 1 ? 's' : ''}.`
              : 'No downstream resources depend on this log.'}
          </p>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {hasImpact
              ? 'The items below reference this event log directly or through its project. Re-point or remove them first to avoid broken views.'
              : 'It is safe to delete or re-import without breaking dashboards, alerts, KPIs, or automations.'}
          </p>
        </div>
      </div>

      {/* Stat strip */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={GitBranch}
          value={directDeps}
          label="Direct dependents"
          tone="accent"
        />
        <StatCard
          icon={Database}
          value={data.derived_logs.length}
          label="Derived logs"
          tone="accent"
        />
        <StatCard
          icon={StickyNote}
          value={data.annotations_count}
          label="Annotations"
          tone="muted"
        />
        <StatCard
          icon={History}
          value={data.version_history_count}
          label="Version records"
          tone="muted"
        />
      </div>

      {/* Dependency groups */}
      {!hasImpact ? (
        <div className="mt-6">
          <EmptyState
            icon={ShieldCheck}
            title="No downstream dependencies"
            description="Nothing references this event log yet. As you build dashboards, alerts, KPIs, and automations on top of it, they'll appear here."
          />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {populatedGroups.map((group) => {
            const Icon = group.icon;
            return (
              <div key={group.key} className="card p-5">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/10 text-accent">
                    <Icon size={15} />
                  </div>
                  <h2 className="text-[13px] font-semibold text-fg">{group.label}</h2>
                  <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium tabular-nums text-fg-secondary">
                    {group.items.length}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-fg-muted">{group.impact}</p>
                <ul className="mt-3 space-y-1.5">
                  {group.items.map((item) => {
                    const inner = (
                      <>
                        <span
                          className={clsx(
                            'truncate text-[12px] font-medium',
                            item.muted ? 'text-fg-muted' : 'text-fg',
                          )}
                        >
                          {item.name}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2">
                          {item.meta && (
                            <span className="text-[11px] text-fg-faint">{item.meta}</span>
                          )}
                          {group.href && (
                            <ArrowRight
                              size={13}
                              className="text-fg-faint transition-colors group-hover:text-accent"
                            />
                          )}
                        </span>
                      </>
                    );
                    return (
                      <li key={item.id}>
                        {group.href ? (
                          <Link
                            to={group.href(item.id)}
                            className="group flex items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 py-2 transition-colors hover:border-line-strong hover:bg-surface-2"
                          >
                            {inner}
                          </Link>
                        ) : (
                          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 py-2">
                            {inner}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {/* Footnote */}
      <p className="mt-6 text-[11px] text-fg-faint">
        Lineage spans direct references (initiatives, action rules, annotations) and
        project-scoped resources (dashboards, alerts, KPIs, reports, pipelines) that can read
        this log. {data.annotations_count > 0 && `${data.annotations_count} annotation${data.annotations_count !== 1 ? 's' : ''} attached. `}
        {data.version_history_count > 0 && `${data.version_history_count} version record${data.version_history_count !== 1 ? 's' : ''} retained.`}
      </p>

      <div className="mt-6">
        <button onClick={() => navigate(-1)} className="btn-secondary text-[12px]">
          Back
        </button>
      </div>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: LucideIcon;
  value: number;
  label: string;
  tone: 'accent' | 'muted';
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <div
          className={clsx(
            'rounded-md p-2',
            tone === 'accent' ? 'bg-accent/10 text-accent' : 'bg-tint text-fg-muted',
          )}
        >
          <Icon size={16} />
        </div>
        <div>
          <p className="text-xl font-bold tabular-nums text-fg">{formatNumber(value)}</p>
          <p className="text-[12px] text-fg-muted">{label}</p>
        </div>
      </div>
    </div>
  );
}
