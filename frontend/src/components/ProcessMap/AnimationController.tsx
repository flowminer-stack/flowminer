import React, { useState, useEffect, useRef, useCallback } from 'react';
import { type Core } from 'cytoscape';
import { Play, Pause, SkipBack, Gauge, Calendar } from 'lucide-react';
import clsx from 'clsx';
import { format, parseISO } from 'date-fns';
import { mining } from '@/api/client';
import type { TimelineEvent } from '@/types';

interface AnimationControllerProps {
  eventLogId: string;
  cyRef: React.RefObject<Core | null>;
  isReady: boolean;
  /**
   * Optional replay hooks for renderers other than cytoscape (e.g. the Sigma
   * WebGL map). `onFlash` fires for every replayed event with the sanitized
   * target node id and the source→target edge key (null when the event has no
   * source). `onReset` fires when the replay is reset. Both are additive: the
   * existing cytoscape animation still runs unchanged when `cyRef` is set.
   */
  onFlash?: (nodeId: string, edgeKey: string | null) => void;
  onReset?: () => void;
}

const SPEEDS = [1, 2, 5, 10] as const;
type Speed = (typeof SPEEDS)[number];

function formatTs(ts: string): string {
  try {
    return format(parseISO(ts), 'MMM d, HH:mm:ss');
  } catch {
    return ts;
  }
}

