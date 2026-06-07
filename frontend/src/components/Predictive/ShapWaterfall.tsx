import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import EChart, { useChartColors } from '@/components/common/EChart';
import type { ExplainResponse, FeatureContribution } from '@/types/predictive';
import { formatDuration } from '@/utils/format';

interface ShapWaterfallProps {
  data: ExplainResponse;
}

/** One resolved waterfall step, in plot order (left → right). */
interface Step {
  /** X-axis category label. */
  name: string;
  /** Cumulative value before this bar. */
  start: number;
  /** Cumulative value after this bar. */
  end: number;
  /** Signed delta for contribution steps; total value for endpoints. */
  delta: number;
  /** 'base' | 'pred' anchors, or 'pos'/'neg' contribution direction. */
  kind: 'base' | 'pred' | 'pos' | 'neg';
  /** Backing feature row (for tooltip), endpoints have none. */
  contribution?: FeatureContribution;
}

/** Truncate long feature names so x-axis labels stay legible. */
function shortLabel(s: string): string {
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

function formatFeatureValue(v: number | string | boolean | null): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toString() : v.toFixed(2);
  }
  return v;
}

/**
 * True SHAP waterfall for a single case's risk explanation. Renders the
 * additive decomposition from `base_value` to `predicted_value`:
 *
 *   Base → +/− each top contribution → Other features → Prediction
 *
 * Implemented with the ECharts stacked-bar trick: a transparent placeholder
 * series positions each visible bar at its running cumulative offset. Bars are
 * red when a feature pushes risk up (positive contribution) and green when it
 * pushes risk down. The caller only mounts this when both anchors are present.
 */
export default function ShapWaterfall({ data }: ShapWaterfallProps) {
  const colors = useChartColors();
  const isOutcome = (data.kind ?? 'outcome') === 'outcome';

  // Endpoint formatter — probability as a percent for outcome models, a raw
  // duration (seconds) otherwise. Matches the spark-bar fallback's semantics.
  const fmtAnchor = useMemo(
    () => (v: number) =>
      isOutcome ? `${(v * 100).toFixed(1)}%` : formatDuration(v),
    [isOutcome],
  );

  const steps = useMemo<Step[]>(() => {
    const base = data.base_value ?? 0;
    const predicted = data.predicted_value ?? 0;
    const contribs = data.top_contributions ?? [];

    const out: Step[] = [];

    // Base anchor: 0 → base_value.
    out.push({ name: 'Base', start: 0, end: base, delta: base, kind: 'base' });

    // Each shown contribution, in order, stacked from the running cumulative.
    let cum = base;
    let shownSum = 0;
    for (const c of contribs) {
      const start = cum;
      const end = cum + c.contribution;
      out.push({
        name: shortLabel(c.feature),
        start,
        end,
        delta: c.contribution,
        kind: c.contribution >= 0 ? 'pos' : 'neg',
        contribution: c,
      });
      cum = end;
      shownSum += c.contribution;
    }

    // Residual: everything the unshown features account for. Only render it
    // when its magnitude is non-trivial relative to the total span.
    const other = predicted - base - shownSum;
    const span = Math.max(Math.abs(predicted - base), Math.abs(base), 1e-9);
    if (Math.abs(other) > span * 0.005) {
      out.push({
        name: 'Other features',
        start: cum,
        end: cum + other,
        delta: other,
        kind: other >= 0 ? 'pos' : 'neg',
      });
    }

    // Prediction anchor: 0 → predicted_value.
    out.push({
      name: 'Prediction',
      start: 0,
      end: predicted,
      delta: predicted,
      kind: 'pred',
    });

    return out;
  }, [data]);

  const option = useMemo<EChartsOption>(() => {
    const categories = steps.map((s) => s.name);

    // Placeholder = the lower of the two cumulative bounds (transparent).
    const placeholder = steps.map((s) => Math.min(s.start, s.end));
    // Visible bar = the absolute height of the step's delta.
    const values = steps.map((s) => Math.abs(s.end - s.start));

    const colorFor = (kind: Step['kind']) => {
      switch (kind) {
        case 'base':
          return colors.textMuted;
        case 'pred':
          return colors.accent;
        case 'pos':
          return colors.bad;
        case 'neg':
          return colors.good;
      }
    };

    return {
      grid: { left: 8, right: 16, top: 16, bottom: 64, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: colors.tooltipBg,
        borderColor: colors.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: colors.text, fontSize: 12 },
        formatter: (params: unknown) => {
          const arr = params as Array<{ dataIndex: number }>;
          const idx = arr?.[0]?.dataIndex ?? 0;
          const s = steps[idx];
          if (!s) return '';
          if (s.kind === 'base') {
            return `<strong>Base value</strong><br/>Model average: ${fmtAnchor(
              s.end,
            )}`;
          }
          if (s.kind === 'pred') {
            return `<strong>Prediction</strong><br/>This case: ${fmtAnchor(
              s.end,
            )}`;
          }
          const signed = `${s.delta >= 0 ? '+' : ''}${s.delta.toFixed(3)}`;
          const dir = s.delta >= 0 ? 'increases risk' : 'decreases risk';
          const featLine = s.contribution
            ? `${s.contribution.feature} = ${formatFeatureValue(
                s.contribution.value,
              )}`
            : 'Other features';
          return [
            `<strong>${featLine}</strong>`,
            `Contribution: <span style="color:${colorFor(
              s.kind,
            )}">${signed}</span> (${dir})`,
            `Running total: ${fmtAnchor(s.end)}`,
          ].join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: categories,
        axisLine: { lineStyle: { color: colors.axis } },
        axisTick: { show: false },
        axisLabel: {
          color: colors.textMuted,
          fontSize: 10,
          interval: 0,
          rotate: 40,
          hideOverlap: false,
        },
      },
      yAxis: {
        type: 'value',
        // base/predicted are non-negative (probability or seconds), so clamp the
        // axis — avoids confusing negative ticks if a cumulative briefly dips
        // below zero on a large negative contribution.
        min: 0,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: colors.grid } },
        axisLabel: {
          color: colors.textFaint,
          fontSize: 10,
          formatter: (v: number) => (isOutcome ? `${Math.round(v * 100)}%` : formatDuration(v)),
        },
      },
      series: [
        {
          // Transparent spacer that lifts each visible bar to its offset.
          name: 'placeholder',
          type: 'bar',
          stack: 'shap',
          silent: true,
          itemStyle: { color: 'transparent' },
          emphasis: { itemStyle: { color: 'transparent' } },
          data: placeholder,
        },
        {
          name: 'contribution',
          type: 'bar',
          stack: 'shap',
          barMaxWidth: 38,
          data: steps.map((s, i) => ({
            value: values[i],
            itemStyle: { color: colorFor(s.kind), borderRadius: 2 },
          })),
          label: {
            show: true,
            color: colors.textMuted,
            fontSize: 10,
            // Only the Base + Prediction anchors carry a formatted value label.
            formatter: (p: { dataIndex: number }) => {
              const s = steps[p.dataIndex];
              if (!s) return '';
              if (s.kind === 'base' || s.kind === 'pred') {
                return fmtAnchor(s.end);
              }
              return '';
            },
            position: 'top',
          },
        },
      ],
    };
  }, [steps, colors, fmtAnchor, isOutcome]);

  const height = Math.max(280, steps.length * 34);

  return <EChart option={option} height={height} />;
}
