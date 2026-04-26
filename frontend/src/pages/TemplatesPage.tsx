import { useEffect, useState } from 'react';
import {
  BookTemplate,
  Plus,
  Download,
  Target,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Tag,
  Save,
  LayoutTemplate,
} from 'lucide-react';
import { templates as templatesApi } from '@/api/client';
import type { ProcessTemplate } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore } from '@/store';

const templateCategories = [
  'Order-to-Cash',
  'Procure-to-Pay',
  'Lead-to-Cash',
  'Incident Management',
  'HR Onboarding',
  'Claims Processing',
  'Supply Chain',
  'Custom',
];

export default function TemplatesPage() {
  const addNotification = useUIStore((s) => s.addNotification);

  const [templateList, setTemplateList] = useState<ProcessTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] =
    useState<ProcessTemplate | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Create form state
  const [createName, setCreateName] = useState('');
  const [createCategory, setCreateCategory] = useState('Custom');
  const [createDescription, setCreateDescription] = useState('');
  const [createActivities, setCreateActivities] = useState('');
  const [createSaving, setCreateSaving] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    setLoading(true);
    try {
      const list = await templatesApi.list();
      setTemplateList(list);
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to load templates',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSeedTemplates = async () => {
    try {
      await templatesApi.seed();
      addNotification({
        type: 'success',
        title: 'Templates seeded',
        message: 'Built-in templates have been loaded.',
      });
      loadTemplates();
    } catch {
      addNotification({ type: 'error', title: 'Failed to seed templates' });
    }
  };

  const resetCreateForm = () => {
    setCreateName('');
    setCreateCategory('Custom');
    setCreateDescription('');
    setCreateActivities('');
  };

  const handleCreateTemplate = async () => {
    if (!createName.trim()) {
      addNotification({
        type: 'error',
        title: 'Validation error',
        message: 'Template name is required.',
      });
      return;
    }

    const activitiesList = createActivities
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    setCreateSaving(true);
    try {
      await templatesApi.create({
        name: createName.trim(),
        category: createCategory,
        description: createDescription.trim(),
        expected_activities: activitiesList,
        kpis: [],
        anti_patterns: [],
        reference_model: {},
        is_builtin: false,
      });
      await loadTemplates();
      setShowCreateModal(false);
      resetCreateForm();
      addNotification({
        type: 'success',
        title: 'Template created',
        message: `Template "${createName.trim()}" has been created successfully.`,
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Failed to create template',
      });
    } finally {
      setCreateSaving(false);
    }
  };

  if (loading) {
    return <LoadingSpinner size="lg" text="Loading templates..." fullPage />;
  }

  // Group by category
  const categories = templateList.reduce<Record<string, ProcessTemplate[]>>(
    (acc, template) => {
      const cat = template.category || 'Uncategorized';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(template);
      return acc;
    },
    {},
  );

  return (
    <div>
      <PageHeader
        title="Process Templates"
        icon={LayoutTemplate}
        description="Reference models for common business processes"
        actions={
          <>
            <button onClick={handleSeedTemplates} className="btn-secondary">
              <Download size={16} />
              Load Built-in Templates
            </button>
            <button
              className="btn-primary"
              onClick={() => setShowCreateModal(true)}
            >
              <Plus size={18} />
              Create Template
            </button>
          </>
        }
      />

      {templateList.length === 0 ? (
        <div className="mt-16 flex flex-col items-center">
          <div className="rounded-full bg-tint p-4">
            <BookTemplate size={32} className="text-fg-faint" />
          </div>
          <h3 className="mt-4 text-[13px] font-semibold text-fg">
            No templates available
          </h3>
          <p className="mt-1 max-w-md text-center text-[12px] text-fg-muted">
            Load built-in templates for common processes like Order-to-Cash,
            Procure-to-Pay, and more.
          </p>
          <button onClick={handleSeedTemplates} className="btn-primary mt-6">
            <Download size={18} />
            Load Built-in Templates
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {Object.entries(categories).map(([category, templates]) => (
            <div key={category}>
              <div className="flex items-center gap-2">
                <Tag size={16} className="text-fg-faint" />
                <h2 className="text-[14px] font-semibold text-fg">
                  {category}
                </h2>
                <span className="badge badge-slate">{templates.length}</span>
              </div>

              <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => (
                  <div
                    key={template.id}
                    className="card cursor-pointer p-5 transition-all hover:border-line-strong hover:bg-surface-3"
                    onClick={() => setSelectedTemplate(template)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10">
                        <BookTemplate
                          size={20}
                          className="text-accent"
                        />
                      </div>
                      {template.is_builtin && (
                        <span className="badge badge-accent text-[10px]">
                          Built-in
                        </span>
                      )}
                    </div>

                    <h3 className="mt-3 text-[13px] font-semibold text-fg">
                      {template.name}
                    </h3>
                    <p className="mt-1 line-clamp-2 text-[12px] text-fg-muted">
                      {template.description}
                    </p>

                    <div className="mt-4 flex items-center gap-4 text-[11px] text-fg-faint">
                      <span>
                        {template.expected_activities.length} activities
                      </span>
                      <span>{template.kpis.length} KPIs</span>
                      <span>{template.anti_patterns.length} anti-patterns</span>
                    </div>

                    <div className="mt-3 flex items-center text-[12px] font-medium text-accent">
                      View details
                      <ChevronRight size={14} className="ml-0.5" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Template Detail Modal */}
      <Modal
        isOpen={selectedTemplate !== null}
        onClose={() => setSelectedTemplate(null)}
        title={selectedTemplate?.name ?? ''}
        size="lg"
        footer={
          <button
            onClick={() => setSelectedTemplate(null)}
            className="btn-secondary"
          >
            Close
          </button>
        }
      >
        {selectedTemplate && (
          <div className="space-y-6">
            <p className="text-[12px] text-fg-muted">
              {selectedTemplate.description}
            </p>

            {/* Expected Activities */}
            <div>
              <h3 className="text-[13px] font-semibold text-fg">
                Expected Activities
              </h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedTemplate.expected_activities.map((activity) => (
                  <span
                    key={activity}
                    className="rounded-md bg-tint px-2.5 py-1 text-[12px] font-medium text-fg-secondary"
                  >
                    {activity}
                  </span>
                ))}
              </div>
            </div>

            {/* KPIs */}
            {selectedTemplate.kpis.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-fg">
                  Key Performance Indicators
                </h3>
                <div className="mt-2 space-y-2">
                  {selectedTemplate.kpis.map((kpi, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between rounded-lg border border-line px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Target size={14} className="text-accent" />
                        <span className="text-[12px] font-medium text-fg-secondary">
                          {kpi.name}
                        </span>
                      </div>
                      <span className="text-[12px] text-fg-muted">
                        Target: {kpi.target} {kpi.unit}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Anti-patterns */}
            {selectedTemplate.anti_patterns.length > 0 && (
              <div>
                <h3 className="text-[13px] font-semibold text-fg">
                  Anti-Patterns
                </h3>
                <div className="mt-2 space-y-2">
                  {selectedTemplate.anti_patterns.map((pattern, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-warning/30 bg-warning/10 p-3"
                    >
                      <div className="flex items-center gap-2">
                        <AlertTriangle
                          size={14}
                          className="text-warning"
                        />
                        <span className="text-[12px] font-medium text-warning">
                          {pattern.name}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-warning/70">
                        {pattern.description}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Create Template Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => {
          setShowCreateModal(false);
          resetCreateForm();
        }}
        title="Create Template"
        size="lg"
        footer={
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setShowCreateModal(false);
                resetCreateForm();
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateTemplate}
              disabled={createSaving || !createName.trim()}
              className="btn-primary"
            >
              {createSaving ? (
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Creating...
                </div>
              ) : (
                <>
                  <Save size={16} />
                  Create Template
                </>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Template Name
            </label>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g., Invoice Approval Process"
              className="input w-full"
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Category
            </label>
            <div className="relative">
              <select
                value={createCategory}
                onChange={(e) => setCreateCategory(e.target.value)}
                className="input w-full appearance-none pr-10 cursor-pointer"
              >
                {templateCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={16}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Description
            </label>
            <textarea
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              placeholder="Describe the process this template represents..."
              rows={3}
              className="input w-full resize-none"
            />
          </div>

          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Expected Activities
            </label>
            <input
              type="text"
              value={createActivities}
              onChange={(e) => setCreateActivities(e.target.value)}
              placeholder="e.g., Submit Request, Review, Approve, Complete"
              className="input w-full"
            />
            <p className="mt-1.5 text-[11px] text-fg-faint">
              Enter activity names separated by commas
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
