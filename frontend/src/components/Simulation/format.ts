// ─── Simulation formatting helpers ──────────────────────────────────────────

export function formatPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}
