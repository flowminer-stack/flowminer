import { formatDistanceToNow, format, parseISO } from 'date-fns';

const DURATION_UNITS: [number, string][] = [
  [86400, 'd'],
  [3600, 'h'],
  [60, 'm'],
  [1, 's'],
];

export function formatDuration(seconds: number): string {
  if (seconds < 0) return '—';
  if (seconds === 0) return '0s';

  if (seconds < 1) {
    return `${(seconds * 1000).toFixed(0)}ms`;
  }

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const parts: string[] = [];
  let remaining = Math.floor(seconds);

  for (const [unit, label] of DURATION_UNITS) {
    if (remaining >= unit) {
      const count = Math.floor(remaining / unit);
      parts.push(`${count}${label}`);
      remaining %= unit;
    }
    if (parts.length === 2) break;
  }

  return parts.join(' ');
}

export function formatNumber(n: number): string {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

export function formatPercentage(n: number, decimals: number = 1): string {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

export function formatRelativeTime(date: string): string {
  if (!date) return '—';
  try {
    const parsed = typeof date === 'string' ? parseISO(date) : date;
    return formatDistanceToNow(parsed, { addSuffix: true });
  } catch {
    return '—';
  }
}

export function formatDate(date: string): string {
  if (!date) return '—';
  try {
    const parsed = typeof date === 'string' ? parseISO(date) : date;
    return format(parsed, 'MMM d, yyyy');
  } catch {
    return '—';
  }
}

export function formatDateTime(date: string): string {
  if (!date) return '—';
  try {
    const parsed = typeof date === 'string' ? parseISO(date) : date;
    return format(parsed, 'MMM d, yyyy HH:mm');
  } catch {
    return '—';
  }
}

export function severityColor(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical':
    case 'high':
      return 'text-danger bg-danger border-danger';
    case 'medium':
    case 'moderate':
      return 'text-warning bg-warning border-warning';
    case 'low':
      return 'text-success bg-success border-success';
    case 'info':
      return 'text-accent bg-accent border-accent';
    default:
      return 'text-slate-600 bg-slate-50 border-slate-200';
  }
}

export function truncate(str: string, max: number): string {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}

const CHART_PALETTE = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // rose
  '#ec4899', // pink
  '#3b82f6', // blue
  '#14b8a6', // teal
  '#f97316', // orange
  '#84cc16', // lime
  '#a855f7', // purple
  '#22d3ee', // cyan-light
  '#34d399', // emerald-light
  '#fbbf24', // amber-light
  '#fb7185', // rose-light
];

export function generateColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

export function performanceLabel(color: string): { label: string; className: string } {
  switch (color) {
    case 'green':
    case '#22c55e':
      return { label: 'Fast', className: 'text-success bg-success' };
    case 'yellow':
    case '#eab308':
      return { label: 'Normal', className: 'text-warning bg-warning' };
    case 'red':
    case '#ef4444':
      return { label: 'Slow', className: 'text-danger bg-danger' };
    default:
      return { label: 'Unknown', className: 'text-slate-600 bg-slate-50' };
  }
}

export function parseCronToHuman(cron: string): string {
  if (!cron) return '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (minute === '*' && hour === '*') return 'Every minute';
  if (minute === '0' && hour === '*') return 'Every hour';
  if (minute === '*/5') return 'Every 5 minutes';
  if (minute === '*/15') return 'Every 15 minutes';
  if (minute === '*/30') return 'Every 30 minutes';
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*')
    return 'Daily at midnight';
  if (minute === '0' && hour !== '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*')
    return `Daily at ${hour}:00`;
  if (dayOfWeek === '1' && dayOfMonth === '*') return `Weekly on Monday at ${hour}:${minute.padStart(2, '0')}`;
  if (dayOfMonth === '1' && month === '*' && dayOfWeek === '*')
    return `Monthly on the 1st at ${hour}:${minute.padStart(2, '0')}`;

  return cron;
}
