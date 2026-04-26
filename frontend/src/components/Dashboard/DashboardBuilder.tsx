import React, { useState, useCallback } from 'react';
import clsx from 'clsx';
import {
  Plus,
  Save,
  X,
  Hash,
  LineChart,
  BarChart3,
  PieChart,
  Activity,
  GitBranch,
  Table2,
  Gauge,
  ChevronDown,
  LayoutDashboard,
} from 'lucide-react';
import WidgetGrid from './WidgetGrid';

interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  config: Record<string, any>;
  position: { x: number; y: number; w: number; h: number };
}

interface Dashboard {
  id: string;
  name: string;
  description?: string;
  project_id: string;
  layout: any;
  widgets: WidgetConfig[];
  created_at: string;
  updated_at: string;
}

interface EventLog {
  id: string;
  name: string;
  [key: string]: any;
}

interface DashboardBuilderProps {
  dashboard: Dashboard;
  eventLogs: EventLog[];
  onSave: (dashboard: Dashboard) => void;
}

interface WidgetTypeOption {
  type: WidgetConfig['type'];
  label: string;
  description: string;
  icon: React.ReactNode;
  defaultSize: { w: number; h: number };
}

const widgetTypes: WidgetTypeOption[] = [
  {
    type: 'kpi',
    label: 'KPI Card',
    description: 'Single metric display with trend indicator',
    icon: <Hash className="w-5 h-5" />,
    defaultSize: { w: 3, h: 2 },
  },
  {
    type: 'line_chart',
    label: 'Line Chart',
    description: 'Cases over time, cycle time trends',
    icon: <LineChart className="w-5 h-5" />,
    defaultSize: { w: 6, h: 3 },
  },
  {
    type: 'bar_chart',
    label: 'Bar Chart',
    description: 'Activity frequencies, variant distribution',
    icon: <BarChart3 className="w-5 h-5" />,
    defaultSize: { w: 6, h: 3 },
  },
  {
    type: 'pie_chart',
    label: 'Pie Chart',
    description: 'Proportional data visualization',
    icon: <PieChart className="w-5 h-5" />,
    defaultSize: { w: 4, h: 3 },
  },
  {
    type: 'process_map',
    label: 'Process Map',
    description: 'Embedded mini process map',
    icon: <Activity className="w-5 h-5" />,
    defaultSize: { w: 8, h: 4 },
  },
  {
    type: 'variant_list',
    label: 'Variant List',
    description: 'Top N process variants',
    icon: <GitBranch className="w-5 h-5" />,
    defaultSize: { w: 6, h: 3 },
  },
  {
    type: 'bottleneck_table',
    label: 'Bottleneck Table',
    description: 'Performance bottlenecks',
    icon: <Table2 className="w-5 h-5" />,
    defaultSize: { w: 6, h: 3 },
  },
  {
    type: 'conformance_gauge',
    label: 'Conformance Gauge',
    description: 'Fitness and precision gauges',
    icon: <Gauge className="w-5 h-5" />,
    defaultSize: { w: 4, h: 3 },
  },
];

const sizeOptions = [
  { label: '1x1', w: 3, h: 2 },
  { label: '2x1', w: 6, h: 2 },
  { label: '2x2', w: 6, h: 3 },
  { label: '3x1', w: 9, h: 2 },
  { label: '3x2', w: 9, h: 3 },
  { label: 'Full', w: 12, h: 3 },
];

