import { useEffect, useState } from 'react';
import { mining as miningApi } from '@/api/client';
import type { OrgRolesResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { Users } from 'lucide-react';
import { getCached, setCached } from '@/store/analysisCache';

interface Props { eventLogId: string; }

export default function OrgRoles({ eventLogId }: Props) {
  const cached = getCached<OrgRolesResponse>(eventLogId, 'org_roles');
  const [data, setData] = useState<OrgRolesResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<OrgRolesResponse>(eventLogId, 'org_roles');
    if (existing) {
      setData(existing);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    miningApi.getOrgRoles(eventLogId)
      .then((d) => {
        setCached(eventLogId, 'org_roles', d);
        setData(d);
      })
      .catch((e) => {
        const msg = e?.response?.data?.detail;
        if (typeof msg === 'string' && msg.toLowerCase().includes('resource')) {
          setError('resource');
        } else {
          setError('Failed to load org roles');
        }
      })
      .finally(() => setLoading(false));
  }, [eventLogId]);

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;

  if (error === 'resource') {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <Users size={28} className="mb-2 text-fg-ghost" />
        <p className="text-[12px] font-medium text-fg-muted">Resource data required</p>
        <p className="mt-1 text-[11px] text-fg-faint">Org role mining requires a resource column in your event log.</p>
      </div>
    );
  }

  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data || data.roles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <Users size={28} className="mb-2 text-fg-ghost" />
        <p className="text-[12px] font-medium text-fg-muted">No roles detected</p>
        <p className="mt-1 text-[11px] text-fg-faint">Could not identify distinct organizational roles.</p>
      </div>
    );
  }

  const roleColors = [
    'border-accent/30 bg-accent/5',
    'border-accent/30 bg-accent/5',
    'border-success/30 bg-success/5',
    'border-warning/30 bg-warning/5',
    'border-danger/30 bg-danger/5',
    'border-accent/30 bg-accent/5',
  ];

  return (
    <div>
      <p className="mb-3 text-[11px] text-fg-muted">Automatically discovered organizational roles based on which activities each resource performs.</p>
      <p className="mb-3 text-[11px] text-fg-faint">{data.roles.length} organizational role{data.roles.length !== 1 ? 's' : ''} identified by activity clustering.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.roles.map((role, i) => (
          <div key={i} className={`rounded-lg border p-3 ${roleColors[i % roleColors.length]}`}>
            <p className="mb-2 text-[11px] font-semibold text-fg">Role {i + 1}</p>
            <div className="space-y-2">
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-fg-faint">Activities ({role.activities.length})</p>
                <div className="flex flex-wrap gap-1">
                  {role.activities.map((a) => (
                    <span key={a} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-secondary">{a}</span>
                  ))}
                </div>
              </div>
              {role.resources.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-fg-faint">Resources ({role.resources.length})</p>
                  <div className="flex flex-wrap gap-1">
                    {role.resources.slice(0, 8).map((r) => (
                      <span key={r} className="rounded bg-tint px-1.5 py-0.5 text-[10px] text-fg-muted">{r}</span>
                    ))}
                    {role.resources.length > 8 && (
                      <span className="text-[10px] text-fg-faint">+{role.resources.length - 8} more</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
