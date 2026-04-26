import { useState } from 'react';
import { mining as miningApi } from '@/api/client';
import type { TemporalProfileResponse } from '@/types';
import AnalysisLoading from '@/components/common/AnalysisLoading';
import ErrorState from '@/components/common/ErrorState';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

function fmtDuration(s: number): string {
  if (!s && s !== 0) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export default function TemporalProfile({ eventLogId }: Props) {
  const { data, loading, error, retry, elapsedSec } = useAnalysisData<TemporalProfileResponse>(
    eventLogId, 'temporal_profile', miningApi.getTemporalProfile, 'Failed to load temporal profile',
  );
  const [profileSearch, setProfileSearch] = useState('');
  const [devSearch, setDevSearch] = useState('');

  if (loading) return <AnalysisLoading elapsedSec={elapsedSec} label="Computing temporal profile…" />;
  if (error) return <ErrorState message={error} onRetry={retry} />;
  if (!data) return null;

  const filteredProfiles = data.profiles.filter((p) => {
    if (!profileSearch) return true;
    const q = profileSearch.toLowerCase();
    return p.source.toLowerCase().includes(q) || p.target.toLowerCase().includes(q);
  });

  const filteredDevs = data.deviations.filter((d) => {
    if (!devSearch) return true;
    const q = devSearch.toLowerCase();
    return d.case_id.toLowerCase().includes(q) || d.activity_pair.toLowerCase().includes(q);
  });

  const deviatingOnly = filteredDevs.filter((d) => d.is_deviation);

  return (
    <div className="space-y-5">
      <p className="mb-3 text-[11px] text-fg-muted">Expected timing between activity pairs (mean ± standard deviation). Deviations flag cases that are abnormally fast or slow.</p>
      {/* Profiles */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[12px] font-semibold text-fg">Activity Pair Profiles</h4>
          <input
            type="text"
            placeholder="Search activities…"
            value={profileSearch}
            onChange={(e) => setProfileSearch(e.target.value)}
            className="rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder-fg-ghost outline-none focus:border-accent"
          />
        </div>
        <div className="overflow-auto rounded-lg border border-line">
          <table className="min-w-full text-[11px]">
            <thead>
              <tr className="border-b border-line bg-surface-1">
                <th className="px-3 py-2 text-left font-semibold text-fg-faint">Source</th>
                <th className="px-3 py-2 text-left font-semibold text-fg-faint">Target</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Mean</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Std Dev</th>
              </tr>
            </thead>
            <tbody>
              {filteredProfiles.length === 0 ? (
                <tr><td colSpan={4} className="py-6 text-center text-fg-muted">No profiles found.</td></tr>
              ) : filteredProfiles.map((p, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                  <td className="px-3 py-1.5 text-fg-secondary">{p.source}</td>
                  <td className="px-3 py-1.5 text-fg-secondary">{p.target}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-fg">{fmtDuration(p.mean)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-fg-muted">± {fmtDuration(p.stdev)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Deviations */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[12px] font-semibold text-fg">
            Temporal Deviations
            {deviatingOnly.length > 0 && (
              <span className="ml-2 rounded-full bg-danger/12 px-1.5 py-0.5 text-[10px] text-danger">{deviatingOnly.length}</span>
            )}
          </h4>
          <input
            type="text"
            placeholder="Search case/pair…"
            value={devSearch}
            onChange={(e) => setDevSearch(e.target.value)}
            className="rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder-fg-ghost outline-none focus:border-accent"
          />
        </div>
        {filteredDevs.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-fg-muted">No deviations found.</p>
        ) : (
          <div className="overflow-auto rounded-lg border border-line">
            <table className="min-w-full text-[11px]">
              <thead>
                <tr className="border-b border-line bg-surface-1">
                  <th className="px-3 py-2 text-left font-semibold text-fg-faint">Case</th>
                  <th className="px-3 py-2 text-left font-semibold text-fg-faint">Activity Pair</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">Expected</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">Actual</th>
                  <th className="px-3 py-2 text-center font-semibold text-fg-faint">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredDevs.map((d, i) => (
                  <tr key={i} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                    <td className="px-3 py-1.5 font-mono text-fg-secondary">{d.case_id}</td>
                    <td className="px-3 py-1.5 text-fg-secondary">{d.activity_pair}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-fg">{fmtDuration(d.expected)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-fg">{fmtDuration(d.actual)}</td>
                    <td className="px-3 py-1.5 text-center">
                      {d.is_deviation ? (
                        <span className="inline-block rounded-full bg-danger/12 px-2 py-0.5 text-[10px] text-danger">Deviation</span>
                      ) : (
                        <span className="inline-block rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
