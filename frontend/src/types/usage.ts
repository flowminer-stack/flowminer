// Usage metering types — mirrors backend app/api/usage.py response shapes.

export interface UsageKindTotal {
  kind: string;
  total: number;
}

export interface UsageSummary {
  since: string;
  team_id: string | null;
  by_kind: UsageKindTotal[];
}
