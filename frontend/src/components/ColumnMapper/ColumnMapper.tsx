import React, { useState, useEffect, useMemo, useCallback } from 'react';
import clsx from 'clsx';
import {
  Columns,
  ChevronDown,
  Check,
  AlertCircle,
  Sparkles,
  ArrowRight,
  Hash,
  Activity,
  Clock,
  User,
  DollarSign,
  Layers,
  Rocket,
} from 'lucide-react';

interface ColumnMapping {
  case_id: string;
  activity: string;
  timestamp: string;
  resource?: string;
  cost?: string;
  additional_columns?: string[];
}

interface ColumnMapperProps {
  eventLogId: string;
  columns: string[];
  sampleRows: Record<string, unknown>[];
  onMappingComplete: (mapping: ColumnMapping) => void;
  /** Optional per-field confidence scores (0–1) from the parent's name-based
   *  auto-mapper. When provided they replace the plain "Auto-detected" badge
   *  with a percentage pill, matching the Mehrwerk mpmX pattern. */
  confidenceScores?: Partial<Record<'case_id' | 'activity' | 'timestamp' | 'resource' | 'cost', number>>;
}

const HINTS: Record<string, string[]> = {
  case_id: ['case', 'id', 'order', 'ticket', 'case_id', 'caseid', 'incident', 'request'],
  activity: ['activity', 'event', 'action', 'status', 'step', 'task', 'stage'],
  timestamp: ['time', 'date', 'timestamp', 'created', 'datetime', 'start', 'end'],
  resource: ['resource', 'user', 'agent', 'employee', 'assigned', 'worker', 'operator', 'performer'],
  cost: ['cost', 'price', 'amount', 'value', 'fee', 'total'],
};

// ISO-8601 / common date patterns used by content-based timestamp detection
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const EPOCH_MILLIS_RE = /^1[0-9]{12}$/;
const EPOCH_SECS_RE = /^1[0-9]{9}$/;

function looksLikeTimestamp(value: string): boolean {
  const v = String(value).trim();
  return ISO_TIMESTAMP_RE.test(v) || EPOCH_MILLIS_RE.test(v) || EPOCH_SECS_RE.test(v);
}

function looksLikeUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value).trim()
  );
}

type Scored = { col: string; score: number };

/** Content-based column inference WITH confidence scores.
 *
 * Scans up to 20 sample rows and returns a best guess + score for each XES
 * role from the DATA (not the column name) — so anonymised/renamed exports
 * (col_a, F1, …) still get a real signal. Runs ALWAYS, in parallel with
 * name-based detection; the two are reconciled by combineDetect().
 */
function contentInfer(
  columns: string[],
  sampleRows: Record<string, unknown>[],
  exclude: Set<string>
): Partial<Record<'case_id' | 'activity' | 'timestamp', Scored>> {
  const candidates = columns.filter((c) => !exclude.has(c));
  const maxRows = Math.min(sampleRows.length, 20);
  const out: Partial<Record<'case_id' | 'activity' | 'timestamp', Scored>> = {};
  if (maxRows === 0) return out;

  const sampleOf = (col: string) =>
    sampleRows.slice(0, maxRows).map((r) => String(r[col] ?? ''));

  // Timestamp: fraction of values parsing as ISO-8601 / epoch (>= 0.6).
  for (const col of candidates) {
    const values = sampleOf(col);
    const ratio = values.filter(looksLikeTimestamp).length / values.length;
    if (ratio >= 0.6 && (!out.timestamp || ratio > out.timestamp.score)) {
      out.timestamp = { col, score: ratio };
    }
  }

  // Case ID: UUID fraction, or per-sample uniqueness (each row distinct —
  // the classic case-id signature).
  for (const col of candidates) {
    if (col === out.timestamp?.col) continue;
    const values = sampleOf(col);
    const uuidRatio = values.filter(looksLikeUUID).length / values.length;
    const uniqueRatio = new Set(values).size / values.length;
    const score = Math.max(uuidRatio, uniqueRatio >= 1 ? uniqueRatio : 0);
    if (score >= 0.5 && (!out.case_id || score > out.case_id.score)) {
      out.case_id = { col, score };
    }
  }

  // Activity: low-cardinality string column. Weak signal -> capped at 0.7.
  for (const col of candidates) {
    if (col === out.timestamp?.col || col === out.case_id?.col) continue;
    const values = sampleOf(col);
    const unique = new Set(values).size;
    if (unique > 1 && unique <= Math.max(3, values.length * 0.4)) {
      const score = Math.min(0.7, 0.4 + (1 - unique / values.length) * 0.5);
      if (!out.activity || score > out.activity.score) {
        out.activity = { col, score };
      }
    }
  }
  return out;
}

