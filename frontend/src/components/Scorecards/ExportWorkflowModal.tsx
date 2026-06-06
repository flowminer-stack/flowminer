/**
 * ExportWorkflowModal
 *
 * Process-to-code export. Lets the user pick a workflow engine
 * (Temporal / n8n / Airflow), calls GET /scorecards/export-workflow/{id},
 * and shows the generated happy-path source in a copy-able, downloadable
 * code block. A real Celonis differentiator — the mined process becomes
 * runnable orchestration code.
 *
 * Self-contained: takes only `eventLogId`, `isOpen`, and `onClose`. Drop a
 * trigger button anywhere and render this alongside it.
 */

import { useState } from 'react';
import { Check, Copy, Download, FileCode2, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import Modal from '@/components/common/Modal';
import ErrorState from '@/components/common/ErrorState';
import { exportWorkflow } from '@/api/scorecards';
import type { ExportTarget, ExportWorkflowResult } from '@/types/scorecards';

interface Props {
  eventLogId: string;
  isOpen: boolean;
  onClose: () => void;
}

const TARGETS: { id: ExportTarget; label: string; blurb: string }[] = [
  {
    id: 'temporal',
    label: 'Temporal',
    blurb: 'Python workflow + activity skeleton',
  },
  {
    id: 'n8n',
    label: 'n8n',
    blurb: 'Importable workflow JSON',
  },
  {
    id: 'airflow',
    label: 'Airflow',
    blurb: 'Python DAG with PythonOperators',
  },
];

const EXTENSION: Record<string, string> = {
  python: 'py',
  json: 'json',
};

function errMessage(e: unknown): string {
  const ax = e as { response?: { data?: { detail?: string } }; message?: string };
  return (
    ax?.response?.data?.detail ||
    ax?.message ||
    'Failed to generate workflow code.'
  );
}

export default function ExportWorkflowModal({ eventLogId, isOpen, onClose }: Props) {
  const [target, setTarget] = useState<ExportTarget>('temporal');
  const [result, setResult] = useState<ExportWorkflowResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async (t: ExportTarget) => {
    if (!eventLogId) return;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const r = await exportWorkflow(eventLogId, t);
      setResult(r);
    } catch (e) {
      setError(errMessage(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (t: ExportTarget) => {
    setTarget(t);
    // Re-generate whenever the target changes after an initial run.
    if (result || error) generate(t);
  };

  const copyCode = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — download remains available */
    }
  };

  const downloadCode = () => {
    if (!result) return;
    const ext = EXTENSION[result.language] || 'txt';
    const mime = result.language === 'json' ? 'application/json' : 'text/plain';
    const blob = new Blob([result.code], { type: `${mime};charset=utf-8;` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flowminer_${result.target}_workflow.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Export as Code" size="xl">
      <div className="space-y-4">
        <div className="flex items-start gap-2">
          <FileCode2 size={16} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-[12px] text-fg-muted">
            Turn the mined happy path into runnable orchestration code. Pick a
            target engine, then copy or download the generated source.
          </p>
        </div>

        {/* Target selector */}
        <div className="grid grid-cols-3 gap-2">
          {TARGETS.map((t) => {
            const active = t.id === target;
            return (
              <button
                key={t.id}
                onClick={() => handleSelect(t.id)}
                disabled={loading}
                className={clsx(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'border-accent bg-accent/10'
                    : 'border-line hover:bg-tint/40',
                  loading && 'cursor-wait opacity-70',
                )}
              >
                <div
                  className={clsx(
                    'text-[13px] font-semibold',
                    active ? 'text-accent' : 'text-fg',
                  )}
                >
                  {t.label}
                </div>
                <div className="mt-0.5 text-[11px] text-fg-faint">{t.blurb}</div>
              </button>
            );
          })}
        </div>

        {/* Generate button (initial action) */}
        {!result && !error && (
          <button
            onClick={() => generate(target)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-wait disabled:opacity-70"
          >
            {loading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <FileCode2 size={13} />
            )}
            {loading ? 'Generating…' : 'Generate'}
          </button>
        )}

        {/* Error */}
        {error && (
          <ErrorState message={error} onRetry={() => generate(target)} compact />
        )}

        {/* Loading after a result already exists (re-generate) */}
        {loading && result && (
          <div className="flex items-center gap-2 text-[12px] text-fg-muted">
            <Loader2 size={13} className="animate-spin" />
            Regenerating…
          </div>
        )}

        {/* Code block */}
        {result && !loading && (
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="flex items-center justify-between border-b border-line bg-surface-1 px-3 py-2">
              <span className="font-mono text-[11px] uppercase tracking-wide text-fg-faint">
                {result.target} · {result.language}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={copyCode}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-tint hover:text-fg"
                  aria-label="Copy code"
                >
                  {copied ? (
                    <>
                      <Check size={12} className="text-success" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy size={12} /> Copy
                    </>
                  )}
                </button>
                <button
                  onClick={downloadCode}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-tint hover:text-fg"
                  aria-label="Download code"
                >
                  <Download size={12} /> Download
                </button>
              </div>
            </div>
            <pre className="max-h-[48vh] overflow-auto bg-surface-0 p-3.5 text-[11.5px] leading-relaxed text-fg-secondary">
              <code className="font-mono whitespace-pre">{result.code}</code>
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}
