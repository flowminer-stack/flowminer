import { useState } from 'react';
import { X } from 'lucide-react';

export interface FeatureGuideStep {
  label: string;
  detail?: string;
}

interface FeatureGuideProps {
  /** Stable key — dismissal is remembered per-key in localStorage. */
  storageKey: string;
  icon?: React.ElementType;
  title: string;
  /** One short paragraph: what this feature is / why it exists. */
  lead: string;
  /** Optional numbered "how to use it" steps. */
  steps?: FeatureGuideStep[];
}

/**
 * A dismissible "what is this & how to use it" card for features whose purpose
 * isn't obvious from the UI alone. Shown by default; once dismissed it stays
 * hidden (per storageKey) so it never nags returning users.
 */
export default function FeatureGuide({
  storageKey,
  icon: Icon,
  title,
  lead,
  steps,
}: FeatureGuideProps) {
  const key = `flowminer-guide-dismissed::${storageKey}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* ignore storage failures */
    }
    setDismissed(true);
  };

  return (
    <div className="relative mt-5 rounded-xl border border-accent/20 bg-accent/5 p-4">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss guide"
        title="Got it — hide this"
        className="absolute right-3 top-3 rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
      >
        <X size={14} />
      </button>
      <div className="flex items-start gap-3">
        {Icon && (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15">
            <Icon size={16} className="text-accent" />
          </div>
        )}
        <div className="min-w-0 flex-1 pr-6">
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{lead}</p>
          {steps && steps.length > 0 && (
            <ol className="mt-2.5 space-y-1.5">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2 text-[12px] text-fg-secondary">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[9px] font-bold text-accent">
                    {i + 1}
                  </span>
                  <span>
                    <span className="font-medium text-fg">{s.label}</span>
                    {s.detail && <span className="text-fg-muted"> — {s.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
