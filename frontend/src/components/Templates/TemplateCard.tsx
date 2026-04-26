import React from 'react';
import clsx from 'clsx';
import {
  ArrowRight,
  Target,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';

interface ProcessTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  expected_activities: string[];
  kpi_targets: Record<string, any>[];
  anti_patterns: Record<string, any>[];
  created_at: string;
}

interface TemplateCardProps {
  template: ProcessTemplate;
  onSelect: (template: ProcessTemplate) => void;
}

const categoryStyles: Record<string, { accent: string; badge: string }> = {
  finance: {
    accent: 'bg-accent',
    badge: 'bg-accent/10 text-accent',
  },
  it: {
    accent: 'bg-accent',
    badge: 'bg-accent/10 text-accent',
  },
  support: {
    accent: 'bg-success',
    badge: 'bg-success/10 text-success',
  },
  hr: {
    accent: 'bg-warning',
    badge: 'bg-warning/10 text-warning',
  },
  insurance: {
    accent: 'bg-accent',
    badge: 'bg-accent/10 text-accent',
  },
  healthcare: {
    accent: 'bg-danger',
    badge: 'bg-danger/10 text-danger',
  },
};

const defaultCategoryStyle = {
  accent: 'bg-tint',
  badge: 'bg-tint text-fg-muted',
};

const TemplateCard: React.FC<TemplateCardProps> = ({ template, onSelect }) => {
  const catStyle =
    categoryStyles[template.category?.toLowerCase()] || defaultCategoryStyle;

  return (
    <div
      className="bg-surface-2 rounded-xl border border-line overflow-hidden hover:border-line-strong transition-all duration-200 group cursor-pointer"
      onClick={() => onSelect(template)}
    >
      {/* Top accent bar */}
      <div className={clsx('h-1', catStyle.accent)} />

      <div className="p-5">
        {/* Category badge */}
        <span
          className={clsx(
            'inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mb-3',
            catStyle.badge
          )}
        >
          {template.category}
        </span>

        {/* Name */}
        <h3 className="text-base font-bold text-fg mb-1.5 group-hover:text-fg transition-colors">
          {template.name}
        </h3>

        {/* Description */}
        <p className="text-[12px] text-fg-muted mb-4 line-clamp-2">
          {template.description}
        </p>

        {/* Expected activities */}
        <div className="mb-4">
          <p className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider mb-2">
            Expected Flow
          </p>
          <div className="flex items-center flex-wrap gap-1">
            {template.expected_activities.slice(0, 5).map((act, i) => (
              <React.Fragment key={i}>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-tint text-fg-muted border border-line-strong">
                  {act}
                </span>
                {i < Math.min(template.expected_activities.length, 5) - 1 && (
                  <ArrowRight className="w-2.5 h-2.5 text-fg-ghost flex-shrink-0" />
                )}
              </React.Fragment>
            ))}
            {template.expected_activities.length > 5 && (
              <span className="text-[10px] text-fg-faint">
                +{template.expected_activities.length - 5} more
              </span>
            )}
          </div>
        </div>

        {/* KPI targets */}
        {template.kpi_targets.length > 0 && (
          <div className="mb-4">
            <p className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider mb-1.5">
              KPI Targets
            </p>
            <div className="space-y-1">
              {template.kpi_targets.slice(0, 3).map((kpi, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Target className="w-3 h-3 text-success flex-shrink-0" />
                  <span className="text-[12px] text-fg-muted">
                    {kpi.name || kpi.label}:{' '}
                    <span className="font-medium text-fg-secondary">
                      {kpi.target || kpi.value}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Anti-patterns */}
        {template.anti_patterns.length > 0 && (
          <div className="mb-4">
            <p className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider mb-1.5">
              Anti-Patterns
            </p>
            <div className="space-y-1">
              {template.anti_patterns.slice(0, 2).map((ap, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-warning flex-shrink-0" />
                  <span className="text-[12px] text-fg-muted">
                    {ap.name || ap.label || ap.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CTA */}
        <button
          className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-semibold text-accent bg-accent/10 hover:bg-accent/15 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(template);
          }}
        >
          Use Template
          <ChevronRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
        </button>
      </div>
    </div>
  );
};

export default TemplateCard;
