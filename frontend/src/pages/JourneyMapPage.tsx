import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Map, Plus, Trash2, Pencil, ChevronRight, X, GripVertical } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import { journeys as journeysApi } from '@/api/journeys';
import { useUIStore } from '@/store';
import type { Journey, JourneyStage, JourneyCreate, JourneyUpdate } from '@/types/journey';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a 0-100 sentiment score to a colour class and label. */
function sentimentMeta(score: number): { label: string; ring: string; fill: string; text: string } {
  if (score >= 70) return { label: 'Positive', ring: 'border-emerald-500/60', fill: 'bg-emerald-500/20', text: 'text-emerald-400' };
  if (score >= 40) return { label: 'Neutral', ring: 'border-yellow-500/60', fill: 'bg-yellow-500/10', text: 'text-yellow-400' };
  return { label: 'Negative', ring: 'border-red-500/60', fill: 'bg-red-500/15', text: 'text-red-400' };
}

/** Visual sentiment arc drawn as a thin inline bar. */
function SentimentBar({ value }: { value: number }) {
  const { fill, text } = sentimentMeta(value);
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-tint">
        <div
          className={`h-full rounded-full ${fill.replace('/20', '').replace('/10', '').replace('/15', '')} bg-current ${text} transition-all`}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className={`text-[9px] tabular-nums font-medium ${text}`}>{value}</span>
    </div>
  );
}

// ─── Stage card ───────────────────────────────────────────────────────────────

interface StageCardProps {
  stage: JourneyStage;
  index: number;
  total: number;
  onEdit: (stage: JourneyStage) => void;
  onDelete: (id: string) => void;
}

