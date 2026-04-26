import React from 'react';
import clsx from 'clsx';
import {
  X,
  Clock,
  Hash,
  ArrowRight,
  Play,
  Square,
  MessageSquare,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  Activity,
} from 'lucide-react';
import { formatDuration, formatNumber, formatPercentage, performanceLabel } from '../../utils/format';

interface ProcessNode {
  id: string;
  label: string;
  frequency: number;
  avg_duration: number;
  median_duration: number;
  is_start: boolean;
  is_end: boolean;
}

interface ProcessEdge {
  source: string;
  target: string;
  frequency: number;
  avg_duration: number;
  median_duration: number;
  performance_color: string;
}

interface Annotation {
  id: string;
  node_id?: string;
  edge_id?: string;
  text: string;
  author: string;
  created_at: string;
}

interface NodeDetailPanelProps {
  selectedNode?: ProcessNode | null;
  selectedEdge?: ProcessEdge | null;
  annotations?: Annotation[];
  totalCases?: number;
  allEdges?: ProcessEdge[];
  allNodes?: ProcessNode[];
  onClose: () => void;
  onAddAnnotation?: (nodeId?: string, edgeId?: string) => void;
}

const StatRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  sublabel?: string;
}> = ({ icon, label, value, sublabel }) => (
  <div className="flex items-start justify-between py-2.5 border-b border-line last:border-0">
    <div className="flex items-center gap-2 text-fg-faint">
      {icon}
      <span className="text-[12px]">{label}</span>
    </div>
    <div className="text-right">
      <span className="text-sm font-semibold text-fg">{value}</span>
      {sublabel && <p className="text-[11px] text-fg-faint">{sublabel}</p>}
    </div>
  </div>
);

