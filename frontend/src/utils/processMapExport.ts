import type { ProcessNode, ProcessEdge } from '@/types';

/**
 * CSV/download helpers shared by the Sigma WebGL renderer's export control.
 * These mirror the (intentionally untouched) helpers inside ExportMenu.tsx so
 * the two renderers emit byte-identical export files — the same header rows,
 * escaping rules and `# Nodes … # Edges` combined layout.
 */

export function escapeCsv(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildNodesCsv(nodes: ProcessNode[]): string {
  const header = 'activity,frequency,avg_duration,median_duration,is_start,is_end';
  const rows = nodes.map((n) =>
    [
      escapeCsv(n.label),
      escapeCsv(n.frequency),
      escapeCsv(n.avg_duration),
      escapeCsv(n.median_duration),
      escapeCsv(n.is_start),
      escapeCsv(n.is_end),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export function buildEdgesCsv(edges: ProcessEdge[]): string {
  const header = 'source,target,frequency,avg_duration,median_duration,performance_color';
  const rows = edges.map((e) =>
    [
      escapeCsv(e.source),
      escapeCsv(e.target),
      escapeCsv(e.frequency),
      escapeCsv(e.avg_duration),
      escapeCsv(e.median_duration),
      escapeCsv(e.performance_color),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
