import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertCircle,
  TrendingUp,
  Download,
  Target,
  Activity,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import FilterScopeNotice from '@/components/common/FilterScopeNotice';
import EmptyState from '@/components/common/EmptyState';
import HintTooltip from '@/components/common/Tooltip';
import ComplianceMatrix from '@/components/Conformance/ComplianceMatrix';
import SideBySideConformance from '@/components/Conformance/SideBySideConformance';
import StochasticConformancePanel from '@/components/Conformance/StochasticConformancePanel';
import ConformanceDeviationHeatmap from '@/components/Conformance/ConformanceDeviationHeatmap';
import ExplainButton from '@/components/AI/ExplainButton';
import { mining as miningApi } from '@/api/client';
import { useUIStore } from '@/store';
import clsx from 'clsx';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { useMiningStore } from '@/store';
import { useEventLogData } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import DataTable from '@/components/common/DataTable';
import type { ColumnDef } from '@tanstack/react-table';
import type { Deviation } from '@/types';

const deviationColumns: ColumnDef<Deviation, unknown>[] = [
  {
    accessorKey: 'case_id',
    header: 'Case ID',
    cell: ({ getValue }) => (
      <span className="font-mono text-xs">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: 'deviation_type',
    header: 'Type',
    cell: ({ getValue }) => {
      const type = getValue<string>();
      const badge = (
        <span
          className={clsx(
            'badge',
            type === 'missing'
              ? 'badge-amber'
              : type === 'unexpected'
                ? 'badge-rose'
                : 'badge-slate',
          )}
        >
          {type}
        </span>
      );
      if (type === 'missing') {
        return <HintTooltip text="An expected activity was skipped">{badge}</HintTooltip>;
      }
      if (type === 'unexpected') {
        return <HintTooltip text="An activity occurred that the model doesn't expect">{badge}</HintTooltip>;
      }
      return badge;
    },
  },
  {
    accessorKey: 'activity',
    header: 'Activity',
    cell: ({ getValue }) => getValue<string>() ?? '--',
  },
  {
    accessorKey: 'expected',
    header: 'Expected',
    cell: ({ getValue }) => getValue<string>() ?? '--',
  },
  {
    accessorKey: 'actual',
    header: 'Actual',
    cell: ({ getValue }) => getValue<string>() ?? '--',
  },
  {
    id: 'explain',
    header: '',
    cell: ({ row }) => (
      <ExplainButton
        kind="conformance"
        context={{
          case_id: row.original.case_id,
          deviation_type: row.original.deviation_type,
          activity: row.original.activity ?? '',
          expected: row.original.expected ?? null,
          actual: row.original.actual ?? null,
        }}
        size="xs"
      />
    ),
  },
];

function MetricGauge({
  value,
  label,
  color,
}: {
  value: number | null;
  label: string;
  color: string;
}) {
  if (value === null) {
    return (
      <div className="flex flex-col items-center">
        <div className="text-xl font-bold tabular-nums text-fg">N/A</div>
        <div className="text-[11px] text-fg-muted">{label}</div>
      </div>
    );
  }

  const percentage = (value * 100).toFixed(1);

  return (
    <div className="flex flex-col items-center">
      <div className={clsx('text-xl font-bold tabular-nums', color)}>{percentage}%</div>
      <div className="mt-1 text-[11px] text-fg-muted">{label}</div>
    </div>
  );
}

type ConformanceTab = 'token_replay' | 'stochastic';

export default function ConformancePage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [activeTab, setActiveTab] = useState<ConformanceTab>('token_replay');

  const { eventLog } = useEventLogData(eventLogId);

  const trackAsInitiative = () => {
    if (!eventLog?.project_id || !conformance) return;
    navigate(`/initiatives/${eventLog.project_id}`, {
      state: {
        prefill: {
          name: `Improve conformance of ${eventLog.name ?? 'this process'}`,
          description: `Current fitness is ${(conformance.fitness * 100).toFixed(1)}%. ${conformance.total_cases - conformance.conformant_cases} of ${conformance.total_cases} cases deviate from the model.`,
          metric: 'fitness',
          unit: 'ratio',
          baseline_value: conformance.fitness,
          target_value: Math.min(1, conformance.fitness + (1 - conformance.fitness) / 2),
          event_log_id: eventLogId,
        },
      },
    });
  };
  const { conformance, conformanceLoading, error, fetchConformance } =
    useMiningStore();

  const exportPdf = async () => {
    if (!eventLogId) return;
    setExportingPdf(true);
    try {
      await miningApi.downloadConformancePdf(eventLogId, 'alignment');
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'PDF export failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setExportingPdf(false);
    }
  };

  useEffect(() => {
    if (eventLogId) {
      fetchConformance(eventLogId);
    }
  }, [eventLogId, fetchConformance]);

  if (conformanceLoading) {
    return (
      <LoadingSpinner
        size="lg"
        text="Running conformance checking..."
        fullPage
      />
    );
  }

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => eventLogId && fetchConformance(eventLogId)}
      />
    );
  }

  const conformantRate = conformance
    ? ((conformance.conformant_cases / conformance.total_cases) * 100).toFixed(
        1,
      )
    : '0';

  const pieData = conformance
    ? [
        {
          name: 'Conformant',
          value: conformance.conformant_cases,
        },
        {
          name: 'Deviating',
          value: conformance.total_cases - conformance.conformant_cases,
        },
      ]
    : [];

  const pieColors = ['#10b981', '#f43f5e'];

  return (
    <div>
      <PageHeader
        title="Conformance Checking"
        icon={ShieldCheck}
        backTo={-1}
        description="How closely your actual process matches the expected model. Deviations may indicate problems or legitimate exceptions."
        subtitle={`${eventLog?.name ?? 'Event Log'} — comparing actual behavior against the reference model`}
        actions={
          conformance ? (
            <div className="flex items-center gap-2">
              <button
                onClick={trackAsInitiative}
                className="btn-secondary flex items-center gap-1.5"
                title="Create an Initiative to track conformance improvement"
              >
                <Target size={14} />
                Track as Initiative
              </button>
              <button
                onClick={exportPdf}
                disabled={exportingPdf}
                className="btn-secondary flex items-center gap-1.5"
                title="Download a standardized PDF conformance report"
              >
                <Download size={14} />
                {exportingPdf ? 'Generating…' : 'PDF report'}
              </button>
            </div>
          ) : undefined
        }
      />

      <FilterScopeNotice eventLogId={eventLogId} />

      {/* Tab switcher */}
      <div className="mt-6 flex gap-1 border-b border-line">
        <button
          type="button"
          onClick={() => setActiveTab('token_replay')}
          className={clsx(
            'flex items-center gap-1.5 border-b-2 px-4 py-2 text-[13px] font-medium transition-colors',
            activeTab === 'token_replay'
              ? 'border-accent text-accent'
              : 'border-transparent text-fg-muted hover:text-fg',
          )}
        >
          <ShieldCheck size={14} />
          Token Replay / Alignment
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('stochastic')}
          className={clsx(
            'flex items-center gap-1.5 border-b-2 px-4 py-2 text-[13px] font-medium transition-colors',
            activeTab === 'stochastic'
              ? 'border-accent text-accent'
              : 'border-transparent text-fg-muted hover:text-fg',
          )}
        >
          <Activity size={14} />
          Stochastic (EMD)
        </button>
      </div>

      {/* Stochastic tab */}
      {activeTab === 'stochastic' && eventLogId && (
        <div className="mt-6">
          <StochasticConformancePanel eventLogId={eventLogId} />
        </div>
      )}

      {activeTab === 'token_replay' && conformance && (
        <>
          {/* Metrics */}
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card flex flex-col items-center p-6">
              <HintTooltip text="How well the event log fits the process model. 100% = all cases follow the model exactly.">
                <MetricGauge
                  value={conformance.fitness}
                  label="Fitness"
                  color="text-success"
                />
              </HintTooltip>
            </div>
            <div className="card flex flex-col items-center p-6">
              <HintTooltip text="Precision (Escaping Edges / ETC): measures how much phantom behaviour the model allows that the log never walks. Calculated by following the log's prefix tree through the model — each time the model offers a transition the log never takes, that is an 'escaping edge'. Precision = 1 − (escaping edge rate). A flower model has fitness 1.0 but precision near 0.">
                <MetricGauge
                  value={conformance.precision}
                  label="Precision (ETC)"
                  color="text-accent"
                />
              </HintTooltip>
            </div>
            <div className="card flex flex-col items-center p-6">
              <HintTooltip text="How well the model generalizes to unseen behavior. Higher = more general.">
                <MetricGauge
                  value={conformance.generalization}
                  label="Generalization"
                  color="text-warning"
                />
              </HintTooltip>
            </div>
            <div className="card flex flex-col items-center p-6">
              <div className="text-xl font-bold tabular-nums text-fg">
                {conformantRate}%
              </div>
              <div className="mt-1 text-[11px] text-fg-muted">
                Conformant Cases
              </div>
            </div>
          </div>

          {/* Chart & summary */}
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Pie chart */}
            <div className="card p-5">
              <h2 className="text-[14px] font-semibold text-fg">
                Case Distribution
              </h2>
              <div className="mt-4 h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                    >
                      {pieData.map((_, index) => (
                        <Cell key={index} fill={pieColors[index]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        borderRadius: '8px',
                        border: '1px solid var(--chart-tooltip-border)',
                        fontSize: '12px',
                        backgroundColor: 'var(--chart-tooltip-bg)',
                        color: 'var(--chart-tooltip-text)',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex justify-center gap-6">
                <div className="flex items-center gap-2 text-[12px]">
                  <div className="h-3 w-3 rounded-full bg-success" />
                  <span className="text-fg-muted">
                    Conformant ({conformance.conformant_cases})
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[12px]">
                  <div className="h-3 w-3 rounded-full bg-danger" />
                  <span className="text-fg-muted">
                    Deviating (
                    {conformance.total_cases - conformance.conformant_cases})
                  </span>
                </div>
              </div>
            </div>

            {/* Summary stats */}
            <div className="card p-5">
              <h2 className="text-[14px] font-semibold text-fg">Summary</h2>
              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2
                      size={16}
                      className="text-success"
                    />
                    <span className="text-[12px] text-fg-muted">
                      Conformant Cases
                    </span>
                  </div>
                  <span className="text-[12px] font-semibold text-fg">
                    {conformance.conformant_cases.toLocaleString()} /{' '}
                    {conformance.total_cases.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <XCircle size={16} className="text-danger" />
                    <span className="text-[12px] text-fg-muted">
                      Total Deviations
                    </span>
                  </div>
                  <span className="text-[12px] font-semibold text-fg">
                    {conformance.deviations.length.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp size={16} className="text-accent" />
                    <span className="text-[12px] text-fg-muted">
                      Fitness Score
                    </span>
                  </div>
                  <span className="text-[12px] font-semibold text-fg">
                    {(conformance.fitness * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertCircle size={16} className="text-warning" />
                    <span className="text-[12px] text-fg-muted">
                      Deviation Types
                    </span>
                  </div>
                  <span className="text-[12px] font-semibold text-fg">
                    {new Set(conformance.deviations.map((d) => d.deviation_type))
                      .size}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Deviations table */}
          {conformance.deviations.length > 0 && (
            <div className="mt-6">
              <h2 className="text-[14px] font-semibold text-fg">
                Deviations
              </h2>
              <div className="mt-4">
                <DataTable
                  data={conformance.deviations}
                  columns={deviationColumns}
                  searchable
                  searchPlaceholder="Search deviations..."
                  paginated
                  pageSize={10}
                  emptyMessage="No deviations"
                  emptyDescription="All cases conform to the reference model."
                />
              </div>
            </div>
          )}

          {/* Deviation heatmap */}
          <ConformanceDeviationHeatmap conformance={conformance} />
        </>
      )}

      {!conformance && !conformanceLoading && (
        <EmptyState
          className="mt-16"
          icon={ShieldCheck}
          title="No conformance data available"
          description="No conformance data is available for this event log."
        />
      )}

      {/* Compliance matrix (Minit / ARIS parity) — token-replay tab only */}
      {activeTab === 'token_replay' && eventLogId && conformance && (
        <div className="mt-8">
          <ComplianceMatrix eventLogId={eventLogId} />
        </div>
      )}

      {/* Side-by-side conformance (ARIS parity) — token-replay tab only */}
      {activeTab === 'token_replay' && eventLogId && conformance && (
        <div className="mt-8">
          <SideBySideConformance eventLogId={eventLogId} />
        </div>
      )}
    </div>
  );
}