/** Name-based detection with a confidence score (exact match strongest). */
function scoredNameDetect(
  columns: string[],
  hints: string[],
  exclude: Set<string>
): Scored | null {
  const avail = columns.filter((c) => !exclude.has(c));
  const lower = avail.map((c) => c.toLowerCase());
  for (const hint of hints) {
    const i = lower.indexOf(hint);
    if (i !== -1) return { col: avail[i], score: 0.9 }; // exact
  }
  for (const hint of hints) {
    const i = lower.findIndex((c) => c.includes(hint));
    if (i !== -1) return { col: avail[i], score: 0.55 }; // partial
  }
  return null;
}

/** Reconcile a name guess and a content guess for one field. Agreement boosts
 *  confidence; disagreement trusts the (intentional) column name; a
 *  content-only guess is kept but stays low (and is flagged "review"). */
function combineDetect(name: Scored | null, content: Scored | null): Scored | null {
  if (name && content) {
    if (name.col === content.col) {
      return { col: name.col, score: Math.min(1, Math.max(name.score, content.score) + 0.15) };
    }
    return name;
  }
  return name ?? content ?? null;
}

function autoDetectColumn(columns: string[], hints: string[]): string | null {
  const lowerColumns = columns.map((c) => c.toLowerCase());

  // Exact match first
  for (const hint of hints) {
    const idx = lowerColumns.indexOf(hint);
    if (idx !== -1) return columns[idx];
  }

  // Partial match
  for (const hint of hints) {
    const idx = lowerColumns.findIndex((c) => c.includes(hint));
    if (idx !== -1) return columns[idx];
  }

  return null;
}

interface MappingDropdownProps {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  columns: string[];
  required?: boolean;
  autoDetected?: boolean;
  /** 0–1 confidence score from name-based mapper; renders a percentage pill
   *  instead of the plain "Auto-detected" label when non-zero. */
  confidenceScore?: number;
  error?: string;
  description?: string;
  disabledColumns?: string[];
}

