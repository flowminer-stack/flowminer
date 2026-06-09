import React from 'react';
import clsx from 'clsx';
import { AlertTriangle } from 'lucide-react';
import HintTooltip from '@/components/common/Tooltip';

export interface ComplexityScoreBadgeProps {
  activityCount: number;
  edgeCount: number;
  gatewayCount?: number;
}

function computeScore(nodes: number, edges: number, gateways: number): number {
  const activityPenalty = Math.max(0, (nodes - 30) * 1.5);
  const edgePenalty = Math.max(0, (edges - 50) * 0.8);
  const gatewayPenalty = Math.max(0, (gateways - 10) * 2);
  return Math.max(0, Math.round(100 - activityPenalty - edgePenalty - gatewayPenalty));
}

const TOOLTIP_TEXT =
  'Comprehensibility score (0-100) derived from activity count, edge density, and gateway count. Process models above ~30 activities, ~50 edges, or ~10 gateways become substantially harder to read (Reijers, Mendling — process model comprehensibility research).';

const ComplexityScoreBadge: React.FC<ComplexityScoreBadgeProps> = ({
  activityCount,
  edgeCount,
  gatewayCount,
}) => {
  // If gatewayCount is not provided, skip gateway penalty (treat as 0)
  const gateways = gatewayCount ?? 0;
  const score = computeScore(activityCount, edgeCount, gateways);

  const colorClasses =
    score >= 70
      ? 'text-success bg-success/10 border-success/30'
      : score >= 40
        ? 'text-warning bg-warning/10 border-warning/30'
        : 'text-danger bg-danger/10 border-danger/30';

  return (
    <HintTooltip text={TOOLTIP_TEXT}>
      <span
        className={clsx(
          'inline-flex items-center gap-1 rounded-full border px-2 py-1',
          colorClasses,
        )}
      >
        {score < 40 && <AlertTriangle size={11} className="shrink-0" />}
        <span className="text-[11px] font-semibold tabular-nums">
          Readability {score}/100
        </span>
      </span>
    </HintTooltip>
  );
};

export default ComplexityScoreBadge;
