// ─── Stochastic Conformance (EMD / JSD) ────────────────────────────────────
// Mirrors backend schemas/conformance.py → StochasticConformanceResponse.
// Reference: Polyvyanyy et al., "Earth Movers' Stochastic Conformance"
//            Information Systems 2021.

export interface DeviatingVariant {
  /** Ordered list of activity labels constituting the trace variant. */
  variant: string[];
  /** Relative frequency of this variant in the event log (sums to 1). */
  log_frequency: number;
  /** Estimated probability under the stochastic process model. */
  model_probability: number;
  /** |log_frequency - model_probability|. Higher = more deviation. */
  contribution: number;
}

export interface SeverityBreakdown {
  /** |Δ| < 0.05 — negligible frequency mismatch. */
  minor: number;
  /** 0.05 ≤ |Δ| < 0.15. */
  moderate: number;
  /** |Δ| ≥ 0.15 — material frequency deviation. */
  severe: number;
}

export interface StochasticConformanceResult {
  /** Earth Mover's Distance in [0, 1]; 0 = perfect distributional fit. */
  emd_distance: number;
  /** 1 - emd_distance; higher = better distributional fit. */
  stochastic_fitness: number;
  /** Up to 20 variants sorted by contribution desc. */
  top_deviating_variants: DeviatingVariant[];
  severity_breakdown: SeverityBreakdown;
  /** Total distinct variants in the log. */
  log_variants_count: number;
  /** Traces sampled from the model during stochastic playout. */
  model_traces_sampled: number;
}
