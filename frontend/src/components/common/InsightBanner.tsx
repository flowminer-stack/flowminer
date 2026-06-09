import { Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';

type Tone = 'accent' | 'warning' | 'danger';

const TONES: Record<Tone, { box: string; icon: string }> = {
  accent: { box: 'border-accent/20 bg-accent/5', icon: 'text-accent' },
  warning: { box: 'border-warning/20 bg-warning/5', icon: 'text-warning' },
  danger: { box: 'border-danger/20 bg-danger/5', icon: 'text-danger' },
};

/**
 * A one-line, plain-English "narrative" callout — the Smart-Narrative pattern:
 * a directed conclusion sitting above a chart, so the user reads the takeaway
 * before interpreting the visualization. Tone defaults to accent.
 */
export default function InsightBanner({
  icon: Icon = Sparkles,
  tone = 'accent',
  children,
}: {
  icon?: LucideIcon;
  tone?: Tone;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div className={clsx('mt-4 flex items-start gap-2.5 rounded-xl border p-3.5', t.box)}>
      <Icon size={16} className={clsx('mt-0.5 shrink-0', t.icon)} />
      <p className="text-[12px] leading-relaxed text-fg-secondary">{children}</p>
    </div>
  );
}
