import { useEffect, useState } from 'react';
import { ArrowRightLeft, Clock, Table2 } from 'lucide-react';
import { ocel } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCached, setCached } from '@/store/analysisCache';
import type {
  ObjectInteractionsResponse,
  ObjectLifecycleResponse,
  ActivityObjectTypesResponse,
} from '@/types';
import ObjectInteractionsPanel from './ObjectInteractionsPanel';
import ObjectLifecyclePanel from './ObjectLifecyclePanel';
import ActivityObjectTypesPanel from './ActivityObjectTypesPanel';

// ─── Analysis Section ─────────────────────────────────────────────────────────

export default function AnalysisSection({
  ocelId,
  objectTypes,
}: {
  ocelId: string;
  objectTypes: string[];
}) {
  const cachedInt = getCached<ObjectInteractionsResponse>(ocelId, 'ocel_interactions');
  const cachedLc = getCached<ObjectLifecycleResponse>(ocelId, 'ocel_lifecycle');
  const cachedAct = getCached<ActivityObjectTypesResponse>(ocelId, 'ocel_activity_types');
  const allCached = !!(cachedInt && cachedLc && cachedAct);

  const [interactions, setInteractions] = useState<ObjectInteractionsResponse | null>(cachedInt);
  const [lifecycle, setLifecycle] = useState<ObjectLifecycleResponse | null>(cachedLc);
  const [activityTypes, setActivityTypes] = useState<ActivityObjectTypesResponse | null>(cachedAct);
  const [loading, setLoading] = useState(!allCached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ci = getCached<ObjectInteractionsResponse>(ocelId, 'ocel_interactions');
    const cl = getCached<ObjectLifecycleResponse>(ocelId, 'ocel_lifecycle');
    const ca = getCached<ActivityObjectTypesResponse>(ocelId, 'ocel_activity_types');
    if (ci && cl && ca) {
      setInteractions(ci); setLifecycle(cl); setActivityTypes(ca);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.allSettled([
      ocel.getObjectInteractions(ocelId),
      ocel.getObjectLifecycle(ocelId),
      ocel.getActivityObjectTypes(ocelId),
    ]).then(([intRes, lcRes, actRes]) => {
      if (intRes.status === 'fulfilled') { setCached(ocelId, 'ocel_interactions', intRes.value); setInteractions(intRes.value); }
      if (lcRes.status === 'fulfilled') { setCached(ocelId, 'ocel_lifecycle', lcRes.value); setLifecycle(lcRes.value); }
      if (actRes.status === 'fulfilled') { setCached(ocelId, 'ocel_activity_types', actRes.value); setActivityTypes(actRes.value); }
      const anyFailed = [intRes, lcRes, actRes].some((r) => r.status === 'rejected');
      if (anyFailed && !interactions && !lifecycle && !activityTypes) {
        setError('Some analysis endpoints failed. Results may be partial.');
      }
      setLoading(false);
    });
  }, [ocelId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <LoadingSpinner size="md" text="Computing OCEL analysis…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          {error}
        </div>
      )}

      {/* Object Interactions */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="rounded-md bg-accent/10 p-1.5">
            <ArrowRightLeft size={13} className="text-accent" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Object Interactions</h3>
            <p className="text-[10px] text-fg-muted">
              Co-occurrence frequency between object type pairs across events
            </p>
          </div>
        </div>
        {interactions ? (
          <ObjectInteractionsPanel data={interactions} objectTypes={objectTypes} />
        ) : (
          <p className="text-[12px] text-fg-muted">Not available.</p>
        )}
      </div>

      {/* Object Lifecycle */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="rounded-md bg-accent/10 p-1.5">
            <Clock size={13} className="text-accent" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Object Lifecycle</h3>
            <p className="text-[10px] text-fg-muted">
              Per-type object counts, average lifecycle duration, and associated activities
            </p>
          </div>
        </div>
        {lifecycle ? (
          <ObjectLifecyclePanel data={lifecycle} objectTypes={objectTypes} />
        ) : (
          <p className="text-[12px] text-fg-muted">Not available.</p>
        )}
      </div>

      {/* Activity × Object Type */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="rounded-md bg-accent/10 p-1.5">
            <Table2 size={13} className="text-accent" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Activity × Object Type</h3>
            <p className="text-[10px] text-fg-muted">
              Average number of objects of each type involved per activity execution
            </p>
          </div>
        </div>
        {activityTypes ? (
          <ActivityObjectTypesPanel data={activityTypes} objectTypes={objectTypes} />
        ) : (
          <p className="text-[12px] text-fg-muted">Not available.</p>
        )}
      </div>
    </div>
  );
}
