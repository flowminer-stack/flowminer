import { useEffect, useState } from 'react';
import { Filter, ChevronDown, Clock, Activity, Users, BarChart3, ArrowRight, X, Ban } from 'lucide-react';
import clsx from 'clsx';
import { mining as miningApi } from '@/api/client';
import type { ProcessFilter, FilterOptions } from '@/types';
import { getCached, setCached } from '@/store/analysisCache';

interface FilterPanelProps {
  eventLogId: string;
  filters: ProcessFilter;
  onChange: (filters: ProcessFilter) => void;
}

function formatDur(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function Section({ label, icon: Icon, children, defaultOpen = false }: {
  label: string;
  icon: React.ElementType;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-line last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-semibold text-fg-secondary hover:bg-tint transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Icon size={12} className="text-fg-faint" />
          {label}
        </span>
        <ChevronDown size={11} className={clsx('text-fg-faint transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
}

function MultiSelect({ options, selected, onChange, placeholder }: {
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded border border-line bg-surface-1 px-2 py-1 text-[10px] text-fg-secondary outline-none hover:border-accent/40"
      >
        <span className="truncate">{selected.length ? `${selected.length} selected` : placeholder}</span>
        <ChevronDown size={10} className="text-fg-faint shrink-0 ml-1" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-40 overflow-y-auto rounded border border-line bg-surface-2 py-1 shadow-lg">
          {options.map((opt) => (
            <label key={opt} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-tint text-[10px] text-fg-secondary">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="rounded border-line"
              />
              <span className="truncate">{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FilterPanel({ eventLogId, filters, onChange }: FilterPanelProps) {
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const cached = getCached<FilterOptions>(eventLogId, 'filter_options');
    if (cached) { setOptions(cached); setLoading(false); return; }
    setLoading(true);
    miningApi.getFilterOptions(eventLogId)
      .then((opts) => { setCached(eventLogId, 'filter_options', opts); setOptions(opts); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [eventLogId]);

  const activeCount = [
    filters.time_start || filters.time_end,
    filters.duration_min != null || filters.duration_max != null,
    filters.activities_include?.length,
    filters.activities_exclude?.length,
    filters.start_activities?.length,
    filters.end_activities?.length,
    filters.attributes?.length,
    filters.required_edges?.length,
    filters.forbidden_edges?.length,
  ].filter(Boolean).length;

  const removeRequiredEdge = (idx: number) => {
    const next = (filters.required_edges ?? []).filter((_, i) => i !== idx);
    onChange({ ...filters, required_edges: next.length ? next : undefined });
  };
  const removeForbiddenEdge = (idx: number) => {
    const next = (filters.forbidden_edges ?? []).filter((_, i) => i !== idx);
    onChange({ ...filters, forbidden_edges: next.length ? next : undefined });
  };

  const clearAll = () => onChange({});

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-[11px] text-fg-muted">
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent mr-2" />
        Loading filters...
      </div>
    );
  }

  if (!options) return null;

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-fg-secondary">
          <Filter size={12} className="text-fg-faint" />
          Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold text-accent">{activeCount}</span>
          )}
        </span>
        {activeCount > 0 && (
          <button onClick={clearAll} className="text-[10px] text-accent hover:text-accent/80 transition-colors">
            Clear all
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Timeframe */}
        <Section label="Timeframe" icon={Clock}>
          <div className="space-y-1.5">
            <label className="block text-[9px] uppercase tracking-wider text-fg-faint">From</label>
            <input
              type="datetime-local"
              value={filters.time_start ?? ''}
              onChange={(e) => onChange({ ...filters, time_start: e.target.value || undefined })}
              className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-[10px] text-fg outline-none focus:border-accent"
            />
            <label className="block text-[9px] uppercase tracking-wider text-fg-faint">To</label>
            <input
              type="datetime-local"
              value={filters.time_end ?? ''}
              onChange={(e) => onChange({ ...filters, time_end: e.target.value || undefined })}
              className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-[10px] text-fg outline-none focus:border-accent"
            />
          </div>
        </Section>

        {/* Case Duration */}
        <Section label="Case Duration" icon={BarChart3}>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="block text-[9px] uppercase tracking-wider text-fg-faint">Min</label>
                <input
                  type="number"
                  placeholder={formatDur(options.duration_min)}
                  value={filters.duration_min ?? ''}
                  onChange={(e) => onChange({ ...filters, duration_min: e.target.value ? Number(e.target.value) : undefined })}
                  className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-[10px] text-fg outline-none focus:border-accent"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[9px] uppercase tracking-wider text-fg-faint">Max</label>
                <input
                  type="number"
                  placeholder={formatDur(options.duration_max)}
                  value={filters.duration_max ?? ''}
                  onChange={(e) => onChange({ ...filters, duration_max: e.target.value ? Number(e.target.value) : undefined })}
                  className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-[10px] text-fg outline-none focus:border-accent"
                />
              </div>
            </div>
            <p className="text-[9px] text-fg-ghost">Duration in seconds ({formatDur(options.duration_min)} – {formatDur(options.duration_max)})</p>
          </div>
        </Section>

        {/* Activities */}
        <Section label="Activities" icon={Activity} defaultOpen>
          <div className="space-y-2">
            <div>
              <label className="block text-[9px] uppercase tracking-wider text-fg-faint mb-1">Must include</label>
              <MultiSelect
                options={options.activities}
                selected={filters.activities_include ?? []}
                onChange={(v) => onChange({ ...filters, activities_include: v.length ? v : undefined })}
                placeholder="Any activity"
              />
            </div>
            <div>
              <label className="block text-[9px] uppercase tracking-wider text-fg-faint mb-1">Exclude</label>
              <MultiSelect
                options={options.activities}
                selected={filters.activities_exclude ?? []}
                onChange={(v) => onChange({ ...filters, activities_exclude: v.length ? v : undefined })}
                placeholder="None excluded"
              />
            </div>
          </div>
        </Section>

        {/* Start / End Activities */}
        <Section label="Endpoints" icon={Activity}>
          <div className="space-y-2">
            <div>
              <label className="block text-[9px] uppercase tracking-wider text-fg-faint mb-1">Starts with</label>
              <MultiSelect
                options={options.start_activities}
                selected={filters.start_activities ?? []}
                onChange={(v) => onChange({ ...filters, start_activities: v.length ? v : undefined })}
                placeholder="Any start"
              />
            </div>
            <div>
              <label className="block text-[9px] uppercase tracking-wider text-fg-faint mb-1">Ends with</label>
              <MultiSelect
                options={options.end_activities}
                selected={filters.end_activities ?? []}
                onChange={(v) => onChange({ ...filters, end_activities: v.length ? v : undefined })}
                placeholder="Any end"
              />
            </div>
          </div>
        </Section>

        {/* Edge filters — populated by clicking edges on the map. */}
        {((filters.required_edges && filters.required_edges.length > 0) ||
          (filters.forbidden_edges && filters.forbidden_edges.length > 0)) && (
          <Section label="Edges" icon={ArrowRight} defaultOpen>
            <div className="space-y-2">
              {filters.required_edges && filters.required_edges.length > 0 && (
                <div>
                  <label className="mb-1 block text-[9px] uppercase tracking-wider text-fg-faint">
                    Must traverse
                  </label>
                  <div className="space-y-1">
                    {filters.required_edges.map(([s, t], i) => (
                      <div
                        key={`req-${i}`}
                        className="flex items-center gap-1 rounded border border-accent/30 bg-accent/5 px-1.5 py-1 text-[10px] text-fg-secondary"
                      >
                        <span className="truncate">{s}</span>
                        <ArrowRight size={9} className="shrink-0 text-fg-faint" />
                        <span className="truncate flex-1">{t}</span>
                        <button
                          onClick={() => removeRequiredEdge(i)}
                          className="shrink-0 text-fg-faint hover:text-fg"
                          aria-label="Remove required edge"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {filters.forbidden_edges && filters.forbidden_edges.length > 0 && (
                <div>
                  <label className="mb-1 block text-[9px] uppercase tracking-wider text-fg-faint">
                    Must NOT traverse
                  </label>
                  <div className="space-y-1">
                    {filters.forbidden_edges.map(([s, t], i) => (
                      <div
                        key={`forb-${i}`}
                        className="flex items-center gap-1 rounded border border-danger/30 bg-danger/5 px-1.5 py-1 text-[10px] text-fg-secondary"
                      >
                        <Ban size={9} className="shrink-0 text-danger" />
                        <span className="truncate">{s}</span>
                        <ArrowRight size={9} className="shrink-0 text-fg-faint" />
                        <span className="truncate flex-1">{t}</span>
                        <button
                          onClick={() => removeForbiddenEdge(i)}
                          className="shrink-0 text-fg-faint hover:text-fg"
                          aria-label="Remove forbidden edge"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Attribute Filters */}
        {Object.keys(options.attributes).length > 0 && (
          <Section label="Attributes" icon={Users}>
            <div className="space-y-2">
              {Object.entries(options.attributes).map(([col, vals]) => (
                <div key={col}>
                  <label className="block text-[9px] uppercase tracking-wider text-fg-faint mb-1">{col}</label>
                  <MultiSelect
                    options={vals}
                    selected={
                      filters.attributes?.find((a) => a.column === col)?.values ?? []
                    }
                    onChange={(v) => {
                      const existing = (filters.attributes ?? []).filter((a) => a.column !== col);
                      const next = v.length ? [...existing, { column: col, values: v }] : existing;
                      onChange({ ...filters, attributes: next.length ? next : undefined });
                    }}
                    placeholder={`All ${col}`}
                  />
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
