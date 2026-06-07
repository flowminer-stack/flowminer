import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Download, RefreshCw, Search } from 'lucide-react';
import { format } from 'date-fns';
import api from '@/api/client';
import { useAuthStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';

interface AuditEntry {
  id: string;
  user_id: string | null;
  user_email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  method: string;
  path: string;
  status_code: number | null;
  resource_type: string | null;
  resource_id: string | null;
  action: string | null;
  payload_snapshot: any;
  created_at: string | null;
}

interface AuditSummary {
  total: number;
  by_action: { action: string; count: number }[];
  by_resource: { resource_type: string; count: number }[];
  top_users: { user_email: string; count: number }[];
}

const RESOURCE_OPTIONS = [
  '', 'project', 'event_log', 'dashboard', 'alert', 'connector', 'template',
  'annotation', 'ocel', 'custom_kpi', 'case_tag', 'scheduled_report',
  'initiative', 'action_rule', 'etl_pipeline', 'privacy_config', 'version_history', 'user',
];

const ACTION_OPTIONS = ['', 'create', 'update', 'delete'];

export default function AuditLogPage() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);

  // Admin guard — redirect non-admins immediately (defense-in-depth; the
  // backend also enforces admin on these endpoints). Mirrors UsageAdminPage /
  // UserManagementPage so all three /admin pages behave consistently.
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') navigate('/projects');
  }, [currentUser, navigate]);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    resource_type: '',
    action: '',
    user_email: '',
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params: any = { limit: 200 };
      if (filters.resource_type) params.resource_type = filters.resource_type;
      if (filters.action) params.action = filters.action;

      const [list, sum] = await Promise.all([
        api.get<AuditEntry[]>('/audit-logs', { params }).then((r) => r.data),
        api.get<AuditSummary>('/audit-logs/summary').then((r) => r.data),
      ]);

      setEntries(list);
      setSummary(sum);
    } catch (e: any) {
      setError(e?.response?.status === 403 ? 'Admin access required' : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [filters.resource_type, filters.action]); // eslint-disable-line

  const filtered = useMemo(() => {
    if (!filters.user_email) return entries;
    const needle = filters.user_email.toLowerCase();
    return entries.filter((e) => (e.user_email || '').toLowerCase().includes(needle));
  }, [entries, filters.user_email]);

  const downloadCsv = () => {
    const headers = ['created_at', 'user_email', 'ip_address', 'method', 'path', 'status_code', 'resource_type', 'resource_id', 'action'];
    const rows = filtered.map((e) => [
      e.created_at, e.user_email, e.ip_address, e.method, e.path, e.status_code,
      e.resource_type, e.resource_id, e.action,
    ].map((v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`)).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-log-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="btn-ghost p-2">←</button>
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-accent" />
            <div>
              <h1 className="text-lg font-semibold text-fg">Audit Log</h1>
              <p className="text-[11px] text-fg-faint">Every mutating API call, with who / what / when</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn-ghost flex items-center gap-1.5" aria-label="Refresh">
            <RefreshCw size={14} />
            Refresh
          </button>
          <button onClick={downloadCsv} className="btn-ghost flex items-center gap-1.5" aria-label="Download CSV">
            <Download size={14} />
            CSV
          </button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Total events" value={summary.total} />
          <StatCard label="Actions" value={summary.by_action.length} />
          <StatCard label="Resource types" value={summary.by_resource.length} />
          <StatCard label="Active users" value={summary.top_users.length} />
        </div>
      )}

      <div className="rounded-lg border border-line bg-surface-1 p-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-fg-muted">Resource type</label>
            <select
              className="input w-full text-[11px]"
              value={filters.resource_type}
              onChange={(e) => setFilters({ ...filters, resource_type: e.target.value })}
            >
              {RESOURCE_OPTIONS.map((r) => (
                <option key={r || 'all'} value={r}>{r || 'All'}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-fg-muted">Action</label>
            <select
              className="input w-full text-[11px]"
              value={filters.action}
              onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            >
              {ACTION_OPTIONS.map((a) => (
                <option key={a || 'all'} value={a}>{a || 'All'}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-fg-muted">User email</label>
            <div className="relative">
              <Search size={12} className="pointer-events-none absolute left-2 top-2.5 text-fg-faint" />
              <input
                className="input w-full pl-6 text-[11px]"
                placeholder="filter@example.com"
                value={filters.user_email}
                onChange={(e) => setFilters({ ...filters, user_email: e.target.value })}
              />
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingSpinner size="md" text="Loading audit trail..." />
      ) : error ? (
        <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">{error}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface-1">
          <table className="w-full text-[11px]">
            <thead className="bg-tint/40 text-fg-faint">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">IP</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">Resource</th>
                <th className="px-3 py-2 text-left">Path</th>
                <th className="px-3 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-fg-faint">No entries match the current filter</td>
                </tr>
              ) : (
                filtered.map((e) => (
                  <tr key={e.id} className="border-t border-line text-fg">
                    <td className="px-3 py-1.5 text-fg-muted tabular-nums">
                      {e.created_at ? format(new Date(e.created_at), 'MMM d HH:mm:ss') : '--'}
                    </td>
                    <td className="px-3 py-1.5">{e.user_email || <span className="text-fg-faint">anonymous</span>}</td>
                    <td className="px-3 py-1.5 text-fg-faint tabular-nums">{e.ip_address || '--'}</td>
                    <td className="px-3 py-1.5">
                      <span className={`badge ${e.action === 'delete' ? 'badge-rose' : e.action === 'create' ? 'badge-emerald' : 'badge-slate'}`}>
                        {e.action || e.method}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-fg-muted">
                      {e.resource_type || '--'}
                      {e.resource_id && <span className="ml-1 text-fg-faint">{e.resource_id.slice(0, 8)}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-fg-faint">{e.path}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{e.status_code ?? '--'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p className="border-t border-line px-3 py-1.5 text-[10px] text-fg-faint">
            {filtered.length} of {entries.length} entries shown
          </p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-lg border border-line bg-surface-1 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">{label}</p>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{value}</p>
    </div>
  );
}
