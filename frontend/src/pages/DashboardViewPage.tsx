import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Share2,
  Settings,
  Plus,
  LayoutDashboard,
  Hash,
  LineChart,
  BarChart3,
  Activity,
  PieChart,
  GitBranch,
  Table2,
  Gauge,
  Save,
} from 'lucide-react';
import { useDashboard } from '@/hooks/useProcessMining';
import { useDashboardCollab } from '@/hooks/useDashboardCollab';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import EventLogPicker from '@/components/common/EventLogPicker';
import WidgetGrid from '@/components/Dashboard/WidgetGrid';
import { useUIStore, useEventLogsStore } from '@/store';
import type { WidgetConfig } from '@/types';

const widgetTypes = [
  { type: 'kpi', label: 'KPI Card', icon: Hash, description: 'Key metric (total cases, duration, etc.)' },
  { type: 'line_chart', label: 'Line Chart', icon: LineChart, description: 'Events over time' },
  { type: 'bar_chart', label: 'Bar Chart', icon: BarChart3, description: 'Top activity frequencies' },
  { type: 'area_chart', label: 'Area Chart', icon: Activity, description: 'Filled activity distribution' },
  { type: 'pie_chart', label: 'Pie Chart', icon: PieChart, description: 'Activity proportions' },
  { type: 'variant_list', label: 'Variant List', icon: GitBranch, description: 'Top process variants' },
  { type: 'bottleneck_table', label: 'Bottleneck Table', icon: Table2, description: 'Slowest activities' },
  { type: 'conformance_gauge', label: 'Conformance Gauge', icon: Gauge, description: 'Fitness & precision' },
];

const KPI_METRICS = [
  { value: 'total_cases', label: 'Total cases' },
  { value: 'total_events', label: 'Total events' },
  { value: 'total_activities', label: 'Total activities' },
  { value: 'avg_case_duration', label: 'Avg case duration' },
  { value: 'median_case_duration', label: 'Median case duration' },
  { value: 'avg_events_per_case', label: 'Avg events per case' },
];

