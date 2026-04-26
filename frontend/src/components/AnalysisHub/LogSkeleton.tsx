import { useEffect, useState } from 'react';
import { mining as miningApi } from '@/api/client';
import type { LogSkeletonResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

// Maps constraint key → human-readable template
const CONSTRAINT_LABELS: Record<string, { label: string; template: (a: string, b?: string) => string; color: string }> = {
  always_before: { label: 'Always Before', template: (a, b) => `"${a}" always before "${b}"`, color: 'bg-accent/8 text-accent border-accent/20' },
  always_after: { label: 'Always After', template: (a, b) => `"${a}" always after "${b}"`, color: 'bg-success/8 text-success border-success/20' },
  never_together: { label: 'Never Together', template: (a, b) => `"${a}" never together with "${b}"`, color: 'bg-danger/8 text-danger border-danger/20' },
  equivalence: { label: 'Equivalence', template: (a, b) => `"${a}" equivalent to "${b}"`, color: 'bg-accent/8 text-accent border-accent/20' },
  always_required: { label: 'Always Required', template: (a) => `"${a}" is always present`, color: 'bg-warning/8 text-warning border-warning/20' },
};

function parseConstraints(constraints: Record<string, unknown>) {
  const groups: Array<{ key: string; label: string; color: string; rows: string[] }> = [];

  for (const [key, val] of Object.entries(constraints)) {
    const meta = CONSTRAINT_LABELS[key];
    const rows: string[] = [];

    if (Array.isArray(val)) {
      for (const item of val) {
        if (Array.isArray(item) && item.length >= 2) {
          const [a, b] = item.map(String);
          rows.push(meta ? meta.template(a, b) : `${a} — ${b}`);
        } else if (typeof item === 'string') {
          rows.push(meta ? meta.template(item) : item);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      for (const [a, bSet] of Object.entries(val as Record<string, unknown>)) {
        const targets = Array.isArray(bSet) ? bSet : [bSet];
        for (const b of targets) {
          rows.push(meta ? meta.template(a, String(b)) : `${a} — ${b}`);
        }
      }
    }

    if (rows.length > 0) {
      groups.push({
        key,
        label: meta?.label ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        color: meta?.color ?? 'bg-tint text-fg-muted border-line',
        rows,
      });
    }
  }

  return groups;
}

export default function LogSkeleton({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<LogSkeletonResponse>(
    eventLogId, 'log_skeleton', miningApi.getLogSkeleton, 'Failed to load log skeleton',
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-expand all groups when data loads
  useEffect(() => {
    if (data?.constraints) {
      setExpanded(new Set(Object.keys(data.constraints)));
    }
  }, [data]);

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data) return null;

  const groups = parseConstraints(data.constraints ?? {});

  if (groups.length === 0) {
    return <p className="py-10 text-center text-[12px] text-fg-muted">No log skeleton constraints found.</p>;
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="space-y-3">
      <p className="mb-3 text-[11px] text-fg-muted">Declarative constraints discovered from the data — rules like 'A always happens before B' or 'C and D never occur together'.</p>
      <p className="text-[11px] text-fg-faint">{groups.reduce((s, g) => s + g.rows.length, 0)} constraints across {groups.length} relation types.</p>
      {groups.map((g) => (
        <div key={g.key} className={`overflow-hidden rounded-lg border ${g.color}`}>
          <button
            onClick={() => toggle(g.key)}
            className="flex w-full items-center justify-between px-3 py-2 text-left"
          >
            <span className="text-[11px] font-semibold">{g.label}</span>
            <span className="text-[10px] opacity-70">{g.rows.length} rule{g.rows.length !== 1 ? 's' : ''} {expanded.has(g.key) ? '▴' : '▾'}</span>
          </button>
          {expanded.has(g.key) && (
            <div className="border-t border-current/20 bg-surface-0 px-3 py-2">
              <div className="space-y-1">
                {g.rows.map((row, i) => (
                  <p key={i} className="text-[11px] text-fg-secondary">{row}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
