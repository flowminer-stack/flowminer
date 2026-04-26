import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Activity, LayoutDashboard } from 'lucide-react';
import { dashboards } from '@/api/client';
import type { Dashboard, WidgetConfig } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import KPICard from '@/components/Dashboard/KPICard';
import ProcessChart from '@/components/Dashboard/ProcessChart';

function renderWidgetContent(widget: WidgetConfig) {
  const { config } = widget;

  switch (widget.type) {
    case 'kpi':
      return (
        <div className="p-4 h-full flex items-center">
          <KPICard
            title={(config.title as string) || widget.title}
            value={(config.value as string | number) ?? '--'}
            unit={config.unit as string | undefined}
            change={config.change as number | undefined}
            changeLabel={config.changeLabel as string | undefined}
            color={(config.color as string) || 'indigo'}
          />
        </div>
      );

    case 'line_chart':
      return (
        <div className="w-full h-full p-3">
          <ProcessChart
            type="line"
            data={(config.data as any[]) || []}
            dataKey={(config.dataKey as string) || 'value'}
            xAxisKey={(config.xAxisKey as string) || 'name'}
            color={config.color as string | undefined}
          />
        </div>
      );

    case 'bar_chart':
      return (
        <div className="w-full h-full p-3">
          <ProcessChart
            type="bar"
            data={(config.data as any[]) || []}
            dataKey={(config.dataKey as string) || 'value'}
            xAxisKey={(config.xAxisKey as string) || 'name'}
            color={config.color as string | undefined}
          />
        </div>
      );

    case 'area_chart':
      return (
        <div className="w-full h-full p-3">
          <ProcessChart
            type="area"
            data={(config.data as any[]) || []}
            dataKey={(config.dataKey as string) || 'value'}
            xAxisKey={(config.xAxisKey as string) || 'name'}
            color={config.color as string | undefined}
          />
        </div>
      );

    case 'pie_chart':
      return (
        <div className="w-full h-full p-3">
          <ProcessChart
            type="pie"
            data={(config.data as any[]) || []}
            dataKey={(config.dataKey as string) || 'value'}
            xAxisKey={(config.xAxisKey as string) || 'name'}
            color={config.color as string | undefined}
          />
        </div>
      );

    case 'process_map':
      return (
        <div className="w-full h-full flex items-center justify-center bg-tint rounded-lg">
          <div className="text-center">
            <Activity size={32} className="text-fg-ghost mx-auto mb-2" />
            <p className="text-[12px] text-fg-muted">Process Map Widget</p>
            <p className="text-[11px] text-fg-faint mt-0.5">
              Embedded mini process map
            </p>
          </div>
        </div>
      );

    case 'variant_list': {
      const variants = (config.variants as any[]) || [];
      return (
        <div className="p-3 space-y-2 overflow-y-auto h-full">
          {variants.length > 0 ? (
            variants.slice(0, 5).map((v: any, i: number) => (
              <div
                key={i}
                className="flex items-center justify-between px-3 py-2 bg-tint rounded-lg"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold text-fg-faint">
                    #{i + 1}
                  </span>
                  <span className="text-[12px] text-fg-secondary truncate">
                    {(v.activities || []).join(' -> ')}
                  </span>
                </div>
                <span className="text-xs font-semibold text-fg-muted flex-shrink-0 ml-2">
                  {v.frequency}
                </span>
              </div>
            ))
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-[12px] text-fg-muted">No variant data</p>
            </div>
          )}
        </div>
      );
    }

    case 'bottleneck_table': {
      const bottlenecks = (config.bottlenecks as any[]) || [];
      return (
        <div className="p-3 overflow-auto h-full">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left py-2 px-2 text-fg-muted font-medium">Activity</th>
                <th className="text-right py-2 px-2 text-fg-muted font-medium">Avg Duration</th>
                <th className="text-right py-2 px-2 text-fg-muted font-medium">Severity</th>
              </tr>
            </thead>
            <tbody>
              {bottlenecks.length > 0 ? (
                bottlenecks.map((b: any, i: number) => (
                  <tr key={i} className="border-b border-line">
                    <td className="py-2 px-2 text-fg-secondary font-medium">{b.activity}</td>
                    <td className="py-2 px-2 text-right text-fg-muted">{b.avg_duration}</td>
                    <td className="py-2 px-2 text-right">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          b.severity === 'high' || b.severity === 'critical'
                            ? 'bg-danger/10 text-danger'
                            : b.severity === 'medium'
                            ? 'bg-warning/10 text-warning'
                            : 'bg-success/10 text-success'
                        }`}
                      >
                        {b.severity}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="py-6 text-center text-fg-faint">
                    No bottleneck data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      );
    }

    case 'conformance_gauge': {
      const fitness = (config.fitness as number) ?? 0;
      const precision = (config.precision as number) ?? 0;
      const fitnessPercent = Math.round(fitness * 100);
      const precisionPercent = Math.round(precision * 100);

      return (
        <div className="flex items-center justify-center gap-8 p-4 h-full">
          <div className="text-center">
            <div className="relative w-24 h-24">
              <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" fill="none" stroke="var(--chart-grid)" strokeWidth="10" />
                <circle
                  cx="50" cy="50" r="40" fill="none"
                  stroke={fitnessPercent >= 80 ? '#22c55e' : fitnessPercent >= 60 ? '#eab308' : '#ef4444'}
                  strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={`${fitnessPercent * 2.51} 251`}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-lg font-bold text-fg">{fitnessPercent}%</span>
              </div>
            </div>
            <p className="text-[12px] font-medium text-fg-muted mt-2">Fitness</p>
          </div>
          <div className="text-center">
            <div className="relative w-24 h-24">
              <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" fill="none" stroke="var(--chart-grid)" strokeWidth="10" />
                <circle
                  cx="50" cy="50" r="40" fill="none"
                  stroke={precisionPercent >= 80 ? '#22c55e' : precisionPercent >= 60 ? '#eab308' : '#ef4444'}
                  strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={`${precisionPercent * 2.51} 251`}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-lg font-bold text-fg">{precisionPercent}%</span>
              </div>
            </div>
            <p className="text-[12px] font-medium text-fg-muted mt-2">Precision</p>
          </div>
        </div>
      );
    }

    default:
      return (
        <div className="flex items-center justify-center h-full">
          <p className="text-[12px] text-fg-muted">Unknown widget type: {widget.type}</p>
        </div>
      );
  }
}

export default function SharedDashboardPage() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareToken) return;

    const loadDashboard = async () => {
      setLoading(true);
      try {
        const d = await dashboards.getShared(shareToken);
        setDashboard(d);
      } catch {
        setError('This dashboard is not available or the share link has expired.');
      } finally {
        setLoading(false);
      }
    };

    loadDashboard();
  }, [shareToken]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-1">
        <LoadingSpinner size="lg" text="Loading shared dashboard..." />
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface-1">
        <div className="rounded-full bg-tint p-4">
          <LayoutDashboard size={32} className="text-fg-faint" />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-fg">
          Dashboard Not Available
        </h2>
        <p className="mt-2 text-[12px] text-fg-muted">
          {error ?? 'This shared dashboard could not be found.'}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-1">
      {/* Header */}
      <header className="border-b border-line bg-surface-2">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
              <Activity className="text-white" size={18} />
            </div>
            <span className="text-lg font-bold tracking-tight text-fg">
              FlowMiner
            </span>
          </div>
          <span className="badge badge-indigo">Shared Dashboard</span>
        </div>
      </header>

      {/* Dashboard content */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        <h1 className="text-2xl font-bold text-fg">
          {dashboard.name}
        </h1>
        {dashboard.description && (
          <p className="mt-1 text-[12px] text-fg-muted">
            {dashboard.description}
          </p>
        )}

        {dashboard.widgets.length === 0 ? (
          <div className="mt-16 flex flex-col items-center">
            <LayoutDashboard size={48} className="text-fg-ghost" />
            <p className="mt-4 text-sm text-fg-muted">
              This dashboard has no widgets yet.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid auto-rows-[200px] grid-cols-12 gap-4">
            {dashboard.widgets.map((widget) => (
              <div
                key={widget.id}
                className="bg-surface-2 rounded-xl border border-line flex flex-col overflow-hidden"
                style={{
                  gridColumn: `span ${widget.position.w}`,
                  gridRow: `span ${widget.position.h}`,
                }}
              >
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-fg-secondary">
                    {widget.title}
                  </h3>
                  <span className="badge badge-slate text-[10px]">
                    {widget.type}
                  </span>
                </div>
                <div className="flex-1 overflow-hidden">
                  {renderWidgetContent(widget)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
