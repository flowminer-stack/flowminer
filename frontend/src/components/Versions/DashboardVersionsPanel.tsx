import { useEffect, useState, useCallback } from 'react';
import { History, Save, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { versions } from '@/api/versions';
import type { VersionRecord } from '@/types/version';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import Modal from '@/components/common/Modal';
import { useUIStore } from '@/store';

// ─── Props ────────────────────────────────────────────────────────────────────

interface DashboardVersionsPanelProps {
  /** UUID of the dashboard whose versions are managed. */
  dashboardId: string;
  /**
   * Current dashboard state snapshot — passed to POST /snapshot when the
   * user manually saves a version. The caller (DashboardViewPage) already
   * holds this object; passing it as a prop avoids an extra fetch.
   */
  currentSnapshot: Record<string, unknown>;
  /** Called after a successful restore so the page can reload the dashboard. */
  onRestored?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function VersionRow({
  version,
  onRestore,
  restoring,
}: {
  version: VersionRecord;
  onRestore: (v: VersionRecord) => void;
  restoring: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-line bg-surface-1">
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
          <History size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold text-fg">
            {version.version_number}
            {version.change_summary && (
              <span className="ml-1.5 font-normal text-fg-muted">— {version.change_summary}</span>
            )}
          </p>
          <p className="text-[10px] text-fg-faint">{formatDate(version.created_at)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => onRestore(version)}
            disabled={restoring}
            title="Restore to this version"
            className="flex items-center gap-1 rounded-md border border-line bg-surface-0 px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <RotateCcw size={10} />
            Restore
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
            aria-label={expanded ? 'Collapse snapshot' : 'Expand snapshot'}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {/* Expandable snapshot preview */}
      {expanded && (
        <div className="border-t border-line/60 bg-surface-0 px-3 py-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
            Snapshot keys
          </p>
          <div className="flex flex-wrap gap-1">
            {Object.keys(version.snapshot).map((k) => (
              <span
                key={k}
                className="rounded-md bg-tint px-1.5 py-0.5 text-[10px] text-fg-muted"
              >
                {k}
              </span>
            ))}
            {Object.keys(version.snapshot).length === 0 && (
              <span className="text-[10px] text-fg-faint">Empty snapshot</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function DashboardVersionsPanel({
  dashboardId,
  currentSnapshot,
  onRestored,
}: DashboardVersionsPanelProps) {
  const addNotification = useUIStore((s) => s.addNotification);

  const [versionList, setVersionList] = useState<VersionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Save-version flow
  const [saving, setSaving] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveSummary, setSaveSummary] = useState('');

  // Restore flow
  const [restoring, setRestoring] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<VersionRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await versions.list('dashboard', dashboardId);
      setVersionList(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load versions';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Save snapshot ────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      const record = await versions.snapshot(
        'dashboard',
        dashboardId,
        currentSnapshot,
        saveSummary.trim() || undefined,
      );
      setVersionList((prev) => [record, ...prev]);
      setShowSaveModal(false);
      setSaveSummary('');
      addNotification({
        type: 'success',
        title: 'Version saved',
        message: `Snapshot ${record.version_number} created.`,
      });
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Failed to save version',
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  // ── Restore ──────────────────────────────────────────────────────────────

  const handleConfirmRestore = async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    try {
      await versions.restore(pendingRestore.id);
      setPendingRestore(null);
      addNotification({
        type: 'success',
        title: 'Dashboard restored',
        message: `Restored to ${pendingRestore.version_number}.`,
      });
      onRestored?.();
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Restore failed',
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRestoring(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Panel header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History size={15} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-fg">Version history</h3>
          {!loading && versionList.length > 0 && (
            <span className="rounded-full bg-tint px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
              {versionList.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowSaveModal(true)}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-0 px-2.5 py-1.5 text-[11px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Save size={12} />
          Save version
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <LoadingSpinner size="sm" text="Loading versions…" className="py-6" />
      ) : error ? (
        <ErrorState compact message={error} onRetry={load} />
      ) : versionList.length === 0 ? (
        <EmptyState
          icon={History}
          title="No versions yet"
          description="Save a version snapshot to preserve the current dashboard state."
          compact
        />
      ) : (
        <div className="space-y-2">
          {versionList.map((v) => (
            <VersionRow
              key={v.id}
              version={v}
              onRestore={(ver) => setPendingRestore(ver)}
              restoring={restoring}
            />
          ))}
        </div>
      )}

      {/* Save version modal */}
      <Modal
        isOpen={showSaveModal}
        onClose={() => {
          setShowSaveModal(false);
          setSaveSummary('');
        }}
        title="Save version"
        size="sm"
        footer={
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowSaveModal(false);
                setSaveSummary('');
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving} className="btn-primary">
              {saving ? <LoadingSpinner size="sm" /> : <Save size={13} />}
              Save snapshot
            </button>
          </div>
        }
      >
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-fg-muted">
            Change summary{' '}
            <span className="font-normal text-fg-faint">(optional)</span>
          </label>
          <input
            type="text"
            value={saveSummary}
            onChange={(e) => setSaveSummary(e.target.value)}
            placeholder="e.g. Added Q2 KPI widgets"
            className="input w-full"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
          <p className="mt-2 text-[11px] text-fg-faint">
            A snapshot of the current dashboard configuration will be saved.
          </p>
        </div>
      </Modal>

      {/* Restore confirmation modal */}
      <Modal
        isOpen={!!pendingRestore}
        onClose={() => setPendingRestore(null)}
        title="Restore version?"
        size="sm"
        footer={
          <div className="flex items-center gap-2">
            <button onClick={() => setPendingRestore(null)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleConfirmRestore}
              disabled={restoring}
              className="btn-primary"
            >
              {restoring ? <LoadingSpinner size="sm" /> : <RotateCcw size={13} />}
              Restore
            </button>
          </div>
        }
      >
        {pendingRestore && (
          <p className="text-[13px] text-fg-muted">
            This will restore the dashboard to{' '}
            <span className="font-semibold text-fg">{pendingRestore.version_number}</span>
            {pendingRestore.change_summary && (
              <> ({pendingRestore.change_summary})</>
            )}{' '}
            from {formatDate(pendingRestore.created_at)}. This action cannot be undone unless you
            save another snapshot first.
          </p>
        )}
      </Modal>
    </div>
  );
}
