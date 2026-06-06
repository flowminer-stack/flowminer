import { useParams, Link } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import ProcessCityCanvas from '@/components/ProcessMap/ProcessCityCanvas';
import { useProcessMap, useEventLogData } from '@/hooks/useProcessMining';
import { isWebGLAvailable } from '@/utils/webgl';

/* ── Process City (3D CodeCity for processes) ─────────────────────────────
 *
 * Thin route wrapper around <ProcessCityCanvas>, which is also embedded as the
 * default "City" tab on the process view. Fly through your process as a skyline:
 * each activity is a tower (tall = slow/high-volume, colour = health) connected
 * by glowing streets with case traffic.
 */

export default function ProcessCityPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);
  const { discovery, loading, error } = useProcessMap(eventLogId, 'dfg');

  if (loading) return <LoadingSpinner size="lg" text="Constructing the city…" fullPage />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const empty = !discovery || discovery.nodes.length === 0;
  const webgl = isWebGLAvailable();

  return (
    <div>
      <PageHeader
        title="Process City"
        icon={Building2}
        backTo={eventLogId ? `/process/${eventLogId}` : -1}
        description="Your process as a 3D city. Each tower is an activity — taller means slower (or higher-volume), colour is health, and the streets glow with case traffic. Drag to orbit, scroll to zoom."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      <div className="mt-6">
        {empty ? (
          <div className="h-[640px] overflow-hidden rounded-xl border border-line bg-[#0a0c10]">
            <EmptyState icon={Building2} title="No process to build" description="Discover a process map first to raise the city." />
          </div>
        ) : !webgl ? (
          <div className="flex h-[640px] flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface-2 text-center">
            <Building2 size={28} className="text-fg-faint" />
            <p className="max-w-sm text-[13px] text-fg-muted">
              Process City needs WebGL, which isn’t available in this browser or
              environment.{' '}
              {eventLogId && (
                <Link to={`/process/${eventLogId}?tab=map`} className="text-accent hover:underline">
                  Open the flow map instead.
                </Link>
              )}
            </p>
          </div>
        ) : (
          <ProcessCityCanvas nodes={discovery.nodes} edges={discovery.edges} />
        )}
      </div>
    </div>
  );
}
