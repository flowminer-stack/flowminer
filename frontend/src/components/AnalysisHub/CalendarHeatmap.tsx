import { analytics as analyticsApi } from '@/api/client';
import { useAnalysisData } from '@/hooks/useAnalysisData';
import LoadingSpinner from '@/components/common/LoadingSpinner';

interface Props {
  eventLogId: string;
}

function heatColor(share: number): string {
  // 0..max -> transparent -> accent
  const intensity = Math.min(1, share * 20);
  return `rgba(6, 182, 212, ${intensity})`;
}

export default function CalendarHeatmap({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<any>(
    eventLogId,
    'calendar_heatmap',
    analyticsApi.calendarHeatmap,
    'Failed to load calendar heatmap',
  );

  if (loading)
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner size="md" />
      </div>
    );
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data) return <p className="py-10 text-center text-[12px] text-fg-muted">No data</p>;

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-fg-muted">
        Event activity by day of week and hour of day. Peak:{' '}
        <span className="text-fg">
          {data.peak_day} at {data.peak_hour}:00
        </span>
        . Off-hours events: <span className="text-fg">{data.off_hours_events.toLocaleString()}</span> (
        {Math.round((data.off_hours_share || 0) * 100)}%)
      </p>

      <div className="overflow-x-auto">
        <table className="text-[10px]">
          <thead>
            <tr>
              <th></th>
              {data.hours.map((h: number) => (
                <th key={h} className="w-5 px-0.5 text-center text-fg-faint">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.matrix.map((row: any) => (
              <tr key={row.day}>
                <td className="pr-2 text-[11px] text-fg-muted">{row.day}</td>
                {row.values.map((v: any) => (
                  <td
                    key={`${row.day}-${v.hour}`}
                    className="h-5 w-5 rounded-sm"
                    style={{ background: heatColor(v.share) }}
                    title={`${row.day} ${v.hour}:00 — ${v.count} events`}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
