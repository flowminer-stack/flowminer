// Shared cross-view filter context.
//
// This is the backbone for a whole cluster of competitive features we
// ship in Wave 0 / 1:
//
//   - Click-to-filter (UiPath / Celonis / ARIS): clicking a node on any
//     visualisation adds a persistent chip here.
//   - Filter breadcrumb with per-chip undo (Apromore / Signavio): the
//     chips are rendered as a persistent pill bar above the main view.
//   - "Focus this variant" (Apromore / Disco): stashes the variant's
//     activity sequence as a scope filter that re-runs analyses.
//   - Saved views as URLs (UiPath): we serialise this state into the
//     URL query string so sharing a link reproduces the exact analysis.
//   - Filter export / import (Microsoft PAPM): JSON dump of the chips.
//   - Auto-inject current filter into AI chat (KYP.ai): chat endpoints
//     read from this store.
//   - Associative cross-filter (Mehrwerk mpmX): any widget that adds
//     a chip re-filters every other widget subscribing to the store.
//
// Keep this store tiny on purpose — heavy analysis state lives in
// useMiningStore; this is purely filter definitions.

import { create } from 'zustand';

export type FilterChipType =
  | 'activity'         // include only cases touching this activity
  | 'activity_exclude' // exclude cases touching this activity
  | 'edge'             // include cases traversing this DFG edge
  | 'variant'          // scope to one variant by activity sequence
  | 'case'             // explicit case id subset
  | 'attribute_range'  // numeric attribute within [min, max]
  | 'attribute_value'  // categorical attribute equals value
  | 'duration_range'   // case duration within [min, max] seconds
  | 'time_range'       // start time within [iso, iso]
  | 'resource';        // one or more resource names

export interface FilterChip {
  id: string; // uuid — used for dedup + per-chip remove
  type: FilterChipType;
  label: string; // human-readable, rendered on the chip
  // Free-form payload the backend readers know how to unpack. We keep
  // it typed as `unknown` here and push all validation to the caller.
  payload: Record<string, unknown>;
}

export interface FilterState {
  eventLogId: string | null;
  chips: FilterChip[];
  // Per-chip hidden state so users can toggle a chip "off" without
  // deleting it. Keyed by chip id.
  disabled: Record<string, boolean>;
}

interface FilterActions {
  setEventLog: (id: string | null) => void;
  addChip: (chip: Omit<FilterChip, 'id'>) => string;
  removeChip: (id: string) => void;
  toggleChip: (id: string) => void;
  clearChips: () => void;
  // Serialise to JSON for export / URL / AI-context injection.
  serialise: () => string;
  // Replace the whole chip list from a serialised blob.
  deserialise: (json: string) => void;
  // Build the backend filter query params. Every analysis endpoint that
  // accepts filters reads from this helper so chip semantics stay
  // consistent across pages.
  toQuery: () => Record<string, string>;
}

function newId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 12);
}

export const useFilterStore = create<FilterState & FilterActions>((set, get) => ({
  eventLogId: null,
  chips: [],
  disabled: {},

  setEventLog: (id) => {
    const current = get().eventLogId;
    if (current === id) return;
    // Changing logs wipes any chips keyed to the old log. Otherwise a
    // chip pointing at "Review Request" in one log would bleed into a
    // completely unrelated log and look mysterious.
    set({ eventLogId: id, chips: [], disabled: {} });
  },

  addChip: (chip) => {
    const id = newId();
    set((state) => ({ chips: [...state.chips, { id, ...chip }] }));
    return id;
  },

  removeChip: (id) => {
    set((state) => {
      const { [id]: _dropped, ...rest } = state.disabled;
      return {
        chips: state.chips.filter((c) => c.id !== id),
        disabled: rest,
      };
    });
  },

  toggleChip: (id) => {
    set((state) => ({
      disabled: { ...state.disabled, [id]: !state.disabled[id] },
    }));
  },

  clearChips: () => set({ chips: [], disabled: {} }),

  serialise: () => {
    const { chips, disabled, eventLogId } = get();
    return JSON.stringify({ eventLogId, chips, disabled });
  },

  deserialise: (json) => {
    try {
      const parsed = JSON.parse(json);
      set({
        eventLogId: parsed.eventLogId ?? null,
        chips: Array.isArray(parsed.chips) ? parsed.chips : [],
        disabled: parsed.disabled ?? {},
      });
    } catch {
      // Bad blob — silently ignore. The user sees no change.
    }
  },

  toQuery: () => {
    const { chips, disabled } = get();
    const active = chips.filter((c) => !disabled[c.id]);
    const out: Record<string, string> = {};
    // Collect per-type lists so the backend sees one key per category.
    const bucket = (key: string, value: string) => {
      out[key] = out[key] ? `${out[key]},${value}` : value;
    };
    for (const c of active) {
      switch (c.type) {
        case 'activity':
          bucket('include_activity', String(c.payload.activity ?? ''));
          break;
        case 'activity_exclude':
          bucket('exclude_activity', String(c.payload.activity ?? ''));
          break;
        case 'edge':
          bucket(
            'include_edge',
            `${c.payload.source ?? ''}->${c.payload.target ?? ''}`,
          );
          break;
        case 'variant':
          if (Array.isArray(c.payload.activities)) {
            out['variant_activities'] = (c.payload.activities as string[]).join('|');
          }
          break;
        case 'case':
          if (Array.isArray(c.payload.case_ids)) {
            out['case_ids'] = (c.payload.case_ids as string[]).join(',');
          }
          break;
        case 'resource':
          bucket('resource', String(c.payload.name ?? ''));
          break;
        case 'duration_range':
          if (c.payload.min != null) out['duration_min'] = String(c.payload.min);
          if (c.payload.max != null) out['duration_max'] = String(c.payload.max);
          break;
        case 'time_range':
          if (c.payload.start) out['time_start'] = String(c.payload.start);
          if (c.payload.end) out['time_end'] = String(c.payload.end);
          break;
        case 'attribute_range':
          if (c.payload.attribute && c.payload.min != null)
            out[`attr_${c.payload.attribute}_min`] = String(c.payload.min);
          if (c.payload.attribute && c.payload.max != null)
            out[`attr_${c.payload.attribute}_max`] = String(c.payload.max);
          break;
        case 'attribute_value':
          if (c.payload.attribute && c.payload.value != null)
            bucket(`attr_${c.payload.attribute}`, String(c.payload.value));
          break;
      }
    }
    return out;
  },
}));

// Convenience summary for rendering the chip count in headers without
// subscribing to the whole chip array.
export const useActiveFilterCount = () =>
  useFilterStore((s) => s.chips.filter((c) => !s.disabled[c.id]).length);
