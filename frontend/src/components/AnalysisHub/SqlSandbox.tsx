import { useState } from 'react';
import { Play } from 'lucide-react';
import { analytics as analyticsApi } from '@/api/client';

interface Props {
  eventLogId: string;
}

const SAMPLE_QUERY =
  'SELECT "concept:name" AS activity, COUNT(*) AS events\nFROM log\nGROUP BY "concept:name"\nORDER BY events DESC\nLIMIT 20';

export default function SqlSandbox({ eventLogId }: Props) {
  const [query, setQuery] = useState(SAMPLE_QUERY);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await analyticsApi.sqlSandbox({ event_log_id: eventLogId, query, limit: 1000 });
      setResult(r);
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Query failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-fg-muted">
        Run read-only SELECT queries against the event log exposed as table{' '}
        <code className="rounded bg-tint px-1 text-[10px]">log</code>.
      </p>

      <div>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={6}
          className="input w-full font-mono text-[11px]"
          spellCheck={false}
        />
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={run}
            disabled={loading}
            className="btn-primary flex items-center gap-1.5 disabled:opacity-50"
          >
            <Play size={13} />
            {loading ? 'Running...' : 'Run query'}
          </button>
          {result?.truncated && (
            <span className="text-[10px] text-warning">Results truncated to {result.row_count} rows</span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {error}
        </div>
      )}

      {result && (
        <div className="overflow-auto rounded-lg border border-line">
          <table className="min-w-full text-[11px]">
            <thead className="bg-tint/40 text-fg-faint">
              <tr>
                {result.columns.map((c: string) => (
                  <th key={c} className="px-3 py-1.5 text-left">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 200).map((row: any, i: number) => (
                <tr key={i} className="border-t border-line text-fg">
                  {result.columns.map((c: string) => (
                    <td key={c} className="px-3 py-1 tabular-nums">
                      {String(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-1.5 text-[10px] text-fg-faint">{result.row_count} rows returned</p>
        </div>
      )}
    </div>
  );
}