/** Convert activity name to the sanitized node ID used by cytoscape */
function toNodeId(name: string): string {
  return name.replace(/ /g, '_').replace(/\//g, '_').replace(/\\/g, '_').toLowerCase();
}

const AnimationController: React.FC<AnimationControllerProps> = ({
  eventLogId,
  cyRef,
  isReady,
  onFlash,
  onReset,
}) => {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Fetch timeline
  useEffect(() => {
    setLoading(true);
    mining
      .getTimeline(eventLogId)
      .then((data) => {
        setEvents(data.events);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load timeline.');
        setLoading(false);
      });
    return () => {
      flashTimers.current.forEach((t) => clearTimeout(t));
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [eventLogId]);

  // Flash a node + edge
  const flashEvent = useCallback(
    (evt: TimelineEvent) => {
      const targetId = toNodeId(evt.activity);
      const edgeId = evt.source ? `${toNodeId(evt.source)}->${targetId}` : null;

      // Renderer-agnostic hook FIRST — fires even when cyRef is null (Sigma
      // mode). ids/edge-key match the Sigma graph keys exactly, so no remap.
      onFlash?.(targetId, edgeId);

      // Cytoscape-specific animation below; no-ops in Sigma mode (cy == null).
      const cy = cyRef.current;
      if (!cy) return;

      const targetNode = cy.getElementById(targetId);

      // Flash the target node
      if (targetNode && targetNode.length > 0) {
        const existingTimer = flashTimers.current.get(targetId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          targetNode.removeClass('anim-flash');
        }

        targetNode.addClass('anim-flash');
        const timer = setTimeout(() => {
          targetNode.removeClass('anim-flash');
          flashTimers.current.delete(targetId);
        }, 500);
        flashTimers.current.set(targetId, timer);
      }

      // Flash the edge from source → target
      if (evt.source && edgeId) {
        const edge = cy.getElementById(edgeId);

        if (edge && edge.length > 0) {
          const edgeTimerKey = `edge_${edgeId}`;
          const existingEdgeTimer = flashTimers.current.get(edgeTimerKey);
          if (existingEdgeTimer) {
            clearTimeout(existingEdgeTimer);
            edge.removeClass('anim-flash-edge');
          }

          edge.addClass('anim-flash-edge');
          const timer = setTimeout(() => {
            edge.removeClass('anim-flash-edge');
            flashTimers.current.delete(edgeTimerKey);
          }, 500);
          flashTimers.current.set(edgeTimerKey, timer);
        }
      }
    },
    [cyRef, onFlash],
  );

  // Inject flash CSS styles into cytoscape
  useEffect(() => {
    if (!isReady || !cyRef.current) return;
    const cy = cyRef.current;
    try {
      (cy.style() as any)
        .selector('node.anim-flash')
        .css({
          'border-color': '#06b6d4',
          'border-width': 3,
          'background-color': 'rgba(6, 182, 212, 0.18)',
          'z-index': 999,
          'transition-property': 'border-color border-width background-color',
          'transition-duration': '0.08s',
        })
        .selector('edge.anim-flash-edge')
        .css({
          'line-color': '#06b6d4',
          'target-arrow-color': '#06b6d4',
          'width': 4,
          'opacity': 1,
          'z-index': 999,
          'transition-property': 'line-color target-arrow-color width opacity',
          'transition-duration': '0.08s',
        })
        .update();
    } catch {
      // harmless if cy not fully ready
    }
  }, [isReady, cyRef]);

  // Advance one frame
  const advanceFrame = useCallback(() => {
    setCursor((prev) => {
      const next = prev + 1;
      if (next >= events.length) {
        setIsPlaying(false);
        return prev;
      }
      const evt = events[next];
      if (evt) flashEvent(evt);
      return next;
    });
  }, [events, flashEvent]);

  // Play / pause interval
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!isPlaying || events.length === 0) return;

    const intervalMs = Math.max(30, Math.round(500 / speed));
    intervalRef.current = setInterval(advanceFrame, intervalMs);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, speed, advanceFrame, events.length]);

  const handlePlayPause = () => {
    if (cursor >= events.length - 1) {
      // At end — reset and play
      setCursor(0);
      // Flash the first event
      if (events[0]) flashEvent(events[0]);
      setIsPlaying(true);
    } else {
      if (!isPlaying && events[cursor]) {
        // Flash current event when starting
        flashEvent(events[cursor]);
      }
      setIsPlaying((p) => !p);
    }
  };

  const handleReset = () => {
    setIsPlaying(false);
    setCursor(0);
    // Renderer-agnostic reset hook (Sigma mode).
    onReset?.();
    // Clear all flashes (cytoscape mode).
    const cy = cyRef.current;
    if (cy) {
      cy.nodes().removeClass('anim-flash');
      cy.edges().removeClass('anim-flash-edge');
    }
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = Number(e.target.value);
    setCursor(idx);
    if (events[idx]) flashEvent(events[idx]);
  };

  const currentEvent = events[cursor];

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line bg-surface-2/95 px-4 py-2.5 backdrop-blur-md">
      {loading && (
        <span className="text-[11px] text-fg-faint">Loading timeline...</span>
      )}
      {error && (
        <span className="text-[11px] text-danger">{error}</span>
      )}

      {!loading && !error && (
        <>
          {/* Controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={handleReset}
              disabled={cursor === 0 && !isPlaying}
              className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-tint hover:text-fg disabled:opacity-30"
              title="Reset"
            >
              <SkipBack size={13} />
            </button>
            <button
              onClick={handlePlayPause}
              className={clsx(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                isPlaying
                  ? 'bg-accent text-white hover:bg-accent/90'
                  : 'bg-tint text-fg hover:bg-tint/80',
              )}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={13} /> : <Play size={13} />}
            </button>
          </div>

          {/* Speed */}
          <div className="flex items-center gap-0.5 rounded-md border border-line bg-surface-1 p-0.5">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={clsx(
                  'rounded px-2 py-0.5 text-[10px] font-semibold transition-colors',
                  speed === s
                    ? 'bg-accent text-white'
                    : 'text-fg-muted hover:bg-tint hover:text-fg',
                )}
              >
                {s}x
              </button>
            ))}
          </div>

          {/* Scrubber */}
          <input
            type="range"
            min={0}
            max={Math.max(0, events.length - 1)}
            value={cursor}
            onChange={handleScrub}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-tint accent-accent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
          />

          {/* Timestamp */}
          {currentEvent && (
            <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-fg-muted">
              <Calendar size={10} />
              <span className="font-mono">{formatTs(currentEvent.timestamp)}</span>
            </div>
          )}

          {/* Current activity */}
          {currentEvent && (
            <div className="shrink-0 rounded bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
              {currentEvent.activity}
            </div>
          )}

          {/* Event counter */}
          <div className="flex shrink-0 items-center gap-1 text-[10px] text-fg-muted">
            <Gauge size={11} />
            <span className="tabular-nums">
              <span className="font-semibold text-fg-secondary">
                {(cursor + 1).toLocaleString()}
              </span>
              {' / '}
              {events.length.toLocaleString()}
            </span>
          </div>
        </>
      )}
    </div>
  );
};

export default AnimationController;
