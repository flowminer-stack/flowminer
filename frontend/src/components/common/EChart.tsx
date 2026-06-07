import { useEffect, useRef } from 'react';
// Tree-shaken ECharts: register only the chart types + components we use so the
// bundle carries a fraction of the full library (~1.1MB) instead of all of it.
import * as echarts from 'echarts/core';
import { SankeyChart, HeatmapChart, BarChart } from 'echarts/charts';
import { TooltipComponent, GridComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { useUIStore } from '@/store';

echarts.use([
  SankeyChart,
  HeatmapChart,
  BarChart,
  TooltipComponent,
  GridComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

type EChartsInstance = ReturnType<typeof echarts.init>;

/**
 * Thin, theme-aware Apache ECharts wrapper. ECharts ships no first-party React
 * component, so this handles init / setOption / resize / dispose. Callers build
 * a theme-aware `option` (use `useChartColors()` for palette tokens that match
 * the app's light/dark surfaces). Charts re-create on theme flip so axis/text
 * colours stay correct.
 */
interface EChartProps {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  /** notMerge for setOption — default true so option swaps replace cleanly. */
  notMerge?: boolean;
  /** Receives the chart instance after init (e.g. to bind click events). */
  onInit?: (chart: EChartsInstance) => void;
}

export default function EChart({
  option,
  height = 320,
  className,
  notMerge = true,
  onInit,
}: EChartProps) {
  const isDark = useUIStore((s) => s.theme === 'dark');
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const onInitRef = useRef(onInit);
  onInitRef.current = onInit;

  // Re-init on theme change — the simplest way to fully re-style the canvas.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    onInitRef.current?.(chart);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [isDark]);

  // Push option whenever it (or the chart, after re-init) changes.
  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge });
  }, [option, notMerge, isDark]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height }} />;
}

/** Palette tokens that match the app's light/dark surfaces, for chart options. */
export function useChartColors() {
  const isDark = useUIStore((s) => s.theme === 'dark');
  return {
    isDark,
    text: isDark ? '#e0e0e4' : '#1a1d24',
    textMuted: isDark ? '#a1a1aa' : '#6c7283',
    textFaint: isDark ? '#71717a' : '#9ca3af',
    axis: isDark ? '#3a3a42' : '#d6d9e0',
    grid: isDark ? '#2a2a30' : '#e8eaed',
    surface: isDark ? '#1e1e22' : '#ffffff',
    tooltipBg: isDark ? '#26262c' : '#ffffff',
    tooltipBorder: isDark ? '#3a3a42' : '#e2e5eb',
    accent: '#6ea8d8',
    // sequential + diverging ramps used by heatmaps / waterfalls
    good: '#22c55e',
    warn: '#eab308',
    bad: '#ef4444',
    // categorical palette for sankey/series
    categorical: isDark
      ? ['#6ea8d8', '#5cc8a8', '#e0a458', '#cf6f8a', '#9b8bd4', '#5bb0c9', '#d49a5b', '#7ec97e']
      : ['#4f63b2', '#2f9e7d', '#c97a2b', '#b14a66', '#6f5fb0', '#3a8aa8', '#b07a3a', '#4f9e4f'],
  };
}
