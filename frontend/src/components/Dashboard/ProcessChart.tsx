import React from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  TooltipProps,
} from 'recharts';
import { generateColor, formatNumber } from '../../utils/format';

interface ProcessChartProps {
  type: 'line' | 'bar' | 'area' | 'pie';
  data: any[];
  dataKey: string;
  xAxisKey?: string;
  title?: string;
  color?: string;
  // Human-readable name for the plotted series. Recharts shows this
  // in the legend + tooltip instead of the raw dataKey (which is
  // usually something generic like "value"). Defaults to dataKey.
  seriesName?: string;
  // Axis titles — rendered inside the chart so the user can see
  // what each axis represents without editing the widget title.
  xAxisLabel?: string;
  yAxisLabel?: string;
  // Optional tooltip/legend value formatter (e.g. pretty-print
  // durations, add units). Defaults to formatNumber.
  valueFormatter?: (v: number) => string;
  // Subtitle rendered above the chart — lets the widget explain
  // what it's plotting without relying on the user-set title.
  subtitle?: string;
}

const CustomTooltip: React.FC<
  TooltipProps<any, any> & { valueFormatter?: (v: number) => string }
> = ({ active, payload, label, valueFormatter }) => {
  if (!active || !payload || payload.length === 0) return null;

  const fmt = (v: unknown) =>
    typeof v === 'number'
      ? valueFormatter
        ? valueFormatter(v)
        : formatNumber(v)
      : String(v);

  return (
    <div
      style={{
        borderRadius: '8px',
        border: '1px solid var(--chart-tooltip-border)',
        fontSize: '12px',
        backgroundColor: 'var(--chart-tooltip-bg)',
        color: 'var(--chart-tooltip-text)',
        padding: '8px 12px',
      }}
    >
      {label && <p className="font-medium text-fg-muted mb-1">{label}</p>}
      {payload.map((entry: any, index: number) => (
        <div key={index} className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-fg-muted">{entry.name}:</span>
          <span className="font-semibold text-fg-secondary">
            {fmt(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

const ProcessChart: React.FC<ProcessChartProps> = ({
  type,
  data,
  dataKey,
  xAxisKey = 'name',
  title,
  color = '#06b6d4',
  seriesName,
  xAxisLabel,
  yAxisLabel,
  valueFormatter,
  subtitle,
}) => {
  const chartColor = color || '#06b6d4';
  // Human-readable series name — used by recharts for the legend and
  // tooltip. Falls back to the dataKey so existing callers still work.
  const displayName = seriesName ?? dataKey;

  const commonAxisProps = {
    tick: { fontSize: 11, fill: 'var(--chart-tick)' },
    tickLine: false,
    axisLine: { stroke: 'var(--chart-grid)' },
  };

  const xLabelProps = xAxisLabel
    ? {
        label: {
          value: xAxisLabel,
          position: 'insideBottom' as const,
          offset: -2,
          fill: 'var(--chart-tick)',
          fontSize: 10,
        },
      }
    : {};
  const yLabelProps = yAxisLabel
    ? {
        label: {
          value: yAxisLabel,
          angle: -90,
          position: 'insideLeft' as const,
          offset: 10,
          fill: 'var(--chart-tick)',
          fontSize: 10,
        },
      }
    : {};

  const renderChart = () => {
    switch (type) {
      case 'line':
        return (
          <LineChart
            data={data}
            margin={{ top: 5, right: 20, left: yAxisLabel ? 20 : 0, bottom: xAxisLabel ? 18 : 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey={xAxisKey} {...commonAxisProps} {...xLabelProps} />
            <YAxis
              {...commonAxisProps}
              {...yLabelProps}
              tickFormatter={valueFormatter}
            />
            <Tooltip content={<CustomTooltip valueFormatter={valueFormatter} />} />
            <Legend wrapperStyle={{ fontSize: '12px', color: 'var(--chart-tick)' }} />
            <Line
              type="monotone"
              name={displayName}
              dataKey={dataKey}
              stroke={chartColor}
              strokeWidth={2.5}
              dot={{ r: 3, fill: chartColor, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: chartColor, strokeWidth: 2, stroke: 'var(--chart-tooltip-bg)' }}
              animationDuration={600}
              animationEasing="ease-out"
            />
          </LineChart>
        );

      case 'bar':
        return (
          <BarChart
            data={data}
            margin={{ top: 5, right: 20, left: yAxisLabel ? 20 : 0, bottom: xAxisLabel ? 18 : 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey={xAxisKey} {...commonAxisProps} {...xLabelProps} />
            <YAxis
              {...commonAxisProps}
              {...yLabelProps}
              tickFormatter={valueFormatter}
            />
            <Tooltip content={<CustomTooltip valueFormatter={valueFormatter} />} />
            <Legend wrapperStyle={{ fontSize: '12px', color: 'var(--chart-tick)' }} />
            <Bar
              name={displayName}
              dataKey={dataKey}
              fill={chartColor}
              radius={[4, 4, 0, 0]}
              animationDuration={600}
              animationEasing="ease-out"
            >
              {data.map((_, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={generateColor(index)}
                  opacity={0.85}
                />
              ))}
            </Bar>
          </BarChart>
        );

      case 'area':
        return (
          <AreaChart
            data={data}
            margin={{ top: 5, right: 20, left: yAxisLabel ? 20 : 0, bottom: xAxisLabel ? 18 : 5 }}
          >
            <defs>
              <linearGradient id={`areaGradient-${chartColor}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColor} stopOpacity={0.3} />
                <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey={xAxisKey} {...commonAxisProps} {...xLabelProps} />
            <YAxis
              {...commonAxisProps}
              {...yLabelProps}
              tickFormatter={valueFormatter}
            />
            <Tooltip content={<CustomTooltip valueFormatter={valueFormatter} />} />
            <Legend wrapperStyle={{ fontSize: '12px', color: 'var(--chart-tick)' }} />
            <Area
              type="monotone"
              name={displayName}
              dataKey={dataKey}
              stroke={chartColor}
              strokeWidth={2.5}
              fill={`url(#areaGradient-${chartColor})`}
              dot={{ r: 3, fill: chartColor, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: chartColor, strokeWidth: 2, stroke: 'var(--chart-tooltip-bg)' }}
              animationDuration={600}
              animationEasing="ease-out"
            />
          </AreaChart>
        );

      case 'pie':
        return (
          <PieChart>
            <Tooltip content={<CustomTooltip valueFormatter={valueFormatter} />} />
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              wrapperStyle={{ fontSize: '12px', color: 'var(--chart-tick)' }}
            />
            <Pie
              data={data}
              dataKey={dataKey}
              nameKey={xAxisKey}
              name={displayName}
              cx="40%"
              cy="50%"
              outerRadius="80%"
              innerRadius="50%"
              strokeWidth={2}
              stroke="var(--chart-tooltip-bg)"
              animationDuration={600}
              animationEasing="ease-out"
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={generateColor(index)} />
              ))}
            </Pie>
          </PieChart>
        );

      default:
        return null;
    }
  };

  // Subtitle (or title) takes vertical space — subtract it from the
  // chart container so the plot doesn't get cropped at the bottom.
  const headerHeight = (title ? 28 : 0) + (subtitle ? 16 : 0);
  return (
    <div className="w-full h-full">
      {title && (
        <h3 className="text-sm font-semibold text-fg-secondary mb-0.5 px-1">
          {title}
        </h3>
      )}
      {subtitle && (
        <p className="text-[10px] text-fg-muted mb-2 px-1">{subtitle}</p>
      )}
      <div
        className="w-full"
        style={{
          height: headerHeight > 0 ? `calc(100% - ${headerHeight}px)` : '100%',
          minHeight: 200,
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          {renderChart()!}
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default ProcessChart;
