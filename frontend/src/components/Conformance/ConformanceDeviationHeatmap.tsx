import { useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';
import EChart, { useChartColors } from '@/components/common/EChart';
import type { ConformanceResponse } from '@/types';

interface Props {
  conformance: ConformanceResponse;
}

const DEVIATION_TYPE_LABELS: Record<string, string> = {
  missing_activity: 'Missing activity',
  unexpected_activity: 'Unexpected activity',
  wrong_order: 'Wrong order',
};

function labelFor(type: string): string {
  return DEVIATION_TYPE_LABELS[type] ?? type;
}

export default function ConformanceDeviationHeatmap({ conformance }: Props) {
  const colors = useChartColors();

  const { activities, types, cells, maxCount } = useMemo(() => {
    const deviations = conformance.deviations.filter((d) => d.activity !== null);

    if (deviations.length === 0) {
      return { activities: [], types: [], cells: [], maxCount: 0 };
    }

    // Collect distinct deviation types
    const typeSet = new Set<string>();
    deviations.forEach((d) => typeSet.add(d.deviation_type));
    const types = Array.from(typeSet).sort();

    // Aggregate: activity -> type -> count
    const countMap = new Map<string, Map<string, number>>();
    deviations.forEach((d) => {
      const act = d.activity as string;
      if (!countMap.has(act)) countMap.set(act, new Map());
      const inner = countMap.get(act)!;
      inner.set(d.deviation_type, (inner.get(d.deviation_type) ?? 0) + 1);
    });

    // Sort activities by total deviation count desc, cap to top 25
    const activityTotals = Array.from(countMap.entries()).map(([act, inner]) => {
      const total = Array.from(inner.values()).reduce((a, b) => a + b, 0);
      return { act, total };
    });
    activityTotals.sort((a, b) => b.total - a.total);
    const activities = activityTotals.slice(0, 25).map((x) => x.act);

    // Build flat cell array [typeIndex, activityIndex, count]
    let maxCount = 0;
    const cells: [number, number, number][] = [];
    activities.forEach((act, ai) => {
      types.forEach((type, ti) => {
        const count = countMap.get(act)?.get(type) ?? 0;
        cells.push([ti, ai, count]);
        if (count > maxCount) maxCount = count;
      });
    });

    return { activities, types, cells, maxCount };
  }, [conformance.deviations]);

  // Zero-deviation positive state
  if (activities.length === 0) {
    const pct = (conformance.fitness * 100).toFixed(1);
    return (
      <div className="card mt-6 flex flex-col items-center justify-center gap-3 p-10">
        <CheckCircle2 size={36} className="text-success" />
        <p className="text-[14px] font-semibold text-fg">No deviations detected</p>
        <p className="text-[12px] text-fg-muted">Fitness {pct}% — all activities conform to the reference model.</p>
      </div>
    );
  }

  const typeLabels = types.map(labelFor);

  const option = {
    backgroundColor: 'transparent',
    grid: {
      top: 16,
      right: 24,
      bottom: 80,
      left: Math.max(...activities.map((a) => a.length)) * 6 + 16,
    },
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.text, fontSize: 12 },
      formatter: (params: any) => {
        const [ti, ai, count] = params.data;
        const act = activities[ai] ?? '';
        const type = typeLabels[ti] ?? '';
        return `<strong>${act}</strong><br/>${type}<br/>Count: <strong>${count}</strong>`;
      },
    },
    visualMap: {
      min: 0,
      max: maxCount,
      calculable: false,
      orient: 'horizontal' as const,
      left: 'center',
      bottom: 4,
      textStyle: { color: colors.textMuted, fontSize: 11 },
      inRange: {
        color: [
          colors.isDark ? '#1e2d3a' : '#f0f5fb',
          '#e07070',
          '#c0302a',
        ],
      },
      text: ['More', 'Fewer'],
    },
    xAxis: {
      type: 'category' as const,
      data: typeLabels,
      axisLine: { lineStyle: { color: colors.axis } },
      axisTick: { show: false },
      axisLabel: {
        color: colors.textMuted,
        fontSize: 11,
        interval: 0,
      },
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category' as const,
      data: activities,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: colors.text,
        fontSize: 11,
      },
      splitArea: {
        show: true,
        areaStyle: {
          color: [colors.isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', 'transparent'],
        },
      },
    },
    series: [
      {
        type: 'heatmap' as const,
        data: cells,
        label: {
          show: true,
          formatter: (params: any) =>
            params.data[2] > 0 ? String(params.data[2]) : '',
          color: colors.isDark ? '#e0e0e4' : '#1a1d24',
          fontSize: 11,
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 8,
            shadowColor: 'rgba(0,0,0,0.3)',
          },
        },
      },
    ],
  };

  return (
    <div className="card mt-6 p-5">
      <h2 className="text-[14px] font-semibold text-fg">
        Where deviations concentrate (by activity)
      </h2>
      <p className="mt-0.5 text-[12px] text-fg-muted">
        Counts of deviations per activity and type — top {activities.length} activities by total deviations.
      </p>
      <div className="mt-4">
        <EChart
          option={option}
          height={Math.max(220, activities.length * 28 + 100)}
          className="w-full"
        />
      </div>
    </div>
  );
}
