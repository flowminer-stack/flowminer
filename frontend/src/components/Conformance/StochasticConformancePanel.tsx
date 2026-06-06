/**
 * StochasticConformancePanel
 *
 * Visualises the EMD-based stochastic conformance result for one event log.
 * Shows:
 *   - Headline scores (EMD distance, stochastic fitness)
 *   - Severity breakdown (minor / moderate / severe variant counts)
 *   - Distribution comparison bar chart (log frequency vs model probability
 *     for the top deviating variants)
 *   - Deviating variants table
 *
 * Data is fetched independently via getStochasticConformance so this panel
 * is self-contained and can be dropped into any page.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  BarChart as RBarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { Activity, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import HintTooltip from '@/components/common/Tooltip';
import { getStochasticConformance } from '@/api/stochasticConformance';
import type { StochasticConformanceResult, DeviatingVariant } from '@/types/stochastic';

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function severityColor(severity: 'minor' | 'moderate' | 'severe') {
  return {
    minor: 'text-success',
    moderate: 'text-warning',
    severe: 'text-danger',
  }[severity];
}

function badgeClass(severity: 'minor' | 'moderate' | 'severe') {
  return {
    minor: 'badge-emerald',
    moderate: 'badge-amber',
    severe: 'badge-rose',
  }[severity];
}

function variantLabel(variant: string[], maxLen = 40): string {
  const joined = variant.join(' → ');
  if (joined.length <= maxLen) return joined;
  if (variant.length <= 2) return joined.slice(0, maxLen - 1) + '…';
  return `${variant[0]} → … (${variant.length} steps) → ${variant[variant.length - 1]}`;
}

function getSeverity(contribution: number): 'minor' | 'moderate' | 'severe' {
  if (contribution < 0.05) return 'minor';
  if (contribution < 0.15) return 'moderate';
  return 'severe';
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ScoreCard({
  label,
  value,
  tooltip,
  colorClass,
}: {
  label: string;
  value: string;
  tooltip: string;
  colorClass: string;
}) {
  return (
    <div className="card flex flex-col items-center p-6">
      <HintTooltip text={tooltip}>
        <div className={clsx('text-2xl font-bold tabular-nums', colorClass)}>
          {value}
        </div>
      </HintTooltip>
      <div className="mt-1 text-[11px] text-fg-muted">{label}</div>
    </div>
  );
}

function SeverityCard({
  severity,
  count,
  total,
}: {
  severity: 'minor' | 'moderate' | 'severe';
  count: number;
  total: number;
}) {
  const label = {
    minor: 'Minor',
    moderate: 'Moderate',
    severe: 'Severe',
  }[severity];
  const tooltip = {
    minor: '|Δ| < 5% — negligible frequency mismatch between log and model.',
    moderate: '5% ≤ |Δ| < 15% — noticeable deviation in variant frequency.',
    severe: '|Δ| ≥ 15% — material deviation; variants behave very differently from the model.',
  }[severity];
  const share = total > 0 ? ((count / total) * 100).toFixed(0) : '0';
  return (
    <div className="card p-4">
      <HintTooltip text={tooltip}>
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-fg-muted capitalize">{label}</span>
          <span className={clsx('text-[11px] font-semibold', severityColor(severity))}>
            {share}%
          </span>
        </div>
      </HintTooltip>
      <div className={clsx('mt-2 text-xl font-bold tabular-nums', severityColor(severity))}>
        {count.toLocaleString()}
      </div>
      <div className="mt-1 text-[10px] text-fg-faint">variants</div>
    </div>
  );
}

// ── Distribution chart ────────────────────────────────────────────────────────

interface ChartDatum {
  label: string;
  log_pct: number;
  model_pct: number;
}

function DistributionChart({ variants }: { variants: DeviatingVariant[] }) {
  // Show top 10 by contribution
  const top = variants.slice(0, 10);
  const data: ChartDatum[] = top.map((v) => ({
    label: variantLabel(v.variant, 30),
    log_pct: parseFloat((v.log_frequency * 100).toFixed(2)),
    model_pct: parseFloat((v.model_probability * 100).toFixed(2)),
  }));

  if (data.length === 0) {
    return (
      <p className="text-[12px] text-fg-muted">No variant data to display.</p>
    );
  }

  return (
    <div style={{ width: '100%', height: Math.max(200, data.length * 38) }}>
      <ResponsiveContainer>
        <RBarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 4 }}
        >
          <CartesianGrid strokeDasharray="2 2" stroke="var(--line)" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fill: 'var(--fg-muted)', fontSize: 10 }}
          />
          <YAxis
            dataKey="label"
            type="category"
            width={140}
            tickFormatter={(v: string) => (v.length > 22 ? v.slice(0, 19) + '…' : v)}
            tick={{ fill: 'var(--fg-muted)', fontSize: 9 }}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              fontSize: 11,
            }}
            formatter={(v: number, name: string) => [
              `${v}%`,
              name === 'log_pct' ? 'Log frequency' : 'Model probability',
            ]}
          />
          <Legend
            formatter={(value) =>
              value === 'log_pct' ? 'Log frequency' : 'Model probability'
            }
            wrapperStyle={{ fontSize: 11 }}
          />
          <Bar dataKey="log_pct" name="log_pct" fill="var(--accent)" radius={[0, 2, 2, 0]} />
          <Bar dataKey="model_pct" name="model_pct" fill="var(--fg-faint)" radius={[0, 2, 2, 0]} />
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Deviating variant table ───────────────────────────────────────────────────

function DeviatingVariantRow({ v, rank }: { v: DeviatingVariant; rank: number }) {
  const severity = getSeverity(v.contribution);
  return (
    <tr className="border-t border-line text-[12px] hover:bg-surface-1">
      <td className="py-2 pl-3 pr-2 tabular-nums text-fg-faint">{rank}</td>
      <td className="py-2 pr-2">
        <span className={clsx('badge', badgeClass(severity))}>{severity}</span>
      </td>
      <td className="py-2 pr-4 text-fg max-w-[240px]">
        <span title={v.variant.join(' → ')}>
          {variantLabel(v.variant, 50)}
        </span>
        <span className="ml-1 text-fg-faint">({v.variant.length} steps)</span>
      </td>
      <td className="py-2 pr-4 tabular-nums text-fg">{pct(v.log_frequency)}</td>
      <td className="py-2 pr-4 tabular-nums text-fg">{pct(v.model_probability)}</td>
      <td className={clsx('py-2 pr-3 tabular-nums font-semibold', severityColor(severity))}>
        {pct(v.contribution)}
      </td>
    </tr>
  );
}

function DeviatingVariantsTable({ variants }: { variants: DeviatingVariant[] }) {
  if (variants.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-fg-muted">
        <CheckCircle2 size={14} className="text-success" />
        No significantly deviating variants found.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            <th className="pb-2 pl-3 pr-2">#</th>
            <th className="pb-2 pr-2">Severity</th>
            <th className="pb-2 pr-4">Variant</th>
            <th className="pb-2 pr-4">Log freq.</th>
            <th className="pb-2 pr-4">Model prob.</th>
            <th className="pb-2 pr-3">|Δ|</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v, i) => (
            <DeviatingVariantRow key={i} v={v} rank={i + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function StochasticConformancePanel({
  eventLogId,
}: {
  eventLogId: string;
}) {
  const [data, setData] = useState<StochasticConformanceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventLogId) return;
    setLoading(true);
    setError(null);
    getStochasticConformance(eventLogId)
      .then(setData)
      .catch((e) => {
        setError(
          e instanceof Error
            ? e.message
            : 'Failed to load stochastic conformance data.',
        );
      })
      .finally(() => setLoading(false));
  }, [eventLogId]);

  if (loading) {
    return (
      <LoadingSpinner
        size="md"
        text="Computing stochastic conformance (EMD)…"
      />
    );
  }

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          setError(null);
          setLoading(true);
          getStochasticConformance(eventLogId)
            .then(setData)
            .catch((e) =>
              setError(e instanceof Error ? e.message : 'Failed to reload.'),
            )
            .finally(() => setLoading(false));
        }}
      />
    );
  }

  if (!data) return null;

  const totalVariants =
    data.severity_breakdown.minor +
    data.severity_breakdown.moderate +
    data.severity_breakdown.severe;

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Activity size={18} className="text-accent" />
        <div>
          <h2 className="text-[14px] font-semibold text-fg">
            Stochastic Conformance (EMD)
          </h2>
          <p className="text-[11px] text-fg-muted">
            Measures how closely the log's variant frequency distribution
            matches the model — a 0.1% deviation is distinguished from a 30%
            deviation.{' '}
            <HintTooltip
              text="Earth Mover's Distance (Wasserstein distance) between the empirical log distribution and the model's sampled stochastic language. Ref: Polyvyanyy et al., Information Systems 2021."
            >
              <span className="inline-flex cursor-help items-center gap-0.5 text-fg-faint">
                <Info size={11} /> Reference
              </span>
            </HintTooltip>
          </p>
        </div>
      </div>

      {/* Score cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <ScoreCard
          label="EMD Distance"
          value={data.emd_distance.toFixed(4)}
          tooltip="Earth Mover's Distance in [0, 1]. 0 = perfect distributional fit between log and model. Lower is better."
          colorClass={data.emd_distance < 0.1 ? 'text-success' : data.emd_distance < 0.3 ? 'text-warning' : 'text-danger'}
        />
        <ScoreCard
          label="Stochastic Fitness"
          value={pct(data.stochastic_fitness)}
          tooltip="1 − EMD distance. Frequency-weighted fitness: how much of the log's variant mass the model explains. Higher is better."
          colorClass={data.stochastic_fitness > 0.9 ? 'text-success' : data.stochastic_fitness > 0.7 ? 'text-warning' : 'text-danger'}
        />
        <ScoreCard
          label="Log Variants"
          value={data.log_variants_count.toLocaleString()}
          tooltip="Total distinct trace variants (unique ordered activity sequences) observed in the event log."
          colorClass="text-fg"
        />
        <ScoreCard
          label="Model Traces Sampled"
          value={data.model_traces_sampled.toLocaleString()}
          tooltip="Number of traces sampled from the process model during stochastic playout to estimate the model distribution."
          colorClass="text-fg"
        />
      </div>

      {/* Severity breakdown */}
      <div>
        <h3 className="mb-3 text-[13px] font-semibold text-fg">
          Variant Severity Breakdown
          <HintTooltip text="All variants — not just the top deviating ones — are bucketed by how far their log frequency deviates from the model probability.">
            <AlertTriangle size={13} className="ml-1 inline text-fg-faint" />
          </HintTooltip>
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <SeverityCard severity="minor" count={data.severity_breakdown.minor} total={totalVariants} />
          <SeverityCard severity="moderate" count={data.severity_breakdown.moderate} total={totalVariants} />
          <SeverityCard severity="severe" count={data.severity_breakdown.severe} total={totalVariants} />
        </div>
      </div>

      {/* Distribution comparison chart */}
      <div className="card p-5">
        <h3 className="mb-3 text-[13px] font-semibold text-fg">
          Distribution Comparison — Top Deviating Variants
        </h3>
        <p className="mb-3 text-[11px] text-fg-muted">
          Log frequency vs. model probability for the variants with the highest
          absolute deviation (|Δ|). Bars that differ strongly indicate where
          the model and the log disagree most.
        </p>
        <DistributionChart variants={data.top_deviating_variants} />
      </div>

      {/* Deviating variants table */}
      <div className="card p-5">
        <h3 className="mb-3 text-[13px] font-semibold text-fg">
          Top Deviating Variants
        </h3>
        <DeviatingVariantsTable variants={data.top_deviating_variants} />
      </div>
    </div>
  );
}
