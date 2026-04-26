import React from 'react';
import clsx from 'clsx';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface KPICardProps {
  title: string;
  value: string | number;
  unit?: string;
  change?: number;
  changeLabel?: string;
  icon?: React.ReactNode;
  color?: string;
  // Benchmark bar inputs. When all three are supplied (current, target,
  // bestInClass) the card renders a Celonis-style horizontal bar showing
  // where the current value sits relative to the target and best-in-class.
  currentNumeric?: number;
  target?: number;
  bestInClass?: number;
  lowerIsBetter?: boolean;
}

const colorMap: Record<string, { border: string; iconBg: string; iconText: string }> = {
  indigo: { border: 'border-l-cyan-500', iconBg: 'bg-accent/10', iconText: 'text-accent' },
  emerald: { border: 'border-l-emerald-500', iconBg: 'bg-success/10', iconText: 'text-success' },
  violet: { border: 'border-l-violet-500', iconBg: 'bg-accent/10', iconText: 'text-accent' },
  amber: { border: 'border-l-amber-500', iconBg: 'bg-warning/10', iconText: 'text-warning' },
  rose: { border: 'border-l-red-500', iconBg: 'bg-danger/10', iconText: 'text-danger' },
  cyan: { border: 'border-l-cyan-500', iconBg: 'bg-accent/10', iconText: 'text-accent' },
  sky: { border: 'border-l-sky-500', iconBg: 'bg-accent/10', iconText: 'text-accent' },
};

const KPICard: React.FC<KPICardProps> = ({
  title,
  value,
  unit,
  change,
  changeLabel,
  icon,
  color = 'indigo',
  currentNumeric,
  target,
  bestInClass,
  lowerIsBetter = false,
}) => {
  const colors = colorMap[color] || colorMap.indigo;

  const hasBenchmark =
    currentNumeric != null && (target != null || bestInClass != null);

  const changeIsPositive = change !== undefined && change > 0;
  const changeIsNegative = change !== undefined && change < 0;
  const changeIsNeutral = change !== undefined && change === 0;

  return (
    <div
      className={clsx(
        'bg-surface-2 rounded-xl border border-line border-l-4 p-5',
        'transition-colors duration-200',
        colors.border
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-[12px] font-medium text-fg-muted leading-tight">
          {title}
        </h3>
        {icon && (
          <div
            className={clsx(
              'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
              colors.iconBg,
              colors.iconText
            )}
          >
            {icon}
          </div>
        )}
      </div>

      <div className="flex items-baseline gap-1.5 mb-1">
        <span className="text-3xl font-bold text-fg tracking-tight">
          {value}
        </span>
        {unit && (
          <span className="text-sm font-medium text-fg-faint">{unit}</span>
        )}
      </div>

      {change !== undefined && (
        <div className="flex items-center gap-1.5 mt-2">
          <div
            className={clsx(
              'flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs font-semibold',
              changeIsPositive && 'bg-success/10 text-success',
              changeIsNegative && 'bg-danger/10 text-danger',
              changeIsNeutral && 'bg-tint text-fg-muted'
            )}
          >
            {changeIsPositive && <TrendingUp className="w-3 h-3" />}
            {changeIsNegative && <TrendingDown className="w-3 h-3" />}
            {changeIsNeutral && <Minus className="w-3 h-3" />}
            <span>
              {changeIsPositive && '+'}
              {change.toFixed(1)}%
            </span>
          </div>
          {changeLabel && (
            <span className="text-xs text-fg-faint">{changeLabel}</span>
          )}
        </div>
      )}

      {hasBenchmark && (
        <BenchmarkBar
          current={currentNumeric!}
          target={target}
          bestInClass={bestInClass}
          lowerIsBetter={lowerIsBetter}
        />
      )}
    </div>
  );
};

function BenchmarkBar({
  current,
  target,
  bestInClass,
  lowerIsBetter,
}: {
  current: number;
  target?: number;
  bestInClass?: number;
  lowerIsBetter: boolean;
}) {
  // Compute a scale that fits all three markers with a little padding.
  const values = [current, target, bestInClass].filter(
    (v): v is number => v != null,
  );
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = range * 0.1;
  const scaleMin = min - pad;
  const scaleMax = max + pad;
  const scaleRange = scaleMax - scaleMin || 1;
  const pct = (v: number) => ((v - scaleMin) / scaleRange) * 100;

  // "On track" if current is on the better side of target.
  let onTrack: boolean | null = null;
  if (target != null) {
    onTrack = lowerIsBetter ? current <= target : current >= target;
  }

  return (
    <div className="mt-3 border-t border-line/60 pt-3">
      <div className="relative h-2 rounded-full bg-tint">
        {/* Best-in-class dashed marker */}
        {bestInClass != null && (
          <div
            className="absolute top-[-4px] bottom-[-4px] border-l-2 border-dashed border-fg-muted"
            style={{ left: `${pct(bestInClass)}%` }}
            title={`Best in class: ${bestInClass.toLocaleString()}`}
          />
        )}
        {/* Target solid marker */}
        {target != null && (
          <div
            className="absolute top-[-4px] bottom-[-4px] w-0.5 bg-fg-faint"
            style={{ left: `${pct(target)}%` }}
            title={`Target: ${target.toLocaleString()}`}
          />
        )}
        {/* Current value filled circle */}
        <div
          className={clsx(
            'absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 border-surface-2',
            onTrack === true && 'bg-success',
            onTrack === false && 'bg-danger',
            onTrack == null && 'bg-accent',
          )}
          style={{ left: `${pct(current)}%` }}
          title={`Current: ${current.toLocaleString()}`}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-fg-faint">
        <span>
          {target != null && (
            <>
              Target{' '}
              <span className="font-semibold text-fg-muted">{target.toLocaleString()}</span>
            </>
          )}
        </span>
        <span>
          {bestInClass != null && (
            <>
              Best in class{' '}
              <span className="font-semibold text-fg-muted">{bestInClass.toLocaleString()}</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export default KPICard;
