import React, { useRef, useEffect, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Download, AlertCircle, ArrowRightLeft } from 'lucide-react';
import { mining } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCached, setCached } from '@/store/analysisCache';

/**
 * Transform a BPMN XML layout from vertical (top-down) to horizontal (left-right)
 * by swapping x/y (and width/height for shape bounds) in BPMNDI coordinates.
 */
function toHorizontal(xml: string): string {
  // dc:Bounds — swap x/y and width/height
  let transformed = xml.replace(/<dc:Bounds\b[^/>]*\/?>/g, (match) => {
    const x = match.match(/x="([-\d.]+)"/)?.[1];
    const y = match.match(/y="([-\d.]+)"/)?.[1];
    const w = match.match(/width="([-\d.]+)"/)?.[1];
    const h = match.match(/height="([-\d.]+)"/)?.[1];
    if (x === undefined || y === undefined) return match;
    let result = match;
    result = result.replace(/x="([-\d.]+)"/, `x="__TMPX__"`).replace(/y="([-\d.]+)"/, `y="${x}"`);
    result = result.replace(`__TMPX__`, y);
    if (w !== undefined && h !== undefined) {
      result = result
        .replace(/width="([-\d.]+)"/, `width="__TMPW__"`)
        .replace(/height="([-\d.]+)"/, `height="${w}"`)
        .replace(`__TMPW__`, h);
    }
    return result;
  });

  // di:waypoint — swap x/y only
  transformed = transformed.replace(/<di:waypoint\b[^/>]*\/?>/g, (match) => {
    const x = match.match(/x="([-\d.]+)"/)?.[1];
    const y = match.match(/y="([-\d.]+)"/)?.[1];
    if (x === undefined || y === undefined) return match;
    return match
      .replace(/x="([-\d.]+)"/, `x="__TMPX__"`)
      .replace(/y="([-\d.]+)"/, `y="${x}"`)
      .replace(`__TMPX__`, y);
  });

  return transformed;
}

// bpmn-js required CSS
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';

interface BPMNViewerProps {
  eventLogId: string;
}

const BPMNViewer: React.FC<BPMNViewerProps> = ({ eventLogId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const xmlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [horizontal, setHorizontal] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;

    const loadBpmn = async () => {
      setLoading(true);
      setError(null);

      try {
        // Dynamic import to avoid SSR issues and reduce initial bundle
        const BpmnJS = (await import('bpmn-js/lib/NavigatedViewer')).default;

        let data = getCached<{ bpmn_xml: string }>(eventLogId, 'bpmn_export');
        if (!data) {
          data = await mining.exportBpmn(eventLogId);
          setCached(eventLogId, 'bpmn_export', data);
        }

        if (cancelled) return;

        xmlRef.current = data.bpmn_xml;

        // Destroy previous
        if (viewerRef.current) {
          viewerRef.current.destroy();
          viewerRef.current = null;
        }

        const viewer = new BpmnJS({
          container: containerRef.current!,
        });
        viewerRef.current = viewer;

        const xml = horizontal ? toHorizontal(data.bpmn_xml) : data.bpmn_xml;
        const result = await viewer.importXML(xml);

        if (result.warnings && result.warnings.length > 0) {
          console.warn('BPMN import warnings:', result.warnings);
        }

        // Fit after a brief delay to ensure the container has rendered
        requestAnimationFrame(() => {
          if (cancelled || !viewerRef.current) return;
          try {
            const canvas = viewerRef.current.get('canvas');
            canvas.zoom('fit-viewport', 'auto');
          } catch {
            // ignore zoom errors
          }
        });
      } catch (err) {
        if (!cancelled) {
          console.error('BPMN load error:', err);
          setError(err instanceof Error ? err.message : 'Failed to load BPMN model');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadBpmn();

    return () => {
      cancelled = true;
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, [eventLogId, horizontal]);

  const handleZoomIn = () => {
    try {
      const canvas = viewerRef.current?.get('canvas');
      if (canvas) canvas.zoom(canvas.zoom() * 1.3);
    } catch (err) { console.warn('BPMNViewer zoom error:', err); }
  };

  const handleZoomOut = () => {
    try {
      const canvas = viewerRef.current?.get('canvas');
      if (canvas) canvas.zoom(canvas.zoom() / 1.3);
    } catch (err) { console.warn('BPMNViewer zoom error:', err); }
  };

  const handleFit = () => {
    try {
      const canvas = viewerRef.current?.get('canvas');
      if (canvas) canvas.zoom('fit-viewport', 'auto');
    } catch (err) { console.warn('BPMNViewer zoom error:', err); }
  };

  const handleExportSvg = async () => {
    if (!viewerRef.current) return;
    try {
      const { svg } = await viewerRef.current.saveSVG();
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'process-model.bpmn.svg';
      link.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  };

  return (
    <div className="relative w-full h-full min-h-[500px]" style={{ position: 'relative' }}>
      {/* Controls */}
      <div className="absolute bottom-3 right-3 z-20 flex items-center gap-px rounded-lg border border-line bg-surface-2/95 backdrop-blur-md p-0.5 shadow-sm">
        <button onClick={handleZoomIn} className="p-2 rounded-md text-fg-muted hover:bg-tint hover:text-fg transition-colors" title="Zoom in">
          <ZoomIn size={14} />
        </button>
        <button onClick={handleZoomOut} className="p-2 rounded-md text-fg-muted hover:bg-tint hover:text-fg transition-colors" title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <div className="w-px h-5 bg-line mx-0.5" />
        <button onClick={handleFit} className="p-2 rounded-md text-fg-muted hover:bg-tint hover:text-fg transition-colors" title="Fit to screen">
          <Maximize2 size={14} />
        </button>
        <button
          onClick={() => setHorizontal((h) => !h)}
          className={`p-2 rounded-md transition-colors ${
            horizontal ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-tint hover:text-fg'
          }`}
          title={horizontal ? 'Switch to vertical layout' : 'Switch to horizontal layout'}
        >
          <ArrowRightLeft size={14} />
        </button>
        <button onClick={handleExportSvg} className="p-2 rounded-md text-fg-muted hover:bg-tint hover:text-fg transition-colors" title="Export SVG">
          <Download size={14} />
        </button>
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-2/80 z-20">
          <LoadingSpinner size="md" text="Generating BPMN model..." />
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3">
            <AlertCircle size={16} className="text-danger" />
            <span className="text-[12px] text-danger">{error}</span>
          </div>
        </div>
      )}

      {/* bpmn-js canvas — must have explicit height */}
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ minHeight: '500px' }}
      />

      {/* Style overrides for bpmn-js */}
      <style>{`
        .bjs-powered-by { display: none !important; }
        .bjs-container { overflow: hidden !important; }
      `}</style>
    </div>
  );
};

export default BPMNViewer;
