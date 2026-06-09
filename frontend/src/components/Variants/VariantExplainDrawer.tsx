import { useEffect, useState } from 'react';
import { Sparkles, X, Clock, User as UserIcon, ArrowRight } from 'lucide-react';
import { ai as aiApi } from '@/api/client';
import type { VariantExplanation } from '@/api/client';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface VariantExplainDrawerProps {
  eventLogId: string;
  variantActivities: string[];
  variantLabel: string;
  onClose: () => void;
}

function fmtDur(s: number): string {
  if (!s && s !== 0) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export default function VariantExplainDrawer({
  eventLogId,
  variantActivities,
  variantLabel,
  onClose,
}: VariantExplainDrawerProps) {
  const [data, setData] = useState<VariantExplanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    aiApi
      .explainVariant(eventLogId, variantActivities)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load explanation');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally don't track variantActivities as a dep — the
    // parent unmounts the drawer when switching variants, so a
    // stable fetch-once-per-open is the right behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventLogId]);

  const stats = data?.stats;
  const ratio = stats?.duration_ratio ?? null;
  const ratioLabel =
    ratio === null
      ? null
      : ratio > 1
        ? `${ratio.toFixed(2)}× slower`
        : `${(1 / ratio).toFixed(2)}× faster`;
  const ratioTone =
    ratio === null ? 'text-fg-muted' : ratio > 1 ? 'text-danger' : 'text-success';

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Variant explanation"
        className="flex h-full w-full max-w-md flex-col border-l border-line bg-surface-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Sparkles size={13} className="text-accent" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                Why this variant?
              </span>
            </div>
            <p className="mt-1 text-[13px] font-semibold leading-tight text-fg">
              {variantLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-fg-muted transition-colors hover:bg-tint hover:text-fg"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-fg-muted">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
              Comparing this variant against the rest of the log…
            </div>
          ) : error ? (
            <p className="text-[12px] text-danger">{error}</p>
          ) : data && stats ? (
            <>
              {/* ── Quick facts ────────────────────────────────────── */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-line bg-surface-1 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                    Cases
                  </div>
                  <div className="text-[14px] font-bold tabular-nums text-fg">
                    {stats.variant_case_count.toLocaleString()}
                    <span className="ml-1 text-[10px] font-normal text-fg-faint">
                      / {(stats.variant_case_count + stats.other_case_count).toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="rounded-lg border border-line bg-surface-1 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                    vs rest
                  </div>
                  <div className={`text-[14px] font-bold ${ratioTone}`}>
                    {ratioLabel ?? '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-line bg-surface-1 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                    This variant
                  </div>
                  <div className="flex items-center gap-1 text-[13px] font-semibold text-fg">
                    <Clock size={11} />
                    {fmtDur(stats.variant_avg_duration_seconds)}
                  </div>
                </div>
                <div className="rounded-lg border border-line bg-surface-1 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                    Other variants
                  </div>
                  <div className="flex items-center gap-1 text-[13px] font-semibold text-fg-secondary">
                    <Clock size={11} />
                    {fmtDur(stats.other_avg_duration_seconds)}
                  </div>
                </div>
              </div>

              {/* ── LLM configured banner ────────────────────────── */}
              {data.llm_configured === false && (
                <div className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-[11px] text-warning">
                  No LLM provider is configured — showing the raw delta
                  stats the model would have received. Set{' '}
                  <code className="mx-1 rounded bg-tint px-1 py-0.5 text-fg">
                    OPENROUTER_API_KEY
                  </code>{' '}
                  on the backend to enable a real explanation.
                </div>
              )}

              {/* ── LLM explanation ─────────────────────────────── */}
              <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Sparkles size={11} className="text-accent" />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">
                    AI explanation
                  </span>
                </div>
                <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg-secondary">
                  {data.explanation}
                </div>
              </div>

              {/* ── Deterministic detail facts ──────────────────── */}
              <div className="mt-4 space-y-3">
                {stats.longest_step && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                      Slowest step inside this variant
                    </div>
                    <div className="mt-1 flex items-center gap-2 rounded-md border border-line bg-surface-1 px-3 py-2">
                      <Clock size={12} className="text-fg-muted" />
                      <span className="flex-1 text-[12px] font-semibold text-fg">
                        {stats.longest_step.activity}
                      </span>
                      <span className="text-[11px] tabular-nums text-fg-muted">
                        {fmtDur(stats.longest_step.avg_seconds)} avg dwell
                      </span>
                    </div>
                  </div>
                )}

                {stats.top_resources_in_variant.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                      Top resources in this variant
                    </div>
                    <div className="mt-1 space-y-1">
                      {stats.top_resources_in_variant.map((r) => (
                        <div
                          key={r.name}
                          className="flex items-center gap-2 rounded-md border border-line bg-surface-1 px-3 py-1.5"
                        >
                          <UserIcon size={11} className="text-fg-muted" />
                          <span className="flex-1 text-[12px] text-fg-secondary">{r.name}</span>
                          <span className="text-[11px] tabular-nums text-fg-muted">
                            {(r.share * 100).toFixed(0)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {stats.root_cause_factor && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                      Correlating attribute
                    </div>
                    <div className="mt-1 rounded-md border border-line bg-surface-1 px-3 py-2">
                      <div className="text-[12px] font-semibold text-fg">
                        {stats.root_cause_factor.attribute} ={' '}
                        <span className="font-mono text-fg-secondary">
                          {String(stats.root_cause_factor.value)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-fg-muted">
                        covers {(stats.root_cause_factor.overlap_pct * 100).toFixed(0)}% of these cases
                      </div>
                    </div>
                  </div>
                )}

                {stats.happy_path && stats.happy_path.activities.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-fg-faint">
                      Happy path for comparison
                    </div>
                    <div className="mt-1 rounded-md border border-line bg-surface-1 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {stats.happy_path.activities.slice(0, 8).map((act, i) => (
                          <span key={`${act}-${i}`} className="flex items-center gap-1">
                            <span className="rounded bg-tint px-1.5 py-0.5 text-[10px] text-fg-secondary">
                              {act}
                            </span>
                            {i < Math.min(stats.happy_path!.activities.length, 8) - 1 && (
                              <ArrowRight size={8} className="text-fg-ghost" />
                            )}
                          </span>
                        ))}
                        {stats.happy_path.activities.length > 8 && (
                          <span className="text-[10px] text-fg-faint">…</span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-fg-muted">
                        {stats.happy_path.case_count.toLocaleString()} cases · avg{' '}
                        {fmtDur(stats.happy_path.avg_duration)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
