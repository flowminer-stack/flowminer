import { useState } from 'react';
import { Boxes, ChevronRight, Loader2, CheckCircle2 } from 'lucide-react';
import { ocel as ocelApi } from '@/api/client';
import { useUIStore } from '@/store';
import type { EventLog } from '@/types';

type FlattenKey = string; // `${ocelId}:${objectType}`

interface EventLogPickerProps {
  logs: EventLog[];
  value: string;
  /** Called with the real (possibly flattened) event_log_id plus a display label. */
  onChange: (eventLogId: string, displayLabel: string) => void;
  /** Optional placeholder when no logs exist. */
  emptyHint?: string;
}

/**
 * Unified event-log source picker that understands OCEL logs.
 *
 * Standard logs render as clickable rows. OCEL logs render as expandable
 * cards with one chip per object_type; clicking a chip lazily flattens
 * the OCEL via POST /ocel/{id}/flatten/{type} and selects the resulting
 * (hidden) standard EventLog. Backend + client-side caching mean repeat
 * picks of the same slice are free.
 */
export default function EventLogPicker({
  logs,
  value,
  onChange,
  emptyHint,
}: EventLogPickerProps) {
  const addNotification = useUIStore((s) => s.addNotification);

  const standardLogs = logs.filter((l) => l.case_id_column);
  const ocelLogs = logs.filter(
    (l) => !l.case_id_column && Array.isArray(l.object_types) && l.object_types.length > 0,
  );

  const [flattenCache, setFlattenCache] = useState<Record<FlattenKey, string>>({});
  const [flattening, setFlattening] = useState<Set<FlattenKey>>(new Set());

  const pickOcelSlice = async (ocelLog: EventLog, objectType: string) => {
    const key: FlattenKey = `${ocelLog.id}:${objectType}`;
    const cached = flattenCache[key];
    if (cached) {
      onChange(cached, `${ocelLog.name} — ${objectType}`);
      return;
    }
    setFlattening((f) => new Set(f).add(key));
    try {
      const r = await ocelApi.flatten(ocelLog.id, objectType);
      setFlattenCache((c) => ({ ...c, [key]: r.event_log_id }));
      onChange(r.event_log_id, `${ocelLog.name} — ${objectType}`);
    } catch (e: any) {
      addNotification({
        type: 'error',
        title: `Flattening "${objectType}" failed`,
        message: e?.response?.data?.detail || e?.message || `Could not flatten ${ocelLog.name}`,
      });
    } finally {
      setFlattening((f) => {
        const next = new Set(f);
        next.delete(key);
        return next;
      });
    }
  };

  if (logs.length === 0) {
    return (
      <p className="text-[12px] text-fg-muted py-3 text-center border border-dashed border-line rounded-lg">
        {emptyHint || 'No event logs in this project yet.'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* Standard logs */}
      {standardLogs.map((l) => {
        const isSel = value === l.id;
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => onChange(l.id, l.name)}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors ${
              isSel
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-line bg-surface-2 text-fg-muted hover:bg-tint/40'
            }`}
          >
            <CheckCircle2
              size={14}
              className={isSel ? 'text-accent' : 'text-fg-ghost'}
              fill={isSel ? 'currentColor' : 'none'}
              strokeWidth={2}
            />
            <span className="truncate flex-1">{l.name}</span>
          </button>
        );
      })}

      {/* OCEL logs — expand into object-type slices */}
      {ocelLogs.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-fg-muted pt-1.5">
            <Boxes size={13} className="text-accent" />
            OCEL logs — pick an object type to use as the case
          </div>
          {ocelLogs.map((l) => (
            <div key={l.id} className="rounded-lg border border-line bg-surface-2 p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg">
                <span className="truncate">{l.name}</span>
                <span className="badge badge-accent">OCEL</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {l.object_types.map((ot: string) => {
                  const key: FlattenKey = `${l.id}:${ot}`;
                  const cached = flattenCache[key];
                  const isSel = !!cached && value === cached;
                  const busy = flattening.has(key);
                  return (
                    <button
                      key={ot}
                      type="button"
                      disabled={busy}
                      onClick={() => pickOcelSlice(l, ot)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                        isSel
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-line bg-surface-1 text-fg-muted hover:bg-tint/40'
                      } ${busy ? 'cursor-wait opacity-70' : ''}`}
                      title={
                        cached
                          ? 'Select this flattened view'
                          : 'Flatten on first use (cached after)'
                      }
                    >
                      {busy ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <ChevronRight size={11} />
                      )}
                      {ot}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
