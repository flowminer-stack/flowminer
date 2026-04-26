import { useEffect, useRef, useState } from 'react';
import { X, Bookmark, Download, Upload, Eraser, BarChart3 } from 'lucide-react';
import clsx from 'clsx';
import { useFilterStore } from '@/store/filterStore';
import AttributeHistogramPopover from './AttributeHistogramPopover';

// Renders the active filter chips as a persistent breadcrumb above
// any analysis view. Each chip is individually removable; the whole
// stack can be cleared, exported to JSON, imported from JSON, or
// saved into the URL (and read back on page load via useFilterUrlSync).

interface FilterChipBarProps {
  className?: string;
  // Optional hook so a page can react when chips change (e.g.,
  // re-fetch its analysis). If omitted the page is expected to
  // subscribe to the store itself.
  onChange?: () => void;
  // Optional columns list; when provided, renders a "Filter by
  // attribute" button that opens the histogram popover for the
  // chosen column. Pages pass in e.g. the event-log preview columns.
  eventLogId?: string;
  attributeColumns?: string[];
}

export default function FilterChipBar({
  className,
  onChange,
  eventLogId,
  attributeColumns,
}: FilterChipBarProps) {
  const chips = useFilterStore((s) => s.chips);
  const disabled = useFilterStore((s) => s.disabled);
  const removeChip = useFilterStore((s) => s.removeChip);
  const toggleChip = useFilterStore((s) => s.toggleChip);
  const clearChips = useFilterStore((s) => s.clearChips);
  const serialise = useFilterStore((s) => s.serialise);
  const deserialise = useFilterStore((s) => s.deserialise);
  const fileInput = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [popoverAttr, setPopoverAttr] = useState<string | null>(null);

  useEffect(() => {
    if (onChange) onChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips, disabled]);

  // Render a small standalone "Filter by attribute" launcher even
  // when there are no chips yet, so users can start filtering from
  // scratch. When chips exist we render the full breadcrumb below.
  if (chips.length === 0) {
    if (!eventLogId || !attributeColumns || attributeColumns.length === 0) return null;
    return (
      <div
        className={clsx(
          'relative flex items-center gap-1.5 rounded-lg border border-dashed border-line bg-surface-1 px-3 py-1.5',
          className,
        )}
      >
        <span className="text-[10px] uppercase tracking-wide text-fg-faint">
          No filters
        </span>
        <select
          onChange={(e) => {
            if (e.target.value) setPopoverAttr(e.target.value);
            e.target.value = '';
          }}
          className="rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] text-fg-muted outline-none hover:border-accent hover:text-accent"
        >
          <option value="">+ Filter by attribute…</option>
          {attributeColumns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {popoverAttr && (
          <div className="absolute left-0 top-full z-30 mt-1">
            <AttributeHistogramPopover
              eventLogId={eventLogId}
              attribute={popoverAttr}
              onClose={() => setPopoverAttr(null)}
            />
          </div>
        )}
      </div>
    );
  }

  const handleExport = () => {
    const blob = new Blob([serialise()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flowminer-filters-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    deserialise(text);
  };

  const handleCopyUrl = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('filters', encodeURIComponent(serialise()));
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={clsx(
        'relative flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-3 py-2',
        className,
      )}
    >
      <span className="text-[10px] uppercase tracking-wide text-fg-faint">
        Filters
      </span>
      {chips.map((c) => {
        const off = !!disabled[c.id];
        return (
          <span
            key={c.id}
            className={clsx(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
              off
                ? 'border-dashed border-line bg-transparent text-fg-ghost line-through'
                : 'border-accent/30 bg-accent/10 text-accent',
            )}
          >
            <button
              type="button"
              onClick={() => toggleChip(c.id)}
              className="outline-none"
              title={off ? 'Enable filter' : 'Disable filter (without removing)'}
            >
              {c.label}
            </button>
            <button
              type="button"
              onClick={() => removeChip(c.id)}
              className="rounded-full p-0.5 transition-colors hover:bg-accent/20"
              title="Remove filter"
            >
              <X size={10} />
            </button>
          </span>
        );
      })}
      <div className="ml-auto flex items-center gap-1">
        {eventLogId && attributeColumns && attributeColumns.length > 0 && (
          <select
            onChange={(e) => {
              if (e.target.value) setPopoverAttr(e.target.value);
              e.target.value = '';
            }}
            className="rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] font-medium text-fg-muted outline-none hover:border-accent hover:text-accent"
          >
            <option value="">
              <BarChart3 size={10} /> + Attribute
            </option>
            {attributeColumns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={handleCopyUrl}
          className="rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
          title="Copy a shareable URL that includes these filters"
        >
          <Bookmark size={10} className="mr-1 inline" />
          {copied ? 'Copied' : 'Share'}
        </button>
        <button
          type="button"
          onClick={handleExport}
          className="rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
          title="Export filter set as JSON"
        >
          <Download size={10} className="mr-1 inline" />
          Export
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
          title="Import filter set from JSON"
        >
          <Upload size={10} className="mr-1 inline" />
          Import
        </button>
        <button
          type="button"
          onClick={clearChips}
          className="rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:border-danger hover:text-danger"
          title="Clear all filters"
        >
          <Eraser size={10} className="mr-1 inline" />
          Clear
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleImport}
        />
      </div>
      {popoverAttr && eventLogId && (
        <div className="absolute left-0 top-full z-30 mt-1">
          <AttributeHistogramPopover
            eventLogId={eventLogId}
            attribute={popoverAttr}
            onClose={() => setPopoverAttr(null)}
          />
        </div>
      )}
    </div>
  );
}