const MappingDropdown: React.FC<MappingDropdownProps> = ({
  label,
  icon,
  value,
  onChange,
  columns,
  required = false,
  autoDetected = false,
  confidenceScore,
  error,
  description,
  disabledColumns = [],
}) => {
  const showBadge = autoDetected && value;
  const pct = confidenceScore !== undefined ? Math.round(confidenceScore * 100) : 0;
  const badgeTone =
    pct >= 70
      ? 'bg-success/10 text-success border-success/20'
      : pct >= 40
        ? 'bg-warning/10 text-warning border-warning/20'
        : 'bg-accent/10 text-accent border-line';

  return (
  <div>
    <div className="flex items-center justify-between mb-1.5">
      <label className="flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
        {icon}
        {label}
        {required && <span className="text-danger">*</span>}
      </label>
      {showBadge && (
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeTone}`}
          title="Auto-mapping confidence"
        >
          <Sparkles className="w-3 h-3" />
          {pct > 0 ? `${pct < 40 ? 'review' : 'auto'} · ${pct}%` : 'Auto-detected'}
        </span>
      )}
    </div>
    {description && (
      <p className="text-[12px] text-fg-faint mb-1.5">{description}</p>
    )}
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          'select w-full',
          error && 'border-danger/50 text-danger',
          !error && value && 'border-success/40'
        )}
      >
        <option value="">Select a column...</option>
        {columns.map((col) => (
          <option
            key={col}
            value={col}
            disabled={disabledColumns.includes(col)}
          >
            {col}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-faint pointer-events-none" />
      {value && !error && (
        <Check className="absolute right-8 top-1/2 -translate-y-1/2 w-4 h-4 text-success" />
      )}
    </div>
    {error && (
      <p className="flex items-center gap-1 mt-1 text-xs text-danger">
        <AlertCircle className="w-3 h-3" />
        {error}
      </p>
    )}
  </div>
  );
};

const ColumnMapper: React.FC<ColumnMapperProps> = ({
  eventLogId: _eventLogId,
  columns,
  sampleRows,
  onMappingComplete,
  confidenceScores,
}) => {
  const [caseId, setCaseId] = useState('');
  const [activity, setActivity] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [resource, setResource] = useState('');
  const [cost, setCost] = useState('');
  const [additionalColumns, setAdditionalColumns] = useState<string[]>([]);
  const [autoDetectedFields, setAutoDetectedFields] = useState<Set<string>>(
    new Set()
  );
  // Combined (name + content) confidence per field, 0–1. Drives the pills and
  // the "review" flag for low-confidence / content-only guesses.
  const [fieldConfidence, setFieldConfidence] = useState<Record<string, number>>({});

  // Auto-detect columns on mount. Name-based and content-based detection run
  // ALWAYS, in parallel, and are reconciled per field — so a renamed/anonymised
  // column (name score 0) still gets a real content-derived confidence.
  useEffect(() => {
    const detected = new Set<string>();
    const conf: Record<string, number> = {};
    const used = new Set<string>();

    // Required fields, in priority order, each combining name + content.
    const content = contentInfer(columns, sampleRows, new Set());
    const required: Array<['case_id' | 'activity' | 'timestamp', (v: string) => void]> = [
      ['case_id', setCaseId],
      ['activity', setActivity],
      ['timestamp', setTimestamp],
    ];
    for (const [field, setter] of required) {
      const name = scoredNameDetect(columns, HINTS[field], used);
      const cg = content[field];
      const contentGuess = cg && !used.has(cg.col) ? cg : null;
      const pick = combineDetect(name, contentGuess);
      if (pick && !used.has(pick.col)) {
        setter(pick.col);
        used.add(pick.col);
        detected.add(field);
        conf[field] = pick.score;
      }
    }

    // Optional fields stay name-based.
    const detectedResource = autoDetectColumn(
      columns.filter((c) => !used.has(c)),
      HINTS.resource
    );
    if (detectedResource) {
      setResource(detectedResource);
      used.add(detectedResource);
      detected.add('resource');
      conf.resource = 0.6;
    }

    const detectedCost = autoDetectColumn(
      columns.filter((c) => !used.has(c)),
      HINTS.cost
    );
    if (detectedCost) {
      setCost(detectedCost);
      used.add(detectedCost);
      detected.add('cost');
      conf.cost = 0.6;
    }

    setAutoDetectedFields(detected);
    setFieldConfidence(conf);
  }, [columns, sampleRows]);

  // Columns used by required/optional mappings
  const usedColumns = useMemo(
    () => [caseId, activity, timestamp, resource, cost].filter(Boolean),
    [caseId, activity, timestamp, resource, cost]
  );

  const remainingColumns = useMemo(
    () => columns.filter((c) => !usedColumns.includes(c)),
    [columns, usedColumns]
  );

  // Validation
  const errors = useMemo(() => {
    const errs: Record<string, string> = {};
    const selected = [caseId, activity, timestamp].filter(Boolean);
    const duplicates = selected.filter(
      (col, idx) => selected.indexOf(col) !== idx
    );

    if (duplicates.length > 0) {
      if (caseId && duplicates.includes(caseId))
        errs.case_id = 'Column already used for another field';
      if (activity && duplicates.includes(activity))
        errs.activity = 'Column already used for another field';
      if (timestamp && duplicates.includes(timestamp))
        errs.timestamp = 'Column already used for another field';
    }
    return errs;
  }, [caseId, activity, timestamp]);

  const isValid = caseId && activity && timestamp && Object.keys(errors).length === 0;

  // Quick stats preview
  const estimatedStats = useMemo(() => {
    if (!caseId || !activity || sampleRows.length === 0) return null;

    const caseIds = new Set(sampleRows.map((r) => r[caseId]));
    const activities = new Set(sampleRows.map((r) => r[activity]));

    return {
      estimatedCases: caseIds.size,
      estimatedActivities: activities.size,
      totalEvents: sampleRows.length,
    };
  }, [caseId, activity, sampleRows]);

  const disabledColumnsForRequired = useCallback(
    (currentField: string) => {
      return [caseId, activity, timestamp]
        .filter((c) => c && c !== currentField)
        .filter(Boolean) as string[];
    },
    [caseId, activity, timestamp]
  );

  const handleSubmit = () => {
    if (!isValid) return;
    const mapping: ColumnMapping = {
      case_id: caseId,
      activity,
      timestamp,
      ...(resource && { resource }),
      ...(cost && { cost }),
      ...(additionalColumns.length > 0 && {
        additional_columns: additionalColumns,
      }),
    };
    onMappingComplete(mapping);
  };

  const toggleAdditionalColumn = (col: string) => {
    setAdditionalColumns((prev) =>
      prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]
    );
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
            <Columns className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-fg">
              Map Your Event Log Columns
            </h2>
            <p className="text-[12px] text-fg-muted">
              Select which columns represent the case ID, activity, and
              timestamp in your data
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left: Mapping dropdowns */}
        <div className="space-y-6">
          {/* Required fields */}
          <div>
            <h3 className="text-xs font-semibold text-fg-faint uppercase tracking-wider mb-4">
              Required Fields
            </h3>
            <div className="space-y-4">
              <MappingDropdown
                label="Case ID"
                icon={<Hash className="w-4 h-4 text-accent" />}
                value={caseId}
                onChange={setCaseId}
                columns={columns}
                required
                autoDetected={autoDetectedFields.has('case_id')}
                confidenceScore={fieldConfidence.case_id ?? confidenceScores?.case_id}
                error={errors.case_id}
                description="Unique identifier for each process instance"
                disabledColumns={disabledColumnsForRequired(caseId)}
              />
              <MappingDropdown
                label="Activity"
                icon={<Activity className="w-4 h-4 text-accent" />}
                value={activity}
                onChange={setActivity}
                columns={columns}
                required
                autoDetected={autoDetectedFields.has('activity')}
                confidenceScore={fieldConfidence.activity ?? confidenceScores?.activity}
                error={errors.activity}
                description="The activity or step name in the process"
                disabledColumns={disabledColumnsForRequired(activity)}
              />
              <MappingDropdown
                label="Timestamp"
                icon={<Clock className="w-4 h-4 text-accent" />}
                value={timestamp}
                onChange={setTimestamp}
                columns={columns}
                required
                autoDetected={autoDetectedFields.has('timestamp')}
                confidenceScore={fieldConfidence.timestamp ?? confidenceScores?.timestamp}
                error={errors.timestamp}
                description="When the activity occurred"
                disabledColumns={disabledColumnsForRequired(timestamp)}
              />
            </div>
          </div>

          {/* Optional fields */}
          <div>
            <h3 className="text-xs font-semibold text-fg-faint uppercase tracking-wider mb-4">
              Optional Fields
            </h3>
            <div className="space-y-4">
              <MappingDropdown
                label="Resource"
                icon={<User className="w-4 h-4 text-fg-faint" />}
                value={resource}
                onChange={setResource}
                columns={columns}
                autoDetected={autoDetectedFields.has('resource')}
                confidenceScore={fieldConfidence.resource ?? confidenceScores?.resource}
                description="Who performed the activity"
              />
              <MappingDropdown
                label="Cost"
                icon={<DollarSign className="w-4 h-4 text-fg-faint" />}
                value={cost}
                onChange={setCost}
                columns={columns}
                autoDetected={autoDetectedFields.has('cost')}
                confidenceScore={fieldConfidence.cost ?? confidenceScores?.cost}
                description="Cost associated with the activity"
              />
            </div>
          </div>

          {/* Additional columns */}
          {remainingColumns.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-fg-faint uppercase tracking-wider mb-3">
                Additional Columns
              </h3>
              <p className="text-[12px] text-fg-faint mb-3">
                Include extra columns for filtering and analysis
              </p>
              <div className="flex flex-wrap gap-2">
                {remainingColumns.map((col) => (
                  <button
                    key={col}
                    onClick={() => toggleAdditionalColumn(col)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                      additionalColumns.includes(col)
                        ? 'bg-accent/10 text-accent border-line-strong'
                        : 'bg-surface-2 text-fg-muted border-line hover:border-line-strong hover:text-fg-secondary'
                    )}
                  >
                    {additionalColumns.includes(col) && (
                      <Check className="inline w-3 h-3 mr-1" />
                    )}
                    {col}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Preview */}
        <div className="space-y-4">
          {/* Data preview table */}
          <div className="bg-surface-2 rounded-xl border border-line overflow-hidden">
            <div className="px-4 py-3 border-b border-line bg-surface-1">
              <h3 className="text-sm font-semibold text-fg-secondary">
                Data Preview
              </h3>
              <p className="text-[12px] text-fg-faint">
                First {Math.min(sampleRows.length, 5)} rows of your data
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line">
                    {columns.map((col) => (
                      <th
                        key={col}
                        className={clsx(
                          'px-3 py-2 text-left font-semibold whitespace-nowrap',
                          col === caseId && 'bg-accent/10 text-accent',
                          col === activity && 'bg-accent/10 text-accent',
                          col === timestamp && 'bg-accent/10 text-accent',
                          col === resource && 'bg-success/10 text-success',
                          col === cost && 'bg-warning/10 text-warning',
                          !usedColumns.includes(col) && 'text-fg-muted'
                        )}
                      >
                        {col}
                        {col === caseId && (
                          <span className="ml-1 text-[10px] text-accent">
                            (Case ID)
                          </span>
                        )}
                        {col === activity && (
                          <span className="ml-1 text-[10px] text-accent/70">
                            (Activity)
                          </span>
                        )}
                        {col === timestamp && (
                          <span className="ml-1 text-[10px] text-accent">
                            (Timestamp)
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.slice(0, 5).map((row, i) => (
                    <tr
                      key={i}
                      className="border-b border-line last:border-0"
                    >
                      {columns.map((col) => (
                        <td
                          key={col}
                          className={clsx(
                            'px-3 py-2 whitespace-nowrap',
                            col === caseId && 'bg-accent/5 font-medium text-accent-hover',
                            col === activity && 'bg-accent/5 font-medium text-accent',
                            col === timestamp && 'bg-accent/5 text-accent',
                            col === resource && 'bg-success/5 text-success',
                            col === cost && 'bg-warning/5 text-warning',
                            !usedColumns.includes(col) && 'text-fg-muted'
                          )}
                        >
                          {String(row[col] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Process preview stats */}
          {estimatedStats && (
            <div className="bg-accent/10 rounded-xl border border-line p-4">
              <h3 className="text-sm font-semibold text-fg mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4 text-accent" />
                Quick Preview (from sample)
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center">
                  <p className="text-2xl font-bold text-accent">
                    {estimatedStats.estimatedCases}
                  </p>
                  <p className="text-[12px] text-fg-muted">Cases</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-accent">
                    {estimatedStats.totalEvents}
                  </p>
                  <p className="text-[12px] text-fg-muted">Events</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-accent">
                    {estimatedStats.estimatedActivities}
                  </p>
                  <p className="text-[12px] text-fg-muted">Activities</p>
                </div>
              </div>
            </div>
          )}

          {/* Mapping summary */}
          <div className="bg-surface-2 rounded-xl border border-line p-4">
            <h3 className="text-sm font-semibold text-fg-secondary mb-3">
              Mapping Summary
            </h3>
            <div className="space-y-2">
              {[
                { label: 'Case ID', value: caseId, required: true },
                { label: 'Activity', value: activity, required: true },
                { label: 'Timestamp', value: timestamp, required: true },
                { label: 'Resource', value: resource, required: false },
                { label: 'Cost', value: cost, required: false },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between py-1.5"
                >
                  <span className="text-[12px] text-fg-muted">
                    {item.label}
                    {item.required && (
                      <span className="text-danger ml-0.5">*</span>
                    )}
                  </span>
                  {item.value ? (
                    <span className="text-sm font-medium text-fg flex items-center gap-1">
                      <Check className="w-3.5 h-3.5 text-success" />
                      {item.value}
                    </span>
                  ) : (
                    <span className="text-sm text-fg-ghost italic">
                      Not set
                    </span>
                  )}
                </div>
              ))}
              {additionalColumns.length > 0 && (
                <div className="flex items-start justify-between py-1.5 border-t border-line">
                  <span className="text-[12px] text-fg-muted">Additional</span>
                  <span className="text-[12px] text-fg-muted text-right max-w-[200px]">
                    {additionalColumns.join(', ')}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Submit */}
      <div className="mt-8 flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={!isValid}
          className={clsx(
            'flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-semibold transition-all',
            isValid
              ? 'btn-primary'
              : 'bg-tint text-fg-faint cursor-not-allowed'
          )}
        >
          <Rocket className="w-4 h-4" />
          Start Mining
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default ColumnMapper;
