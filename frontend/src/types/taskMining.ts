// ─── Task Mining ─────────────────────────────────────────────────────────────

export interface TaskPattern {
  id: string;
  name: string;
  sequence: Array<[string, string]>;
  frequency: number;
  avg_duration_sec: number;
  unique_users: number;
  automatable_score: number;
  discovered_at: string | null;
}

export interface TaskPatternCrossLink {
  pattern_id: string;
  pattern_name: string;
  frequency: number;
  automatable_score: number;
  step_count: number;
  overall_similarity: number;
  top_activities: Array<{ activity: string; score: number }>;
  per_step: Array<{ probe: string; best_match: string; score: number }>;
}
