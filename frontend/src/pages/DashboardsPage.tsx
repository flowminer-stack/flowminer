import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  LayoutDashboard,
  Calendar,
  Share2,
  Trash2,
} from 'lucide-react';
import { format } from 'date-fns';
import { dashboards as dashboardsApi } from '@/api/client';
import type { Dashboard } from '@/types';
import Modal from '@/components/common/Modal';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore, useProjectsStore } from '@/store';
import { confirmDialog } from '@/components/common/ConfirmDialog';

export default function DashboardsPage() {
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);
  const { projects, fetchProjects } = useProjectsStore();

  const [dashboardList, setDashboardList] = useState<Dashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadDashboards();
    fetchProjects();
  }, [fetchProjects]);

  const loadDashboards = async () => {
    setLoading(true);
    try {
      const list = await dashboardsApi.list();
      setDashboardList(list);
    } catch {
      addNotification({ type: 'error', title: 'Failed to load dashboards' });
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newProjectId) return;

    setCreating(true);
    try {
      const dashboard = await dashboardsApi.create({
        project_id: newProjectId,
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      });
      setCreateModalOpen(false);
      setNewName('');
      setNewDescription('');
      setNewProjectId('');
      addNotification({
        type: 'success',
        title: 'Dashboard created',
      });
      navigate(`/dashboards/${dashboard.id}`);
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to create dashboard',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: `Delete dashboard "${name}"?`,
      message: 'All widgets and shared links for this dashboard will be permanently removed.',
      confirmLabel: 'Delete dashboard',
      danger: true,
    });
    if (!ok) return;
    try {
      await dashboardsApi.delete(id);
      setDashboardList((prev) => prev.filter((d) => d.id !== id));
      addNotification({ type: 'success', title: 'Dashboard deleted' });
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to delete dashboard',
      });
    }
  };

  if (loading) {
    return <LoadingSpinner size="lg" text="Loading dashboards..." fullPage />;
  }

  return (
    <div>
      <PageHeader
        title="Dashboards"
        icon={LayoutDashboard}
        description="Custom dashboards for monitoring your processes"
        actions={
          <button
            onClick={() => setCreateModalOpen(true)}
            className="btn-primary"
          >
            <Plus size={18} />
            New Dashboard
          </button>
        }
      />

      {dashboardList.length === 0 ? (
        <div className="mt-16 flex flex-col items-center">
          <div className="rounded-full bg-tint p-4">
            <LayoutDashboard size={32} className="text-fg-faint" />
          </div>
          <h3 className="mt-4 text-[13px] font-semibold text-fg">
            No dashboards yet
          </h3>
          <p className="mt-1 text-[12px] text-fg-muted">
            Create your first dashboard to visualize process metrics.
          </p>
          <button
            onClick={() => setCreateModalOpen(true)}
            className="btn-primary mt-6"
          >
            <Plus size={18} />
            Create Dashboard
          </button>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dashboardList.map((dashboard) => (
            <div
              key={dashboard.id}
              className="group card cursor-pointer p-5 transition-all hover:border-line-strong hover:bg-surface-3"
              onClick={() => navigate(`/dashboards/${dashboard.id}`)}
            >
              <div className="flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10">
                  <LayoutDashboard size={20} className="text-accent" />
                </div>
                <div
                  className="flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {dashboard.is_shared && (
                    <div className="rounded-md p-1 text-accent">
                      <Share2 size={14} />
                    </div>
                  )}
                  <button
                    onClick={() =>
                      handleDelete(dashboard.id, dashboard.name)
                    }
                    className="rounded-md p-1 text-fg-faint transition-colors hover:bg-tint hover:text-danger"
                    aria-label="Delete dashboard"
                    title="Delete dashboard"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <h3 className="mt-3 text-[13px] font-semibold text-fg">
                {dashboard.name}
              </h3>
              {dashboard.description && (
                <p className="mt-1 line-clamp-2 text-[12px] text-fg-muted">
                  {dashboard.description}
                </p>
              )}

              <div className="mt-4 flex items-center gap-4 text-[11px] text-fg-faint">
                <div className="flex items-center gap-1">
                  <LayoutDashboard size={12} />
                  <span>{dashboard.widgets.length} widgets</span>
                </div>
                <div className="flex items-center gap-1">
                  <Calendar size={12} />
                  <span>
                    {format(new Date(dashboard.updated_at), 'MMM d, yyyy')}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create New Dashboard"
        footer={
          <>
            <button
              onClick={() => setCreateModalOpen(false)}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim() || !newProjectId}
              className="btn-primary"
            >
              {creating ? 'Creating...' : 'Create Dashboard'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Dashboard name
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., Process Overview"
              className="input mt-1.5"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Project
            </label>
            <select
              value={newProjectId}
              onChange={(e) => setNewProjectId(e.target.value)}
              className="select mt-1.5"
            >
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Description{' '}
              <span className="font-normal text-fg-faint">(optional)</span>
            </label>
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Brief description..."
              rows={2}
              className="input mt-1.5 resize-none"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
