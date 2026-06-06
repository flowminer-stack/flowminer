// Types for SLA-aware Timed-Declare conformance.
//
// Mirrors backend/app/schemas/formal_methods.py exactly:
//   TimedConstraintType, BoundUnit, TimedConstraint, TimedDeclareRequest,
//   TimeToViolationStats, TimedConstraintResult, TimedDeclareResponse.

/**
 * Constraint templates supported by check_timed_declare. Every relation
 * carries an explicit time bound (the "SLA").
 *   response   — whenever A occurs, B must follow within T
 *   precedence — whenever B occurs, A must have preceded it within T
 *   existence  — A must occur within T of the case start
 *   absence    — A must NOT occur within T of the case start
 */
export type TimedConstraintType = 'response' | 'precedence' | 'existence' | 'absence';

export type BoundUnit = 'minutes' | 'hours' | 'days';

/** A single time-bounded DECLARE-style SLA constraint (request shape). */
export interface TimedConstraint {
  type: TimedConstraintType;
  activity_a: string;
  /** Required for binary templates (response, precedence); ignored for unary. */
  activity_b?: string | null;
  /** SLA window magnitude (T); must be > 0. */
  bound_value: number;
  bound_unit: BoundUnit;
  business_days: boolean;
  /** Optional human label so the UI can name a constraint. */
  label?: string | null;
}

/** Request body for POST /compliance/timed-declare/{event_log_id}. */
export interface TimedDeclareRequest {
  constraints: TimedConstraint[];
}

/**
 * Distribution of how long each violating obligation actually took
 * (or had elapsed by case end), measured in the constraint's bound_unit.
 */
export interface TimeToViolationStats {
  count: number;
  mean: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
  unit: string;
}

/** Conformance result for one timed constraint. */
export interface TimedConstraintResult {
  type: string;
  activity_a: string;
  activity_b: string | null;
  bound_value: number;
  bound_unit: string;
  business_days: boolean;
  label: string | null;
  narrative: string;

  /** Population the constraint was evaluated over (cases that activate it). */
  evaluated_cases: number;
  satisfied_cases: number;
  violating_cases: number;
  /** violating / evaluated (0.0 when none apply). */
  violation_rate: number;
  /** Bounded sample of violating case ids. */
  violating_case_ids: string[];
  time_to_violation: TimeToViolationStats;
}

/** Response body for the timed-declare conformance endpoint. */
export interface TimedDeclareResponse {
  total_cases: number;
  results: TimedConstraintResult[];
}
