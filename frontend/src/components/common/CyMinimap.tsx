import { useEffect, useRef, useState } from 'react';
import { Map as MapIcon } from 'lucide-react';
import cytoscape from 'cytoscape';
import navigator from 'cytoscape-navigator';
import 'cytoscape-navigator/cytoscape.js-navigator.css';
import type { Core } from 'cytoscape';

// Register the navigator extension once (idempotent across every graph).
try { cytoscape.use(navigator); } catch { /* already registered */ }

type Corner = 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left';

const CORNER_POS: Record<Corner, React.CSSProperties> = {
  'top-right': { top: 12, right: 12, alignItems: 'flex-end' },
  'bottom-right': { bottom: 12, right: 12, alignItems: 'flex-end' },
  'top-left': { top: 12, left: 12, alignItems: 'flex-start' },
  'bottom-left': { bottom: 12, left: 12, alignItems: 'flex-start' },
};

// Module-level counter → a stable, collision-free container id per instance
// (the navigator resolves its container by string selector, so two minimaps
// must never share an id). Avoids a hard dependency on React 18's useId.
let _seq = 0;

interface CyMinimapProps {
  /** Ref to the cytoscape core rendered by the parent graph. */
  cyRef: React.RefObject<Core | null>;
  /**
   * Bumped by the parent after every (re)build of the cy instance. The
   * navigator binds listeners to a *specific* core, so it must be recreated
   * whenever the parent destroys + recreates `cyRef.current`. 0 = not built
   * yet (nothing to navigate).
   */
  cyEpoch: number;
  /** Which corner of the (relative) graph container to dock in. */
  corner?: Corner;
  /**
   * Whether the minimap starts open. Defaults to true — every graph shows its
   * minimap by default so the bird's-eye view is there without hunting for a
   * toggle.
   */
  defaultOpen?: boolean;
}

/**
 * Reusable bird's-eye minimap for any cytoscape graph, wrapping
 * `cytoscape-navigator`. Drop it inside the graph's `position: relative`
 * container and bump `cyEpoch` whenever the cy instance is rebuilt.
 *
 * (ProcessMap keeps its own older, bespoke minimap; every other graph should
 * use this component.)
 */
export default function CyMinimap({
  cyRef,
  cyEpoch,
  corner = 'top-right',
  defaultOpen = true,
}: CyMinimapProps) {
  const [open, setOpen] = useState(defaultOpen);
  const idRef = useRef<string>('');
  if (!idRef.current) idRef.current = `cy-minimap-${++_seq}`;
  const containerId = idRef.current;

  // (Re)create the navigator for the current cy instance. cytoscape-navigator's
  // destroy() doesn't fully unbind the listeners it puts on the core, so we
  // bind ONCE per cy instance (keyed on cyEpoch) and never on open/close —
  // toggling just flips CSS. On a rebuild the previous core was already
  // destroyed by the parent, so its listeners died with it; the cleanup's
  // destroy() is best-effort.
  const navRef = useRef<{ destroy(): void } | null>(null);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cyEpoch === 0) return;
    try {
      const withNav = cy as unknown as {
        navigator(o: Record<string, unknown>): { destroy(): void };
      };
      navRef.current = withNav.navigator({
        container: `#${containerId}`,
        viewLiveFramerate: 0, // redraw the viewport box on demand, not every frame
        thumbnailEventFramerate: 30, // cap thumbnail refreshes
        dblClickDelay: 200,
        removeCustomContainer: false, // keep our React-owned div on destroy
      });
    } catch (err) {
      console.warn('CyMinimap init failed', err);
    }
    return () => {
      try { navRef.current?.destroy(); } catch { /* core already gone */ }
      navRef.current = null;
    };
  }, [cyEpoch, containerId, cyRef]);

  if (cyEpoch === 0) return null; // nothing to navigate yet

  return (
    <div className="absolute z-10 flex flex-col gap-1" style={CORNER_POS[corner]}>
      {/* Bird's-eye container. Always mounted while the graph exists (the
          navigator resolves it by id); hidden via CSS when closed so we never
          rebind listeners. Inline styles override the library's default
          position:fixed 400x400 panel. */}
      <div
        id={containerId}
        className="cytoscape-navigator overflow-hidden rounded-lg border border-line bg-surface-2 shadow-md"
        aria-hidden="true"
        style={{
          position: 'relative',
          top: 'auto',
          right: 'auto',
          bottom: 'auto',
          left: 'auto',
          width: 180,
          height: 120,
          display: open ? 'block' : 'none',
        }}
      />
      <button
        onClick={() => setOpen((v) => !v)}
        className={`self-end rounded-md border border-line p-2 backdrop-blur-md transition-colors ${
          open
            ? 'bg-accent/10 text-accent'
            : 'bg-surface-2/95 text-fg-muted hover:text-fg'
        }`}
        title={open ? 'Hide minimap' : 'Show minimap'}
        aria-pressed={open}
      >
        <MapIcon size={14} />
      </button>
    </div>
  );
}
