import { useEffect, useState } from 'react';
import {
  Upload,
  Database,
  Map,
  BarChart3,
  ChevronRight,
  X,
  Sparkles,
  Layers,
  Check,
  PartyPopper,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { logBuilder } from '@/api/client';
import type { ProcessRecipe } from '@/api/client';
import {
  getOnboardingProgress,
  ONBOARDING_EVENT,
  type OnboardingStep,
} from '@/utils/onboarding';

interface OnboardingWizardProps {
  onDismiss: () => void;
  onNavigate: (path: string) => void;
}

// The activation path. Each milestone derives from real flags (see
// utils/onboarding) so the checklist reflects genuine progress, not decoration.
// Sample data and uploading your own are ALTERNATIVE ways to get data in —
// requiring both would make 100% unreachable for anyone who skips the sample.
const CHECKLIST: {
  key: string;
  icon: LucideIcon;
  label: string;
  isDone: (p: Record<OnboardingStep, boolean>) => boolean;
}[] = [
  { key: 'data', icon: Upload, label: 'Add data (sample or your own)', isDone: (p) => p.sample || p.upload },
  { key: 'map', icon: Map, label: 'Discover the map', isDone: (p) => p.map },
  { key: 'analysis', icon: BarChart3, label: 'Run deep analysis', isDone: (p) => p.analysis },
];

interface IntentCardProps {
  icon: LucideIcon;
  title: string;
  blurb: string;
  cta: string;
  primary?: boolean;
  onClick: () => void;
}

function IntentCard({ icon: Icon, title, blurb, cta, primary, onClick }: IntentCardProps) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-all',
        primary
          ? 'border-accent/40 bg-accent/10 hover:bg-accent/15'
          : 'border-line bg-surface-2 hover:border-line-strong',
      )}
    >
      <div
        className={clsx(
          'flex h-8 w-8 items-center justify-center rounded-lg',
          primary ? 'bg-accent/20 text-accent' : 'bg-tint text-fg-muted',
        )}
      >
        <Icon size={16} />
      </div>
      <span className="text-[13px] font-semibold text-fg">{title}</span>
      <span className="text-[11px] leading-relaxed text-fg-muted">{blurb}</span>
      <span
        className={clsx(
          'mt-1 inline-flex items-center gap-1 text-[11px] font-medium',
          primary ? 'text-accent' : 'text-fg-secondary',
        )}
      >
        {cta}
        <ChevronRight size={11} />
      </span>
    </button>
  );
}

export default function OnboardingWizard({ onDismiss, onNavigate }: OnboardingWizardProps) {
  const [recipes, setRecipes] = useState<ProcessRecipe[]>([]);
  const [progress, setProgress] = useState(getOnboardingProgress);

  // Best-effort: surface the prebuilt process packs so users know they exist.
  useEffect(() => {
    logBuilder
      .getTemplates()
      .then(setRecipes)
      .catch(() => {
        /* packs are an enhancement; ignore failures */
      });
  }, []);

  // Re-read completion when a milestone fires (same tab) or another tab updates.
  useEffect(() => {
    const refresh = () => setProgress(getOnboardingProgress());
    window.addEventListener(ONBOARDING_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(ONBOARDING_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const doneCount = CHECKLIST.filter((c) => c.isDone(progress)).length;
  const allDone = doneCount === CHECKLIST.length;

  return (
    <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-accent" />
          <span className="text-[12px] font-semibold text-fg">
            {allDone ? "You're all set with FlowMiner" : 'Getting Started with FlowMiner'}
          </span>
          <span className="ml-1 rounded-full bg-surface-2 border border-line px-1.5 py-px text-[10px] font-semibold text-fg-faint">
            {doneCount}/{CHECKLIST.length}
          </span>
        </div>
        <button
          onClick={onDismiss}
          title="Hide — reopen any time from “Getting started”."
          className="rounded p-1 text-fg-faint transition-colors hover:text-fg-muted"
        >
          <X size={13} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${(doneCount / CHECKLIST.length) * 100}%` }}
        />
      </div>

      {/* Checklist with real completion state */}
      <div className="mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        {CHECKLIST.map((s, i) => {
          const done = s.isDone(progress);
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <span
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                  done
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-line bg-surface-2 text-fg-muted',
                )}
              >
                {done ? (
                  <Check size={12} className="text-accent" />
                ) : (
                  <s.icon size={12} className="text-fg-faint" />
                )}
                <span className={clsx(done && 'line-through opacity-80')}>{s.label}</span>
              </span>
              {i < CHECKLIST.length - 1 && (
                <ChevronRight size={11} className="text-fg-faint" />
              )}
            </div>
          );
        })}
      </div>

      {allDone ? (
        /* Celebration — replaces the intent cards once the basics are done. */
        <div className="flex animate-fade-in items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 p-3.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/20 text-accent">
            <PartyPopper size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-fg">Nice — you’ve run the full loop.</p>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              Press <kbd className="rounded border border-line bg-surface-1 px-1 text-[10px]">⌘K</kbd> anywhere to jump to any of the 30+ analyses.
            </p>
          </div>
          <button onClick={onDismiss} className="btn-secondary shrink-0 text-[12px]">
            Hide
          </button>
        </div>
      ) : (
        <>
          {/* Intent — what do you want to do? */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <IntentCard
              icon={Sparkles}
              title="Start with sample data"
              blurb="A pre-mapped example process — see a mined map in one click, no setup."
              cta="Open sample project"
              primary
              onClick={() => onNavigate('/projects?seed=1')}
            />
            <IntentCard
              icon={Upload}
              title="Upload your event log"
              blurb="CSV, XES, Parquet or Excel. Columns are auto-detected; wide tables welcome."
              cta="New project + upload"
              onClick={() => onNavigate('/projects?new=1')}
            />
            <IntentCard
              icon={Database}
              title="Connect a system"
              blurb="Databases, Jira/GitHub/Zendesk, SAP, Salesforce, ServiceNow and more."
              cta="Set up a connector"
              onClick={() => onNavigate('/connectors')}
            />
          </div>

          {/* Prebuilt process packs (surfaces the recipe content packs) */}
          {recipes.length > 0 && (
            <div className="mt-4 rounded-xl border border-line bg-surface-1 p-3">
              <div className="mb-2 flex items-center gap-1.5">
                <Layers size={13} className="text-accent" />
                <span className="text-[12px] font-semibold text-fg">
                  Or start from a prebuilt process pack
                </span>
              </div>
              <p className="mb-2.5 text-[11px] text-fg-muted">
                Skip the ETL — these map a known system's tables straight to a
                mineable process. Create a project, then pick a pack in the Event
                Log Builder.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {recipes.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onNavigate('/projects?new=1')}
                    className="rounded-lg border border-line bg-surface-2 p-2.5 text-left transition-all hover:border-line-strong"
                  >
                    <span className="block text-[12px] font-semibold text-fg">
                      {r.process_name}
                    </span>
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-fg-faint">
                      {r.category}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-fg-muted">
                      {r.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
