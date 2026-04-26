import React, { useState, useRef, useEffect } from 'react';
import { type Core } from 'cytoscape';
import { Download, Image, FileCode2, FileSpreadsheet, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import type { ProcessNode, ProcessEdge } from '@/types';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ExportMenuProps {
  cyRef: React.RefObject<Core | null>;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  isDark: boolean;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function escapeCsv(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildNodesCsv(nodes: ProcessNode[]): string {
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

function buildEdgesCsv(edges: ProcessEdge[]): string {
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

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Component ────────────────────────────────────────────────────────────────

const ExportMenu: React.FC<ExportMenuProps> = ({ cyRef, nodes, edges, isDark }) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleExportPNG = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const bgColor = isDark ? '#1e1e22' : '#ffffff';
    const png = cy.png({ full: true, scale: 2, bg: bgColor });
    const a = document.createElement('a');
    a.href = png;
    a.download = 'process-map.png';
    a.click();
    setOpen(false);
  };

  const handleExportSVG = () => {
    const cy = cyRef.current;
    if (!cy) return;
    try {
      // cytoscape-svg plugin or built-in cy.svg() if available
      const svgContent = (cy as any).svg({ full: true, scale: 1 });
      triggerDownload(svgContent, 'process-map.svg', 'image/svg+xml');
    } catch {
      // Fallback: notify user
      console.warn('SVG export requires cytoscape-svg plugin.');
    }
    setOpen(false);
  };

  const handleExportCSV = () => {
    const nodesCsv = buildNodesCsv(nodes);
    const edgesCsv = buildEdgesCsv(edges);
    const combined =
      '# Nodes\n' + nodesCsv + '\n\n# Edges\n' + edgesCsv;
    triggerDownload(combined, 'process-map.csv', 'text/csv');
    setOpen(false);
  };

  const items = [
    {
      label: 'Export as PNG',
      description: 'High-res raster image',
      icon: Image,
      action: handleExportPNG,
    },
    {
      label: 'Export as SVG',
      description: 'Scalable vector graphic',
      icon: FileCode2,
      action: handleExportSVG,
    },
    {
      label: 'Export data as CSV',
      description: 'Nodes and edges table',
      icon: FileSpreadsheet,
      action: handleExportCSV,
    },
  ];

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'flex items-center gap-1 p-2 rounded-md text-fg-muted transition-colors',
          'hover:bg-tint hover:text-fg',
          open && 'bg-tint text-fg',
        )}
        title="Export"
      >
        <Download size={14} />
        <ChevronDown
          size={10}
          className={clsx('transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          className={clsx(
            'absolute bottom-full right-0 mb-1 z-50',
            'min-w-[200px] overflow-hidden rounded-lg border border-line',
            'bg-surface-1 shadow-lg',
          )}
        >
          {items.map(({ label, description, icon: Icon, action }) => (
            <button
              key={label}
              onClick={action}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-tint"
            >
              <Icon size={14} className="mt-0.5 shrink-0 text-fg-muted" />
              <div>
                <p className="text-[12px] font-medium text-fg-secondary">
                  {label}
                </p>
                <p className="text-[10px] text-fg-faint">{description}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ExportMenu;
