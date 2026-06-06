import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Upload,
  Plus,
  Trash2,
  ArrowRight,
  Wand2,
  Database,
  GitMerge,
  Link2,
  Info,
  Boxes,
  Package,
  X,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { logBuilder } from '@/api/client';
import type { ProcessRecipe, SuggestMappingResponse } from '@/api/logBuilder';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore } from '@/store';
import type {
  LogBuilderColumn,
  LogBuilderJoin,
  LogBuilderUploadResponse,
} from '@/types';

type JoinHow = NonNullable<LogBuilderJoin['how']>;

// One uploaded staging table. The first source is the "primary" table; every
// later source carries the join that brings it onto the assembled wide table.
interface SourceTable {
  id: number;
  preview: LogBuilderUploadResponse & { file_name?: string };
  // Join config (ignored for the primary source — index 0).
  joinLeftOn: string;
  joinRightOn: string;
  joinHow: JoinHow;
}

// A column on the assembled wide table, tagged with the source it came from so
// the UI can show provenance. ``name`` already includes any pandas merge suffix.
interface WideColumn extends LogBuilderColumn {
  sourceId: number;
  sourceLabel: string;
  // Original (unsuffixed) column name on its own source — used to read sample
  // values when building the joined preview.
  originalName: string;
}

interface EventMapping {
  id: number;
  activity_name: string;
  timestamp_column: string;
}

// Standard = one row per case → a classic (case-centric) event log.
// OCEL = each chosen wide-table column becomes an object type → an
// object-centric event log, navigated to via /ocpm/:id.
type BuildMode = 'standard' | 'ocel';

const KIND_COLORS: Record<string, string> = {
  datetime: 'badge-accent',
  datetime_like: 'badge-accent',
  numeric: 'badge-emerald',
  text: 'badge-slate',
};

const JOIN_HOWS: { value: JoinHow; label: string }[] = [
  { value: 'left', label: 'Left (keep all primary rows)' },
  { value: 'inner', label: 'Inner (only matched rows)' },
  { value: 'right', label: 'Right (keep all joined rows)' },
  { value: 'outer', label: 'Outer (keep everything)' },
];

const RIGHT_SUFFIX = '_right';

function sourceLabel(s: SourceTable, index: number): string {
  return s.preview.file_name || `Source ${index + 1}`;
}

