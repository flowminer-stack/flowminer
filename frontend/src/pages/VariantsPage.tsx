import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowRight, GitBranch, Clock, Hash, Search, X, Sparkles, Target, List, Workflow, Dna } from 'lucide-react';
import Tooltip from '@/components/common/Tooltip';
import clsx from 'clsx';
import { useMiningStore } from '@/store';
import { useEventLogData } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import ExportButtons from '@/components/common/ExportButtons';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/common/EmptyState';
import VariantExplainDrawer from '@/components/Variants/VariantExplainDrawer';
import VariantEvolution from '@/components/Variants/VariantEvolution';
import VariantSankey from '@/components/Variants/VariantSankey';
import VariantDNA from '@/components/Variants/VariantDNA';
import { useFilterStore } from '@/store/filterStore';
import { formatDuration } from '@/utils/format';

type VariantTab = 'list' | 'flow' | 'sequence';

export default function VariantsPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();

  const { eventLog } = useEventLogData(eventLogId);
  const { variants, variantsLoading, error, fetchVariants } = useMiningStore();
  const [activeTab, setActiveTab] = useState<VariantTab>('list');
  const [search, setSearch] = useState('');
  const [explainTarget, setExplainTarget] = useState<{
    activities: string[];
    label: string;
  } | null>(null);
  const addChip = useFilterStore((s) => s.addChip);

  // "Focus this variant" -- stash the variant as a scope chip and
  // navigate to the process map so every downstream analysis
  // (bottlenecks, conformance, etc.) re-runs against only those cases.
  const handleFocusVariant = (variant: { id: number; activities: string[]; percentage: number; frequency: number }) => {
    addChip({
      type: 'variant',
      label: `variant: ${variant.activities[0] ?? '?'} -> ... (${variant.frequency} cases)`,
      payload: { activities: variant.activities },
    });
    if (eventLogId) {
      navigate(`/process/${eventLogId}`);
    }
  };

  useEffect(() => {
    if (eventLogId) {
      fetchVariants(eventLogId);
    }
  }, [eventLogId, fetchVariants]);

  const filteredVariants = useMemo(() => {
    if (!variants?.variants) return [];
    if (!search) return variants.variants;
    const q = search.toLowerCase();
    return variants.variants.filter((v) =>
      v.activities.some((a) => a.toLowerCase().includes(q)),
    );
  }, [variants, search]);

  if (variantsLoading) {
    return <LoadingSpinner size="lg" text="Analyzing process variants..." fullPage />;
  }

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => eventLogId && fetchVariants(eventLogId)}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Process Variants"
        icon={GitBranch}
        backTo={-1}
        description="Different paths cases take through your process. High variance may indicate inconsistency or flexibility."
        subtitle={
          <>
            {eventLog?.name ?? 'Event Log'} &mdash;{' '}
            {variants?.total_variants ?? 0} unique variants across{' '}
            {variants?.total_cases.toLocaleString() ?? 0} cases
          </>
        }
        actions={eventLogId && <ExportButtons eventLogId={eventLogId} analysis="variants" />}
      />

      {/* Stats */}
      {variants && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-accent/10 p-2">
                <GitBranch size={18} className="text-accent" />
              </div>
              <div>
                <p className="text-xl font-bold tabular-nums text-fg">
                  {variants.total_variants}
                </p>
                <p className="text-[12px] text-fg-muted">Unique Variants</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-success/10 p-2">
                <Hash size={18} className="text-success" />
              </div>
              <div>
                <p className="text-xl font-bold tabular-nums text-fg">
                  {variants.total_cases.toLocaleString()}
                </p>
                <p className="text-[12px] text-fg-muted">Total Cases</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-warning/10 p-2">
                <Clock size={18} className="text-warning" />
              </div>
              <div>
                <p className="text-xl font-bold tabular-nums text-fg">
                  {variants.variants.length > 0
                    ? variants.variants[0].activities.length
                    : 0}
                </p>
                <p className="text-[12px] text-fg-muted">
                  Top Variant Steps
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab strip */}
      <div className="mt-6 flex gap-1 border-b border-line">
        <button
          type="button"
          onClick={() => setActiveTab('list')}
          className={clsx(
            'flex items-center gap-1.5 border-b-2 px-4 py-2 text-[13px] font-medium transition-colors',
            activeTab === 'list'
              ? 'border-accent text-accent'
              : 'border-transparent text-fg-muted hover:text-fg',
          )}
        >
          <List size={14} />
          List
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('flow')}
          className={clsx(
            'flex items-center gap-1.5 border-b-2 px-4 py-2 text-[13px] font-medium transition-colors',
            activeTab === 'flow'
              ? 'border-accent text-accent'
              : 'border-transparent text-fg-muted hover:text-fg',
          )}
        >
          <Workflow size={14} />
          Flow
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sequence')}
          className={clsx(
            'flex items-center gap-1.5 border-b-2 px-4 py-2 text-[13px] font-medium transition-colors',
            activeTab === 'sequence'
              ? 'border-accent text-accent'
              : 'border-transparent text-fg-muted hover:text-fg',
          )}
        >
          <Dna size={14} />
          Sequence
        </button>
      </div>

      {/* List tab -- search bar + variant cards + evolution */}
      {activeTab === 'list' && (
        <>
          {/* Search bar */}
          {variants && variants.variants.length > 0 && (
            <div className="mt-6 flex items-center gap-3">
              <div className="relative flex-1 max-w-sm">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by activity name..."
                  className="input pl-8 pr-8 py-2 text-[12px] w-full"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              {search && (
                <span className="text-[11px] text-fg-muted">
                  {filteredVariants.length} of {variants.variants.length} variants
                </span>
              )}
            </div>
          )}

          {/* Variants list */}
          <div className="mt-4 space-y-3">
            {filteredVariants.map((variant, index) => (
              <div
                key={variant.id}
                className="card overflow-hidden transition-all"
              >
                <div className="flex items-start gap-4 p-5">
                  {/* Rank */}
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tint text-[12px] font-bold text-fg-secondary">
                    {index + 1}
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* Activity flow */}
                    <div className="flex flex-wrap items-center gap-1">
                      {variant.activities.map((activity, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <span
                            className={clsx(
                              'rounded-md px-2 py-1 text-xs font-medium',
                              i === 0
                                ? 'bg-success/10 text-success'
                                : i === variant.activities.length - 1
                                  ? 'bg-danger/10 text-danger'
                                  : 'bg-tint text-fg-secondary',
                            )}
                          >
                            {activity}
                          </span>
                          {i < variant.activities.length - 1 && (
                            <ArrowRight
                              size={12}
                              className="shrink-0 text-fg-ghost"
                            />
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Stats */}
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px]">
                      <div>
                        <Tooltip text="Number of cases that follow this exact sequence of activities">
                          <span className="text-fg-muted">Frequency</span>
                        </Tooltip>:{' '}
                        <span className="font-medium text-fg">
                          {variant.frequency.toLocaleString()}
                        </span>
                      </div>
                      <div>
                        <Tooltip text="Percentage of all cases that follow this exact sequence">
                          <span className="text-fg-muted">Coverage</span>
                        </Tooltip>:{' '}
                        <span className="font-medium text-fg">
                          {variant.percentage.toFixed(1)}%
                        </span>
                      </div>
                      <div>
                        <span className="text-fg-muted">Avg Duration: </span>
                        <span className="font-medium text-fg">
                          {variant.avg_duration == null ? '--' : formatDuration(variant.avg_duration)}
                        </span>
                      </div>
                      {variant.min_duration !== null && (
                        <div>
                          <span className="text-fg-muted">Range: </span>
                          <span className="font-medium text-fg">
                            {formatDuration(variant.min_duration)} -{' '}
                            {variant.max_duration == null ? '--' : formatDuration(variant.max_duration)}
                          </span>
                        </div>
                      )}
                      {/* Focus this variant -- adds a scope filter chip
                          and jumps to the process map so every downstream
                          analysis re-runs on just this variant's cases.
                          Competitor parity: Apromore Process Discoverer
                          "focus" action, Disco variant drill-in. */}
                      <button
                        type="button"
                        onClick={() => handleFocusVariant(variant)}
                        data-tour={index === 0 ? 'variant-focus' : undefined}
                        className="ml-auto inline-flex items-center gap-1 rounded-md border border-line bg-surface-0 px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:border-accent hover:bg-accent/5 hover:text-accent"
                      >
                        <Target size={11} />
                        Focus
                      </button>
                      {/* AI explain button */}
                      <button
                        type="button"
                        onClick={() =>
                          setExplainTarget({
                            activities: variant.activities,
                            label: `Variant #${index + 1} - ${variant.percentage.toFixed(1)}% - ${variant.avg_duration == null ? '--' : formatDuration(variant.avg_duration)}`,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-0 px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:border-accent hover:bg-accent/5 hover:text-accent"
                      >
                        <Sparkles size={11} />
                        Why this variant?
                      </button>
                    </div>
                  </div>

                  {/* Percentage bar */}
                  <div className="w-24 shrink-0">
                    <div className="text-right text-[12px] font-semibold text-accent">
                      {variant.percentage.toFixed(1)}%
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-tint">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${Math.min(variant.percentage, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {variants && variants.variants.length === 0 && (
              <EmptyState
                icon={GitBranch}
                title="No variants found"
                description="Upload an event log with case and activity data to see process variants."
                action={
                  <button onClick={() => navigate('/projects')} className="btn-secondary text-[12px]">
                    Go to Projects
                  </button>
                }
              />
            )}

            {search && filteredVariants.length === 0 && variants && variants.variants.length > 0 && (
              <EmptyState
                icon={Search}
                title={`No variants contain "${search}"`}
                description="Try a different search term."
                action={
                  <button onClick={() => setSearch('')} className="btn-secondary text-[12px]">
                    Clear search
                  </button>
                }
                compact
              />
            )}
          </div>

          {/* Variant evolution over time (Minit parity) */}
          {eventLogId && (
            <div className="mt-8" data-tour="variant-evolution">
              <VariantEvolution eventLogId={eventLogId} />
            </div>
          )}
        </>
      )}

      {/* Flow tab -- Sankey diagram */}
      {activeTab === 'flow' && (
        <div className="mt-6">
          <VariantSankey variants={variants?.variants ?? []} />
        </div>
      )}

      {/* Sequence tab -- Variant DNA */}
      {activeTab === 'sequence' && (
        <div className="mt-6">
          <VariantDNA
            variants={variants?.variants ?? []}
            totalCases={variants?.total_cases ?? 0}
          />
        </div>
      )}

      {/* AI explain drawer (conditional) -- available from List tab */}
      {explainTarget && eventLogId && (
        <VariantExplainDrawer
          eventLogId={eventLogId}
          variantActivities={explainTarget.activities}
          variantLabel={explainTarget.label}
          onClose={() => setExplainTarget(null)}
        />
      )}
    </div>
  );
}
