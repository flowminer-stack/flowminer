import { useState } from 'react';
import { Terminal, Play } from 'lucide-react';
import { useFilterStore } from '@/store/filterStore';

// Apromore-style filter expression input. Users type a tiny DSL:
//
//   case.duration > 3d and activity = "Approve" and resource != "Bot"
//
// We POST it to /competitive/filter-expression and push the matching
// case_ids back into the shared filter store as a single 'case' chip,
// so every analysis page picks it up automatically.

export default function FilterExpressionBar({ eventLogId }: { eventLogId: string }) {
  const [expr, setExpr] = useState('');
  const [running, setRunning] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [matched, setMatched] = useState<number | null>(null);
  const addChip = useFilterStore((s) => s.addChip);

  const run = async () => {
    if (!expr.trim()) return;
    setRunning(true);
    setWarnings([]);
    try {
      const res = (await (
        await fetch('/api/v1/competitive/filter-expression', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('flowminer_token') ?? ''}`,
          },
          body: JSON.stringify({ event_log_id: eventLogId, expression: expr }),
        })
      ).json()) as {
        case_ids: string[];
        total_matched: number;
        warnings: string[];
      };
      setMatched(res.total_matched);
      setWarnings(res.warnings ?? []);
      if (res.case_ids && res.case_ids.length > 0) {
        addChip({
          type: 'case',
          label: `expr: ${expr.slice(0, 40)}${expr.length > 40 ? '…' : ''} (${res.total_matched})`,
          payload: { case_ids: res.case_ids, expression: expr },
        });
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-2">
        <Terminal
          size={13}
          className="shrink-0 text-accent"
          aria-label="Filter expression"
        />
        <span
          className="hidden shrink-0 text-[10px] font-semibold uppercase tracking-wide text-fg-faint sm:inline"
          title="Power-user filter. Running an expression adds a chip to the universal filter, so it scopes the process map AND every analysis tab."
        >
          Expression
        </span>
        <input
          type="text"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
          }}
          placeholder='case.duration > 3d and activity = "Approve"'
          className="flex-1 bg-transparent font-mono text-[11px] text-fg outline-none placeholder:text-fg-ghost"
        />
        <button
          type="button"
          onClick={run}
          disabled={running || !expr.trim()}
          className="inline-flex items-center gap-1 rounded border border-line bg-surface-0 px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
        >
          <Play size={10} />
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
      {matched !== null && (
        <p className="mt-1.5 text-[10px] text-fg-muted">
          Matched {matched} cases. Chip added — the map and every analysis tab now scope to them.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="mt-1 text-[10px] text-warning">
          {warnings.map((w, i) => (
            <li key={i}>• {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