export default function EventLogBuilderPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addSourceInputRef = useRef<HTMLInputElement>(null);

  const [sources, setSources] = useState<SourceTable[]>([]);
  const [uploading, setUploading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [logName, setLogName] = useState('Built log');
  const [buildMode, setBuildMode] = useState<BuildMode>('standard');
  const [caseIdColumn, setCaseIdColumn] = useState('');
  // OCEL mode: each selected wide-table column becomes one OCEL object type.
  const [objectTypeColumns, setObjectTypeColumns] = useState<string[]>([]);
  const [resourceColumn, setResourceColumn] = useState<string>('');
  const [events, setEvents] = useState<EventMapping[]>([]);
  const [passthrough, setPassthrough] = useState<string[]>([]);
  const [nextId, setNextId] = useState(1);
  const [nextSourceId, setNextSourceId] = useState(1);

  // ── AI mapping suggestion ────────────────────────────────────────────────────
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<SuggestMappingResponse | null>(null);
  const [aiSuggestError, setAiSuggestError] = useState<string | null>(null);

  // ── Process content packs (recipes) ─────────────────────────────────────────
  // A recipe pre-fills the builder's process scaffold (events, case id, joins,
  // passthrough columns) using the recipe's *logical* table/column names. The
  // user then maps those onto the columns of their actual uploaded data and the
  // selected recipe id is sent to the backend so it provisions the pack's
  // alerts / KPIs / reference model on a successful build.
  const [recipes, setRecipes] = useState<ProcessRecipe[]>([]);
  const [recipesLoaded, setRecipesLoaded] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string>('');

  const selectedRecipe = useMemo(
    () => recipes.find((r) => r.id === selectedRecipeId) ?? null,
    [recipes, selectedRecipeId],
  );

  useEffect(() => {
    let cancelled = false;
    logBuilder
      .getTemplates()
      .then((rs) => {
        if (!cancelled) setRecipes(rs);
      })
      .catch(() => {
        // Recipes are a best-effort onboarding aid; manual building still works.
      })
      .finally(() => {
        if (!cancelled) setRecipesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isMultiSource = sources.length > 1;

  // Assemble the wide-table column list by sequentially "merging" each source's
  // columns onto the accumulator, mirroring pandas' default ["", "_right"]
  // suffixing so the names match what the backend produces after the joins.
  const wideColumns = useMemo<WideColumn[]>(() => {
    const out: WideColumn[] = [];
    const seen = new Set<string>();
    sources.forEach((s, idx) => {
      const label = sourceLabel(s, idx);
      s.preview.columns.forEach((c) => {
        // Primary source keeps original names; later sources get _right on collision.
        const name = idx > 0 && seen.has(c.name) ? `${c.name}${RIGHT_SUFFIX}` : c.name;
        seen.add(name);
        out.push({ ...c, name, originalName: c.name, sourceId: s.id, sourceLabel: label });
      });
    });
    return out;
  }, [sources]);

  const datetimeColumns = useMemo(
    () => wideColumns.filter((c) => c.kind === 'datetime' || c.kind === 'datetime_like'),
    [wideColumns],
  );

  // Build a client-side preview of the joined wide table from each source's
  // sample rows. This is a best-effort, in-memory left/inner join purely for
  // the UI — the real join happens server-side at build time.
  // NOTE: preview assumes a unique right-hand key (first match wins). When the
  // right key is non-unique, the build step will validate/handle it; this
  // preview does NOT reflect that fan-out.
  const joinedSample = useMemo<{ rows: Record<string, unknown>[]; nonUniqueKeys: boolean }>(() => {
    if (sources.length === 0) return { rows: [], nonUniqueKeys: false };
    let rows: Record<string, unknown>[] = (sources[0].preview.sample_rows || []).map((r) => ({
      ...r,
    }));
    let nonUniqueKeys = false;
    for (let i = 1; i < sources.length; i++) {
      const src = sources[i];
      const leftKey = src.joinLeftOn;
      const rightKey = src.joinRightOn;
      const rightRows = src.preview.sample_rows || [];
      const rightColumns = src.preview.columns.map((c) => c.name);
      // Index right rows by the join key (first match per key — preview only).
      const index = new Map<string, Record<string, unknown>>();
      if (rightKey) {
        for (const rr of rightRows) {
          const k = String((rr as Record<string, unknown>)[rightKey] ?? '');
          if (index.has(k)) {
            nonUniqueKeys = true;
          } else {
            index.set(k, rr as Record<string, unknown>);
          }
        }
      }
      rows = rows.map((lr) => {
        const merged: Record<string, unknown> = { ...lr };
        const match = leftKey && rightKey ? index.get(String(lr[leftKey] ?? '')) : undefined;
        for (const col of rightColumns) {
          const target = col in merged ? `${col}${RIGHT_SUFFIX}` : col;
          merged[target] = match ? (match as Record<string, unknown>)[col] : null;
        }
        return merged;
      });
    }
    return { rows, nonUniqueKeys };
  }, [sources]);

  const resetAll = () => {
    setSources([]);
    setEvents([]);
    setPassthrough([]);
    setCaseIdColumn('');
    setObjectTypeColumns([]);
    setResourceColumn('');
    setNextId(1);
    setNextSourceId(1);
    setLogName('Built log');
    setSelectedRecipeId('');
    setAiSuggestion(null);
    setAiSuggestError(null);
  };

  // Apply a content pack: pre-fill the editable process scaffold from the
  // recipe. The recipe uses logical column names (e.g. "case_id", "po_created_at")
  // which the user re-points to their own uploaded columns. Recipes are
  // case-centric, so applying one also switches to standard build mode.
  const applyRecipe = (recipe: ProcessRecipe) => {
    setSelectedRecipeId(recipe.id);
    setBuildMode('standard');
    setLogName(recipe.process_name || 'Built log');
    setCaseIdColumn(recipe.case_id_column || '');
    const mappedEvents = recipe.events.map((e, i) => ({
      id: i + 1,
      activity_name: e.activity_name,
      timestamp_column: e.timestamp_column,
    }));
    setEvents(mappedEvents);
    setNextId(mappedEvents.length + 1);
    // additional_columns is a {column: role} map of extra fields the pack carries
    // through to the log; seed them as passthrough columns.
    setPassthrough(Object.keys(recipe.additional_columns || {}));
    // First event with a resource column hints the resource designation.
    const resHint = recipe.events.find((e) => e.resource_column)?.resource_column;
    if (resHint) setResourceColumn(resHint);
  };

  const clearRecipe = () => {
    setSelectedRecipeId('');
  };

  // Apply an AI suggestion's output: pre-fill case_id, resource, and event rows.
  // Called both automatically (after primary upload, standard mode, no recipe)
  // and manually via the "Suggest mapping with AI" button.
  const applySuggestion = (s: SuggestMappingResponse, currentWideColumns: WideColumn[]) => {
    const colNames = new Set(currentWideColumns.map((c) => c.name));
    if (s.case_id_column && colNames.has(s.case_id_column)) {
      setCaseIdColumn(s.case_id_column);
    }
    if (s.resource_column && colNames.has(s.resource_column)) {
      setResourceColumn(s.resource_column);
    }
    // Timestamp-ish columns suggested by the AI as event timestamps.
    // activity_column from the AI maps to the activity_name label; timestamp to
    // the timestamp column. If the AI only named a timestamp column we fall back
    // to using the datetime columns (same as the manual heuristic).
    const tsColName = s.timestamp_column && colNames.has(s.timestamp_column)
      ? s.timestamp_column
      : null;
    const actColName = s.activity_column && colNames.has(s.activity_column)
      ? s.activity_column
      : null;

    if (tsColName) {
      const mapped: EventMapping[] = [
        {
          id: 1,
          activity_name: actColName ? humanize(actColName) : humanize(tsColName),
          timestamp_column: tsColName,
        },
      ];
      // Supplement with remaining datetime columns (up to 6 total).
      const dtCols = currentWideColumns.filter(
        (c) => (c.kind === 'datetime' || c.kind === 'datetime_like') && c.name !== tsColName,
      );
      dtCols.slice(0, 5).forEach((c, i) => {
        mapped.push({ id: i + 2, activity_name: humanize(c.name), timestamp_column: c.name });
      });
      setEvents(mapped);
      setNextId(mapped.length + 1);
    }
  };

  // Call /log-builder/suggest-mapping and, if in standard mode with no recipe,
  // auto-apply the result. Otherwise just store it so the user can apply it.
  const callSuggestMapping = async (
    stagingPath: string,
    currentWideColumns: WideColumn[],
    autoApply: boolean,
  ) => {
    setAiSuggesting(true);
    setAiSuggestError(null);
    try {
      const suggestion = await logBuilder.suggestMapping({ staging_path: stagingPath });
      setAiSuggestion(suggestion);
      if (autoApply) {
        applySuggestion(suggestion, currentWideColumns);
      }
    } catch (err: unknown) {
      setAiSuggestError(errMsg(err));
    } finally {
      setAiSuggesting(false);
    }
  };

  // Upload the very first (primary) source and auto-suggest a mapping.
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    // Clear any previous AI suggestion state when a new file is uploaded.
    setAiSuggestion(null);
    setAiSuggestError(null);
    try {
      const r = await logBuilder.uploadRaw(file);
      const sid = nextSourceId;
      const newSource: SourceTable = { id: sid, preview: r, joinLeftOn: '', joinRightOn: '', joinHow: 'left' };
      setSources([newSource]);
      setNextSourceId(sid + 1);

      // When a content pack is active its process scaffold takes precedence —
      // don't overwrite the recipe's events/case-id with auto-detection.
      if (selectedRecipeId) return;

      // Build the wide-column list for the new single source (mirrors wideColumns memo).
      const initialWideColumns: WideColumn[] = r.columns.map((c) => ({
        ...c,
        sourceId: sid,
        sourceLabel: file.name || `Source 1`,
        originalName: c.name,
      }));

      if (buildMode === 'standard') {
        // Fire AI suggestion and auto-apply in standard mode (no recipe).
        // The heuristic fallback is handled server-side; we never block the upload.
        void callSuggestMapping(r.staging_path, initialWideColumns, true);
      } else {
        // OCEL mode: still seed a simple heuristic so the user has something to start with.
        const tsCols = r.columns.filter((c) => c.kind === 'datetime' || c.kind === 'datetime_like');
        const mapped = tsCols.slice(0, 6).map((c, i) => ({
          id: i + 1,
          activity_name: humanize(c.name),
          timestamp_column: c.name,
        }));
        setEvents(mapped);
        setNextId(mapped.length + 1);
      }
    } catch (err: unknown) {
      addNotification({ type: 'error', title: 'Upload failed', message: errMsg(err) });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Upload an additional source to join onto the assembled table.
  const handleAddSource = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const r = await logBuilder.uploadRaw(file);
      const sid = nextSourceId;
      // Auto-suggest join keys: find a column the new source shares with the
      // current assembled table (matched by original/unsuffixed name). The
      // left key must use the wide-table name (which may carry a _right suffix
      // from a previous join), not the original source name.
      const sharedRight = r.columns.find((c) =>
        wideColumns.some((wc) => wc.originalName === c.name),
      );
      const sharedLeftWide = sharedRight
        ? wideColumns.find((wc) => wc.originalName === sharedRight.name)
        : undefined;
      setSources((prev) => [
        ...prev,
        {
          id: sid,
          preview: r,
          joinLeftOn: sharedLeftWide?.name ?? '',
          joinRightOn: sharedRight?.name ?? '',
          joinHow: 'left',
        },
      ]);
      setNextSourceId(sid + 1);
    } catch (err: unknown) {
      addNotification({ type: 'error', title: 'Upload failed', message: errMsg(err) });
    } finally {
      setUploading(false);
      if (addSourceInputRef.current) addSourceInputRef.current.value = '';
    }
  };

  const removeSource = (id: number) => {
    setSources((prev) => {
      const next = prev.filter((s) => s.id !== id);
      // If the primary was removed, fall back to a full reset for simplicity.
      if (next.length === 0) return [];
      return next;
    });
  };

  const updateJoin = (id: number, field: 'joinLeftOn' | 'joinRightOn' | 'joinHow', value: string) =>
    setSources((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, [field]: field === 'joinHow' ? (value as JoinHow) : value }
          : s,
      ),
    );

  const addEvent = () => {
    setEvents([...events, { id: nextId, activity_name: '', timestamp_column: '' }]);
    setNextId(nextId + 1);
  };

  const removeEvent = (id: number) => setEvents(events.filter((e) => e.id !== id));

  const updateEvent = (id: number, field: keyof EventMapping, value: string) =>
    setEvents(events.map((e) => (e.id === id ? { ...e, [field]: value } : e)));

  const togglePassthrough = (col: string) =>
    setPassthrough((p) => (p.includes(col) ? p.filter((c) => c !== col) : [...p, col]));

  const toggleObjectType = (col: string) =>
    setObjectTypeColumns((p) => (p.includes(col) ? p.filter((c) => c !== col) : [...p, col]));

  // Every additional source must have valid join keys before we can build.
  const joinsConfigured = sources
    .slice(1)
    .every((s) => s.joinLeftOn && s.joinRightOn);

  const isOcel = buildMode === 'ocel';

  // Designation differs by mode: standard needs a single case id, OCEL needs at
  // least one object-type column. Activity + timestamp (events) are required in
  // both modes.
  const designationReady = isOcel ? objectTypeColumns.length > 0 : !!caseIdColumn;

  const canBuild =
    sources.length > 0 &&
    joinsConfigured &&
    designationReady &&
    events.length > 0 &&
    events.every((e) => e.activity_name && e.timestamp_column) &&
    !!logName;

  const handleBuild = async () => {
    if (!canBuild || !projectId || sources.length === 0) return;
    setBuilding(true);
    try {
      const primary = sources[0];
      const additional = sources.slice(1);
      // additional_sources is indexed 0-based; join.right_source references it.
      const additional_sources = additional.map((s) => s.preview.staging_path);
      const joins: LogBuilderJoin[] = additional.map((s, i) => ({
        right_source: i,
        left_on: [s.joinLeftOn],
        right_on: [s.joinRightOn],
        how: s.joinHow,
      }));

      const r = await logBuilder.build({
        project_id: projectId,
        name: logName,
        staging_path: primary.preview.staging_path,
        events: events.map((e) => ({
          activity_name: e.activity_name,
          timestamp_column: e.timestamp_column,
        })),
        resource_column: resourceColumn || null,
        passthrough_columns: passthrough,
        ...(isMultiSource ? { additional_sources, joins } : {}),
        ...(isOcel
          ? // OCEL mode: case_id is ignored server-side; designate object types.
            { ocel_mode: true, object_type_columns: objectTypeColumns }
          : {
              case_id_column: caseIdColumn,
              // Recipes are case-centric; only attach in standard mode.
              ...(selectedRecipeId ? { recipe_id: selectedRecipeId } : {}),
            }),
      });

      if (isOcel) {
        const ocelId = r.ocel_id;
        if (!ocelId) throw new Error('Build succeeded but no OCEL id was returned');
        addNotification({
          type: 'success',
          title: `Built OCEL: ${r.event_count ?? 0} events · ${r.object_count ?? 0} objects`,
        });
        navigate(`/ocpm/${ocelId}`);
      } else {
        addNotification({ type: 'success', title: `Built event log: ${r.total_events} events` });
        // Surface what the content pack provisioned, if anything.
        if (r.recipe_applied) {
          const { alerts_created, kpis_created, reference_model_attached } = r.recipe_applied;
          const packName = selectedRecipe?.process_name ?? 'content pack';
          const parts = [`${alerts_created} alert${alerts_created === 1 ? '' : 's'}`, `${kpis_created} KPI${kpis_created === 1 ? '' : 's'}`];
          addNotification({
            type: 'success',
            title: `Applied ${packName}`,
            message: `Created ${parts.join(' + ')}${reference_model_attached ? ' · reference model attached for conformance' : ''}.`,
            duration: 8000,
          });
        }
        navigate(`/process/${r.event_log_id}`);
      }
    } catch (err: unknown) {
      addNotification({ type: 'error', title: 'Build failed', message: errMsg(err) });
    } finally {
      setBuilding(false);
    }
  };

  if (uploading) return <LoadingSpinner size="lg" text="Uploading..." fullPage />;

  const primary = sources[0];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Event Log Builder"
        icon={Wand2}
        description="Turn one or more wide tables with timestamp columns into a standard or object-centric (OCEL) event log"
        backTo={-1}
      />

      {!primary ? (
        <div className="rounded-lg border-2 border-dashed border-line bg-surface-1 p-12 text-center">
          <Upload size={32} className="mx-auto text-fg-faint" />
          <p className="mt-3 text-[13px] text-fg-muted">Upload a raw table (CSV, Parquet, or Excel)</p>
          <p className="mt-1 text-[11px] text-fg-faint">
            Start with one row per case and timestamp columns for each step. You can join in more
            tables afterwards.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.parquet,.xlsx,.xls"
            onChange={handleUpload}
            className="hidden"
          />
          <button onClick={() => fileInputRef.current?.click()} className="btn-primary mt-4">
            Choose file
          </button>
        </div>
      ) : (
        <>
          {/* ── Step 1: Sources ─────────────────────────────────────────── */}
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database size={14} className="text-accent" />
                <h2 className="text-[13px] font-semibold text-fg">Source tables</h2>
                {isMultiSource && (
                  <span className="badge badge-accent">{sources.length} joined</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={addSourceInputRef}
                  type="file"
                  accept=".csv,.parquet,.xlsx,.xls"
                  onChange={handleAddSource}
                  className="hidden"
                />
                <button
                  onClick={() => addSourceInputRef.current?.click()}
                  className="btn-ghost flex items-center gap-1 text-[11px]"
                >
                  <Plus size={12} /> Add another source
                </button>
                <button onClick={resetAll} className="btn-ghost text-[11px]">
                  Start over
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {sources.map((s, idx) => (
                <div key={s.id}>
                  {idx > 0 && (
                    <JoinEditor
                      source={s}
                      // Columns available on the left (assembled-so-far) table.
                      leftColumns={wideColumns.filter((c) =>
                        sources.slice(0, idx).some((ps) => ps.id === c.sourceId),
                      )}
                      onChange={(field, value) => updateJoin(s.id, field, value)}
                    />
                  )}
                  <div className="rounded border border-line bg-tint/20 p-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className="badge badge-slate">
                          {idx === 0 ? 'Primary' : `Source ${idx + 1}`}
                        </span>
                        <div>
                          <div className="text-[12px] font-semibold text-fg">
                            {sourceLabel(s, idx)}
                          </div>
                          <div className="text-[10px] text-fg-faint">
                            {s.preview.total_rows.toLocaleString()} rows ·{' '}
                            {s.preview.columns.length} columns
                          </div>
                        </div>
                      </div>
                      {idx > 0 && (
                        <button
                          onClick={() => removeSource(s.id)}
                          className="btn-ghost p-1 text-danger"
                          title="Remove this source"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.preview.columns.slice(0, 16).map((c) => (
                        <span
                          key={c.name}
                          className={`badge ${KIND_COLORS[c.kind] || 'badge-slate'}`}
                          title={`${c.kind} · ${c.nunique} unique`}
                        >
                          {c.name}
                        </span>
                      ))}
                      {s.preview.columns.length > 16 && (
                        <span className="badge badge-slate">
                          +{s.preview.columns.length - 16} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Step 2: Wide-table preview ──────────────────────────────── */}
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <GitMerge size={14} className="text-accent" />
                <h2 className="text-[13px] font-semibold text-fg">
                  {isMultiSource ? 'Joined wide table' : 'Table preview'}
                </h2>
              </div>
              <p className="text-[11px] text-fg-faint">
                {wideColumns.length} columns
                {isMultiSource && (
                  <>
                    {' '}
                    · joined preview from samples
                  </>
                )}
              </p>
            </div>
            {isMultiSource && (
              <p className="mt-1 flex items-center gap-1 text-[10px] text-fg-faint">
                <Info size={11} /> Preview is computed from sample rows; the full join runs when you
                build.
                {joinedSample.nonUniqueKeys && (
                  <span className="ml-1 text-amber-500">
                    · right-key is non-unique in the sample — preview shows first match per key only
                  </span>
                )}
              </p>
            )}

            <div className="mt-3 overflow-x-auto rounded border border-line">
              <table className="w-full text-[10px]">
                <thead className="bg-tint/40 text-fg-faint">
                  <tr>
                    {wideColumns.slice(0, 14).map((c) => (
                      <th key={c.name} className="px-2 py-1.5 text-left">
                        <div className="text-[11px] font-semibold text-fg">{c.name}</div>
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className={`badge ${KIND_COLORS[c.kind] || 'badge-slate'}`}>
                            {c.kind}
                          </span>
                          <span className="text-fg-faint">{c.nunique}u</span>
                        </div>
                        {isMultiSource && (
                          <div className="mt-0.5 truncate text-[9px] text-fg-faint">
                            {c.sourceLabel}
                          </div>
                        )}
                      </th>
                    ))}
                    {wideColumns.length > 14 && (
                      <th className="px-2 py-1.5 text-left text-[10px] text-fg-faint">
                        +{wideColumns.length - 14}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {joinedSample.rows.slice(0, 6).map((row, i) => (
                    <tr key={i} className="border-t border-line">
                      {wideColumns.slice(0, 14).map((c) => (
                        <td key={c.name} className="px-2 py-1 text-fg-muted">
                          {String(row[c.name] ?? '').slice(0, 40)}
                        </td>
                      ))}
                      {wideColumns.length > 14 && <td className="px-2 py-1 text-fg-faint">…</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Content pack (recipe) picker ────────────────────────────── */}
          {recipesLoaded && recipes.length > 0 && (
            <div className="rounded-lg border border-line bg-surface-1 p-4">
              <div className="mb-2 flex items-center gap-2">
                <Package size={14} className="text-accent" />
                <h2 className="text-[13px] font-semibold text-fg">Start from a content pack</h2>
                {selectedRecipe && <span className="badge badge-accent">{selectedRecipe.category}</span>}
              </div>
              <p className="mb-3 flex items-center gap-1 text-[11px] text-fg-faint">
                <Info size={11} /> A pack pre-fills the process scaffold below (events, case id,
                passthrough columns). It uses the pack's logical column names — re-point each one to
                your uploaded columns. Picking a pack also provisions its alerts, KPIs and reference
                model when you build.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input min-w-[260px] flex-1"
                  value={selectedRecipeId}
                  onChange={(e) => {
                    const next = recipes.find((r) => r.id === e.target.value);
                    if (next) applyRecipe(next);
                    else clearRecipe();
                  }}
                >
                  <option value="">— Build manually (no pack) —</option>
                  {recipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.process_name}
                      {r.connector_type ? ` · ${r.connector_type}` : ''}
                    </option>
                  ))}
                </select>
                {selectedRecipe && (
                  <button
                    onClick={clearRecipe}
                    className="btn-ghost flex items-center gap-1 text-[11px]"
                    title="Clear pack and build manually"
                  >
                    <X size={12} /> Clear pack
                  </button>
                )}
              </div>

              {selectedRecipe && (
                <div className="mt-3 space-y-2 rounded border border-accent/30 bg-accent/5 p-3">
                  {selectedRecipe.description && (
                    <p className="text-[11px] text-fg-muted">{selectedRecipe.description}</p>
                  )}
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
                      Tables this pack expects
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedRecipe.required_tables.map((t) => (
                        <span
                          key={t.name}
                          className="badge badge-slate"
                          title={`${t.role}${t.description ? ` — ${t.description}` : ''}${
                            t.source_hint ? ` · ${t.source_hint}` : ''
                          }`}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                    <p className="mt-1.5 flex items-center gap-1 text-[10px] text-fg-faint">
                      <Info size={11} /> Map your uploaded data onto these logical tables — upload the
                      table(s) above, then adjust the case id, events and join keys to your actual
                      column names below.
                    </p>
                  </div>
                  {selectedRecipe.sample_kpis.length > 0 && (
                    <div className="text-[10px] text-fg-faint">
                      Includes KPIs: {selectedRecipe.sample_kpis.join(', ')}
                    </div>
                  )}
                  {selectedRecipe.notes && (
                    <p className="text-[10px] text-fg-faint">{selectedRecipe.notes}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Mapping + events ────────────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-lg border border-line bg-surface-1 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-fg">Configuration</h2>
                {/* AI suggest button — standard mode only, no active recipe */}
                {!isOcel && !selectedRecipeId && sources.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      callSuggestMapping(
                        sources[0].preview.staging_path,
                        wideColumns,
                        true,
                      )
                    }
                    disabled={aiSuggesting}
                    className="btn-ghost flex items-center gap-1 text-[11px] disabled:opacity-50"
                    title="Let AI pre-fill the column mapping"
                  >
                    {aiSuggesting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Sparkles size={12} className="text-accent" />
                    )}
                    {aiSuggesting ? 'Suggesting…' : 'Suggest mapping with AI'}
                  </button>
                )}
              </div>

              {/* AI suggestion feedback strip */}
              {!isOcel && !selectedRecipeId && (aiSuggestion || aiSuggestError) && (
                <div
                  className={`mb-3 flex items-start gap-2 rounded border px-2.5 py-2 text-[11px] ${
                    aiSuggestError
                      ? 'border-danger/30 bg-danger/5 text-danger'
                      : 'border-accent/30 bg-accent/5 text-fg-muted'
                  }`}
                >
                  {aiSuggestError ? (
                    <Info size={12} className="mt-0.5 shrink-0 text-danger" />
                  ) : (
                    <Sparkles size={12} className="mt-0.5 shrink-0 text-accent" />
                  )}
                  <span>
                    {aiSuggestError
                      ? `AI suggestion failed: ${aiSuggestError}`
                      : aiSuggestion
                        ? `${aiSuggestion.source === 'llm' ? 'AI' : 'Heuristic'} suggested (confidence ${Math.round((aiSuggestion.confidence ?? 0) * 100)}%): ${aiSuggestion.rationale}`
                        : null}
                  </span>
                </div>
              )}

              <div className="space-y-3">
                <Field label="Log type">
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        { mode: 'standard' as const, icon: Database, label: 'Standard event log', hint: 'One case id' },
                        { mode: 'ocel' as const, icon: Boxes, label: 'Object-centric (OCEL)', hint: 'Multiple object types' },
                      ]
                    ).map(({ mode, icon: Icon, label, hint }) => {
                      const active = buildMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setBuildMode(mode)}
                          aria-pressed={active}
                          className={`flex flex-col items-start gap-0.5 rounded border px-3 py-2 text-left transition-colors ${
                            active
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-line text-fg-muted hover:border-accent/40'
                          }`}
                        >
                          <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                            <Icon size={13} /> {label}
                          </span>
                          <span className="text-[10px] text-fg-faint">{hint}</span>
                        </button>
                      );
                    })}
                  </div>
                </Field>
                <Field label="New event log name">
                  <input className="input w-full" value={logName} onChange={(e) => setLogName(e.target.value)} />
                </Field>
                {isOcel ? (
                  <Field label="Object types (one per column)">
                    <p className="mb-1.5 flex items-center gap-1 text-[10px] text-fg-faint">
                      <Info size={11} /> Each selected column becomes one OCEL object type. The case id
                      is not used in object-centric mode.
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {wideColumns.map((c) => {
                        const sel = objectTypeColumns.includes(c.name);
                        return (
                          <button
                            key={c.name}
                            type="button"
                            onClick={() => toggleObjectType(c.name)}
                            aria-pressed={sel}
                            className={`rounded border px-2 py-0.5 text-[10px] ${
                              sel ? 'border-accent bg-accent/10 text-accent' : 'border-line text-fg-muted'
                            }`}
                            title={isMultiSource ? c.sourceLabel : undefined}
                          >
                            {c.name}
                          </button>
                        );
                      })}
                    </div>
                    {objectTypeColumns.length > 0 && (
                      <p className="mt-1.5 text-[10px] text-fg-faint">
                        {objectTypeColumns.length} object type
                        {objectTypeColumns.length === 1 ? '' : 's'} selected
                      </p>
                    )}
                  </Field>
                ) : (
                  <Field
                    label="Case ID column"
                    hint={
                      aiSuggestion?.case_id_column === caseIdColumn && caseIdColumn
                        ? 'AI suggested'
                        : undefined
                    }
                  >
                    <select
                      className="input w-full"
                      value={caseIdColumn}
                      onChange={(e) => setCaseIdColumn(e.target.value)}
                    >
                      <option value="">— Select —</option>
                      {wideColumns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                          {isMultiSource ? ` (${c.sourceLabel})` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field
                  label="Resource column (optional)"
                  hint={
                    aiSuggestion?.resource_column === resourceColumn && resourceColumn
                      ? 'AI suggested'
                      : undefined
                  }
                >
                  <select
                    className="input w-full"
                    value={resourceColumn}
                    onChange={(e) => setResourceColumn(e.target.value)}
                  >
                    <option value="">— None —</option>
                    {wideColumns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                        {isMultiSource ? ` (${c.sourceLabel})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Passthrough columns (optional)">
                  <div className="flex flex-wrap gap-1">
                    {wideColumns
                      .filter(
                        (c) => c.name !== caseIdColumn && !events.find((e) => e.timestamp_column === c.name),
                      )
                      .map((c) => {
                        const sel = passthrough.includes(c.name);
                        return (
                          <button
                            key={c.name}
                            onClick={() => togglePassthrough(c.name)}
                            className={`rounded border px-2 py-0.5 text-[10px] ${
                              sel ? 'border-accent bg-accent/10 text-accent' : 'border-line text-fg-muted'
                            }`}
                          >
                            {c.name}
                          </button>
                        );
                      })}
                  </div>
                </Field>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface-1 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-fg">Events</h2>
                <button onClick={addEvent} className="btn-ghost flex items-center gap-1 text-[11px]">
                  <Plus size={12} /> Add event
                </button>
              </div>
              <div className="space-y-2">
                {events.length === 0 && (
                  <p className="py-4 text-center text-[11px] text-fg-faint">No events mapped yet</p>
                )}
                {events.map((ev) => (
                  <div key={ev.id} className="flex items-center gap-2 rounded border border-line bg-tint/20 p-2">
                    <input
                      className="input flex-1 text-[11px]"
                      placeholder="Activity name"
                      value={ev.activity_name}
                      onChange={(e) => updateEvent(ev.id, 'activity_name', e.target.value)}
                    />
                    <ArrowRight size={13} className="text-fg-faint" />
                    <select
                      className="input flex-1 text-[11px]"
                      value={ev.timestamp_column}
                      onChange={(e) => updateEvent(ev.id, 'timestamp_column', e.target.value)}
                    >
                      <option value="">— Timestamp column —</option>
                      {datetimeColumns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                          {isMultiSource ? ` (${c.sourceLabel})` : ''}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => removeEvent(ev.id)} className="btn-ghost p-1 text-danger">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            {!joinsConfigured && (
              <span className="text-[11px] text-amber-500">Set join keys for every added source</span>
            )}
            {joinsConfigured && isOcel && objectTypeColumns.length === 0 && (
              <span className="text-[11px] text-amber-500">Select at least one object-type column</span>
            )}
            <button
              onClick={handleBuild}
              disabled={!canBuild || building}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {isOcel ? <Boxes size={14} /> : <Wand2 size={14} />}
              {building
                ? 'Building...'
                : isOcel
                  ? 'Build as OCEL'
                  : 'Build event log'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Visual join editor: left table.column = right table.column, with join type.
function JoinEditor({
  source,
  leftColumns,
  onChange,
}: {
  source: SourceTable;
  leftColumns: WideColumn[];
  onChange: (field: 'joinLeftOn' | 'joinRightOn' | 'joinHow', value: string) => void;
}) {
  return (
    <div className="relative my-1 ml-3 rounded border border-dashed border-accent/40 bg-accent/5 p-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-accent">
        <GitMerge size={12} /> Join on
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-fg-faint">Assembled table</span>
          <select
            className="input text-[11px]"
            value={source.joinLeftOn}
            onChange={(e) => onChange('joinLeftOn', e.target.value)}
          >
            <option value="">— Column —</option>
            {leftColumns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Link2 size={13} className="text-fg-faint" />
        <div className="flex items-center gap-1">
          <span className="max-w-[120px] truncate text-[10px] text-fg-faint">
            {source.preview.file_name || 'New source'}
          </span>
          <select
            className="input text-[11px]"
            value={source.joinRightOn}
            onChange={(e) => onChange('joinRightOn', e.target.value)}
          >
            <option value="">— Column —</option>
            {source.preview.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <select
          className="input ml-auto text-[11px]"
          value={source.joinHow}
          onChange={(e) => onChange('joinHow', e.target.value)}
        >
          {JOIN_HOWS.map((h) => (
            <option key={h.value} value={h.value}>
              {h.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <label className="text-[11px] font-medium text-fg-muted">{label}</label>
        {hint && (
          <span className="flex items-center gap-0.5 rounded bg-accent/10 px-1 py-0.5 text-[9px] font-medium text-accent">
            <Sparkles size={9} />
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function errMsg(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (typeof detail === 'string') return detail;
  }
  return String(err);
}

function humanize(col: string): string {
  return (
    col
      .replace(/_at$|_ts$|_time$|_date$|_timestamp$/i, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .trim() || col
  );
}