const NodeDetailPanel: React.FC<NodeDetailPanelProps> = ({
  selectedNode,
  selectedEdge,
  annotations = [],
  totalCases = 0,
  allEdges = [],
  allNodes = [],
  onClose,
  onAddAnnotation,
}) => {
  const isOpen = !!(selectedNode || selectedEdge);

  if (!isOpen) return null;

  const nodeAnnotations = selectedNode
    ? annotations.filter((a) => a.node_id === selectedNode.id)
    : [];
  const edgeAnnotations = selectedEdge
    ? annotations.filter(
        (a) => a.edge_id === `${selectedEdge.source}->${selectedEdge.target}`
      )
    : [];

  const incomingEdges = selectedNode
    ? allEdges.filter((e) => e.target === selectedNode.id)
    : [];
  const outgoingEdges = selectedNode
    ? allEdges.filter((e) => e.source === selectedNode.id)
    : [];

  const getNodeLabel = (nodeId: string): string => {
    const node = allNodes.find((n) => n.id === nodeId);
    return node?.label || nodeId;
  };

  return (
    <div
      className={clsx(
        'w-80 bg-surface-2 border-l border-line overflow-y-auto',
        'animate-in slide-in-from-right duration-200'
      )}
    >
      {/* Header */}
      <div className="sticky top-0 bg-surface-2 border-b border-line px-4 py-3 flex items-center justify-between z-10">
        <h3 className="text-sm font-semibold text-fg-secondary">
          {selectedNode ? 'Activity Details' : 'Transition Details'}
        </h3>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-tint text-fg-faint hover:text-fg-muted transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Node details */}
        {selectedNode && (
          <>
            {/* Name and badges */}
            <div>
              <h2 className="text-lg font-bold text-fg mb-2">
                {selectedNode.label}
              </h2>
              <div className="flex items-center gap-2">
                {selectedNode.is_start && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success border border-line">
                    <Play className="w-3 h-3" />
                    Start Activity
                  </span>
                )}
                {selectedNode.is_end && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger/10 text-danger border border-line">
                    <Square className="w-3 h-3" />
                    End Activity
                  </span>
                )}
              </div>
            </div>

            {/* Statistics */}
            <div className="bg-surface-1 rounded-lg p-3">
              <StatRow
                icon={<Hash className="w-4 h-4" />}
                label="Frequency"
                value={`${formatNumber(selectedNode.frequency)} cases`}
                sublabel={
                  totalCases > 0
                    ? formatPercentage(selectedNode.frequency / totalCases)
                    : undefined
                }
              />
              <StatRow
                icon={<Clock className="w-4 h-4" />}
                label="Avg Duration"
                value={formatDuration(selectedNode.avg_duration)}
              />
              <StatRow
                icon={<Clock className="w-4 h-4" />}
                label="Median Duration"
                value={formatDuration(selectedNode.median_duration)}
              />
            </div>

            {/* Incoming edges */}
            {incomingEdges.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <ArrowDownRight className="w-3.5 h-3.5" />
                  Incoming ({incomingEdges.length})
                </h4>
                <div className="space-y-1">
                  {incomingEdges
                    .sort((a, b) => b.frequency - a.frequency)
                    .map((edge) => (
                      <div
                        key={`${edge.source}-in`}
                        className="flex items-center justify-between px-3 py-2 bg-tint rounded-lg text-sm"
                      >
                        <div className="flex items-center gap-1.5 text-fg-muted">
                          <span className="font-medium">
                            {getNodeLabel(edge.source)}
                          </span>
                          <ArrowRight className="w-3 h-3 text-fg-faint" />
                        </div>
                        <span className="text-xs font-medium text-fg-muted">
                          {formatNumber(edge.frequency)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Outgoing edges */}
            {outgoingEdges.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  Outgoing ({outgoingEdges.length})
                </h4>
                <div className="space-y-1">
                  {outgoingEdges
                    .sort((a, b) => b.frequency - a.frequency)
                    .map((edge) => (
                      <div
                        key={`${edge.target}-out`}
                        className="flex items-center justify-between px-3 py-2 bg-tint rounded-lg text-sm"
                      >
                        <div className="flex items-center gap-1.5 text-fg-muted">
                          <ArrowRight className="w-3 h-3 text-fg-faint" />
                          <span className="font-medium">
                            {getNodeLabel(edge.target)}
                          </span>
                        </div>
                        <span className="text-xs font-medium text-fg-muted">
                          {formatNumber(edge.frequency)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Annotations */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Annotations ({nodeAnnotations.length})
                </h4>
                {onAddAnnotation && (
                  <button
                    onClick={() => onAddAnnotation(selectedNode.id)}
                    className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </button>
                )}
              </div>
              {nodeAnnotations.length === 0 ? (
                <p className="text-[12px] text-fg-faint italic px-3 py-2">
                  No annotations yet
                </p>
              ) : (
                <div className="space-y-2">
                  {nodeAnnotations.map((ann) => (
                    <div
                      key={ann.id}
                      className="px-3 py-2 bg-warning/10 border border-line rounded-lg"
                    >
                      <p className="text-sm text-fg-secondary">{ann.text}</p>
                      <p className="text-[11px] text-fg-faint mt-1">
                        {ann.author} &middot; {ann.created_at}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Edge details */}
        {selectedEdge && (
          <>
            {/* Source -> Target */}
            <div className="flex items-center gap-3">
              <div className="flex-1 text-center px-3 py-2 bg-tint rounded-lg">
                <p className="text-[11px] text-fg-faint mb-0.5">From</p>
                <p className="text-sm font-semibold text-fg">
                  {getNodeLabel(selectedEdge.source)}
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-accent flex-shrink-0" />
              <div className="flex-1 text-center px-3 py-2 bg-tint rounded-lg">
                <p className="text-[11px] text-fg-faint mb-0.5">To</p>
                <p className="text-sm font-semibold text-fg">
                  {getNodeLabel(selectedEdge.target)}
                </p>
              </div>
            </div>

            {/* Performance indicator */}
            {(() => {
              const perf = performanceLabel(selectedEdge.performance_color);
              return (
                <div
                  className={clsx(
                    'flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg',
                    perf.className
                  )}
                >
                  <Activity className="w-4 h-4" />
                  <span className="text-sm font-semibold">{perf.label} Transition</span>
                </div>
              );
            })()}

            {/* Statistics */}
            <div className="bg-surface-1 rounded-lg p-3">
              <StatRow
                icon={<Hash className="w-4 h-4" />}
                label="Frequency"
                value={`${formatNumber(selectedEdge.frequency)} transitions`}
              />
              <StatRow
                icon={<Clock className="w-4 h-4" />}
                label="Avg Transition Time"
                value={formatDuration(selectedEdge.avg_duration)}
              />
              <StatRow
                icon={<Clock className="w-4 h-4" />}
                label="Median Transition Time"
                value={formatDuration(selectedEdge.median_duration)}
              />
            </div>

            {/* Annotations */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Annotations ({edgeAnnotations.length})
                </h4>
                {onAddAnnotation && (
                  <button
                    onClick={() =>
                      onAddAnnotation(
                        undefined,
                        `${selectedEdge.source}->${selectedEdge.target}`
                      )
                    }
                    className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </button>
                )}
              </div>
              {edgeAnnotations.length === 0 ? (
                <p className="text-[12px] text-fg-faint italic px-3 py-2">
                  No annotations yet
                </p>
              ) : (
                <div className="space-y-2">
                  {edgeAnnotations.map((ann) => (
                    <div
                      key={ann.id}
                      className="px-3 py-2 bg-warning/10 border border-line rounded-lg"
                    >
                      <p className="text-sm text-fg-secondary">{ann.text}</p>
                      <p className="text-[11px] text-fg-faint mt-1">
                        {ann.author} &middot; {ann.created_at}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default NodeDetailPanel;
