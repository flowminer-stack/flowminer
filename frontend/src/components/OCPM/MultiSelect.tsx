import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import clsx from 'clsx';

// ─── Multi-select dropdown ────────────────────────────────────────────────────

export default function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
}: {
  options: string[];
  selected: string[];
  onChange: (vals: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (val: string) => {
    onChange(
      selected.includes(val)
        ? selected.filter((v) => v !== val)
        : [...selected, val],
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border border-line bg-surface-1 px-3 py-2 text-left text-[12px] text-fg-secondary transition-colors hover:border-accent/50 focus:outline-none"
      >
        <span className="truncate text-fg-muted">
          {selected.length === 0
            ? placeholder
            : `${selected.length} column${selected.length > 1 ? 's' : ''} selected`}
        </span>
        <ChevronDown size={12} className={clsx('ml-2 shrink-0 text-fg-faint transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full animate-fade-in rounded-md border border-line bg-surface-2 py-1 shadow-xl">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-fg-faint">No columns available</p>
          ) : (
            options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-tint hover:text-fg"
              >
                <div className={clsx(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                  selected.includes(opt) ? 'border-accent bg-accent' : 'border-line',
                )}>
                  {selected.includes(opt) && <Check size={9} className="text-white" />}
                </div>
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
