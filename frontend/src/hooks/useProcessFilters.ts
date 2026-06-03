import { useEffect, useMemo } from 'react';
import { useFilterStore } from '@/store/filterStore';
import type { ProcessFilter } from '@/types';

// Merge two ProcessFilters into one (sidebar state + chip-derived
// filter). Lists are unioned, scalar bounds take the *tighter* value,
// and attribute filters are combined per-column. Used so the universal
// filter chips and the sidebar FilterPanel both scope the map without
// one clobbering the other (finding #13).
export function mergeProcessFilters(a: ProcessFilter, b: ProcessFilter): ProcessFilter {
  const out: ProcessFilter = {};
  const unionList = (x?: string[], y?: string[]): string[] | undefined => {
    const set = new Set<string>([...(x ?? []), ...(y ?? [])]);
    return set.size ? Array.from(set) : undefined;
  };
  const unionEdges = (
    x?: Array<[string, string]>,
    y?: Array<[string, string]>,
  ): Array<[string, string]> | undefined => {
    const seen = new Set<string>();
    const merged: Array<[string, string]> = [];
    for (const [s, t] of [...(x ?? []), ...(y ?? [])]) {
      const key = `${s}->${t}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push([s, t]);
      }
    }
    return merged.length ? merged : undefined;
  };

  out.activities_include = unionList(a.activities_include, b.activities_include);
  out.activities_exclude = unionList(a.activities_exclude, b.activities_exclude);
  out.start_activities = unionList(a.start_activities, b.start_activities);
  out.end_activities = unionList(a.end_activities, b.end_activities);
  out.required_edges = unionEdges(a.required_edges, b.required_edges);
  out.forbidden_edges = unionEdges(a.forbidden_edges, b.forbidden_edges);

  const variants = Array.from(new Set([...(a.variants ?? []), ...(b.variants ?? [])]));
  if (variants.length) out.variants = variants;

  // Scalar bounds: take the more restrictive (max of mins, min of maxes).
  const mins = [a.duration_min, b.duration_min].filter((v): v is number => v != null);
  if (mins.length) out.duration_min = Math.max(...mins);
  const maxs = [a.duration_max, b.duration_max].filter((v): v is number => v != null);
  if (maxs.length) out.duration_max = Math.min(...maxs);

  out.time_start = a.time_start ?? b.time_start;
  out.time_end = a.time_end ?? b.time_end;

  // Attribute filters — combine per column, unioning values. (We use a
  // plain record rather than a Map because `Map` is shadowed by the
  // lucide-react icon import in the consuming module.)
  const byColumn: Record<string, { column: string; values: string[]; exclude?: boolean }> = {};
  for (const attr of [...(a.attributes ?? []), ...(b.attributes ?? [])]) {
    const existing = byColumn[attr.column];
    if (existing) {
      existing.values = Array.from(new Set([...existing.values, ...attr.values]));
      if (attr.exclude) existing.exclude = true;
    } else {
      byColumn[attr.column] = { ...attr, values: [...attr.values] };
    }
  }
  const columns = Object.values(byColumn);
  if (columns.length) out.attributes = columns;

  // Strip undefined keys so Object.keys()-based "has filters" checks
  // stay accurate.
  (Object.keys(out) as Array<keyof ProcessFilter>).forEach((k) => {
    if (out[k] === undefined) delete out[k];
  });
  return out;
}

export interface UseProcessFiltersResult {
  /** Sidebar/edge-modal state merged with the chip-derived filter. */
  mergedFilters: ProcessFilter;
  /** ``mergedFilters`` memoized on its JSON shape, for stable query keys. */
  stableFilters: ProcessFilter;
  /** Whether any filter is currently active. */
  hasFilters: boolean;
}

// Finding #13 — unify the filter systems. The chip bar / DSL bar write
// to the shared filterStore (which drives the analysis tabs), while the
// sidebar FilterPanel drives the map via the local ``filters`` state
// passed in here. We project the active chips into a ProcessFilter and
// merge them with the sidebar state so the universal chips now scope the
// *map* too — closing the silent inconsistency where chips moved the
// analysis tabs but left the map untouched.
//
// We also reflect the sidebar FilterPanel's state back into the shared
// filterStore so the analysis tabs see the same scope the map does. We
// tag panel-originated chips with ``__source: 'panel'`` and reconcile
// them whenever the sidebar (or edge-modal) ``filters`` change: drop the
// stale panel chips and re-derive fresh ones. Chips added by other
// surfaces (map clicks, DSL bar) are left untouched. The merge into the
// map is a set-union, so a facet living in both ``filters`` and a panel
// chip never double-counts.
export function useProcessFilters(filters: ProcessFilter): UseProcessFiltersResult {
  const chips = useFilterStore((s) => s.chips);
  const chipDisabled = useFilterStore((s) => s.disabled);
  const toProcessFilter = useFilterStore((s) => s.toProcessFilter);
  const addChip = useFilterStore((s) => s.addChip);
  const removeChip = useFilterStore((s) => s.removeChip);

  const chipFilter = useMemo(
    () => toProcessFilter(),
    // Recompute whenever the active chip set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chips, chipDisabled, toProcessFilter],
  );

  const mergedFilters = useMemo(
    () => mergeProcessFilters(filters, chipFilter),
    [filters, chipFilter],
  );
  const stableFilters = useMemo(
    () => mergedFilters,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(mergedFilters)],
  );
  const hasFilters = Object.keys(mergedFilters).length > 0;

  useEffect(() => {
    const stalePanelChipIds = useFilterStore
      .getState()
      .chips.filter((c) => c.payload.__source === 'panel')
      .map((c) => c.id);
    stalePanelChipIds.forEach((id) => removeChip(id));

    const tag = { __source: 'panel' as const };
    for (const act of filters.activities_include ?? []) {
      addChip({ type: 'activity', label: `activity: ${act}`, payload: { activity: act, ...tag } });
    }
    for (const act of filters.activities_exclude ?? []) {
      addChip({ type: 'activity_exclude', label: `exclude: ${act}`, payload: { activity: act, ...tag } });
    }
    for (const [s, t] of filters.required_edges ?? []) {
      addChip({ type: 'edge', label: `edge: ${s} → ${t}`, payload: { source: s, target: t, ...tag } });
    }
    if (filters.duration_min != null || filters.duration_max != null) {
      addChip({
        type: 'duration_range',
        label: `duration: ${filters.duration_min ?? '0'}–${filters.duration_max ?? '∞'}s`,
        payload: { min: filters.duration_min ?? null, max: filters.duration_max ?? null, ...tag },
      });
    }
    if (filters.time_start || filters.time_end) {
      addChip({
        type: 'time_range',
        label: `time: ${filters.time_start ?? '…'} – ${filters.time_end ?? '…'}`,
        payload: { start: filters.time_start ?? null, end: filters.time_end ?? null, ...tag },
      });
    }
    for (const attr of filters.attributes ?? []) {
      for (const v of attr.values) {
        addChip({
          type: 'attribute_value',
          label: `${attr.column}: ${v}`,
          payload: { attribute: attr.column, value: v, ...tag },
        });
      }
    }
    // Only re-run when the sidebar/edge-modal filter object changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)]);

  return { mergedFilters, stableFilters, hasFilters };
}
