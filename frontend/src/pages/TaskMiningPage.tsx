import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Cpu,
  Link2,
  Play,
  Activity,
  Zap,
  AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import {
  taskMining as taskMiningApi,
  eventLogs as eventLogsApi,
  type TaskPattern,
  type TaskPatternCrossLink,
} from '@/api/client';
import type { EventLog } from '@/types';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import InterAppGraph from '@/components/TaskMining/InterAppGraph';
import AppTeamHeatmap from '@/components/TaskMining/AppTeamHeatmap';

export default function TaskMiningPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const addNotification = useUIStore((s) => s.addNotification);

  const [patterns, setPatterns] = useState<TaskPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [mining, setMining] = useState(false);
  const [linking, setLinking] = useState(false);
  const [logs, setLogs] = useState<EventLog[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [crossLinks, setCrossLinks] = useState<TaskPatternCrossLink[] | null>(null);

  const loadPatterns = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const list = await taskMiningApi.listPatterns(projectId);
      setPatterns(list);
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Could not load task patterns',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  const loadEventLogs = async () => {
    if (!projectId) return;
    try {
      const list = await eventLogsApi.list(projectId);
      setLogs(list);
      if (list.length > 0 && !selectedLogId) {
        setSelectedLogId(list[0].id);
      }
    } catch {
      // Non-fatal — user can still view patterns without cross-linking
    }
  };

  useEffect(() => {
    loadPatterns();
    loadEventLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const runMining = async () => {
    if (!projectId) return;
    setMining(true);
    try {
      const r = await taskMiningApi.mine(projectId);
      if (r.message) {
        addNotification({
          type: 'info',
          title: 'No recordings to mine',
          message: r.message,
        });
      } else {
        addNotification({
          type: 'success',
          title: 'Task mining complete',
          message: `Discovered ${r.patterns} patterns, kept the top ${r.stored ?? r.patterns}.`,
        });
        await loadPatterns();
      }
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Mining failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setMining(false);
    }
  };

  const runCrossLink = async () => {
    if (!projectId || !selectedLogId) return;
    setLinking(true);
    try {
      const r = await taskMiningApi.crossLink(projectId, selectedLogId, 0.4);
      setCrossLinks(r.cross_links);
      addNotification({
        type: 'success',
        title: 'Cross-link complete',
        message: `${r.cross_links.length} patterns matched against ${r.activities_considered} activities.`,
      });
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Cross-link failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setLinking(false);
    }
  };

  const getCrossLinkFor = (patternId: string): TaskPatternCrossLink | undefined => {
    return crossLinks?.find((cl) => cl.pattern_id === patternId);
  };

  return (
    <div>
      <PageHeader
        title="Task Mining"
        icon={Cpu}
        description="Discover repeatable desktop-task patterns from captured recordings — then cross-link them to the activities in your process log."
        backTo={-1}
      />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button onClick={runMining} disabled={mining} className="btn-primary flex items-center gap-1.5">
          <Play size={13} />
          {mining ? 'Mining…' : 'Run pattern mining'}
        </button>

        {logs.length > 0 && (
          <>
            <div className="h-6 w-px bg-line" />
            <label className="text-[11px] text-fg-muted">Cross-link against:</label>
            <select
              value={selectedLogId ?? ''}
              onChange={(e) => setSelectedLogId(e.target.value)}
              className="input text-[11px]"
              style={{ minWidth: 200 }}
            >
              {logs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <button
              onClick={runCrossLink}
              disabled={linking || !selectedLogId || patterns.length === 0}
              className="btn-secondary flex items-center gap-1.5"
              title="Match each task pattern to its closest process-mining activity"
            >
              <Link2 size={13} />
              {linking ? 'Linking…' : 'Cross-link to process'}
            </button>
          </>
        )}
      </div>

      <div className="mt-6">
        {loading ? (
          <LoadingSpinner text="Loading task patterns..." />
        ) : patterns.length === 0 ? (
          <div className="card flex flex-col items-center p-10 text-center">
            <Cpu className="text-fg-ghost" size={40} />
            <p className="mt-4 text-[14px] font-semibold text-fg">No task patterns yet</p>
            <p className="mt-1 max-w-md text-[12px] text-fg-muted">
              Task patterns come from desktop recordings captured by the reference capture agent in{' '}
              <code className="rounded bg-tint px-1 py-0.5 text-[11px] text-fg-secondary">tools/capture_agent/</code>.
              Run the agent to stream active-window events into FlowMiner, then click <b>Run pattern mining</b> above.
            </p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line bg-surface-1 text-left">
                  <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Pattern</th>
                  <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Frequency</th>
                  <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Steps</th>
                  <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Automation score</th>
                  <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Matched process activities</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((p) => {
                  const link = getCrossLinkFor(p.id);
                  return (
                    <tr key={p.id} className="border-b border-line last:border-b-0 hover:bg-tint">
                      <td className="px-3 py-3 align-top">
                        <div className="flex items-start gap-2">
                          <Activity size={14} className="mt-0.5 shrink-0 text-accent" />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-fg" title={p.name}>
                              {p.name}
                            </p>
                            {p.sequence.length > 0 && (
                              <p className="mt-0.5 truncate text-[10px] text-fg-faint">
                                {p.sequence.slice(0, 4).map(([a, t]) => `${a}::${t}`).join(' → ')}
                                {p.sequence.length > 4 && ` +${p.sequence.length - 4}`}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top tabular-nums text-fg-secondary">
                        {p.frequency.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 align-top tabular-nums text-fg-secondary">
                        {p.sequence.length}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-line">
                            <div
                              className={clsx(
                                'h-full rounded-full',
                                p.automatable_score > 0.7
                                  ? 'bg-emerald-500'
                                  : p.automatable_score > 0.4
                                    ? 'bg-amber-500'
                                    : 'bg-rose-500',
                              )}
                              style={{ width: `${p.automatable_score * 100}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-[11px] text-fg-muted">
                            {(p.automatable_score * 100).toFixed(0)}%
                          </span>
                          {p.automatable_score > 0.7 && <Zap size={11} className="text-emerald-500" />}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        {!crossLinks ? (
                          <span className="text-[10px] text-fg-faint">Click &ldquo;Cross-link to process&rdquo;</span>
                        ) : !link || link.top_activities.length === 0 ? (
                          <span className="inline-flex items-center gap-1 text-[10px] text-fg-faint">
                            <AlertCircle size={10} /> No strong match
                          </span>
                        ) : (
                          <div className="space-y-1">
                            {link.top_activities.map((a) => (
                              <div key={a.activity} className="flex items-center gap-2">
                                <span
                                  className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                                  title={`Overall similarity: ${(link.overall_similarity * 100).toFixed(0)}%`}
                                >
                                  {a.activity}
                                </span>
                                <span className="tabular-nums text-[10px] text-fg-faint">
                                  {(a.score * 100).toFixed(0)}%
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Workfellow-style: inter-app graph + team×app heatmap */}
      {selectedLogId && (
        <div className="mt-8 space-y-4">
          <InterAppGraph eventLogId={selectedLogId} />
          <AppTeamHeatmap eventLogId={selectedLogId} />
        </div>
      )}
    </div>
  );
}
