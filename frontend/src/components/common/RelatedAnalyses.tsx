import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface RelatedAnalysis {
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Full destination path, e.g. `/conformance/${eventLogId}`. */
  to: string;
}

/**
 * A "where to look next" strip that turns an analysis page from a dead end into
 * a doorway — surfacing the 2-4 sibling analyses a user most likely wants next.
 * Keeps the discovery web tight and intent-driven rather than dumping the whole
 * catalog (that's what the ⌘K palette is for).
 */
export default function RelatedAnalyses({
  title = 'Where to look next',
  items,
}: {
  title?: string;
  items: RelatedAnalysis[];
}) {
  const navigate = useNavigate();
  if (!items.length) return null;

  return (
    <div className="mt-6 rounded-xl border border-line bg-surface-1 p-4">
      <p className="mb-2.5 text-[11px] font-bold uppercase tracking-widest text-fg-faint">
        {title}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.to}
              onClick={() => navigate(it.to)}
              className="group flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 p-3 text-left transition-all hover:border-line-strong"
            >
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                <Icon size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-[12px] font-semibold text-fg">
                  {it.label}
                  <ArrowRight
                    size={11}
                    className="text-fg-faint transition-transform group-hover:translate-x-0.5"
                  />
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{it.hint}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
