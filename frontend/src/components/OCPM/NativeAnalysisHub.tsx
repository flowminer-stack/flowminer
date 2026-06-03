import { useState } from 'react';
import {
  BarChart3,
  Network,
  Sparkles,
  Calendar,
  Share2,
  Timer,
  Workflow,
} from 'lucide-react';
import clsx from 'clsx';
import OCPetriNetPanel from './OCPetriNetPanel';
import OPeraPerformancePanel from './OPeraPerformancePanel';
import StateAwarePanel from './StateAwarePanel';
import ObjectGraphPanel from './ObjectGraphPanel';
import ObjectFeaturesPanel from './ObjectFeaturesPanel';
import TemporalSummaryPanel from './TemporalSummaryPanel';
import ConnectedComponentsPanel from './ConnectedComponentsPanel';

// ─── OCEL-Native Analysis Hub ─────────────────────────────────────────────────

interface NativeAnalysisItem {
  id: string;
  label: string;
  icon: React.ElementType;
  description: string;
}

const NATIVE_ANALYSIS_ITEMS: NativeAnalysisItem[] = [
  { id: 'oc-petri-net',  label: 'Activity Coverage',      icon: Network,   description: 'Which activities each object type participates in' },
  { id: 'opera',         label: 'OPerA Performance',      icon: Timer,     description: 'Flow / sync / pooling / lagging time per activity' },
  { id: 'state-aware',   label: 'State-Aware OCPM',       icon: Workflow,  description: 'Materialize object-state transitions (EDOC 2025)' },
  { id: 'object-graph',  label: 'Object Graph',           icon: Share2,    description: 'Object-level interaction / ancestry graphs' },
  { id: 'features',      label: 'Object Features',        icon: Sparkles,  description: 'Per-object feature matrix with CSV export' },
  { id: 'temporal',      label: 'Temporal Summary',       icon: Calendar,  description: 'Event distribution over time' },
  { id: 'components',    label: 'Connected Components',   icon: BarChart3, description: 'Graph component size distribution' },
];

export default function NativeAnalysisHub({ ocelId, objectTypes }: { ocelId: string; objectTypes: string[] }) {
  const [selected, setSelected] = useState(NATIVE_ANALYSIS_ITEMS[0].id);
  const active = NATIVE_ANALYSIS_ITEMS.find((a) => a.id === selected) ?? NATIVE_ANALYSIS_ITEMS[0];

  return (
    <div className="flex gap-3 overflow-hidden" style={{ minHeight: 420 }}>
      {/* Sidebar */}
      <div className="w-48 shrink-0 overflow-y-auto rounded-lg border border-line bg-surface-1">
        <div className="border-b border-line px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">OCEL-Native Tools</p>
        </div>
        <nav className="py-1">
          {NATIVE_ANALYSIS_ITEMS.map((item) => {
            const isActive = item.id === selected;
            return (
              <button
                key={item.id}
                onClick={() => setSelected(item.id)}
                title={item.description}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:bg-tint hover:text-fg-secondary',
                )}
              >
                <item.icon size={13} className={isActive ? 'text-accent' : 'text-fg-faint'} />
                <span className="text-[11px] font-medium leading-tight">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-1">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <active.icon size={14} className="text-accent" />
          <div>
            <h2 className="text-[13px] font-semibold text-fg">{active.label}</h2>
            <p className="text-[10px] text-fg-faint">{active.description}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {active.id === 'oc-petri-net'  && <OCPetriNetPanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'opera'         && <OPeraPerformancePanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'state-aware'   && <StateAwarePanel key={ocelId} ocelId={ocelId} objectTypes={objectTypes} />}
          {active.id === 'object-graph'  && <ObjectGraphPanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'features'      && <ObjectFeaturesPanel key={ocelId} ocelId={ocelId} objectTypes={objectTypes} />}
          {active.id === 'temporal'      && <TemporalSummaryPanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'components'    && <ConnectedComponentsPanel key={ocelId} ocelId={ocelId} />}
        </div>
      </div>
    </div>
  );
}
