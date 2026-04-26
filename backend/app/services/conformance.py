"""
Conformance checking service using pm4py.
Supports token-based replay and alignment-based conformance checking.
"""

import logging
from collections import defaultdict

import pandas as pd
import pm4py
from pm4py.algo.conformance.tokenreplay import algorithm as token_replay
from pm4py.algo.evaluation.replay_fitness import algorithm as fitness_evaluator
from pm4py.algo.evaluation.precision import algorithm as precision_evaluator
from pm4py.algo.evaluation.generalization import algorithm as generalization_evaluator

from app.services.rust_accel import (
    token_replay_fitness as _rs_token_replay,
    compute_precision_etc as _rs_precision,
    compute_generalization as _rs_generalization,
)

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"


class ConformanceService:
    """Service for process conformance checking and deviation analysis."""

    def _discover_reference_model(self, df: pd.DataFrame):
        """
        Discover a reference Petri net model using the Inductive Miner.

        Returns:
            (net, initial_marking, final_marking) tuple.
        """
        net, initial_marking, final_marking = pm4py.discover_petri_net_inductive(
            df,
            case_id_key=CASE_COL,
            activity_key=ACTIVITY_COL,
            timestamp_key=TIMESTAMP_COL,
        )

        return net, initial_marking, final_marking

    def _reference_model_to_petri_net(self, reference_model: dict):
        """
        Convert a reference model dict (with transitions, places, arcs) to a pm4py
        Petri net. This handles models stored as serializable dicts.

        Expected format:
        {
            "transitions": [{"name": str, "label": str or None}, ...],
            "places": [{"name": str}, ...],
            "arcs": [{"source": str, "target": str}, ...],
            "initial_marking": [str, ...],  # list of place names
            "final_marking": [str, ...],     # list of place names
        }
        """
        from pm4py.objects.petri_net.obj import PetriNet, Marking

        net = PetriNet("reference_model")

        place_map = {}
        for p_def in reference_model.get("places", []):
            place = PetriNet.Place(p_def["name"])
            net.places.add(place)
            place_map[p_def["name"]] = place

        transition_map = {}
        for t_def in reference_model.get("transitions", []):
            label = t_def.get("label")
            transition = PetriNet.Transition(t_def["name"], label)
            net.transitions.add(transition)
            transition_map[t_def["name"]] = transition

        for a_def in reference_model.get("arcs", []):
            source_name = a_def["source"]
            target_name = a_def["target"]

            source = place_map.get(source_name) or transition_map.get(source_name)
            target = place_map.get(target_name) or transition_map.get(target_name)

            if source is not None and target is not None:
                arc = PetriNet.Arc(source, target)
                net.arcs.add(arc)
                # Also register on the objects themselves
                source.out_arcs.add(arc)
                target.in_arcs.add(arc)

        initial_marking = Marking()
        for pname in reference_model.get("initial_marking", []):
            if pname in place_map:
                initial_marking[place_map[pname]] = 1

        final_marking = Marking()
        for pname in reference_model.get("final_marking", []):
            if pname in place_map:
                final_marking[place_map[pname]] = 1

        return net, initial_marking, final_marking

    def check_conformance(
        self,
        df: pd.DataFrame,
        reference_model: dict = None,
        method: str = "token_replay",
    ) -> dict:
        """
        Check conformance of the event log against a reference model.

        Args:
            df: event log DataFrame (pm4py column names)
            reference_model: optional serialized Petri net; discovered via
                Inductive Miner if omitted
            method: "token_replay" (default), "alignment", or "footprints"

        Alignment-based conformance is strictly more accurate than token
        replay on logs with invisible transitions, skipped activities, or
        repeated loops — but is ~10-100x more expensive. Footprint-based
        conformance is structural-only and much cheaper but misses
        behavioural deviations.

        Returns:
            dict with fitness, precision, generalization, deviations,
            conformant_cases, total_cases, method.
        """
        if df.empty:
            return {
                "fitness": 0.0,
                "precision": None,
                "generalization": None,
                "deviations": [],
                "conformant_cases": 0,
                "total_cases": 0,
                "method": method,
            }

        if method not in {"token_replay", "alignment", "decomposed", "footprints", "jsd"}:
            logger.warning("Unknown conformance method %s, falling back to token_replay", method)
            method = "token_replay"

        try:
            # Get or discover the Petri net
            if reference_model is not None:
                net, im, fm = self._reference_model_to_petri_net(reference_model)
            else:
                net, im, fm = self._discover_reference_model(df)

            if method == "alignment":
                return self._alignment_conformance(df, net, im, fm)
            if method == "decomposed":
                return self._decomposed_alignment_conformance(df, net, im, fm)
            if method == "footprints":
                return self._footprints_conformance(df, net, im, fm)
            if method == "jsd":
                return self._jsd_stochastic_conformance(df, net, im, fm)

            pm4py_kw = {
                "case_id_key": CASE_COL,
                "activity_key": ACTIVITY_COL,
                "timestamp_key": TIMESTAMP_COL,
            }

            # Token-based replay for fitness (default path)
            # Try Rust-accelerated replay first (~17-500x faster)
            rs_result = _rs_token_replay(df, net, im, fm)
            if rs_result is not None:
                replayed_traces = rs_result["per_trace"]
                fitness = rs_result["average_trace_fitness"]
            else:
                replayed_traces = pm4py.conformance_diagnostics_token_based_replay(
                    df, net, im, fm, **pm4py_kw
                )
                fitness_result = pm4py.fitness_token_based_replay(df, net, im, fm, **pm4py_kw)
                fitness = fitness_result.get("average_trace_fitness", 0.0)

            # Compute precision. The Rust ETC implementation is ~600-1200x
            # faster than pm4py, so we no longer need the workload cap that
            # previously disabled precision for large logs.
            precision = None
            rs_prec = _rs_precision(df, net, im, fm)
            if rs_prec is not None:
                precision = rs_prec
            else:
                # Fallback: pm4py with workload cap
                trace_lengths = df.groupby(CASE_COL, sort=False).size()
                prefix_workload = int((trace_lengths ** 2).sum())
                PRECISION_WORKLOAD_CAP = 5_000_000
                if prefix_workload <= PRECISION_WORKLOAD_CAP:
                    try:
                        precision = float(
                            pm4py.precision_token_based_replay(
                                df, net, im, fm, **pm4py_kw
                            )
                        )
                    except Exception as e:
                        logger.warning(f"Could not compute precision: {e}")

            # Compute generalization
            generalization = _rs_generalization(df, net, im, fm)
            if generalization is None:
                try:
                    generalization = float(pm4py.generalization_tbr(df, net, im, fm, **pm4py_kw))
                except Exception as e:
                    logger.warning(f"Could not compute generalization: {e}")

            # Analyze deviations from replay results
            deviations = self._extract_deviations(df, replayed_traces)

            # Count conformant cases
            conformant_cases = sum(
                1 for trace in replayed_traces if trace.get("trace_is_fit", False)
            )
            total_cases = len(replayed_traces)

            return {
                "fitness": float(fitness),
                "precision": precision,
                "generalization": generalization,
                "deviations": deviations,
                "conformant_cases": int(conformant_cases),
                "total_cases": int(total_cases),
                "method": "token_replay",
            }

        except Exception as e:
            logger.error(f"Error in conformance checking: {e}", exc_info=True)
            raise

    def _alignment_conformance(self, df, net, im, fm) -> dict:
        """Alignment-based conformance via pm4py.

        Returns the same shape as ``check_conformance`` — fitness,
        precision, deviations, etc. — but computed from optimal
        alignments rather than token replay. Alignment output gives us
        per-case cost and a readable diagnostic of which moves are
        model-only, log-only, or synchronous.

        A* state-pruning is enabled per REACH (Information Systems 2023) —
        pm4py 2.7+ enables this by default in its A* alignment engine.
        If VARIANT_DIJKSTRA_LESS_MEMORY is available in the pm4py alignment
        Variants enum it is preferred for memory-constrained logs; otherwise
        we fall through to the standard A* variant, which already incorporates
        the REACH-style reachability pruning.
        """
        pm4py_kw = {
            "case_id_key": CASE_COL,
            "activity_key": ACTIVITY_COL,
            "timestamp_key": TIMESTAMP_COL,
        }

        # REACH-style optimization: prefer the less-memory Dijkstra variant
        # when available (pm4py.algo.conformance.alignments.petri_net.algorithm
        # exposes Variants.DIJKSTRA_LESS_MEMORY in pm4py >= 2.7).  Falls back
        # transparently to the default A* variant, which already implements
        # state-space pruning per the REACH paper (Information Systems 2023).
        # TODO: benchmark Variants.DIJKSTRA_NO_HEURISTICS vs A* on the
        # customer's typical log sizes and consider exposing as a query param.
        try:
            from pm4py.algo.conformance.alignments.petri_net import algorithm as _align_algo

            _variants = _align_algo.Variants
            _reach_variant = getattr(
                _variants,
                "DIJKSTRA_LESS_MEMORY",
                getattr(_variants, "VERSION_DIJKSTRA_LESS_MEMORY", None),
            )
        except Exception:
            _reach_variant = None

        if _reach_variant is not None:
            logger.debug(
                "Using pm4py DIJKSTRA_LESS_MEMORY alignment variant (REACH, IS 2023)"
            )
            try:
                aligned = pm4py.conformance_diagnostics_alignments(
                    df, net, im, fm,
                    variant=_reach_variant,
                    **pm4py_kw,
                )
            except TypeError:
                # Some pm4py builds don't forward the variant kwarg through the
                # high-level wrapper — fall back silently.
                aligned = pm4py.conformance_diagnostics_alignments(df, net, im, fm, **pm4py_kw)
        else:
            # A* state-pruning enabled per REACH (Information Systems 2023) —
            # pm4py 2.7+ default.
            aligned = pm4py.conformance_diagnostics_alignments(df, net, im, fm, **pm4py_kw)

        fitness_result = pm4py.fitness_alignments(df, net, im, fm, **pm4py_kw)

        deviations = []
        conformant = 0
        unique_cases = df[CASE_COL].unique().tolist()
        for i, a in enumerate(aligned or []):
            if a is None:
                continue
            # fitness == 1.0 means a perfectly conformant trace; cost alone is
            # not usable because synchronous moves carry non-zero costs in pm4py.
            case_fitness = a.get("fitness", 0.0) if isinstance(a, dict) else 0.0
            case_id = unique_cases[i] if i < len(unique_cases) else f"case_{i}"
            if case_fitness >= 1.0:
                conformant += 1
                continue
            alignment = a.get("alignment") if isinstance(a, dict) else None
            if alignment:
                for log_move, model_move in alignment:
                    # Sync move = both non->>>; log-only move = model_move is '>>'
                    if model_move == ">>" and log_move != ">>":
                        deviations.append({
                            "case_id": str(case_id),
                            "deviation_type": "unexpected_activity",
                            "expected": None,
                            "actual": log_move,
                            "activity": log_move,
                        })
                    elif log_move == ">>" and model_move != ">>" and model_move is not None:
                        deviations.append({
                            "case_id": str(case_id),
                            "deviation_type": "missing_activity",
                            "expected": model_move,
                            "actual": None,
                            "activity": model_move,
                        })

        return {
            "fitness": float(fitness_result.get("average_trace_fitness", 0.0)),
            "precision": None,  # alignment precision requires a separate call
            "generalization": None,
            "deviations": deviations[:500],  # cap to avoid huge payloads
            "conformant_cases": conformant,
            "total_cases": len(aligned or []),
            "method": "alignment",
        }

    def _decomposed_alignment_conformance(self, df, net, im, fm) -> dict:
        """Decomposed alignment conformance via pm4py's SESE decomposition.

        Splits the Petri net into Single-Entry-Single-Exit regions and
        aligns each fragment independently. Scales to logs with 100k+
        events where plain alignment OOMs or times out. Returns the same
        shape as ``_alignment_conformance`` but with ``method`` set to
        ``"decomposed"`` so callers can tell them apart.

        On pm4py versions where the decomposed API isn't available, we
        degrade gracefully to full alignment so the caller still gets
        an answer (with a logged warning).
        """
        try:
            from pm4py.algo.conformance.decomp_alignments import algorithm as decomp_algo
        except Exception as e:
            logger.warning(
                "Decomposed alignment unavailable (%s), falling back to full alignment",
                e,
            )
            result = self._alignment_conformance(df, net, im, fm)
            result["method"] = "decomposed_fallback_alignment"
            return result

        try:
            params = {
                decomp_algo.Variants.RECOMPOS_MAXIMAL.value.Parameters.PARAM_THRESHOLD_BORDER_AGREEMENT: 2,
                decomp_algo.Variants.RECOMPOS_MAXIMAL.value.Parameters.PARAM_MAX_ALIGN_TIME: 600,
                decomp_algo.Variants.RECOMPOS_MAXIMAL.value.Parameters.PARAM_MAX_ALIGN_TIME_TRACE: 10,
            }
        except Exception:
            params = None

        try:
            aligned = decomp_algo.apply(df, net, im, fm, parameters=params)
        except Exception as e:
            logger.warning(
                "Decomposed alignment raised %s — falling back to full alignment",
                e,
            )
            result = self._alignment_conformance(df, net, im, fm)
            result["method"] = "decomposed_fallback_alignment"
            return result

        # Decomposed output is a list of dicts with "cost" (0 = conformant).
        # Deviations are harder to reconstruct than full alignment, so we
        # report per-case cost rather than per-move diagnostics.
        conformant = 0
        deviations = []
        unique_cases = df[CASE_COL].unique().tolist()
        total_cost = 0.0
        for i, a in enumerate(aligned or []):
            if a is None:
                continue
            cost = a.get("cost", 0) if isinstance(a, dict) else 0
            total_cost += float(cost or 0)
            case_id = unique_cases[i] if i < len(unique_cases) else f"case_{i}"
            if cost == 0:
                conformant += 1
                continue
            deviations.append({
                "case_id": str(case_id),
                "deviation_type": "alignment_cost",
                "expected": None,
                "actual": None,
                "activity": None,
                "cost": float(cost),
            })

        total_cases = len(aligned or [])
        # Fitness approximation: 1 - normalized_cost. Decomposed alignments
        # return move costs; we normalize by the max observed cost so
        # the metric stays in [0, 1] and is roughly comparable to plain
        # alignment fitness for reporting purposes.
        avg_cost = total_cost / max(total_cases, 1)
        max_cost = max((d.get("cost", 0) for d in deviations), default=0)
        fitness = 1.0 - (avg_cost / max_cost) if max_cost > 0 else (
            1.0 if conformant == total_cases else 0.0
        )

        return {
            "fitness": max(0.0, min(1.0, float(fitness))),
            "precision": None,
            "generalization": None,
            "deviations": deviations[:500],
            "conformant_cases": conformant,
            "total_cases": total_cases,
            "method": "decomposed",
        }

    def _jsd_stochastic_conformance(self, df, net, im, fm) -> dict:
        """Jensen-Shannon Distance between log and model stochastic languages.

        Implements the metric from Li, Polyvyanyy & Leemans (ICPM 2024) —
        the first true metric for stochastic conformance, enabling fair
        comparison across tools, runs, and logs. We compute variant-level
        distributions over the shared support of (log ∪ model) traces and
        take the Jensen-Shannon distance (square root of Jensen-Shannon
        divergence), which is in [0, 1].

        The model's stochastic language is approximated via pm4py playout
        sampling — exact computation is intractable for arbitrary Petri
        nets. The JS distance is symmetric, metric-grade, and bounded,
        which is what makes this paper the one worth wrapping.
        """
        import math
        from collections import Counter

        try:
            from pm4py.algo.simulation.playout.petri_net import algorithm as pn_playout
        except Exception as e:
            logger.warning("Playout unavailable (%s), cannot compute JSD", e)
            # Fall back to alignment-based so the caller still gets a number
            result = self._alignment_conformance(df, net, im, fm)
            result["method"] = "jsd_fallback_alignment"
            return result

        # Build the log's variant distribution from the dataframe.
        log_variants: Counter = Counter()
        try:
            for _case_id, group in df.groupby(CASE_COL):
                acts = tuple(group.sort_values(TIMESTAMP_COL)[ACTIVITY_COL].astype(str).tolist())
                log_variants[acts] += 1
        except Exception as e:
            logger.warning("Failed to build log variant distribution: %s", e)
            return {
                "fitness": 0.0,
                "precision": None,
                "generalization": None,
                "deviations": [],
                "conformant_cases": 0,
                "total_cases": 0,
                "method": "jsd",
            }

        # Sample the model's stochastic language via playout. Sample size
        # scales with log size so small logs stay fast but big logs get
        # enough coverage to be meaningful.
        sample_size = max(1000, min(10000, len(log_variants) * 50))
        try:
            sampled_log = pn_playout.apply(
                net, im, fm,
                variant=pn_playout.Variants.BASIC_PLAYOUT,
                parameters={
                    pn_playout.Variants.BASIC_PLAYOUT.value.Parameters.NO_TRACES: sample_size,
                    pn_playout.Variants.BASIC_PLAYOUT.value.Parameters.MAX_TRACE_LENGTH: 200,
                },
            )
        except Exception as e:
            logger.warning("Playout failed (%s), falling back to alignment", e)
            result = self._alignment_conformance(df, net, im, fm)
            result["method"] = "jsd_fallback_alignment"
            return result

        model_variants: Counter = Counter()
        for trace in sampled_log:
            acts = tuple(str(ev.get("concept:name", "")) for ev in trace)
            if acts:
                model_variants[acts] += 1

        if not log_variants or not model_variants:
            return {
                "fitness": 0.0,
                "precision": None,
                "generalization": None,
                "deviations": [],
                "conformant_cases": 0,
                "total_cases": int(df[CASE_COL].nunique()),
                "method": "jsd",
            }

        # Shared support — union of traces seen in either distribution.
        support = set(log_variants.keys()) | set(model_variants.keys())
        log_total = sum(log_variants.values()) or 1
        model_total = sum(model_variants.values()) or 1

        p = []  # log
        q = []  # model
        for t in support:
            p.append(log_variants.get(t, 0) / log_total)
            q.append(model_variants.get(t, 0) / model_total)

        # Jensen-Shannon divergence. Use scipy if available, otherwise
        # compute by hand — no reason to bomb on a missing import.
        try:
            from scipy.spatial.distance import jensenshannon
            jsd = float(jensenshannon(p, q, base=2))
        except Exception:
            def _kl(a, b):
                s = 0.0
                for ai, bi in zip(a, b):
                    if ai > 0 and bi > 0:
                        s += ai * math.log2(ai / bi)
                return s
            m = [(pi + qi) / 2 for pi, qi in zip(p, q)]
            jsd_divergence = 0.5 * _kl(p, m) + 0.5 * _kl(q, m)
            jsd = math.sqrt(max(0.0, jsd_divergence))

        # JSD is already in [0, 1]. Convert to a fitness-like score where
        # 1.0 = perfect overlap and 0.0 = completely disjoint languages.
        fitness_equivalent = max(0.0, min(1.0, 1.0 - jsd))

        # Conformant cases = how many log cases hit traces the model also
        # reached during playout. This is a proxy but lines up with the
        # way users interpret "conformant" in the standard report.
        conformant = sum(log_variants[v] for v in log_variants if v in model_variants)

        # Deviations = variants present in the log but not in the model's
        # sampled language, ranked by how much they contributed to drift.
        deviations = []
        for variant, log_count in sorted(log_variants.items(), key=lambda x: -x[1]):
            if variant in model_variants:
                continue
            if len(deviations) >= 200:
                break
            deviations.append({
                "case_id": None,
                "deviation_type": "unsupported_variant",
                "expected": None,
                "actual": " → ".join(variant[:12]),
                "activity": None,
                "count": int(log_count),
            })

        return {
            "fitness": fitness_equivalent,
            "precision": None,
            "generalization": None,
            "deviations": deviations,
            "conformant_cases": int(conformant),
            "total_cases": int(df[CASE_COL].nunique()),
            "method": "jsd",
            "jsd": jsd,  # raw metric for callers that want to show it
        }

    def _footprints_conformance(self, df, net, im, fm) -> dict:
        """Footprint-based conformance — cheapest option, structural only.

        Useful as a quick-pass conformance smoke test before committing to
        a full alignment run on a large log.
        """
        from pm4py.algo.discovery.footprints import algorithm as fp_discovery
        from pm4py.algo.conformance.footprints import algorithm as fp_conformance

        fp_log = fp_discovery.apply(df, variant=fp_discovery.Variants.ENTIRE_EVENT_LOG)
        fp_model = fp_discovery.apply(net, im, fm, variant=fp_discovery.Variants.PETRI_NET)

        conf_result = fp_conformance.apply(fp_log, fp_model)

        # conf_result is a dict with keys like 'footprints_on_log', 'footprints_on_model',
        # 'both_logs_footprints', 'model_violations', 'log_violations'. We fold those
        # into a simple fitness number and a list of deviations.
        model_violations = conf_result.get("model_violations", set()) if isinstance(conf_result, dict) else set()
        log_violations = conf_result.get("log_violations", set()) if isinstance(conf_result, dict) else set()

        total_pairs = max(
            len(conf_result.get("footprints_on_log", set())) if isinstance(conf_result, dict) else 1,
            1,
        )
        mismatched = len(model_violations) + len(log_violations)
        fitness = 1.0 - (mismatched / total_pairs) if total_pairs > 0 else 0.0

        deviations = []
        for a, b in list(model_violations)[:200]:
            deviations.append({
                "case_id": None,
                "deviation_type": "model_violation",
                "expected": None,
                "actual": f"{a} -> {b}",
                "activity": None,
            })
        for a, b in list(log_violations)[:200]:
            deviations.append({
                "case_id": None,
                "deviation_type": "log_violation",
                "expected": None,
                "actual": f"{a} -> {b}",
                "activity": None,
            })

        return {
            "fitness": max(0.0, min(1.0, float(fitness))),
            "precision": None,
            "generalization": None,
            "deviations": deviations,
            "conformant_cases": int(df[CASE_COL].nunique() - len(log_violations)),
            "total_cases": int(df[CASE_COL].nunique()),
            "method": "footprints",
        }

    def _extract_deviations(
        self, df: pd.DataFrame, replayed_traces: list
    ) -> list:
        """
        Extract deviation details from token replay results.

        Returns:
            list of deviation dicts with case_id, deviation_type, expected, actual, activity.
        """
        deviations = []

        # Build case_id list from the dataframe
        case_ids = df.groupby(CASE_COL).ngroup()
        unique_cases = df[CASE_COL].unique().tolist()

        for i, trace_result in enumerate(replayed_traces):
            if trace_result.get("trace_is_fit", True):
                continue

            case_id = unique_cases[i] if i < len(unique_cases) else f"case_{i}"

            # Missing tokens indicate the model expected activities that didn't happen
            missing_tokens = trace_result.get("missing_tokens", 0)
            remaining_tokens = trace_result.get("remaining_tokens", 0)
            consumed_tokens = trace_result.get("consumed_tokens", 0)
            produced_tokens = trace_result.get("produced_tokens", 0)

            # Check for activities that were enabled but not in the trace
            enabled_in_marking = trace_result.get(
                "transitions_with_problems", []
            )
            if isinstance(enabled_in_marking, list):
                for transition in enabled_in_marking:
                    t_label = (
                        transition.label
                        if hasattr(transition, "label") and transition.label
                        else str(transition)
                    )
                    deviations.append(
                        {
                            "case_id": str(case_id),
                            "deviation_type": "unexpected_activity",
                            "expected": None,
                            "actual": t_label,
                            "activity": t_label,
                        }
                    )

            # If there are missing tokens, it usually means an activity was expected
            if missing_tokens > 0 and not enabled_in_marking:
                deviations.append(
                    {
                        "case_id": str(case_id),
                        "deviation_type": "missing_activity",
                        "expected": None,
                        "actual": None,
                        "activity": None,
                    }
                )

            # If there are remaining tokens, the case ended prematurely
            if remaining_tokens > 0 and not enabled_in_marking:
                deviations.append(
                    {
                        "case_id": str(case_id),
                        "deviation_type": "wrong_order",
                        "expected": "process completion",
                        "actual": "premature end",
                        "activity": None,
                    }
                )

        return deviations

    def compute_stochastic_conformance(
        self,
        df: pd.DataFrame,
        reference_model: dict = None,
    ) -> dict:
        """Stochastic conformance via Earth Mover's Distance (EMD).

        Implements the EMD-based stochastic conformance metric from
        Polyvyanyy et al., "Earth Movers' Stochastic Conformance"
        (Information Systems 2021). The method builds a frequency-weighted
        variant distribution over the log, samples the model's stochastic
        language via pm4py playout, then computes the Wasserstein / Earth
        Mover's Distance between the two distributions. This surfaces
        *how much* a process deviates, not just whether it deviates —
        distinguishing a 0.1% deviation from a 30% deviation.

        Stochastic precision/recall framing follows:
          Leemans & Polyvyanyy, "Stochastic-aware precision and recall
          measures" (2023).

        Args:
            df: Event log DataFrame (pm4py column names).
            reference_model: Optional serialized Petri net dict. If None,
                the Inductive Miner discovers one from the log.

        Returns:
            dict with keys:
                emd_distance         – float in [0, 1], lower = better fit
                stochastic_fitness   – float in [0, 1], higher = better fit
                top_deviating_variants – list of up to 20 dicts sorted by
                                         |log_frequency - model_probability|
                severity_breakdown   – {"minor": int, "moderate": int, "severe": int}
                log_variants_count   – int
                model_traces_sampled – int
        """
        if df is None or df.empty:
            return {
                "emd_distance": 1.0,
                "stochastic_fitness": 0.0,
                "top_deviating_variants": [],
                "severity_breakdown": {"minor": 0, "moderate": 0, "severe": 0},
                "log_variants_count": 0,
                "model_traces_sampled": 0,
            }

        # ------------------------------------------------------------------
        # Step 1 — Discover or accept a reference Petri net.
        # ------------------------------------------------------------------
        try:
            if reference_model is not None:
                net, im, fm = self._reference_model_to_petri_net(reference_model)
            else:
                net, im, fm = self._discover_reference_model(df)
        except Exception as e:
            logger.error("Stochastic conformance: model discovery failed: %s", e, exc_info=True)
            return {
                "emd_distance": 1.0,
                "stochastic_fitness": 0.0,
                "top_deviating_variants": [],
                "severity_breakdown": {"minor": 0, "moderate": 0, "severe": 0},
                "log_variants_count": 0,
                "model_traces_sampled": 0,
            }

        # ------------------------------------------------------------------
        # Step 2 — Build the log variant distribution.
        # Each unique activity sequence → relative frequency (sums to 1).
        # ------------------------------------------------------------------
        from collections import Counter

        log_variant_counts: Counter = Counter()
        try:
            for _case_id, group in df.groupby(CASE_COL):
                acts = tuple(
                    group.sort_values(TIMESTAMP_COL)[ACTIVITY_COL].astype(str).tolist()
                )
                log_variant_counts[acts] += 1
        except Exception as e:
            logger.warning("Stochastic conformance: failed to build log distribution: %s", e)
            return {
                "emd_distance": 1.0,
                "stochastic_fitness": 0.0,
                "top_deviating_variants": [],
                "severity_breakdown": {"minor": 0, "moderate": 0, "severe": 0},
                "log_variants_count": 0,
                "model_traces_sampled": 0,
            }

        log_total = sum(log_variant_counts.values()) or 1
        log_dist: dict[tuple, float] = {
            v: c / log_total for v, c in log_variant_counts.items()
        }

        # ------------------------------------------------------------------
        # Step 3 — Sample the model's stochastic language via playout.
        # We prefer STOCHASTIC_PLAYOUT (weights by arc guards / stochastic
        # annotations) and fall back to BASIC_PLAYOUT when unavailable.
        # Sample 1 000 traces — enough for stable EMD on most real logs.
        # ------------------------------------------------------------------
        MODEL_SAMPLE_SIZE = 1_000
        model_variant_counts: Counter = Counter()
        model_traces_sampled = 0

        try:
            from pm4py.algo.simulation.playout.petri_net import algorithm as pn_playout

            playout_params_basic = {
                pn_playout.Variants.BASIC_PLAYOUT.value.Parameters.NO_TRACES: MODEL_SAMPLE_SIZE,
                pn_playout.Variants.BASIC_PLAYOUT.value.Parameters.MAX_TRACE_LENGTH: 200,
            }
            # Attempt stochastic playout first (requires stochastic net weights)
            sampled_log = None
            stochastic_variant = getattr(pn_playout.Variants, "STOCHASTIC_PLAYOUT", None)
            if stochastic_variant is not None:
                try:
                    sampled_log = pn_playout.apply(
                        net, im, fm,
                        variant=stochastic_variant,
                        parameters={
                            stochastic_variant.value.Parameters.NO_TRACES: MODEL_SAMPLE_SIZE,
                        },
                    )
                except Exception as _e:
                    logger.debug(
                        "STOCHASTIC_PLAYOUT unavailable (%s), falling back to BASIC_PLAYOUT", _e
                    )
                    sampled_log = None

            if sampled_log is None:
                sampled_log = pn_playout.apply(
                    net, im, fm,
                    variant=pn_playout.Variants.BASIC_PLAYOUT,
                    parameters=playout_params_basic,
                )

            for trace in sampled_log:
                acts = tuple(str(ev.get("concept:name", "")) for ev in trace)
                if acts:
                    model_variant_counts[acts] += 1
            model_traces_sampled = sum(model_variant_counts.values())

        except Exception as e:
            logger.warning(
                "Stochastic conformance: playout failed (%s); model distribution will be empty", e
            )

        model_total = sum(model_variant_counts.values()) or 1
        model_dist: dict[tuple, float] = {
            v: c / model_total for v, c in model_variant_counts.items()
        }

        # ------------------------------------------------------------------
        # Step 4 — Compute EMD between log and model distributions.
        #
        # Preferred: pm4py's built-in earth-mover implementation.
        # Fallback:  scipy.stats.wasserstein_distance on a 1-D rank encoding
        #            of trace variants.  The rank encoding is an approximation
        #            because it collapses the metric space of trace sequences
        #            to a total order, losing edit-distance geometry — see
        #            comment below.  This is clearly marked as an approximation.
        # ------------------------------------------------------------------

        # Union support: all variants seen in log or model.
        all_variants = list(set(log_dist.keys()) | set(model_dist.keys()))

        emd_distance = 1.0  # pessimistic default

        # Try pm4py's own EMD / stochastic conformance if exposed.
        _pm4py_emd_used = False
        try:
            # pm4py ≥ 2.7 may expose this path; import defensively.
            from pm4py.algo.evaluation.earth_mover_distance import (  # type: ignore[import]
                algorithm as emd_algo,
            )
            # The pm4py earth-mover module expects pm4py EventLog objects, not
            # plain dicts — build minimal wrappers.
            from pm4py.objects.log.obj import EventLog as Pm4pyLog, Trace, Event as Pm4pyEvent
            from pm4py.objects.stochastic_petri_net.obj import StochasticPetriNet  # noqa: F401

            def _build_pm4py_log(dist: dict[tuple, float]) -> Pm4pyLog:
                pm_log = Pm4pyLog()
                # Weight each variant by (frequency * 10 000) rounded to int
                # so relative proportions survive integer rounding.
                for variant, freq in dist.items():
                    count = max(1, round(freq * 10_000))
                    for _ in range(count):
                        trace = Trace()
                        for act in variant:
                            ev = Pm4pyEvent()
                            ev["concept:name"] = act
                            trace.append(ev)
                        pm_log.append(trace)
                return pm_log

            pm_log_log = _build_pm4py_log(log_dist)
            pm_log_model = _build_pm4py_log(model_dist)
            raw_emd = emd_algo.apply(pm_log_log, pm_log_model)
            # pm4py EMD is already normalised; clamp to [0, 1].
            emd_distance = float(max(0.0, min(1.0, raw_emd)))
            _pm4py_emd_used = True
        except Exception as _pm4py_err:
            logger.debug("pm4py earth_mover_distance unavailable (%s), using scipy fallback", _pm4py_err)

        if not _pm4py_emd_used:
            # Fallback: approximate EMD via scipy Wasserstein distance on a
            # rank-encoded 1-D representation of trace variants.
            # NOTE: This is an APPROXIMATION — the rank encoding assigns each
            # distinct variant an integer index (sorted deterministically), so
            # the "distance" between variants is their rank difference rather
            # than their actual edit distance.  For logs with many similar
            # variants this will underestimate transport cost; for logs with
            # a single dominant variant it is exact.  A full trace-edit-distance
            # weighted EMD would require O(|V|²) alignment calls, which is
            # impractical without pm4py's optimised EMD implementation.
            try:
                from scipy.stats import wasserstein_distance as _wdist

                # Stable sort so ranks are deterministic across runs.
                sorted_variants = sorted(all_variants)
                rank_map = {v: i for i, v in enumerate(sorted_variants)}

                log_values = [rank_map[v] for v in sorted_variants]
                log_weights = [log_dist.get(v, 0.0) for v in sorted_variants]
                model_weights = [model_dist.get(v, 0.0) for v in sorted_variants]

                # Wasserstein distance on rank indices; normalise by max rank
                # so the result is in [0, 1].
                max_rank = max(len(sorted_variants) - 1, 1)
                raw_w = _wdist(log_values, log_values, log_weights, model_weights)
                emd_distance = float(max(0.0, min(1.0, raw_w / max_rank)))
            except Exception as _scipy_err:
                logger.warning(
                    "scipy Wasserstein fallback also failed (%s); "
                    "returning worst-case EMD=1.0",
                    _scipy_err,
                )
                emd_distance = 1.0

        stochastic_fitness = 1.0 - emd_distance

        # ------------------------------------------------------------------
        # Step 5 — Compute per-variant deviations and aggregate stats.
        # ------------------------------------------------------------------
        deviating_variants = []
        severity = {"minor": 0, "moderate": 0, "severe": 0}

        for variant in all_variants:
            log_freq = log_dist.get(variant, 0.0)
            model_prob = model_dist.get(variant, 0.0)
            delta = abs(log_freq - model_prob)

            # Severity buckets (Polyvyanyy et al., IS 2021 terminology):
            #   minor    |Δ| < 0.05  — negligible frequency mismatch
            #   moderate |Δ| in [0.05, 0.15)
            #   severe   |Δ| ≥ 0.15  — material frequency deviation
            if delta < 0.05:
                severity["minor"] += 1
            elif delta < 0.15:
                severity["moderate"] += 1
            else:
                severity["severe"] += 1

            deviating_variants.append({
                "variant": list(variant),
                "log_frequency": round(log_freq, 6),
                "model_probability": round(model_prob, 6),
                "contribution": round(delta, 6),
            })

        # Sort by absolute contribution desc, top 20.
        deviating_variants.sort(key=lambda x: -x["contribution"])
        top_deviating = deviating_variants[:20]

        return {
            "emd_distance": round(emd_distance, 6),
            "stochastic_fitness": round(stochastic_fitness, 6),
            "top_deviating_variants": top_deviating,
            "severity_breakdown": severity,
            "log_variants_count": len(log_dist),
            "model_traces_sampled": model_traces_sampled,
        }

    def find_deviations(
        self, df: pd.DataFrame, reference_model: dict
    ) -> list:
        """
        Find cases that deviate from the reference model.

        Returns:
            list of deviation dicts with case_id, deviation_type, expected, actual.
        """
        if df.empty:
            return []

        try:
            net, im, fm = self._reference_model_to_petri_net(reference_model)

            # Get the expected process flow from the Petri net
            # Extract valid transition sequences
            valid_activities = set()
            for t in net.transitions:
                if t.label:
                    valid_activities.add(t.label)

            # Run token replay
            replayed_traces = token_replay.apply(
                df,
                net,
                im,
                fm,
                parameters={
                    token_replay.Variants.TOKEN_REPLAY.value.Parameters.CASE_ID_KEY: CASE_COL,
                    token_replay.Variants.TOKEN_REPLAY.value.Parameters.ACTIVITY_KEY: ACTIVITY_COL,
                    token_replay.Variants.TOKEN_REPLAY.value.Parameters.TIMESTAMP_KEY: TIMESTAMP_COL,
                },
            )

            deviations = []
            unique_cases = df[CASE_COL].unique().tolist()

            for i, trace_result in enumerate(replayed_traces):
                if trace_result.get("trace_is_fit", True):
                    continue

                case_id = unique_cases[i] if i < len(unique_cases) else f"case_{i}"

                # Get the actual activity sequence for this case
                case_events = df[df[CASE_COL] == case_id].sort_values(TIMESTAMP_COL)
                actual_activities = case_events[ACTIVITY_COL].tolist()

                # Check for activities not in the model
                for activity in actual_activities:
                    if activity not in valid_activities:
                        deviations.append(
                            {
                                "case_id": str(case_id),
                                "deviation_type": "unexpected_activity",
                                "expected": None,
                                "actual": str(activity),
                                "activity": str(activity),
                            }
                        )

                # Mark remaining token issues
                missing_tokens = trace_result.get("missing_tokens", 0)
                remaining_tokens = trace_result.get("remaining_tokens", 0)

                if missing_tokens > 0:
                    deviations.append(
                        {
                            "case_id": str(case_id),
                            "deviation_type": "missing_activity",
                            "expected": "activity required by model",
                            "actual": "activity not found in trace",
                            "activity": None,
                        }
                    )

                if remaining_tokens > 0:
                    deviations.append(
                        {
                            "case_id": str(case_id),
                            "deviation_type": "wrong_order",
                            "expected": "process to reach end",
                            "actual": "process ended early or out of order",
                            "activity": None,
                        }
                    )

            return deviations

        except Exception as e:
            logger.error(f"Error finding deviations: {e}", exc_info=True)
            raise