export default function DashboardViewPage() {
  const { dashboardId } = useParams<{ dashboardId: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);
  const { dashboard, loading, error, updateDashboard } = useDashboard(dashboardId);

  const allEventLogs = useEventLogsStore((s) => s.eventLogs);
  const fetchEventLogs = useEventLogsStore((s) => s.fetchEventLogs);
  // Dashboard widgets call standard /mining/* endpoints which require a
  // case/activity/timestamp mapping. OCEL logs don't have one directly, but
  // EventLogPicker handles them by flattening on demand — so both kinds of
  // logs are pickable and the widget just sees a standard event_log_id.
  const eventLogs = allEventLogs;

  const [editMode, setEditMode] = useState(false);
  const [showAddWidgetModal, setShowAddWidgetModal] = useState(false);
  const [newWidgetTitle, setNewWidgetTitle] = useState('');
  const [newWidgetType, setNewWidgetType] = useState('kpi');
  const [newWidgetEventLog, setNewWidgetEventLog] = useState('');
  const [newWidgetMetric, setNewWidgetMetric] = useState('total_cases');
  const [newWidgetTarget, setNewWidgetTarget] = useState<string>('');
  const [newWidgetBestInClass, setNewWidgetBestInClass] = useState<string>('');
  const [settingsWidget, setSettingsWidget] = useState<WidgetConfig | null>(null);

  // Load the project's event logs so widgets can be bound to a source.
  useEffect(() => {
    if (dashboard?.project_id) {
      fetchEventLogs(dashboard.project_id);
    }
  }, [dashboard?.project_id, fetchEventLogs]);

  // Realtime collab — presence + widget-edit broadcast. Peers see an avatar
  // strip of everyone currently viewing this dashboard; when someone edits
  // a widget the change is broadcast to every open session.
  const { viewers, connected, broadcast } = useDashboardCollab(dashboardId);

  if (loading) {
    return <LoadingSpinner size="lg" text="Loading dashboard..." fullPage />;
  }

  if (error || !dashboard) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-fg-muted">Dashboard not found.</p>
        <button
          onClick={() => navigate('/dashboards')}
          className="btn-primary mt-4"
        >
          Go to Dashboards
        </button>
      </div>
    );
  }

  const handleShare = () => {
    if (dashboard.share_token) {
      navigator.clipboard.writeText(
        `${window.location.origin}/dashboards/shared/${dashboard.share_token}`,
      );
      addNotification({
        type: 'success',
        title: 'Share link copied',
        message: 'The share link has been copied to your clipboard.',
      });
    } else {
      addNotification({
        type: 'info',
        title: 'Sharing not enabled',
        message: 'Enable sharing in dashboard settings first.',
      });
    }
  };

  const handleConfigure = () => {
    setEditMode(!editMode);
    if (editMode) {
      addNotification({
        type: 'info',
        title: 'Edit mode disabled',
        message: 'Dashboard is now in view mode.',
      });
    } else {
      addNotification({
        type: 'info',
        title: 'Edit mode enabled',
        message: 'You can now configure and manage widgets.',
      });
    }
  };

  const resetAddWidgetForm = () => {
    setNewWidgetTitle('');
    setNewWidgetType('kpi');
    setNewWidgetEventLog('');
    setNewWidgetMetric('total_cases');
    setNewWidgetTarget('');
    setNewWidgetBestInClass('');
  };

  // 2D bin-packer: place a new widget on the highest row where it doesn't
  // horizontally overlap any existing widget. This fills rows left-to-right
  // instead of stacking every widget at x=0.
  const findSlot = (
    existing: WidgetConfig[],
    w: number,
    h: number,
  ): { x: number; y: number } => {
    const overlaps = (x: number, y: number) =>
      existing.some((e) => {
        const exEnd = e.position.x + e.position.w;
        const eyEnd = e.position.y + e.position.h;
        return x < exEnd && x + w > e.position.x && y < eyEnd && y + h > e.position.y;
      });
    const maxY = existing.reduce(
      (m, e) => Math.max(m, e.position.y + e.position.h),
      0,
    );
    for (let y = 0; y <= maxY; y++) {
      for (let x = 0; x + w <= 12; x++) {
        if (!overlaps(x, y)) return { x, y };
      }
    }
    return { x: 0, y: maxY };
  };

  // Compact widgets vertically so there are no empty rows. Preserves each
  // widget's horizontal placement; just lifts each one up as far as possible.
  const repack = (items: WidgetConfig[]): WidgetConfig[] => {
    const sorted = [...items].sort(
      (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
    );
    const packed: WidgetConfig[] = [];
    for (const item of sorted) {
      let newY = 0;
      for (const p of packed) {
        const pxEnd = p.position.x + p.position.w;
        const wxEnd = item.position.x + item.position.w;
        if (p.position.x < wxEnd && pxEnd > item.position.x) {
          const pBottom = p.position.y + p.position.h;
          if (pBottom > newY) newY = pBottom;
        }
      }
      packed.push({
        ...item,
        position: { ...item.position, y: newY },
      });
    }
    return packed;
  };

  const handleAddWidget = async () => {
    if (!newWidgetTitle.trim()) {
      addNotification({
        type: 'error',
        title: 'Validation error',
        message: 'Widget title is required.',
      });
      return;
    }
    if (!newWidgetEventLog) {
      addNotification({
        type: 'error',
        title: 'Select an event log',
        message: 'Widgets need an event log to pull data from.',
      });
      return;
    }

    const existingWidgets = dashboard.widgets || [];
    const w = newWidgetType === 'kpi' ? 3 : 6;
    const h = newWidgetType === 'kpi' ? 2 : 3;
    const slot = findSlot(existingWidgets, w, h);

    const config: Record<string, unknown> = { eventLogId: newWidgetEventLog };
    if (newWidgetType === 'kpi') {
      config.metric = newWidgetMetric;
      const t = parseFloat(newWidgetTarget);
      if (!Number.isNaN(t) && newWidgetTarget.trim() !== '') config.target = t;
      const b = parseFloat(newWidgetBestInClass);
      if (!Number.isNaN(b) && newWidgetBestInClass.trim() !== '') config.bestInClass = b;
    }

    const newWidget: WidgetConfig = {
      id: `widget-${Date.now()}`,
      type: newWidgetType,
      title: newWidgetTitle.trim(),
      config,
      position: { x: slot.x, y: slot.y, w, h },
    };

    try {
      await updateDashboard({
        widgets: [...existingWidgets, newWidget],
      });
      broadcast({ type: 'widget_added', widget: newWidget });
      setShowAddWidgetModal(false);
      resetAddWidgetForm();
      addNotification({
        type: 'success',
        title: 'Widget added',
        message: `"${newWidget.title}" has been added to the dashboard.`,
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to add widget',
      });
    }
  };

  const handleDeleteWidget = async (widgetId: string) => {
    const updatedWidgets = repack(
      dashboard.widgets.filter((w) => w.id !== widgetId),
    );
    try {
      await updateDashboard({ widgets: updatedWidgets });
      broadcast({ type: 'widget_removed', widget_id: widgetId });
      addNotification({
        type: 'success',
        title: 'Widget removed',
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to remove widget',
      });
    }
  };

  const handleWidgetUpdate = (widget: WidgetConfig) => {
    setSettingsWidget(widget);
  };

  // Drag-and-drop reorder: the WidgetGrid builds a new widget list
  // with swapped positions and we persist via the dashboard update
  // endpoint so the new layout sticks across reloads. Same broadcast
  // channel as settings edits, so other viewers sync automatically.
  const handleWidgetsReorder = async (newWidgets: WidgetConfig[]) => {
    try {
      await updateDashboard({ widgets: newWidgets });
      broadcast({ type: 'widgets_reordered', widgets: newWidgets });
    } catch {
      addNotification({ type: 'error', title: 'Failed to reorder widgets' });
    }
  };

  const saveWidgetSettings = async () => {
    if (!settingsWidget) return;
    const updatedWidgets = dashboard.widgets.map((w) =>
      w.id === settingsWidget.id ? settingsWidget : w,
    );
    try {
      await updateDashboard({ widgets: updatedWidgets });
      broadcast({ type: 'widget_updated', widget: settingsWidget });
      setSettingsWidget(null);
      addNotification({ type: 'success', title: 'Widget updated' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to save widget' });
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/dashboards')}
            className="btn-ghost p-2"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-fg">
              {dashboard.name}
            </h1>
            {dashboard.description && (
              <p className="text-[12px] text-fg-muted">
                {dashboard.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Presence avatars — one badge per concurrent viewer */}
          {connected && viewers.length > 1 && (
            <div className="flex -space-x-1.5" title={`${viewers.length} viewers`}>
              {viewers.slice(0, 5).map((email, i) => {
                const initials = (email || '?')
                  .split('@')[0]
                  .split(/[._-]/)
                  .map((p) => p[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase();
                return (
                  <span
                    key={`${email}-${i}`}
                    className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface-1 bg-accent/20 text-[9px] font-bold text-accent"
                    title={email}
                  >
                    {initials}
                  </span>
                );
              })}
              {viewers.length > 5 && (
                <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface-1 bg-tint text-[9px] font-medium text-fg-muted">
                  +{viewers.length - 5}
                </span>
              )}
            </div>
          )}
          <button onClick={handleShare} className="btn-secondary">
            <Share2 size={16} />
            Share
          </button>
          <button
            onClick={handleConfigure}
            className={editMode ? 'btn-primary' : 'btn-secondary'}
          >
            <Settings size={16} />
            {editMode ? 'Done Editing' : 'Configure'}
          </button>
          <button
            className="btn-primary"
            onClick={() => setShowAddWidgetModal(true)}
          >
            <Plus size={16} />
            Add Widget
          </button>
        </div>
      </div>

      {/* Dashboard grid */}
      {dashboard.widgets.length === 0 ? (
        <div className="mt-16 flex flex-col items-center">
          <div className="rounded-full bg-tint p-4">
            <LayoutDashboard size={32} className="text-fg-faint" />
          </div>
          <h3 className="mt-4 text-[13px] font-semibold text-fg">
            Empty dashboard
          </h3>
          <p className="mt-1 text-[12px] text-fg-muted">
            Add widgets to start monitoring your process metrics.
          </p>
          <button
            className="btn-primary mt-6"
            onClick={() => setShowAddWidgetModal(true)}
          >
            <Plus size={18} />
            Add Your First Widget
          </button>
        </div>
      ) : (
        <div className="mt-6">
          <WidgetGrid
            widgets={dashboard.widgets}
            onWidgetUpdate={handleWidgetUpdate}
            onWidgetDelete={handleDeleteWidget}
            onWidgetsReorder={handleWidgetsReorder}
            editable={editMode}
          />
        </div>
      )}

      {/* Add Widget Modal */}
      <Modal
        isOpen={showAddWidgetModal}
        onClose={() => {
          setShowAddWidgetModal(false);
          resetAddWidgetForm();
        }}
        title="Add Widget"
        size="lg"
        footer={
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setShowAddWidgetModal(false);
                resetAddWidgetForm();
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleAddWidget}
              disabled={!newWidgetTitle.trim() || !newWidgetEventLog}
              className="btn-primary"
            >
              <Save size={16} />
              Add Widget
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Widget Title
            </label>
            <input
              type="text"
              value={newWidgetTitle}
              onChange={(e) => setNewWidgetTitle(e.target.value)}
              placeholder="e.g., Average Cycle Time"
              className="input w-full"
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Event log source
            </label>
            <EventLogPicker
              logs={eventLogs}
              value={newWidgetEventLog}
              onChange={(id) => setNewWidgetEventLog(id)}
              emptyHint="This project has no event logs yet. Upload one first."
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-3">
              Widget Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {widgetTypes.map((wt) => {
                const Icon = wt.icon;
                return (
                  <button
                    key={wt.type}
                    onClick={() => setNewWidgetType(wt.type)}
                    className={`flex items-start gap-3 p-3 rounded-xl border transition-all text-left ${
                      newWidgetType === wt.type
                        ? 'bg-accent/10 border-accent/30 text-accent'
                        : 'bg-surface-1 border-line text-fg-muted hover:border-line-strong'
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        newWidgetType === wt.type ? 'bg-accent/10' : 'bg-tint'
                      }`}
                    >
                      <Icon size={18} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium">{wt.label}</p>
                      <p className="text-[11px] text-fg-faint mt-0.5">{wt.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {newWidgetType === 'kpi' && (
            <>
              <div>
                <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                  KPI metric
                </label>
                <select
                  value={newWidgetMetric}
                  onChange={(e) => setNewWidgetMetric(e.target.value)}
                  className="input w-full"
                >
                  {KPI_METRICS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                    Target{' '}
                    <span className="font-normal text-fg-faint">(optional)</span>
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={newWidgetTarget}
                    onChange={(e) => setNewWidgetTarget(e.target.value)}
                    placeholder="e.g. 100"
                    className="input w-full"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                    Best in class{' '}
                    <span className="font-normal text-fg-faint">(optional)</span>
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={newWidgetBestInClass}
                    onChange={(e) => setNewWidgetBestInClass(e.target.value)}
                    placeholder="e.g. 50"
                    className="input w-full"
                  />
                </div>
              </div>
              <p className="text-[11px] text-fg-faint">
                Set target and best-in-class to render a benchmark bar under the
                current value. For duration metrics, lower is better.
              </p>
            </>
          )}
        </div>
      </Modal>

      {/* Widget Settings Modal */}
      <Modal
        isOpen={!!settingsWidget}
        onClose={() => setSettingsWidget(null)}
        title="Widget settings"
        size="md"
        footer={
          <div className="flex items-center gap-3">
            <button onClick={() => setSettingsWidget(null)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={saveWidgetSettings}
              disabled={!settingsWidget?.config?.eventLogId}
              className="btn-primary"
            >
              <Save size={16} />
              Save
            </button>
          </div>
        }
      >
        {settingsWidget && (
          <div className="space-y-5">
            <div>
              <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                Title
              </label>
              <input
                type="text"
                value={settingsWidget.title}
                onChange={(e) =>
                  setSettingsWidget({ ...settingsWidget, title: e.target.value })
                }
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                Event log source
              </label>
              <EventLogPicker
                logs={eventLogs}
                value={(settingsWidget.config?.eventLogId as string) || ''}
                onChange={(id) =>
                  setSettingsWidget({
                    ...settingsWidget,
                    config: { ...settingsWidget.config, eventLogId: id },
                  })
                }
                emptyHint="This project has no event logs yet. Upload one first."
              />
            </div>
            {settingsWidget.type === 'kpi' && (
              <>
                <div>
                  <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                    KPI metric
                  </label>
                  <select
                    value={(settingsWidget.config?.metric as string) || 'total_cases'}
                    onChange={(e) =>
                      setSettingsWidget({
                        ...settingsWidget,
                        config: { ...settingsWidget.config, metric: e.target.value },
                      })
                    }
                    className="input w-full"
                  >
                    {KPI_METRICS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                      Target
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={
                        (settingsWidget.config?.target as number | undefined) ?? ''
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        const n = parseFloat(v);
                        setSettingsWidget({
                          ...settingsWidget,
                          config: {
                            ...settingsWidget.config,
                            target: v === '' || Number.isNaN(n) ? undefined : n,
                          },
                        });
                      }}
                      className="input w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                      Best in class
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={
                        (settingsWidget.config?.bestInClass as number | undefined) ?? ''
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        const n = parseFloat(v);
                        setSettingsWidget({
                          ...settingsWidget,
                          config: {
                            ...settingsWidget.config,
                            bestInClass:
                              v === '' || Number.isNaN(n) ? undefined : n,
                          },
                        });
                      }}
                      className="input w-full"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
