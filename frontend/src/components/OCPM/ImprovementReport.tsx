import { useEffect, useState } from 'react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Markdown } from '@/components/common/Markdown';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  Lightbulb,
  TrendingDown,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Layers,
  Network,
  MessageSquare,
  X,
  FileDown,
} from 'lucide-react';
import clsx from 'clsx';
import { ocel as ocelApi } from '@/api/client';
import type {
  OCPMImprovementFinding,
  OCPMImprovementReport,
  OCPMObjectTypeSection,
} from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';

// ── Presentation helpers ──────────────────────────────────────────────

function SeverityIcon({ severity }: { severity: OCPMImprovementFinding['severity'] }) {
  if (severity === 'critical')
    return <AlertCircle size={14} className="shrink-0 text-danger" />;
  if (severity === 'warning')
    return <AlertTriangle size={14} className="shrink-0 text-warning" />;
  return <Info size={14} className="shrink-0 text-accent" />;
}

function FindingCard({
  finding,
  onExplain,
}: {
  finding: OCPMImprovementFinding;
  onExplain?: (finding: OCPMImprovementFinding) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
      <div className="mt-0.5">
        <SeverityIcon severity={finding.severity} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-semibold leading-tight text-fg">
            {finding.title}
          </p>
          {onExplain && (
            <button
              type="button"
              onClick={() => onExplain(finding)}
              className="shrink-0 rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
              title="Explain this with AI"
            >
              <Sparkles size={10} className="mr-1 inline" />
              Explain
            </button>
          )}
        </div>
        <p className="mt-0.5 text-[12px] text-fg-muted">{finding.description}</p>
        {finding.recommendation && (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-tint px-2 py-1.5">
            <Lightbulb size={11} className="mt-0.5 shrink-0 text-fg-faint" />
            <p className="text-[11px] text-fg-secondary">{finding.recommendation}</p>
          </div>
        )}
        {finding.impact_estimate && (
          <div className="mt-1 flex items-start gap-1.5 rounded-md bg-accent/5 px-2 py-1.5">
            <TrendingDown size={11} className="mt-0.5 shrink-0 text-accent" />
            <p className="text-[11px] font-medium text-accent">
              {finding.impact_estimate}
            </p>
          </div>
        )}
        {finding.related_activities && finding.related_activities.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {finding.related_activities.slice(0, 4).map((a) => (
              <span
                key={a}
                className="rounded border border-line bg-surface-0 px-1.5 py-0.5 text-[10px] text-fg-muted"
              >
                {a}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AI narrative block ────────────────────────────────────────────────

function NarrativeBlock({ ocelId }: { ocelId: string }) {
  const [narrative, setNarrative] = useState<string | null>(null);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    ocelApi
      .narrateImprovementReport(ocelId)
      .then((r) => {
        if (cancelled) return;
        setNarrative(r.narrative);
        setLlmConfigured(r.llm_configured);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load narrative');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ocelId]);

  if (loading) {
    return (
      <div className="rounded-lg border border-line bg-surface-1 p-4">
        <div className="flex items-center gap-2 text-[12px] text-fg-muted">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
          Generating AI summary…
        </div>
      </div>
    );
  }

  if (error || !narrative) {
    return null;
  }

  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">AI summary</h3>
        {llmConfigured === false && (
          <span
            className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning"
            title="Set FLOWMINER_LLM_PROVIDER=openrouter and OPENROUTER_API_KEY on the backend to enable real AI."
          >
            no LLM configured
          </span>
        )}
      </div>
      <Markdown text={narrative} />
    </div>
  );
}

// ── Explain-this drawer ───────────────────────────────────────────────

function ExplainDrawer({
  ocelId,
  finding,
  onClose,
}: {
  ocelId: string;
  finding: OCPMImprovementFinding;
  onClose: () => void;
}) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    ocelApi
      .explainImprovementFinding(ocelId, finding)
      .then((r) => {
        if (cancelled) return;
        setExplanation(r.explanation);
        setLlmConfigured(r.llm_configured);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load explanation');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // finding is intentionally not in the dep list — we only fetch
    // once per open. The parent unmounts the drawer when the user
    // picks a different finding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocelId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Improvement finding explanation"
        className="flex h-full w-full max-w-md flex-col border-l border-line bg-surface-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Sparkles size={13} className="text-accent" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                AI explanation
              </span>
            </div>
            <p className="mt-1 text-[13px] font-semibold leading-tight text-fg">
              {finding.title}
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
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-fg-muted">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
              Thinking…
            </div>
          ) : error ? (
            <p className="text-[12px] text-danger">{error}</p>
          ) : (
            <>
              {llmConfigured === false && (
                <div className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-[11px] text-warning">
                  No LLM provider is configured — showing the structured
                  context the model would have received. Set
                  <code className="mx-1 rounded bg-tint px-1 py-0.5 text-fg">
                    OPENROUTER_API_KEY
                  </code>
                  on the backend to enable real explanations.
                </div>
              )}
              <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg-secondary">
                {explanation}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'danger' | 'warning' | 'accent';
}) {
  const toneClasses =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'accent'
          ? 'text-accent'
          : 'text-fg';
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface-1 px-4 py-3">
      <span className="text-[10px] uppercase tracking-wide text-fg-faint">{label}</span>
      <span className={clsx('text-[20px] font-bold tabular-nums', toneClasses)}>
        {value}
      </span>
    </div>
  );
}

function ObjectTypeSection({
  section,
  defaultOpen,
  onExplain,
}: {
  section: OCPMObjectTypeSection;
  defaultOpen: boolean;
  onExplain: (finding: OCPMImprovementFinding) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasIssues = section.critical_count > 0 || section.warning_count > 0;

  return (
    <div className="rounded-lg border border-line bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-2"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {open ? (
            <ChevronDown size={14} className="shrink-0 text-fg-faint" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-fg-faint" />
          )}
          <Layers size={13} className="shrink-0 text-fg-muted" />
          <span className="truncate text-[13px] font-semibold text-fg">
            {section.object_type}
          </span>
          <span className="text-[11px] text-fg-muted">
            {section.total_cases.toLocaleString()} cases · {section.total_events.toLocaleString()} events · {section.total_activities} activities
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {section.critical_count > 0 && (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger">
              {section.critical_count} critical
            </span>
          )}
          {section.warning_count > 0 && (
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning">
              {section.warning_count} warning
            </span>
          )}
          {!hasIssues && !section.error && (
            <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
              clean
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="border-t border-line px-4 py-3">
          {section.error ? (
            <p className="text-[11px] italic text-fg-muted">{section.error}</p>
          ) : section.findings.length === 0 ? (
            <p className="text-[11px] italic text-fg-muted">No findings for this object type.</p>
          ) : (
            <div className="divide-y divide-line">
              {section.findings.map((f, i) => (
                <FindingCard key={i} finding={f} onExplain={onExplain} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page component ───────────────────────────────────────────────────

export default function ImprovementReport({ ocelId }: { ocelId: string }) {
  const [report, setReport] = useState<OCPMImprovementReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [explainTarget, setExplainTarget] = useState<OCPMImprovementFinding | null>(null);
  const [exportingReport, setExportingReport] = useState(false);

  // Generate the printable HTML report and open it in a noopener
  // window via a blob URL — same XSS-safe pattern as the standard-log
  // report export. The new window is in a blob origin and has no
  // window.opener, so any HTML the LLM narrative emitted can't reach
  // back into the main app's localStorage.
  const handleExportReport = async () => {
    setExportingReport(true);
    try {
      const result = await ocelApi.getReport(ocelId);
      const blob = new Blob([result.html], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      const win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
      if (!win) {
        URL.revokeObjectURL(blobUrl);
      } else {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      }
    } finally {
      setExportingReport(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    ocelApi
      .getImprovementReport(ocelId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load report');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ocelId]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="lg" text="Compiling improvement report across every object type — this can take 30–60 s on first run…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-4">
        <p className="text-[12px] text-danger">{error}</p>
      </div>
    );
  }

  if (!report) return null;

  return (
    <div className="space-y-4">
      {/* ── Header summary ─────────────────────────────────────────── */}
      <div className="rounded-lg border border-line bg-surface-2 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-accent/10 p-2">
            <Sparkles size={18} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[14px] font-semibold text-fg">
                Improvement recommendations
              </h2>
              <button
                type="button"
                onClick={handleExportReport}
                disabled={exportingReport}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface-0 px-2.5 py-1.5 text-[11px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                title="Generate a printable HTML report covering every finding"
              >
                <FileDown size={11} />
                {exportingReport ? 'Generating…' : 'Generate report'}
              </button>
            </div>
            <p className="mt-0.5 text-[12px] text-fg-muted">{report.summary}</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryStat label="Total findings" value={report.total_findings} />
          <SummaryStat
            label="Critical"
            value={report.critical_count}
            tone={report.critical_count > 0 ? 'danger' : 'neutral'}
          />
          <SummaryStat
            label="Warnings"
            value={report.warning_count}
            tone={report.warning_count > 0 ? 'warning' : 'neutral'}
          />
          <SummaryStat
            label="Object perspectives"
            value={report.per_object_type.length}
            tone="accent"
          />
        </div>
      </div>

      {/* ── AI narrative (runs alongside structured report) ─────────── */}
      <NarrativeBlock ocelId={ocelId} />

      {/* ── Cross-object patterns (the big value) ──────────────────── */}
      {report.cross_object_findings.length > 0 && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Network size={14} className="text-accent" />
            <h3 className="text-[13px] font-semibold text-fg">
              Cross-object patterns
            </h3>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
              {report.cross_object_findings.length}
            </span>
          </div>
          <p className="mb-3 text-[11px] text-fg-muted">
            Findings that span multiple object-type perspectives — these are the
            highest-leverage fixes because one change compounds across every view.
          </p>
          <div className="divide-y divide-line">
            {report.cross_object_findings.map((f, i) => (
              <FindingCard key={i} finding={f} onExplain={setExplainTarget} />
            ))}
          </div>
        </div>
      )}

      {/* ── OCEL-level structural findings ─────────────────────────── */}
      {report.ocel_findings.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-1 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Layers size={14} className="text-fg-muted" />
            <h3 className="text-[13px] font-semibold text-fg">
              OCEL structural findings
            </h3>
            <span className="rounded-full bg-tint px-2 py-0.5 text-[10px] font-semibold text-fg-muted">
              {report.ocel_findings.length}
            </span>
          </div>
          <p className="mb-3 text-[11px] text-fg-muted">
            Observations that only make sense at the OCEL level — object-type
            balance, lifecycle spread, interactions, universal coordinators.
          </p>
          <div className="divide-y divide-line">
            {report.ocel_findings.map((f, i) => (
              <FindingCard key={i} finding={f} onExplain={setExplainTarget} />
            ))}
          </div>
        </div>
      )}

      {/* ── Per-object-type sections ───────────────────────────────── */}
      <div>
        <h3 className="mb-2 text-[13px] font-semibold text-fg">
          Per object type
        </h3>
        <p className="mb-3 text-[11px] text-fg-muted">
          Each object type's flattened log is analysed by the full standard rule
          set (bottlenecks, variants, rework, conformance, and more). Sections
          with the most critical findings are expanded by default.
        </p>
        <div className="space-y-2">
          {report.per_object_type.map((section, i) => (
            <ObjectTypeSection
              key={section.object_type}
              section={section}
              defaultOpen={section.critical_count > 0 || i === 0}
              onExplain={setExplainTarget}
            />
          ))}
        </div>
      </div>

      {/* ── Ask AI hint ────────────────────────────────────────────── */}
      <div className="rounded-lg border border-line bg-surface-1 p-4">
        <div className="flex items-start gap-3">
          <MessageSquare size={16} className="mt-0.5 shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-fg">Need a deeper look?</p>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              Flatten any object type from the Overview tab and use the Ask-AI panel
              in its process view to chat with your data — same LLM, full log context,
              follow-up questions. Click "Explain" on any finding above for an instant
              plain-English breakdown with three concrete next steps.
            </p>
          </div>
        </div>
      </div>

      {/* ── Explain drawer (conditional, z-50) ─────────────────────── */}
      {explainTarget && (
        <ExplainDrawer
          ocelId={ocelId}
          finding={explainTarget}
          onClose={() => setExplainTarget(null)}
        />
      )}
    </div>
  );
}
