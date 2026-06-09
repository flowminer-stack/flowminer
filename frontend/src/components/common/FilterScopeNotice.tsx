import { Link } from 'react-router-dom';
import { Filter } from 'lucide-react';
import { useFilterStore } from '@/store/filterStore';

interface Props {
  /** The log this page shows — the notice only fires for that log's filters. */
  eventLogId?: string;
}

/**
 * Honesty banner for analysis pages that do NOT (yet) apply the universal
 * filter chips. The chip bar promises it "scopes every view"; until these
 * pages pass chips through to their endpoints, say so explicitly instead of
 * silently rendering numbers for the full log.
 */
export default function FilterScopeNotice({ eventLogId }: Props) {
  const chips = useFilterStore((s) => s.chips);
  const disabled = useFilterStore((s) => s.disabled);
  const filterLogId = useFilterStore((s) => s.eventLogId);
  const clearChips = useFilterStore((s) => s.clearChips);

  const active = chips.filter((c) => !disabled[c.id]);
  if (active.length === 0) return null;
  if (eventLogId && filterLogId && filterLogId !== eventLogId) return null;

  const shown = active.slice(0, 3).map((c) => c.label).join(' · ');
  const more = active.length - 3;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
      <Filter size={13} className="shrink-0 text-warning" />
      <p className="min-w-0 text-[12px] text-fg-secondary">
        <strong className="font-semibold">
          {active.length} filter{active.length === 1 ? '' : 's'} active
        </strong>{' '}
        ({shown}
        {more > 0 ? ` +${more} more` : ''}) — this page doesn't apply them yet, so it
        shows the <strong className="font-semibold">full log</strong>.
      </p>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {eventLogId && (
          <Link
            to={`/process/${eventLogId}?tab=map`}
            className="text-[12px] font-medium text-accent hover:underline"
          >
            View filtered map
          </Link>
        )}
        <button
          onClick={clearChips}
          className="text-[12px] font-medium text-fg-muted hover:text-fg hover:underline"
        >
          Clear filters
        </button>
      </span>
    </div>
  );
}
