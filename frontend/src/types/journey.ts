// ─── Journey domain types ────────────────────────────────────────────────────
// Mirrors the Pydantic shapes in backend/app/api/journeys.py

export interface JourneyStage {
  id: string;
  label: string;
  /** 0–100; 50 = neutral */
  sentiment: number;
  touchpoints: string[];
  widgets: Record<string, unknown>[];
}

export interface Journey {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  journey_type: string; // 'customer' | 'employee' | custom
  stages: JourneyStage[];
  created_at: string | null;
  updated_at: string | null;
}

export interface JourneyCreate {
  project_id: string;
  name: string;
  description?: string;
  journey_type?: string;
  stages?: JourneyStage[];
}

export interface JourneyUpdate {
  name?: string;
  description?: string;
  stages?: JourneyStage[];
}
