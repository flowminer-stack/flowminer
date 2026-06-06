import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';

interface DisclosureProps {
  /** Label shown on the toggle row, e.g. "Advanced settings". */
  label: string;
  /** Optional one-line hint of what lives inside (e.g. "headers, pagination"). */
  hint?: string;
  /** Open on first render. Defaults to collapsed — that's the whole point. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A lightweight collapsible used to tuck rarely-touched fields out of the way.
 * Keeps the connector forms approachable: essentials stay visible, the long
 * tail (limits, encodings, pagination, custom queries) hides behind one click.
 */
export function Disclosure({ label, hint, defaultOpen = false, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-line bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <ChevronRight
          className={clsx(
            'h-3.5 w-3.5 text-fg-faint transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="text-[12px] font-medium text-fg-secondary">{label}</span>
        {hint && !open && (
          <span className="truncate text-[11px] text-fg-faint">— {hint}</span>
        )}
      </button>
      {open && <div className="space-y-4 border-t border-line px-3.5 py-3.5">{children}</div>}
    </div>
  );
}