const DashboardBuilder: React.FC<DashboardBuilderProps> = ({
  dashboard,
  eventLogs,
  onSave,
}) => {
  const [widgets, setWidgets] = useState<WidgetConfig[]>(
    dashboard.widgets || []
  );
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [dashboardName, setDashboardName] = useState(dashboard.name);
  const [isEditing, setIsEditing] = useState(false);

  // New widget form state
  const [newWidgetType, setNewWidgetType] = useState<WidgetTypeOption | null>(null);
  const [newWidgetTitle, setNewWidgetTitle] = useState('');
  const [newWidgetEventLog, setNewWidgetEventLog] = useState('');
  const [newWidgetSize, setNewWidgetSize] = useState({ w: 6, h: 3 });

  const getNextPosition = useCallback((): { x: number; y: number } => {
    if (widgets.length === 0) return { x: 0, y: 0 };

    // Find the next available row
    let maxBottom = 0;
    for (const w of widgets) {
      const bottom = w.position.y + w.position.h;
      if (bottom > maxBottom) maxBottom = bottom;
    }

    // Try to fit in current rows first
    for (let y = 0; y <= maxBottom; y++) {
      for (let x = 0; x <= 12 - newWidgetSize.w; x++) {
        const fits = !widgets.some(
          (w) =>
            x < w.position.x + w.position.w &&
            x + newWidgetSize.w > w.position.x &&
            y < w.position.y + w.position.h &&
            y + newWidgetSize.h > w.position.y
        );
        if (fits) return { x, y };
      }
    }

    return { x: 0, y: maxBottom };
  }, [widgets, newWidgetSize]);

  const handleAddWidget = () => {
    if (!newWidgetType || !newWidgetTitle) return;

    const position = getNextPosition();
    const widget: WidgetConfig = {
      id: `widget-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: newWidgetType.type,
      title: newWidgetTitle,
      config: {
        eventLogId: newWidgetEventLog,
      },
      position: {
        ...position,
        w: newWidgetSize.w,
        h: newWidgetSize.h,
      },
    };

    setWidgets((prev) => [...prev, widget]);
    resetAddForm();
    setIsAddModalOpen(false);
  };

  const resetAddForm = () => {
    setNewWidgetType(null);
    setNewWidgetTitle('');
    setNewWidgetEventLog('');
    setNewWidgetSize({ w: 6, h: 3 });
  };

  const handleWidgetUpdate = (widget: WidgetConfig) => {
    setEditingWidget(widget);
    setIsConfigModalOpen(true);
  };

  const handleWidgetDelete = (widgetId: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
  };

  const handleSaveWidgetConfig = () => {
    if (!editingWidget) return;
    setWidgets((prev) =>
      prev.map((w) => (w.id === editingWidget.id ? editingWidget : w))
    );
    setEditingWidget(null);
    setIsConfigModalOpen(false);
  };

  const handleSave = () => {
    onSave({
      ...dashboard,
      name: dashboardName,
      widgets,
      layout: { version: 1, gridCols: 12 },
    });
  };

  return (
    <div className="space-y-4">
      {/* Dashboard header */}
      <div className="bg-surface-2 rounded-xl border border-line px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <LayoutDashboard className="w-5 h-5 text-accent" />
            </div>
            <div>
              {isEditing ? (
                <input
                  type="text"
                  value={dashboardName}
                  onChange={(e) => setDashboardName(e.target.value)}
                  onBlur={() => setIsEditing(false)}
                  onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
                  autoFocus
                  className="text-lg font-bold text-fg bg-transparent border-b-2 border-accent outline-none px-0 py-0"
                />
              ) : (
                <h1
                  className="text-lg font-bold text-fg cursor-pointer hover:text-accent transition-colors"
                  onClick={() => setIsEditing(true)}
                >
                  {dashboardName}
                </h1>
              )}
              <p className="text-[12px] text-fg-muted">
                {widgets.length} widget{widgets.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsAddModalOpen(true)}
              className="btn-secondary flex items-center gap-1.5 px-4 py-2 text-sm"
            >
              <Plus className="w-4 h-4" />
              Add Widget
            </button>
            <button
              onClick={handleSave}
              className="btn-primary flex items-center gap-1.5 px-4 py-2 text-sm font-semibold"
            >
              <Save className="w-4 h-4" />
              Save Dashboard
            </button>
          </div>
        </div>
      </div>

      {/* Widget grid */}
      <WidgetGrid
        widgets={widgets}
        onWidgetUpdate={handleWidgetUpdate}
        onWidgetDelete={handleWidgetDelete}
        editable={true}
      />

      {/* Add Widget Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface-1 rounded-2xl border border-line w-full max-w-2xl max-h-[80vh] overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-line">
              <h2 className="text-lg font-bold text-fg">Add Widget</h2>
              <button
                onClick={() => {
                  resetAddForm();
                  setIsAddModalOpen(false);
                }}
                className="p-1.5 rounded-lg hover:bg-tint text-fg-faint hover:text-fg-muted transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto max-h-[60vh]">
              {!newWidgetType ? (
                /* Step 1: Choose widget type */
                <div>
                  <p className="text-[12px] text-fg-muted mb-4">
                    Choose a widget type to add to your dashboard
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {widgetTypes.map((wt) => (
                      <button
                        key={wt.type}
                        onClick={() => {
                          setNewWidgetType(wt);
                          setNewWidgetTitle(wt.label);
                          setNewWidgetSize(wt.defaultSize);
                        }}
                        className="flex items-start gap-3 p-4 rounded-xl border border-line hover:border-line-strong hover:bg-tint/50 transition-all text-left group"
                      >
                        <div className="w-10 h-10 rounded-lg bg-tint group-hover:bg-accent/10 flex items-center justify-center text-fg-muted group-hover:text-accent transition-colors flex-shrink-0">
                          {wt.icon}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-fg-secondary group-hover:text-fg transition-colors">
                            {wt.label}
                          </p>
                          <p className="text-[12px] text-fg-faint mt-0.5">
                            {wt.description}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* Step 2: Configure widget */
                <div className="space-y-5">
                  <div className="flex items-center gap-3 p-3 bg-accent/10 rounded-lg border border-line">
                    <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center text-accent">
                      {newWidgetType.icon}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-fg">
                        {newWidgetType.label}
                      </p>
                      <p className="text-[12px] text-fg-muted">
                        {newWidgetType.description}
                      </p>
                    </div>
                    <button
                      onClick={() => setNewWidgetType(null)}
                      className="ml-auto text-xs text-accent hover:text-accent-hover font-medium"
                    >
                      Change
                    </button>
                  </div>

                  {/* Title */}
                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                      Widget Title
                    </label>
                    <input
                      type="text"
                      value={newWidgetTitle}
                      onChange={(e) => setNewWidgetTitle(e.target.value)}
                      className="input w-full"
                      placeholder="Enter widget title..."
                    />
                  </div>

                  {/* Event log source */}
                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                      Event Log Source
                    </label>
                    <div className="relative">
                      <select
                        value={newWidgetEventLog}
                        onChange={(e) => setNewWidgetEventLog(e.target.value)}
                        className="select w-full"
                      >
                        <option value="">Select event log...</option>
                        {eventLogs.map((log) => (
                          <option key={log.id} value={log.id}>
                            {log.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-faint pointer-events-none" />
                    </div>
                  </div>

                  {/* Size selector */}
                  <div>
                    <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                      Widget Size
                    </label>
                    <div className="flex items-center gap-2">
                      {sizeOptions.map((size) => (
                        <button
                          key={size.label}
                          onClick={() =>
                            setNewWidgetSize({ w: size.w, h: size.h })
                          }
                          className={clsx(
                            'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                            newWidgetSize.w === size.w &&
                              newWidgetSize.h === size.h
                              ? 'bg-accent/10 text-accent border-line-strong'
                              : 'bg-surface-2 text-fg-muted border-line hover:border-line-strong'
                          )}
                        >
                          {size.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            {newWidgetType && (
              <div className="px-6 py-4 border-t border-line bg-surface-1 flex items-center justify-end gap-3">
                <button
                  onClick={() => {
                    resetAddForm();
                    setIsAddModalOpen(false);
                  }}
                  className="btn-ghost px-4 py-2 text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddWidget}
                  disabled={!newWidgetTitle}
                  className={clsx(
                    'px-5 py-2 rounded-lg text-sm font-semibold transition-all',
                    newWidgetTitle
                      ? 'btn-primary'
                      : 'bg-tint text-fg-faint cursor-not-allowed'
                  )}
                >
                  Add Widget
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Widget Config Modal */}
      {isConfigModalOpen && editingWidget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface-1 rounded-2xl border border-line w-full max-w-lg overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line">
              <h2 className="text-lg font-bold text-fg">
                Widget Settings
              </h2>
              <button
                onClick={() => {
                  setEditingWidget(null);
                  setIsConfigModalOpen(false);
                }}
                className="p-1.5 rounded-lg hover:bg-tint text-fg-faint hover:text-fg-muted transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                  Title
                </label>
                <input
                  type="text"
                  value={editingWidget.title}
                  onChange={(e) =>
                    setEditingWidget({ ...editingWidget, title: e.target.value })
                  }
                  className="input w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                    Width (columns)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={editingWidget.position.w}
                    onChange={(e) =>
                      setEditingWidget({
                        ...editingWidget,
                        position: {
                          ...editingWidget.position,
                          w: Math.max(1, Math.min(12, Number(e.target.value))),
                        },
                      })
                    }
                    className="input w-full"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
                    Height (rows)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={editingWidget.position.h}
                    onChange={(e) =>
                      setEditingWidget({
                        ...editingWidget,
                        position: {
                          ...editingWidget.position,
                          h: Math.max(1, Math.min(8, Number(e.target.value))),
                        },
                      })
                    }
                    className="input w-full"
                  />
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-line bg-surface-1 flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  setEditingWidget(null);
                  setIsConfigModalOpen(false);
                }}
                className="btn-ghost px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveWidgetConfig}
                className="btn-primary px-5 py-2 text-sm font-semibold"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DashboardBuilder;
