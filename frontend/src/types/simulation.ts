// ─── Simulation ──────────────────────────────────────────────────────────────

export interface SimulationModification {
  type: 'duration_scale' | 'remove_activity' | 'adjust_frequency';
  activity: string;
  value: number;
}

export interface SimulationActivityStats {
  name: string;
  frequency: number;
  avg_duration: number;
}

export interface SimulationStats {
  total_cases: number;
  total_events: number;
  avg_case_duration: number;
  median_case_duration: number;
  avg_events_per_case: number;
  activities: SimulationActivityStats[];
}

export interface SimulationResponse {
  original: SimulationStats;
  simulated: SimulationStats;
  improvement: {
    avg_duration_change_pct: number;
    case_count_change: number;
    activities_removed: string[];
  };
}

// ─── Discrete-Event Simulation (DES) ─────────────────────────────────────────

export interface DESActivityDuration {
  mean: number;
  std: number;
  samples: number[];
  count: number;
}

export interface DESResourcePool {
  capacity: number;
  cases_handled: number;
}

export interface DESParameters {
  arrival_distribution: {
    kind: 'exponential' | 'empirical';
    lambda: number;
    mean_inter_arrival_s: number;
  };
  activity_durations: Record<string, DESActivityDuration>;
  gateway_probabilities: Record<string, Record<string, number>>;
  resource_pools: Record<string, DESResourcePool>;
  hourly_calendar: Record<string, number>;
  act_resource_map: Record<string, string | null>;
  start_activities: string[];
  sink_activities: string[];
  total_cases_observed: number;
}

export interface DESScenario {
  arrival_rate_multiplier?: number;
  activity_duration_overrides?: Record<string, number>;
  activity_automation?: Record<string, boolean>;
  resource_pool_overrides?: Record<string, number>;
  new_resources?: Array<{ name: string; capacity: number }>;
}

export interface DESSummary {
  avg_case_duration_s: number;
  p50: number;
  p90: number;
  p95: number;
  throughput_cases_per_day: number;
  max_concurrent_cases: number;
  resource_utilization: Record<string, number>;
}

export interface DESSimulationResult {
  summary: DESSummary;
  baseline: DESSummary;
  delta: Record<string, number>;
  runs: number;
}