function StageCard({ stage, index, total, onEdit, onDelete }: StageCardProps) {
  const { ring, fill, label } = sentimentMeta(stage.sentiment);
  return (
    <div className="relative flex flex-col" style={{ minWidth: 200, maxWidth: 240 }}>
      {/* Connector arrow (all except last) */}
      {index < total - 1 && (
        <div className="absolute right-0 top-1/2 z-10 translate-x-1/2 -translate-y-1/2">
          <ChevronRight size={16} className="text-fg-faint" />
        </div>
      )}
      <div className={`flex flex-1 flex-col rounded-xl border ${ring} ${fill} p-3`}>
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <GripVertical size={11} className="shrink-0 text-fg-ghost" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">
              Stage {index + 1}
            </span>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => onEdit(stage)}
              className="rounded p-0.5 text-fg-ghost hover:text-fg-muted transition-colors"
              title="Edit stage"
            >
              <Pencil size={10} />
            </button>
            <button
              onClick={() => onDelete(stage.id)}
              className="rounded p-0.5 text-fg-ghost hover:text-danger transition-colors"
              title="Remove stage"
            >
              <X size={10} />
            </button>
          </div>
        </div>

        {/* Label */}
        <p className="mt-1.5 text-[13px] font-semibold leading-snug text-fg">{stage.label}</p>

        {/* Sentiment */}
        <SentimentBar value={stage.sentiment} />
        <p className="mt-0.5 text-[9px] text-fg-faint">{label}</p>

        {/* Touchpoints */}
        {stage.touchpoints.length > 0 && (
          <div className="mt-3 space-y-1">
            <p className="text-[9px] font-medium uppercase tracking-wider text-fg-ghost">Touchpoints</p>
            <ul className="space-y-0.5">
              {stage.touchpoints.map((tp, i) => (
                <li key={i} className="text-[10px] text-fg-secondary leading-snug">
                  · {tp}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stage editor modal ───────────────────────────────────────────────────────

interface StageEditorProps {
  isOpen: boolean;
  initial: Partial<JourneyStage> | null;
  onClose: () => void;
  onSave: (stage: JourneyStage) => void;
}

function StageEditor({ isOpen, initial, onClose, onSave }: StageEditorProps) {
  const [label, setLabel] = useState('');
  const [sentiment, setSentiment] = useState(50);
  const [touchpointText, setTouchpointText] = useState('');

  useEffect(() => {
    if (isOpen) {
      setLabel(initial?.label ?? '');
      setSentiment(initial?.sentiment ?? 50);
      setTouchpointText((initial?.touchpoints ?? []).join('\n'));
    }
  }, [isOpen, initial]);

  const handleSave = () => {
    if (!label.trim()) return;
    const touchpoints = touchpointText
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      label: label.trim(),
      sentiment,
      touchpoints,
      widgets: initial?.widgets ?? [],
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={initial?.id ? 'Edit stage' : 'Add stage'} size="sm">
      <div className="space-y-4">
        <Field label="Stage name">
          <input
            className="input w-full"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Awareness"
            autoFocus
          />
        </Field>

        <Field label={`Sentiment — ${sentiment} / 100`}>
          <input
            type="range"
            min={0}
            max={100}
            value={sentiment}
            onChange={(e) => setSentiment(Number(e.target.value))}
            className="w-full accent-cyan-500"
          />
          <div className="mt-1 flex justify-between text-[9px] text-fg-ghost">
            <span>Negative</span>
            <span>Neutral</span>
            <span>Positive</span>
          </div>
        </Field>

        <Field label="Touchpoints (one per line)">
          <textarea
            className="input w-full resize-none"
            rows={4}
            value={touchpointText}
            onChange={(e) => setTouchpointText(e.target.value)}
            placeholder="Email campaign&#10;Sales call&#10;Demo"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost text-[12px]" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary text-[12px]"
            onClick={handleSave}
            disabled={!label.trim()}
          >
            {initial?.id ? 'Save changes' : 'Add stage'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Journey editor modal ─────────────────────────────────────────────────────

interface JourneyEditorProps {
  isOpen: boolean;
  projectId: string;
  initial: Journey | null; // null = create
  onClose: () => void;
  onSaved: (journey: Journey) => void;
}

function JourneyEditor({ isOpen, projectId, initial, onClose, onSaved }: JourneyEditorProps) {
  const addNotification = useUIStore((s) => s.addNotification);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [journeyType, setJourneyType] = useState('customer');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName(initial?.name ?? '');
      setDescription(initial?.description ?? '');
      setJourneyType(initial?.journey_type ?? 'customer');
    }
  }, [isOpen, initial]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      let saved: Journey;
      if (initial) {
        const update: JourneyUpdate = {
          name: name.trim(),
          description: description.trim() || undefined,
        };
        saved = await journeysApi.update(initial.id, update);
      } else {
        const create: JourneyCreate = {
          project_id: projectId,
          name: name.trim(),
          description: description.trim() || undefined,
          journey_type: journeyType,
          stages: [],
        };
        saved = await journeysApi.create(create);
      }
      onSaved(saved);
      onClose();
    } catch {
      addNotification({ type: 'error', title: initial ? 'Failed to update journey' : 'Failed to create journey' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={initial ? 'Edit journey' : 'New journey'} size="sm">
      <div className="space-y-4">
        <Field label="Journey name">
          <input
            className="input w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Customer Onboarding"
            autoFocus
          />
        </Field>
        <Field label="Description (optional)">
          <input
            className="input w-full"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description"
          />
        </Field>
        {!initial && (
          <Field label="Journey type">
            <select
              className="input w-full"
              value={journeyType}
              onChange={(e) => setJourneyType(e.target.value)}
            >
              <option value="customer">Customer</option>
              <option value="employee">Employee</option>
              <option value="partner">Partner</option>
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost text-[12px]" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary text-[12px]"
            onClick={handleSave}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving…' : initial ? 'Save changes' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Stage map canvas ─────────────────────────────────────────────────────────

interface StageMapProps {
  journey: Journey;
  onStagesChange: (stages: JourneyStage[]) => void;
}

function StageMap({ journey, onStagesChange }: StageMapProps) {
  const addNotification = useUIStore((s) => s.addNotification);
  const [stageEditorOpen, setStageEditorOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<Partial<JourneyStage> | null>(null);
  const [saving, setSaving] = useState(false);

  const persistStages = async (newStages: JourneyStage[]) => {
    setSaving(true);
    try {
      const updated = await journeysApi.update(journey.id, { stages: newStages });
      onStagesChange(updated.stages);
    } catch {
      addNotification({ type: 'error', title: 'Failed to save stages' });
    } finally {
      setSaving(false);
    }
  };

  const handleAddStage = () => {
    setEditingStage(null);
    setStageEditorOpen(true);
  };

  const handleEditStage = (stage: JourneyStage) => {
    setEditingStage(stage);
    setStageEditorOpen(true);
  };

  const handleDeleteStage = async (stageId: string) => {
    if (!confirm('Remove this stage?')) return;
    await persistStages(journey.stages.filter((s) => s.id !== stageId));
  };

  const handleSaveStage = async (stage: JourneyStage) => {
    setStageEditorOpen(false);
    const existing = journey.stages.find((s) => s.id === stage.id);
    const newStages = existing
      ? journey.stages.map((s) => (s.id === stage.id ? stage : s))
      : [...journey.stages, stage];
    await persistStages(newStages);
  };

  return (
    <>
      <div className="mt-4 flex items-start gap-3 overflow-x-auto pb-4">
        {journey.stages.length === 0 ? (
          <div className="flex min-h-[140px] w-full items-center justify-center rounded-xl border border-dashed border-line bg-surface-1 text-center">
            <div>
              <p className="text-[12px] text-fg-muted">No stages yet</p>
              <p className="mt-0.5 text-[10px] text-fg-ghost">Click "Add stage" to start building this journey</p>
            </div>
          </div>
        ) : (
          journey.stages.map((stage, i) => (
            <StageCard
              key={stage.id}
              stage={stage}
              index={i}
              total={journey.stages.length}
              onEdit={handleEditStage}
              onDelete={handleDeleteStage}
            />
          ))
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={handleAddStage}
          className="btn-secondary flex items-center gap-1.5 text-[11px]"
          disabled={saving}
        >
          <Plus size={12} />
          Add stage
        </button>
        {saving && <LoadingSpinner size="sm" text="Saving…" />}
      </div>

      <StageEditor
        isOpen={stageEditorOpen}
        initial={editingStage}
        onClose={() => setStageEditorOpen(false)}
        onSave={handleSaveStage}
      />
    </>
  );
}

// ─── Journey list sidebar ─────────────────────────────────────────────────────

interface JourneyListProps {
  journeys: Journey[];
  selected: Journey | null;
  onSelect: (j: Journey) => void;
  onEdit: (j: Journey) => void;
  onDelete: (id: string) => void;
}

function JourneyList({ journeys: list, selected, onSelect, onEdit, onDelete }: JourneyListProps) {
  if (list.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
        <Map size={22} className="text-fg-ghost" />
        <p className="text-[11px] text-fg-muted">No journeys yet</p>
        <p className="text-[10px] text-fg-ghost">Create one to start mapping</p>
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {list.map((j) => (
        <li key={j.id}>
          <button
            type="button"
            onClick={() => onSelect(j)}
            className={`group w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-tint ${
              selected?.id === j.id ? 'bg-accent/10 ring-1 ring-inset ring-accent/30' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-1">
              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-[12px] font-medium ${
                    selected?.id === j.id ? 'text-accent' : 'text-fg'
                  }`}
                >
                  {j.name}
                </p>
                {j.description && (
                  <p className="mt-0.5 truncate text-[10px] text-fg-faint">{j.description}</p>
                )}
                <div className="mt-1 flex items-center gap-2 text-[9px] text-fg-ghost">
                  <span className="capitalize">{j.journey_type}</span>
                  <span>·</span>
                  <span>{j.stages.length} stage{j.stages.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onEdit(j); }}
                  className="rounded p-1 text-fg-ghost hover:text-fg-muted"
                  title="Rename"
                >
                  <Pencil size={10} />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDelete(j.id); }}
                  className="rounded p-1 text-fg-ghost hover:text-danger"
                  title="Delete"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function JourneyMapPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const addNotification = useUIStore((s) => s.addNotification);

  const [list, setList] = useState<Journey[]>([]);
  const [selected, setSelected] = useState<Journey | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [journeyEditorOpen, setJourneyEditorOpen] = useState(false);
  const [editingJourney, setEditingJourney] = useState<Journey | null>(null);

  // ── Data ────────────────────────────────────────────────────────────────────

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await journeysApi.list(projectId);
      setList(data);
      // Keep the selected journey in sync (re-fetched data may have updated stages)
      if (selected) {
        const refreshed = data.find((j) => j.id === selected.id);
        setSelected(refreshed ?? data[0] ?? null);
      } else if (data.length > 0) {
        setSelected(data[0]);
      }
    } catch {
      setError('Failed to load journeys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Journey CRUD ─────────────────────────────────────────────────────────────

  const handleNewJourney = () => {
    setEditingJourney(null);
    setJourneyEditorOpen(true);
  };

  const handleEditJourney = (j: Journey) => {
    setEditingJourney(j);
    setJourneyEditorOpen(true);
  };

  const handleJourneySaved = (saved: Journey) => {
    setList((prev) => {
      const exists = prev.find((j) => j.id === saved.id);
      return exists ? prev.map((j) => (j.id === saved.id ? saved : j)) : [saved, ...prev];
    });
    setSelected(saved);
  };

  const handleDeleteJourney = async (id: string) => {
    if (!confirm('Delete this journey and all its stages?')) return;
    try {
      await journeysApi.delete(id);
      setList((prev) => prev.filter((j) => j.id !== id));
      setSelected((prev) => (prev?.id === id ? list.find((j) => j.id !== id) ?? null : prev));
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete journey' });
    }
  };

  // ── Stage changes (bubble up from StageMap) ──────────────────────────────────

  const handleStagesChange = (stages: JourneyStage[]) => {
    if (!selected) return;
    const updated: Journey = { ...selected, stages };
    setSelected(updated);
    setList((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return <LoadingSpinner size="lg" text="Loading journeys…" fullPage />;

  if (error) {
    return (
      <div>
        <PageHeader title="Journey Maps" icon={Map} description="Customer and employee journey stage maps" />
        <div className="mt-8 rounded-xl border border-line bg-surface-1 py-14 text-center">
          <p className="text-[13px] text-danger">{error}</p>
          <button onClick={load} className="btn-secondary mt-3 text-[11px]">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Journey Maps"
        icon={Map}
        description="Design customer and employee journeys — map stages, touchpoints, and sentiment scores in one visual canvas."
        actions={
          <button onClick={handleNewJourney} className="btn-primary flex items-center gap-1.5 text-[12px]">
            <Plus size={13} />
            New journey
          </button>
        }
      />

      <div className="mt-6 flex flex-1 min-h-0 gap-5">
        {/* ── Sidebar list ──────────────────────────────────────────────── */}
        <aside className="flex w-60 shrink-0 flex-col rounded-xl border border-line bg-surface-1 p-2">
          <p className="px-2 pb-2 pt-1 text-[9px] font-semibold uppercase tracking-widest text-fg-ghost">
            Journeys ({list.length})
          </p>
          <div className="flex-1 overflow-y-auto">
            <JourneyList
              journeys={list}
              selected={selected}
              onSelect={setSelected}
              onEdit={handleEditJourney}
              onDelete={handleDeleteJourney}
            />
          </div>
        </aside>

        {/* ── Main canvas ───────────────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <div className="rounded-xl border border-line bg-surface-1 p-5">
              {/* Journey header */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-[16px] font-bold text-fg">{selected.name}</h2>
                    <span className="rounded-full border border-line bg-tint px-2 py-0.5 text-[9px] font-medium capitalize text-fg-muted">
                      {selected.journey_type}
                    </span>
                  </div>
                  {selected.description && (
                    <p className="mt-0.5 text-[11px] text-fg-muted">{selected.description}</p>
                  )}
                  <p className="mt-1 text-[9px] text-fg-ghost">
                    {selected.stages.length} stage{selected.stages.length !== 1 ? 's' : ''}
                    {selected.updated_at && (
                      <>
                        {' · '}Updated {new Date(selected.updated_at).toLocaleDateString()}
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => handleEditJourney(selected)}
                  className="btn-ghost flex items-center gap-1 text-[11px]"
                >
                  <Pencil size={11} /> Edit
                </button>
              </div>

              {/* Sentiment summary row */}
              {selected.stages.length > 0 && (
                <div className="mt-4 flex items-center gap-1 overflow-x-auto pb-1">
                  {selected.stages.map((s, i) => {
                    const { text } = sentimentMeta(s.sentiment);
                    return (
                      <div key={s.id} className="flex items-center gap-1 shrink-0">
                        <div className={`h-2 w-2 rounded-full bg-current ${text}`} />
                        <span className="text-[9px] text-fg-ghost">{s.label}</span>
                        {i < selected.stages.length - 1 && (
                          <ChevronRight size={9} className="text-fg-ghost" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Stage map */}
              <StageMap journey={selected} onStagesChange={handleStagesChange} />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-line bg-surface-1 py-20 text-center">
              <Map size={30} className="text-fg-ghost" />
              <p className="mt-3 text-[13px] font-medium text-fg-muted">No journey selected</p>
              <p className="mt-1 text-[11px] text-fg-ghost">
                Select a journey from the sidebar or create a new one.
              </p>
              <button onClick={handleNewJourney} className="btn-primary mt-5 flex items-center gap-1.5 text-[12px]">
                <Plus size={13} />
                New journey
              </button>
            </div>
          )}
        </main>
      </div>

      {/* Journey create/edit modal */}
      <JourneyEditor
        isOpen={journeyEditorOpen}
        projectId={projectId ?? ''}
        initial={editingJourney}
        onClose={() => setJourneyEditorOpen(false)}
        onSaved={handleJourneySaved}
      />
    </div>
  );
}

// ─── Shared Field helper ──────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-fg-muted">{label}</label>
      {children}
    </div>
  );
}
