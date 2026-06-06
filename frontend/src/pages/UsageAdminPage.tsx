import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { BarChart2, ArrowLeft, Download, RefreshCw } from 'lucide-react';
import { usage as usageApi } from '@/api/usage';
import { useAuthStore, useUIStore } from '@/store';
import type { UsageSummary } from '@/types/usage';
import LoadingSpinner from '@/components/common/LoadingSpinner';

// ─── Constants ────────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { label: '7 d', value: 7 },
  { label: '30 d', value: 30 },
  { label: '90 d', value: 90 },
  { label: '1 y', value: 365 },
] as const;

// Stable colour per kind — cycles through a palette for unknown kinds.
const KIND_PALETTE = [
  'var(--color-accent)',
  '#f59e0b',
  '#8b5cf6',
  '#10b981',
  '#ef4444',
  '#3b82f6',
  '#ec4899',
  '#84cc16',
];

function kindColor(kind: string, index: number): string {
  const fixed: Record<string, string> = {
    llm_tokens: 'var(--color-accent)',
    connector_sync: '#f59e0b',
    mining: '#8b5cf6',
    api_call: '#10b981',
  };
  return fixed[kind] ?? KIND_PALETTE[index % KIND_PALETTE.length];
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatQuantity(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

// ─── Stat card (mirrors AuditLogPage pattern) ─────────────────────────────────

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line bg-surface-1 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">{label}</p>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{value}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UsageAdminPage() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const theme = useUIStore((s) => s.theme);
  const addNotification = useUIStore((s) => s.addNotification);

  const [sinceDays, setSinceDays] = useState(30);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const isDark = theme === 'dark';
  const gridColor = isDark ? '#2a2a30' : '#e8eaed';
  const tickColor = isDark ? '#71717a' : '#6c7283';
  const tooltipBg = isDark ? '#1e1e22' : '#fff';

  // Admin guard
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      navigate('/projects');
    }
  }, [currentUser, navigate]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await usageApi.getSummary({ sinceDays });
      setSummary(data);
    } catch (e: any) {
      const status = e?.response?.status;
      setError(
        status === 403
          ? 'Admin access required'
          : 'Failed to load usage data',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [sinceDays]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExport = async () => {
    setExporting(true);
    try {
      await usageApi.exportCsv(sinceDays);
    } catch {
      addNotification({ type: 'error', title: 'Export failed' });
    } finally {
      setExporting(false);
    }
  };

  // Derived chart data — sorted descending by total so the bars read largest → smallest
  const chartData = [...(summary?.by_kind ?? [])].sort((a, b) => b.total - a.total);
  const grandTotal = chartData.reduce((s, r) => s + r.total, 0);
  const sinceDate = summary?.since
    ? new Date(summary.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div>
      {/* Back nav */}
      <button
        onClick={() => navigate('/settings')}
        className="btn-ghost mb-4 -ml-3"
      >
        <ArrowLeft size={16} />
        Back to Settings
      </button>

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight text-fg">
            <BarChart2 size={20} />
            Usage Metering
          </h1>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {sinceDate ? `Since ${sinceDate}` : 'Consumption by kind, admin-only'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Window selector */}
          <div className="flex items-center rounded-md border border-line bg-surface-1 p-0.5 text-[11px]">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSinceDays(opt.value)}
                className={`rounded px-2.5 py-1 font-medium transition-colors ${
                  sinceDays === opt.value
                    ? 'bg-accent text-white'
                    : 'text-fg-muted hover:text-fg'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            onClick={load}
            disabled={loading}
            className="btn-ghost flex items-center gap-1.5"
            aria-label="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>

          <button
            onClick={handleExport}
            disabled={exporting || loading}
            className="btn-ghost flex items-center gap-1.5"
            aria-label="Download CSV"
          >
            <Download size={13} />
            {exporting ? 'Exporting…' : 'CSV'}
          </button>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="mt-10">
          <LoadingSpinner size="lg" text="Loading usage data…" fullPage />
        </div>
      ) : error ? (
        <p className="mt-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-[12px] text-danger">
          {error}
        </p>
      ) : !summary || summary.by_kind.length === 0 ? (
        <div className="mt-10 flex flex-col items-center py-16 text-center">
          <BarChart2 size={28} className="text-fg-ghost" />
          <p className="mt-3 text-[13px] font-medium text-fg-muted">No usage recorded yet</p>
          <p className="mt-1 text-[11px] text-fg-faint">
            Usage events are written when LLM calls, connector syncs, and mining jobs run.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Total events" value={formatQuantity(grandTotal)} />
            <StatCard label="Kinds tracked" value={chartData.length} />
            <StatCard
              label="Largest kind"
              value={chartData[0] ? formatKind(chartData[0].kind) : '—'}
            />
            <StatCard
              label="Window"
              value={`${sinceDays}d`}
            />
          </div>

          {/* Bar chart */}
          <div className="rounded-lg border border-line bg-surface-1 p-5">
            <p className="mb-4 text-[13px] font-semibold text-fg">
              Consumption by kind
            </p>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                  <XAxis
                    dataKey="kind"
                    tickFormatter={formatKind}
                    tick={{ fontSize: 10, fill: tickColor }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tickFormatter={(v) => formatQuantity(v)}
                    tick={{ fontSize: 10, fill: tickColor }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{
                      background: tooltipBg,
                      border: `1px solid ${gridColor}`,
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                    labelFormatter={(v) => formatKind(String(v))}
                    formatter={(v: number) => [v.toLocaleString(), 'Total']}
                  />
                  <Bar dataKey="total" radius={[3, 3, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell key={entry.kind} fill={kindColor(entry.kind, index)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Table breakdown */}
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line bg-surface-2">
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                    Kind
                  </th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                    Total
                  </th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                    Share
                  </th>
                  <th className="px-4 py-2.5 pr-5 text-right text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                    Bar
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {chartData.map((row, index) => {
                  const share = grandTotal > 0 ? (row.total / grandTotal) * 100 : 0;
                  const color = kindColor(row.kind, index);
                  return (
                    <tr key={row.kind} className="transition-colors hover:bg-tint/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          <span className="text-[12px] font-medium text-fg">
                            {formatKind(row.kind)}
                          </span>
                          <span className="text-[10px] font-mono text-fg-faint">
                            {row.kind}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[12px] tabular-nums text-fg">
                        {row.total.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-[12px] tabular-nums text-fg-muted">
                        {share.toFixed(1)}%
                      </td>
                      <td className="py-3 pl-4 pr-5">
                        <div className="flex justify-end">
                          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${share}%`,
                                backgroundColor: color,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
