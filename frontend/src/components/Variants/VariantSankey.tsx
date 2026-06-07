import { useMemo } from 'react';
import EChart, { useChartColors } from '@/components/common/EChart';
import type { EChartsOption } from 'echarts';

interface Variant {
  id: number;
  activities: string[];
  frequency: number;
  percentage: number;
  avg_duration?: number | null;
  min_duration?: number | null;
  max_duration?: number | null;
}

interface Props {
  variants: Variant[];
}

interface Link {
  source: string;
  target: string;
  value: number;
}

export default function VariantSankey({ variants }: Props) {
  const colors = useChartColors();

  const { nodes, links } = useMemo(() => {
    if (!variants || variants.length === 0) return { nodes: [], links: [] };

    // Aggregate directed transition weights with a nested map so activity names
    // containing spaces/slashes are never mis-parsed (a string-joined key would).
    const weights = new Map<string, Map<string, number>>();
    for (const v of variants) {
      if (v.activities.length < 2) continue;
      for (let i = 0; i < v.activities.length - 1; i++) {
        const src = v.activities[i];
        const tgt = v.activities[i + 1];
        if (src === tgt) continue; // skip self-loops (sankey can't draw them)
        let row = weights.get(src);
        if (!row) {
          row = new Map();
          weights.set(src, row);
        }
        row.set(tgt, (row.get(tgt) ?? 0) + v.frequency);
      }
    }

    // Candidate transitions, heaviest first (cap the working set for perf).
    const candidates: Link[] = [];
    for (const [source, row] of weights) {
      for (const [target, value] of row) candidates.push({ source, target, value });
    }
    candidates.sort((a, b) => b.value - a.value);
    const working = candidates.slice(0, 120);

    // ECharts sankey requires a DAG, but process flows have loops (rework).
    // Greedily keep the heaviest transitions, dropping any edge that would
    // close a cycle — a max-weight acyclic-subgraph heuristic.
    const adj = new Map<string, Set<string>>();
    const canReach = (from: string, to: string): boolean => {
      const stack = [from];
      const seen = new Set<string>();
      while (stack.length) {
        const n = stack.pop() as string;
        if (n === to) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        const next = adj.get(n);
        if (next) for (const m of next) stack.push(m);
      }
      return false;
    };

    const kept: Link[] = [];
    for (const e of working) {
      if (kept.length >= 40) break;
      if (canReach(e.target, e.source)) continue; // adding would form a cycle
      kept.push(e);
      let out = adj.get(e.source);
      if (!out) {
        out = new Set();
        adj.set(e.source, out);
      }
      out.add(e.target);
    }

    const usedNodes = new Set<string>();
    for (const e of kept) {
      usedNodes.add(e.source);
      usedNodes.add(e.target);
    }

    return { nodes: Array.from(usedNodes).map((name) => ({ name })), links: kept };
  }, [variants]);

  const option = useMemo<EChartsOption>(() => {
    const cat = colors.categorical;
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        triggerOn: 'mousemove',
        backgroundColor: colors.tooltipBg,
        borderColor: colors.tooltipBorder,
        textStyle: { color: colors.text, fontSize: 12 },
        formatter: (params: unknown) => {
          const p = params as {
            dataType?: string;
            name?: string;
            data?: { source?: string; target?: string; value?: number };
          };
          if (p.dataType === 'edge' && p.data) {
            return `${p.data.source} → ${p.data.target}<br/><b>${(p.data.value ?? 0).toLocaleString()}</b> cases`;
          }
          return p.name ?? '';
        },
      },
      series: [
        {
          type: 'sankey',
          emphasis: { focus: 'adjacency' },
          data: nodes,
          links,
          nodeWidth: 16,
          nodeGap: 10,
          left: '2%',
          right: '18%',
          top: '5%',
          bottom: '5%',
          label: { color: colors.text, fontSize: 11, fontFamily: 'inherit' },
          lineStyle: { color: 'gradient', opacity: 0.35 },
          itemStyle: {
            color: (params: unknown) => {
              const p = params as { dataIndex?: number };
              return cat[(p.dataIndex ?? 0) % cat.length];
            },
            borderWidth: 0,
          },
        },
      ],
    };
  }, [nodes, links, colors]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-line bg-surface-1">
        <p className="text-[12px] text-fg-muted">
          No flow data — variants need at least two activities each.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="mb-1">
        <h3 className="text-[13px] font-semibold text-fg">Activity flow (Sankey)</h3>
        <p className="text-[11px] text-fg-muted">
          Link width proportional to case volume. Hover a link or node to highlight adjacent paths.
          {' '}Showing top {links.length} transitions across {nodes.length} activities.
        </p>
      </div>
      <EChart option={option} height={480} />
    </div>
  );
}
