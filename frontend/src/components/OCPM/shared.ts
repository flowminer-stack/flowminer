// ─── Shared constants & helpers for OCPM panels ───────────────────────────────

export const TYPE_COLORS = [
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#3b82f6', // blue
  '#ec4899', // pink
  '#64748b', // slate
];

export const CHART_COLORS = { primary: '#06b6d4', secondary: '#8b5cf6' };

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function getTypeColor(types: string[], type: string): string {
  const idx = types.indexOf(type);
  return TYPE_COLORS[idx % TYPE_COLORS.length] ?? '#64748b';
}

// Compute a relative intensity 0–1 for heat mapping
export function intensity(value: number, max: number): number {
  if (max === 0) return 0;
  return value / max;
}
