import { useState } from 'react';
import { mining as miningApi } from '@/api/client';
import type { DeclareResponse, DeclareRule } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  response: 'If A occurs, B must eventually follow',
  precedence: 'B can only occur if A occurred before',
  succession: 'A and B must both occur, A before B',
  co_existence: 'If A occurs, B must also occur (and vice versa)',
  not_co_existence: 'A and B cannot both occur in the same case',
  responded_existence: 'If A occurs, B must also occur',
  chain_response: 'B must immediately follow A',
  chain_precedence: 'A must immediately precede B',
  alternate_response: 'A cannot recur until B has occurred',
  alternate_precedence: 'B cannot recur until A has occurred',
  exactly_one: 'A occurs exactly once',
  init: 'A must be the first activity',
  end: 'A must be the last activity',
};

function templateLabel(template: string): string {
  return template.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function templateDesc(template: string): string {
  const key = template.toLowerCase();
  return TEMPLATE_DESCRIPTIONS[key] ?? template;
}

function supportColor(support: number): string {
  if (support >= 0.9) return 'bg-success/10 text-success';
  if (support >= 0.7) return 'bg-warning/10 text-warning';
  return 'bg-danger/10 text-danger';
}

export default function DeclareRules({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<DeclareResponse>(
    eventLogId, 'declare', miningApi.getDeclare, 'Failed to load DECLARE rules',
  );
  const [search, setSearch] = useState('');

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data) return null;

  const sorted = [...data.rules].sort((a: DeclareRule, b: DeclareRule) => b.support - a.support);
  const filtered = sorted.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.template.toLowerCase().includes(q) ||
      r.activity_a.toLowerCase().includes(q) ||
      (r.activity_b ?? '').toLowerCase().includes(q) ||
      (r.narrative ?? '').toLowerCase().includes(q);
  });

  if (sorted.length === 0) {
    return <p className="py-10 text-center text-[12px] text-fg-muted">No DECLARE rules found.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="mb-3 text-[11px] text-fg-muted">Formal process rules with confidence levels. Rules describe behavioral patterns like precedence, response, and co-existence.</p>
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-fg-faint">{sorted.length} rule{sorted.length !== 1 ? 's' : ''} discovered, sorted by support.</p>
        <input
          type="text"
          placeholder="Search rules…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder-fg-ghost outline-none focus:border-accent"
        />
      </div>
      <div className="overflow-auto rounded-lg border border-line">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="border-b border-line bg-surface-1">
              <th className="px-3 py-2 text-left font-semibold text-fg-faint">Template</th>
              <th className="px-3 py-2 text-left font-semibold text-fg-faint">Activity A</th>
              <th className="px-3 py-2 text-left font-semibold text-fg-faint">Activity B</th>
              <th className="px-3 py-2 text-left font-semibold text-fg-faint">Narrative</th>
              <th className="px-3 py-2 text-right font-semibold text-fg-faint">Support</th>
              <th className="px-3 py-2 text-right font-semibold text-fg-faint">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="py-6 text-center text-fg-muted">No rules match your search.</td></tr>
            ) : filtered.map((r, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                <td className="px-3 py-1.5 font-medium text-fg">{templateLabel(r.template)}</td>
                <td className="px-3 py-1.5 text-fg-secondary">{r.activity_a || '—'}</td>
                <td className="px-3 py-1.5 text-fg-secondary">{r.activity_b || '—'}</td>
                <td className="px-3 py-1.5 text-fg-faint italic max-w-xs truncate" title={r.narrative ?? templateDesc(r.template)}>
                  {r.narrative ?? templateDesc(r.template)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${supportColor(r.support)}`}>
                    {(r.support * 100).toFixed(0)}%
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right">
                  {r.confidence != null ? (
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${supportColor(r.confidence)}`}>
                      {(r.confidence * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-fg-ghost">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
