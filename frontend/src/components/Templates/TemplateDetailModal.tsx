import React from 'react';
import clsx from 'clsx';
import {
  X,
  ArrowRight,
  Target,
  AlertTriangle,
  Rocket,
  ChevronRight,
  FileText,
  Activity,
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

interface TemplateDetailModalProps {
  template: ProcessTemplate;
  isOpen: boolean;
  onClose: () => void;
  onApply: (template: ProcessTemplate) => void;
}

const categoryColors: Record<string, string> = {
  finance: 'bg-accent/10 text-accent',
  it: 'bg-accent/10 text-accent',
  support: 'bg-success/10 text-success',
  hr: 'bg-warning/10 text-warning',
  insurance: 'bg-accent/10 text-accent',
  healthcare: 'bg-danger/10 text-danger',
};

const TemplateDetailModal: React.FC<TemplateDetailModalProps> = ({
  template,
  isOpen,
  onClose,
  onApply,
}) => {
  if (!isOpen) return null;

  const catColor =
    categoryColors[template.category?.toLowerCase()] ||
    'bg-tint text-fg-muted';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        className="bg-surface-1 rounded-2xl border border-line w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-line flex items-start justify-between flex-shrink-0">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
              <FileText className="w-6 h-6 text-accent" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={clsx(
                    'inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider',
                    catColor
                  )}
                >
                  {template.category}
                </span>
              </div>
              <h2 className="text-xl font-bold text-fg">
                {template.name}
              </h2>
              <p className="text-[12px] text-fg-muted mt-1">
                {template.description}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-tint text-fg-faint hover:text-fg-muted transition-colors flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Expected Process Flow */}
          <div>
            <h3 className="text-sm font-semibold text-fg-secondary mb-4 flex items-center gap-2">
              <Activity className="w-4 h-4 text-accent" />
              Expected Process Flow
            </h3>
            <div className="bg-surface-2 rounded-xl border border-line p-6 overflow-x-auto">
              <div className="flex items-center gap-0 min-w-max">
                {template.expected_activities.map((act, i) => (
                  <React.Fragment key={i}>
                    <div
                      className={clsx(
                        'flex-shrink-0 px-4 py-3 rounded-xl border-2 text-center min-w-[100px] transition-all',
                        i === 0
                          ? 'bg-success/10 border-success/40 text-success'
                          : i === template.expected_activities.length - 1
                          ? 'bg-danger/10 border-danger/40 text-danger'
                          : 'bg-surface-1 border-line-strong text-fg-secondary'
                      )}
                    >
                      <p className="text-[10px] font-medium text-fg-faint mb-0.5">
                        Step {i + 1}
                      </p>
                      <p className="text-sm font-semibold">{act}</p>
                    </div>
                    {i < template.expected_activities.length - 1 && (
                      <div className="flex-shrink-0 flex items-center mx-1">
                        <div className="w-6 h-0.5 bg-tint" />
                        <ChevronRight className="w-4 h-4 text-fg-faint -ml-1" />
                      </div>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>

          {/* KPI Targets */}
          {template.kpi_targets.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-fg-secondary mb-3 flex items-center gap-2">
                <Target className="w-4 h-4 text-success" />
                KPI Targets
              </h3>
              <div className="bg-surface-2 rounded-xl border border-line overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="bg-surface-1 border-b border-line">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                        KPI
                      </th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                        Target
                      </th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                        Description
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {template.kpi_targets.map((kpi, i) => (
                      <tr key={i} className="hover:bg-tint/30">
                        <td className="px-4 py-3">
                          <span className="text-sm font-medium text-fg">
                            {kpi.name || kpi.label || `KPI ${i + 1}`}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm font-semibold text-success bg-success/10 px-2 py-0.5 rounded">
                            {kpi.target || kpi.value || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-[12px] text-fg-muted">
                            {kpi.description || '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Anti-Patterns */}
          {template.anti_patterns.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-fg-secondary mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                Anti-Patterns to Watch For
              </h3>
              <div className="space-y-2">
                {template.anti_patterns.map((ap, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 p-3 bg-warning/10 rounded-lg border border-line"
                  >
                    <div className="w-6 h-6 rounded-full bg-warning/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-warning" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-fg">
                        {ap.name || ap.label || `Pattern ${i + 1}`}
                      </p>
                      {(ap.description || ap.detail) && (
                        <p className="text-[12px] text-fg-muted mt-0.5">
                          {ap.description || ap.detail}
                        </p>
                      )}
                      {ap.activities && (
                        <div className="flex items-center gap-1 mt-2">
                          {(ap.activities as string[]).map((act, j) => (
                            <React.Fragment key={j}>
                              <span className="text-[10px] font-medium bg-warning/10 text-warning px-1.5 py-0.5 rounded">
                                {act}
                              </span>
                              {j < (ap.activities as string[]).length - 1 && (
                                <ArrowRight className="w-2.5 h-2.5 text-warning" />
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line bg-surface-1 flex items-center justify-between flex-shrink-0">
          <p className="text-[12px] text-fg-faint">
            {template.expected_activities.length} activities &middot;{' '}
            {template.kpi_targets.length} KPI targets &middot;{' '}
            {template.anti_patterns.length} anti-patterns
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="btn-ghost px-4 py-2 text-sm font-medium"
            >
              Close
            </button>
            <button
              onClick={() => onApply(template)}
              className="btn-primary flex items-center gap-2 px-5 py-2.5 text-sm font-semibold"
            >
              <Rocket className="w-4 h-4" />
              Apply to Event Log
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TemplateDetailModal;
